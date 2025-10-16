import { stringToPath } from '@cosmjs/crypto';
import { AccountData, DirectSecp256k1HdWallet, GeneratedType, Registry } from '@cosmjs/proto-signing';
import { DeliverTxResponse, GasPrice, SigningStargateClient, calculateFee } from '@cosmjs/stargate';
import { Tendermint37Client, WebsocketClient } from '@cosmjs/tendermint-rpc';
import * as k8s from '@kubernetes/client-node';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import fetch from 'node-fetch';
import * as path from 'path';
import { Reader, Writer } from 'protobufjs/minimal';

// --- 設定値 ---
const BLOCK_SIZE_LIMIT_MB = 1;
let CHUNK_SIZE = 16 * 1024; // 16 KB

// --- 型定義 ---
interface StoredChunk { index: string; data: string; }
interface StoredChunkResponse { stored_chunk: StoredChunk; }
interface StoredManifestResponse { stored_manifest: { url: string; manifest: string; }; }
interface Manifest { filepath: string; chunks: { index: string; chain: string; }[]; }
interface ChainInfo { name: string; type: 'datachain' | 'metachain'; }
interface ChainEndpoints { [key: string]: string; }
interface ExtendedChainClients { client: SigningStargateClient; account: AccountData; tmClient: Tendermint37Client; wsClient: WebsocketClient; }

// --- プロトコルバッファレジストリ設定 ---
interface MsgCreateStoredChunk {
	creator: string;
	index: string;
	data: Uint8Array;
}
const MsgCreateStoredChunk = {
	create(base?: Partial<MsgCreateStoredChunk>): MsgCreateStoredChunk {
		return { creator: base?.creator ?? "", index: base?.index ?? "", data: base?.data ?? new Uint8Array(), };
	},
	encode(message: MsgCreateStoredChunk, writer: Writer = Writer.create()): Writer {
		if (message.creator !== '') { writer.uint32(10).string(message.creator); }
		if (message.index !== '') { writer.uint32(18).string(message.index); }
		if (message.data.length !== 0) { writer.uint32(26).bytes(message.data); }
		return writer;
	},
	decode(input: Reader | Uint8Array, length?: number): MsgCreateStoredChunk {
		const reader = input instanceof Reader ? input : new Reader(input);
		return { creator: '', index: '', data: new Uint8Array() };
	},
};

interface MsgCreateStoredManifest {
	creator: string;
	url: string;
	manifest: string;
}
const MsgCreateStoredManifest = {
	create(base?: Partial<MsgCreateStoredManifest>): MsgCreateStoredManifest {
		return { creator: base?.creator ?? "", url: base?.url ?? "", manifest: base?.manifest ?? "", };
	},
	encode(message: MsgCreateStoredManifest, writer: Writer = Writer.create()): Writer {
		if (message.creator !== "") { writer.uint32(10).string(message.creator); }
		if (message.url !== "") { writer.uint32(18).string(message.url); }
		if (message.manifest !== "") { writer.uint32(26).string(message.manifest); }
		return writer;
	},
	decode(input: Reader | Uint8Array, length?: number): MsgCreateStoredManifest {
		const reader = input instanceof Reader ? input : new Reader(input);
		return { creator: "", url: "", manifest: "" };
	}
};

const customRegistry = new Registry([
	['/datachain.datastore.v1.MsgCreateStoredChunk', MsgCreateStoredChunk as GeneratedType],
	['/metachain.metastore.v1.MsgCreateStoredManifest', MsgCreateStoredManifest as GeneratedType],
]);

// --- Kubernetes APIクライアント設定 ---
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const K8S_NAMESPACE = 'raidchain';
const SECRET_NAME = 'raidchain-mnemonics';

/**
 * Kubernetesからチェーン情報を取得する
 */
async function getChainInfo(): Promise<ChainInfo[]> {
	console.log('INFO: Kubernetesからチェーン情報 (Pod) を取得しています...');
	const res = await k8sApi.listNamespacedPod({
		namespace: K8S_NAMESPACE,
		labelSelector: 'app.kubernetes.io/component in (datachain, metachain)'
	});
	console.log('✅ チェーン情報の取得が完了しました。');
	return res.items.map(pod => ({
		name: pod.metadata!.labels!['app.kubernetes.io/instance']!,
		type: pod.metadata!.labels!['app.kubernetes.io/component']! as any,
	}));
}

/**
 * KubernetesからRPCエンドポイントを取得する
 */
async function getRpcEndpoints(chains: ChainInfo[]): Promise<ChainEndpoints> {
	console.log('INFO: KubernetesからRPCエンドポイント (Service) を取得しています...');
	const endpoints: ChainEndpoints = {};
	const isLocal = process.env.NODE_ENV !== 'production';

	if (isLocal) {
		const res = await k8sApi.listNamespacedService({
			namespace: K8S_NAMESPACE,
			labelSelector: "app.kubernetes.io/category=chain"
		});
		for (const chain of chains) {
			const serviceName = `raidchain-${chain.name}-headless`;
			const service = res.items.find(s => s.metadata?.name === serviceName);
			const portInfo = service?.spec?.ports?.find(p => p.name === 'rpc');
			if (portInfo?.nodePort) {
				endpoints[chain.name] = `http://localhost:${portInfo.nodePort}`;
			}
		}
	} else {
		for (const chain of chains) {
			const serviceName = `raidchain-chain-headless`;
			endpoints[chain.name] = `http://raidchain-${chain.name}-0.${serviceName}.${K8S_NAMESPACE}.svc.cluster.local:26657`;
		}
	}
	console.log('✅ RPCエンドポイントの取得が完了しました。');
	console.log(endpoints);
	return endpoints;
}

/**
 * Kubernetes Secretからニーモニックを取得する
 */
async function getCreatorMnemonic(chainName: string): Promise<string> {
	console.log(`INFO: Kubernetes Secretから'${chainName}'のニーモニックを取得しています...`);
	const res = await k8sApi.readNamespacedSecret({ name: SECRET_NAME, namespace: K8S_NAMESPACE });
	const encodedMnemonic = res.data?.[`${chainName}.mnemonic`];
	if (!encodedMnemonic) throw new Error(`Secret does not contain mnemonic for ${chainName}.`);
	console.log(`✅ '${chainName}'のニーモニック取得が完了しました。`);
	return Buffer.from(encodedMnemonic, 'base64').toString('utf-8');
}

// --- 修正箇所１: キャッシュ用変数を関数の外に定義 ---
let estimatedGas: number | undefined = undefined;

/**
 * チャンクをデータチェーンにアップロードする (ガス見積もりキャッシュ版)
 */
async function uploadChunk(
	client: SigningStargateClient,
	account: AccountData,
	chunkIndex: string,
	chunkData: Buffer,
): Promise<DeliverTxResponse> {
	console.log(`INFO: チャンク #${chunkIndex.split('-').pop()} のトランザクションを構築中...`);
	const msg = {
		typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk',
		value: { creator: account.address, index: chunkIndex, data: chunkData },
	};

	// --- 修正箇所２: キャッシュのロジックを追加 ---
	if (estimatedGas === undefined) {
		// ★ キャッシュがない場合のみ、ガス見積もりを実行
		console.log(`DEBUG: 初回のガス見積もり (simulate) を実行中...`);
		estimatedGas = await client.simulate(account.address, [msg], 'Upload chunk');
		console.log(`DEBUG: ガス量をキャッシュしました: ${estimatedGas}`);
	} else {
		// ★ キャッシュがある場合は、それを利用する
		console.log(`DEBUG: キャッシュされたガス量 (${estimatedGas}) を使用します。`);
	}

	const fee = calculateFee(Math.round(estimatedGas * 1.5), GasPrice.fromString('0.00001uatom'));

	console.log(`INFO: チャンク #${chunkIndex.split('-').pop()} のトランザクションをブロードキャストします...`);
	return await client.signAndBroadcast(account.address, [msg], fee, 'Upload chunk');
}

/**
 * マニフェストをメタチェーンにアップロードする
 */
async function uploadManifest(
	client: SigningStargateClient,
	account: AccountData,
	urlIndex: string,
	manifestString: string
): Promise<DeliverTxResponse> {
	console.log('INFO: マニフェストのトランザクションを構築中...');
	const msg = {
		typeUrl: '/metachain.metastore.v1.MsgCreateStoredManifest',
		value: { creator: account.address, url: urlIndex, manifest: manifestString },
	};
	console.log('DEBUG: ガス見積もり (simulate) を実行中...');
	const gasEstimated = await client.simulate(account.address, [msg], 'Upload manifest');
	console.log(`DEBUG: 推定ガス量: ${gasEstimated}`);
	const fee = calculateFee(Math.round(gasEstimated * 1.5), GasPrice.fromString('0.00001uatom'));

	console.log('INFO: マニフェストのトランザクションをブロードキャストします...');
	return await client.signAndBroadcast(account.address, [msg], fee, 'Upload manifest');
}

/**
 * マニフェストをメタチェーンから取得する
 */
async function queryStoredManifest(restEndpoint: string, urlIndex: string): Promise<StoredManifestResponse> {
	console.log('INFO: REST API経由でマニフェストをクエリ中...');
	const queryUrl = `${restEndpoint}/metachain/metastore/v1/stored_manifest/${encodeURIComponent(urlIndex)}`;
	const response = await fetch(queryUrl);
	if (!response.ok) throw new Error(`Failed to query manifest: ${response.statusText}`);
	console.log('✅ マニフェストのクエリが完了しました。');
	return await response.json() as StoredManifestResponse;
}

/**
 * チャンクをデータチェーンから取得する
 */
async function queryStoredChunk(restEndpoint: string, chunkIndex: string): Promise<StoredChunkResponse> {
	console.log(`INFO: REST API経由でチャンク'${chunkIndex}'をクエリ中...`);
	const queryUrl = `${restEndpoint}/datachain/datastore/v1/stored_chunk/${encodeURIComponent(chunkIndex)}`;
	const response = await fetch(queryUrl);
	if (!response.ok) throw new Error(`Failed to query chunk: ${response.statusText}`);
	console.log(`✅ チャンク'${chunkIndex}'のクエリが完了しました。`);
	return await response.json() as StoredChunkResponse;
}

/**
 * Base64エンコード後のサイズを元に元のファイルサイズを計算
 * @param targetSizeInBytes Base64エンコード後の目標サイズ（バイト）
 */
function getOriginalSizeForBase64Target(targetSizeInBytes: number): number {
	return Math.floor(targetSizeInBytes * 3 / 4);
}

/**
 * メインのアップロード処理
 */
async function main() {
	console.log('--- Raidchain 自動負荷分散アップロードスクリプト ---');

	// コマンドライン引数をパース
	const args = process.argv.slice(2);
	const sizeIndex = args.indexOf('--size-kb');
	const targetSizeKB = (sizeIndex !== -1 && args[sizeIndex + 1]) ? parseInt(args[sizeIndex + 1]!, 10) : 100;

	if (isNaN(targetSizeKB) || targetSizeKB <= 0) {
		console.error('ERROR: --size-kb には正の整数を指定してください。');
		process.exit(1);
	}

	const siteUrl = `UploadTest-${Date.now()}`;
	const filePath = `src/tests/temp-file-${targetSizeKB}kb`;
	const originalSizeKB = Math.floor(getOriginalSizeForBase64Target(targetSizeKB * 1024) / 1024);
	const originalContent = `This is a test file for upload. Target encoded size: ${targetSizeKB} KB.`;

	await fs.writeFile(filePath, Buffer.alloc(originalSizeKB * 1024, originalContent));
	console.log(`✅ ${originalSizeKB} KBのテストファイルを '${filePath}' に作成しました。`);

	// 1. 環境情報の取得
	const allChains = await getChainInfo();
	const dataChains = allChains.filter(c => c.type === 'datachain');
	const metaChain = allChains.find(c => c.type === 'metachain');
	if (!metaChain) {
		console.error('ERROR: メタチェーンが見つかりません。');
		process.exit(1);
	}
	const rpcEndpoints = await getRpcEndpoints(allChains);

	// チャンクサイズの動的計算
	const fileSizeInBytes = originalSizeKB * 1024;
	const numDataChains = dataChains.length > 0 ? dataChains.length : 1;
	let newChunkSize = Math.ceil(fileSizeInBytes / numDataChains);

	// ブロックサイズ上限の適用
	const blockSizeLimitBytes = BLOCK_SIZE_LIMIT_MB * 1024 * 1024;
	if (newChunkSize > blockSizeLimitBytes) {
		newChunkSize = blockSizeLimitBytes;
		console.warn(`WARN: 計算されたチャンクサイズがブロックサイズ上限(${BLOCK_SIZE_LIMIT_MB} MB)を超えたため、上限値に設定します。`);
	}
	CHUNK_SIZE = newChunkSize;
	console.log(`ℹ️ 動的に計算されたチャンクサイズ: ${Math.round(CHUNK_SIZE / 1024)} KB (データチェーン数: ${numDataChains})`);

	// 各チェーンのクライアントとアカウントを一度だけ作成
	console.log('INFO: 各チェーンのウォレットとRPCクライアントを初期化します...');
	const chainClients = new Map<string, ExtendedChainClients>();
	const apiEndpoints: ChainEndpoints = {};
	for (const chain of allChains) {
		console.log(`INFO: チェーン'${chain.name}'のクライアントをセットアップ中...`);
		const mnemonic = await getCreatorMnemonic(chain.name);
		const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { hdPaths: [stringToPath("m/44'/118'/0'/0/2")] });
		const [account] = await wallet.getAccounts();
		if (!account) throw new Error(`Failed to get account from wallet for chain ${chain.name}`);

		const rpcUrl = rpcEndpoints[chain.name]!.replace('http', 'ws');
		const wsClient = new WebsocketClient(rpcUrl, (err) => {
			if (err) {
				console.error(`ERROR: WebSocket connection to ${chain.name} lost:`, err);
			}
		});
		await wsClient.execute({ jsonrpc: "2.0", method: "status", id: 1, params: [] });
		const tmClient = Tendermint37Client.create(wsClient);
		const client = SigningStargateClient.createWithSigner(tmClient, wallet, { registry: customRegistry, gasPrice: GasPrice.fromString('0.00001uatom') });

		chainClients.set(chain.name, { client, account, tmClient, wsClient });
		console.log(`✅ チェーン'${chain.name}'のクライアントセットアップが完了しました。`);

		console.log(`INFO: チェーン'${chain.name}'のREST APIエンドポイントを取得中...`);
		const restEndpointRes = await k8sApi.listNamespacedService({ namespace: K8S_NAMESPACE, labelSelector: `app.kubernetes.io/instance=${chain.name}` });
		const service = restEndpointRes.items.find(s => s.metadata?.name?.includes('headless'));
		const portInfo = service?.spec?.ports?.find(p => p.name === 'api');
		if (portInfo?.nodePort) {
			apiEndpoints[chain.name] = `http://localhost:${portInfo.nodePort}`;
		}
		console.log(`✅ チェーン'${chain.name}'のAPIエンドポイント取得が完了しました。`);
	}
	console.log('✅ 全てのチェーンのクライアント初期化が完了しました。');

	const chainLocks = new Map<string, Promise<void>>();
	for (const chain of allChains) {
		chainLocks.set(chain.name, Promise.resolve());
	}

	let quietestChainLock = Promise.resolve();

	const chunksToUpload: { chunk: Buffer; index: string }[] = [];
	let chunkCounter = 0;
	const uniqueSuffix = `file-${Date.now()}`;

	console.log('INFO: ファイルをチャンクに分割しています...');
	const fileStream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
	for await (const chunk of fileStream) {
		const chunkIndex = `${uniqueSuffix}-${chunkCounter}`;
		chunksToUpload.push({ chunk: chunk as Buffer, index: chunkIndex });
		chunkCounter++;
	}
	console.log(`✅ ファイルの分割が完了しました。合計${chunksToUpload.length}個のチャンクが生成されました。`);

	// uploadedChunks は全ワーカーで共有する
	const uploadedChunks: { index: string; chain: string; }[] = [];

	// ★★★ 修正箇所 ★★★

	// 各ワーカーは、キューからチャンクがなくなるまで処理を続ける
	const worker = async (workerId: number) => {
		// workerId を使って、担当するチェーンを分散させる
		const targetChainName = dataChains[workerId % dataChains.length]!.name;
		console.log(`INFO: ワーカー #${workerId} はチェーン '${targetChainName}' を担当します。`);

		while (chunksToUpload.length > 0) {
			// 他のワーカーと競合しないように、配列から安全にジョブを取り出す
			const job = chunksToUpload.shift();
			if (!job) continue;

			// このワーカーが担当するチェーンのクライアントを取得
			const { client, account } = chainClients.get(targetChainName)!;

			try {
				console.log(`   -> [Worker #${workerId}] チャンク #${job.index.split('-').pop()} を '${targetChainName}' にアップロード中...`);
				await uploadChunk(client, account, job.index, job.chunk);
				console.log(`   ... [Worker #${workerId}] チャンク #${job.index.split('-').pop()} のアップロード完了。`);

				// 配列への追加は競合する可能性があるため、本来は排他制御すべきだが、
				// このケースでは致命的な問題にはなりにくい
				uploadedChunks.push({ index: job.index, chain: targetChainName });
			} catch (error) {
				console.error(`ERROR: [Worker #${workerId}] チャンク #${job.index.split('-').pop()} のアップロードに失敗しました。`, error);
				// 失敗したジョブをキューに戻すなどのリトライ処理も考えられる
				chunksToUpload.unshift(job);
			}
		}
	};

	const workerPromises = [];
	const maxConcurrentUploads = dataChains.length > 0 ? dataChains.length : 1;
	console.log(`アップロードを開始します... (同時実行数: ${maxConcurrentUploads})`);
	for (let i = 0; i < maxConcurrentUploads; i++) {
		// worker にIDを渡す
		workerPromises.push(worker(i));
	}
	await Promise.all(workerPromises);

	// 3. マニフェストのアップロード
	const urlIndex = encodeURIComponent(siteUrl);
	uploadedChunks.sort((a, b) => parseInt(a.index.split('-').pop()!) - parseInt(b.index.split('-').pop()!));
	const manifest: Manifest = {
		filepath: path.basename(filePath),
		chunks: uploadedChunks,
	};
	const manifestString = JSON.stringify(manifest);

	console.log(`✅ 全てのチャンクのアップロードが完了しました。マニフェストをメタチェーンに登録します。`);
	const { client: metaClient, account: metaAccount } = chainClients.get(metaChain.name)!;
	await uploadManifest(metaClient, metaAccount, urlIndex, manifestString);
	console.log(`🎉 '${siteUrl}' のアップロードが正常に完了しました！`);

	// 4. 検証処理
	console.log('\n--- 検証処理を開始します ---');
	console.log('INFO: メタチェーンからマニフェストを取得中...');
	const manifestResponse = await queryStoredManifest(apiEndpoints[metaChain.name]!, urlIndex);
	const downloadedManifest = JSON.parse(manifestResponse.stored_manifest.manifest) as Manifest;
	console.log(`✅ マニフェストを取得しました。${downloadedManifest.chunks.length}個のチャンクをダウンロードします。`);

	const downloadedChunksBuffers: Buffer[] = [];
	console.log('INFO: チャンクのダウンロードを並列で開始します...');
	await Promise.all(downloadedManifest.chunks.map(async (chunkInfo, i) => {
		console.log(`DEBUG: '${chunkInfo.chain}'からチャンク'${chunkInfo.index}'をダウンロード中...`);
		const chunkResponse = await queryStoredChunk(apiEndpoints[chunkInfo.chain]!, chunkInfo.index);
		const chunkBuffer = Buffer.from(chunkResponse.stored_chunk.data, 'base64');
		downloadedChunksBuffers[i] = chunkBuffer;
		console.log(`DEBUG: チャンク'${chunkInfo.index}'のダウンロードが完了しました。`);
	}));

	const reconstructedBuffer = Buffer.concat(downloadedChunksBuffers);
	const originalBuffer = await fs.readFile(filePath);

	if (Buffer.compare(originalBuffer, reconstructedBuffer) === 0) {
		console.log('🎉 検証成功！ダウンロードされたファイルは元のファイルと完全に一致します。');
	} else {
		console.error('❌ 検証失敗！ダウンロードされたファイルが元のファイルと一致しません。');
	}

	await fs.unlink(filePath);
	console.log(`一時ファイル '${filePath}' を削除しました。`);

	// 全てのWebSocket接続を閉じる
	for (const [key, { wsClient }] of chainClients.entries()) {
		wsClient.disconnect();
		console.log(`INFO: WebSocket接続 ${key} を閉じました。`);
	}
	console.log('✅ 全ての処理が完了しました。プロセスを終了します。');
	process.exit(0);
}

// 実行
main().catch(err => {
	console.error("予期せぬエラーでスクリプトが中断されました。");
	console.error(err);
	process.exit(1);
});
