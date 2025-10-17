import { stringToPath } from '@cosmjs/crypto';
import { AccountData, DirectSecp256k1HdWallet, GeneratedType, Registry } from '@cosmjs/proto-signing';
import { DeliverTxResponse, GasPrice, SigningStargateClient, calculateFee } from '@cosmjs/stargate';
import { Tendermint37Client, WebsocketClient } from '@cosmjs/tendermint-rpc';
import * as k8s from '@kubernetes/client-node';
import cliProgress from 'cli-progress';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import fetch from 'node-fetch';
import * as path from 'path';
import { Reader, Writer } from 'protobufjs/minimal';
import winston from 'winston';
import Transport from 'winston-transport';

// winstonが提供するログオブジェクトの型
interface TransformableInfo {
	level: string;
	message: string;
	[key: string]: any;
}

// --- ロガー設定 (メモリバッファリング) ---

const logBuffer: any[] = [];
const scriptFileName = path.basename(process.argv[1]!).replace(path.extname(process.argv[1]!), '');
const logFilePath = path.join(process.cwd(), "src/tests/", `${scriptFileName}.log`);

class LogBufferTransport extends Transport {
	constructor(opts?: Transport.TransportStreamOptions) {
		super(opts);
	}

	log(info: any, callback: () => void) {
		setImmediate(() => { this.emit('logged', info); });
		logBuffer.push(info);
		callback();
	}
}
const logger = winston.createLogger({
	level: 'info',
	format: winston.format.combine(
		winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
		winston.format.printf(info => `[${info.timestamp}] [${info.level.toUpperCase()}] - ${info.message} ${info.stack ? '\n' + info.stack : ''}`)
	),
	transports: [new LogBufferTransport()],
});

/**
 * プログラム終了時またはエラー時にログをファイルに書き込む
 */
async function flushLogs() {
	if (logBuffer.length === 0) return;
	const logContent = logBuffer
		.map(info => {
			const transformed = logger.format.transform(info, {});
			if (transformed && (transformed as TransformableInfo).message) {
				return (transformed as TransformableInfo).message;
			}
			return '';
		})
		.join('\n');
	try {
		await fs.writeFile(logFilePath, logContent + '\n', { flag: 'w' });
		console.error(`\n🚨 ログをファイルに書き込みました: ${logFilePath}`);
	} catch (e) {
		console.error('ERROR: Failed to write logs to file.', e);
	}
}


// --- CONFIG: すべての設定値をここに集約 ---
const CONFIG = {
	K8S_NAMESPACE: 'raidchain',
	SECRET_NAME: 'raidchain-mnemonics',
	BLOCK_SIZE_LIMIT_MB: 20,
	DEFAULT_CHUNK_SIZE: 16 * 1024,
	GAS_PRICE_STRING: '0.0000001uatom',
	GAS_MULTIPLIER: 1.5,
	HD_PATH: "m/44'/118'/0'/0/2",
	MAX_RETRIES: 3,
	RETRY_BACKOFF_MS: 500,
	DEFAULT_TEST_SIZE_KB: 100,
};

let CHUNK_SIZE = CONFIG.DEFAULT_CHUNK_SIZE;

// --- 型定義 ---
interface StoredChunk { index: string; data: string; }
interface StoredChunkResponse { stored_chunk: StoredChunk; }
interface StoredManifestResponse { stored_manifest: { url: string; manifest: string; }; }
interface Manifest { filepath: string; chunks: { index: string; chain: string; }[]; }
interface ChainInfo { name: string; type: 'datachain' | 'metachain'; }
interface ChainEndpoints { [key: string]: string; }
interface ExtendedChainClients { client: SigningStargateClient; account: AccountData; tmClient: Tendermint37Client; wsClient: WebsocketClient; restEndpoint: string; }
interface UploadJob { chunk: Buffer; index: string; retries: number; }
interface ChainProgress { total: number; completed: number; bar: any; }

// --- プロトコルバッファレジストリ設定 ---
interface MsgCreateStoredChunk { creator: string; index: string; data: Uint8Array; }
const MsgCreateStoredChunk = {
	create(base?: Partial<MsgCreateStoredChunk>): MsgCreateStoredChunk { return { creator: base?.creator ?? "", index: base?.index ?? "", data: base?.data ?? new Uint8Array(), }; },
	encode(message: MsgCreateStoredChunk, writer: Writer = Writer.create()): Writer {
		if (message.creator !== '') { writer.uint32(10).string(message.creator); }
		if (message.index !== '') { writer.uint32(18).string(message.index); }
		if (message.data.length !== 0) { writer.uint32(26).bytes(message.data); }
		return writer;
	},
	decode(input: Reader | Uint8Array, length?: number): MsgCreateStoredChunk { const reader = input instanceof Reader ? input : new Reader(input); return { creator: '', index: '', data: new Uint8Array() }; },
};
interface MsgCreateStoredManifest { creator: string; url: string; manifest: string; }
const MsgCreateStoredManifest = {
	create(base?: Partial<MsgCreateStoredManifest>): MsgCreateStoredManifest { return { creator: base?.creator ?? "", url: base?.url ?? "", manifest: base?.manifest ?? "", }; },
	encode(message: MsgCreateStoredManifest, writer: Writer = Writer.create()): Writer {
		if (message.creator !== "") { writer.uint32(10).string(message.creator); }
		if (message.url !== "") { writer.uint32(18).string(message.url); }
		if (message.manifest !== "") { writer.uint32(26).string(message.manifest); }
		return writer;
	},
	decode(input: Reader | Uint8Array, length?: number): MsgCreateStoredManifest { const reader = input instanceof Reader ? input : new Reader(input); return { creator: "", url: "", manifest: "" }; }
};
const customRegistry = new Registry([
	['/datachain.datastore.v1.MsgCreateStoredChunk', MsgCreateStoredChunk as GeneratedType],
	['/metachain.metastore.v1.MsgCreateStoredManifest', MsgCreateStoredManifest as GeneratedType],
]);

// --- Kubernetes APIクライアント設定 ---
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

/**
 * Kubernetesからチェーン情報とREST/RPCエンドポイントを取得する
 */
async function getChainResources(): Promise<{ chains: ChainInfo[], rpcEndpoints: ChainEndpoints, restEndpoints: ChainEndpoints }> {
	const resPods = await k8sApi.listNamespacedPod({ namespace: CONFIG.K8S_NAMESPACE, labelSelector: 'app.kubernetes.io/component in (datachain, metachain)' });
	const chains: ChainInfo[] = resPods.items.map(pod => ({ name: pod.metadata!.labels!['app.kubernetes.io/instance']!, type: pod.metadata!.labels!['app.kubernetes.io/component']! as any, }));
	const rpcEndpoints: ChainEndpoints = {};
	const restEndpoints: ChainEndpoints = {};
	const isLocal = process.env.NODE_ENV !== 'production';
	const resServices = await k8sApi.listNamespacedService({ namespace: CONFIG.K8S_NAMESPACE, labelSelector: "app.kubernetes.io/category=chain" });
	for (const chain of chains) {
		const serviceName = `raidchain-${chain.name}-headless`;
		const service = resServices.items.find(s => s.metadata?.name === serviceName);
		if (isLocal) {
			const rpcPortInfo = service?.spec?.ports?.find(p => p.name === 'rpc');
			const apiPortInfo = service?.spec?.ports?.find(p => p.name === 'api');
			if (rpcPortInfo?.nodePort) { rpcEndpoints[chain.name] = `http://localhost:${rpcPortInfo.nodePort}`; }
			if (apiPortInfo?.nodePort) { restEndpoints[chain.name] = `http://localhost:${apiPortInfo.nodePort}`; }
		} else {
			rpcEndpoints[chain.name] = `http://raidchain-${chain.name}-0.raidchain-chain-headless.${CONFIG.K8S_NAMESPACE}.svc.cluster.local:26657`;
			restEndpoints[chain.name] = `http://raidchain-${chain.name}-0.raidchain-chain-headless.${CONFIG.K8S_NAMESPACE}.svc.cluster.local:1317`;
		}
	}
	return { chains, rpcEndpoints, restEndpoints };
}

/**
 * Kubernetes Secretからニーモニックを取得する
 */
async function getCreatorMnemonic(chainName: string): Promise<string> {
	const res = await k8sApi.readNamespacedSecret({ name: CONFIG.SECRET_NAME, namespace: CONFIG.K8S_NAMESPACE });
	const encodedMnemonic = res.data?.[`${chainName}.mnemonic`];
	if (!encodedMnemonic) throw new Error(`Secret does not contain mnemonic for ${chainName}.`);
	return Buffer.from(encodedMnemonic, 'base64').toString('utf-8');
}

/**
 * チャンクをデータチェーンにアップロードする
 */
async function uploadChunk(client: SigningStargateClient, account: AccountData, chunkIndex: string, chunkData: Buffer, estimatedGas: number): Promise<DeliverTxResponse> {
	const msg = { typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk', value: { creator: account.address, index: chunkIndex, data: chunkData }, };
	const gasWanted = Math.round(estimatedGas * CONFIG.GAS_MULTIPLIER);
	logger.info(`[TX_PREP] Chunk ${chunkIndex} (Size: ${Math.round(chunkData.length / 1024)} KB). Gas Estimated: ${estimatedGas}. Gas Wanted (Fee Base): ${gasWanted}.`);
	const fee = calculateFee(gasWanted, GasPrice.fromString(CONFIG.GAS_PRICE_STRING));
	return await client.signAndBroadcast(account.address, [msg], fee, 'Upload chunk');
}

/**
 * マニフェストをメタチェーンにアップロードする
 */
async function uploadManifest(client: SigningStargateClient, account: AccountData, urlIndex: string, manifestString: string): Promise<DeliverTxResponse> {
	const msg = { typeUrl: '/metachain.metastore.v1.MsgCreateStoredManifest', value: { creator: account.address, url: urlIndex, manifest: manifestString }, };
	const gasEstimated = await client.simulate(account.address, [msg], 'Upload manifest');
	const fee = calculateFee(Math.round(gasEstimated * CONFIG.GAS_MULTIPLIER), GasPrice.fromString(CONFIG.GAS_PRICE_STRING));
	return await client.signAndBroadcast(account.address, [msg], fee, 'Upload manifest');
}

/**
 * マニフェストをメタチェーンから取得する
 */
async function queryStoredManifest(restEndpoint: string, urlIndex: string): Promise<StoredManifestResponse> {
	const queryUrl = `${restEndpoint}/metachain/metastore/v1/stored_manifest/${encodeURIComponent(urlIndex)}`;
	const response = await fetch(queryUrl);
	if (!response.ok) throw new Error(`Failed to query manifest: ${response.statusText}`);
	return await response.json() as StoredManifestResponse;
}

/**
 * チャンクをデータチェーンから取得する
 */
async function queryStoredChunk(restEndpoint: string, chunkIndex: string): Promise<StoredChunkResponse> {
	const queryUrl = `${restEndpoint}/datachain/datastore/v1/stored_chunk/${encodeURIComponent(chunkIndex)}`;
	const response = await fetch(queryUrl);
	if (!response.ok) throw new Error(`Failed to query chunk: ${response.statusText}`);
	return await response.json() as StoredChunkResponse;
}

/**
 * Base64エンコード後のサイズを元に元のファイルサイズを計算
 */
function getOriginalSizeForBase64Target(targetSizeInBytes: number): number {
	return Math.floor(targetSizeInBytes * 3 / 4);
}

/**
 * メインのアップロード処理
 */
async function main() {
	// --- 初期設定とファイル作成 ---
	const args = process.argv.slice(2);
	const sizeIndex = args.indexOf('--size-kb');
	const targetSizeKB = (sizeIndex !== -1 && args[sizeIndex + 1]) ? parseInt(args[sizeIndex + 1]!, 10) : CONFIG.DEFAULT_TEST_SIZE_KB;

	if (isNaN(targetSizeKB) || targetSizeKB <= 0) {
		throw new Error(`Invalid --size-kb argument: ${targetSizeKB}. Must be a positive integer.`);
	}

	const siteUrl = `UploadTest-${Date.now()}`;
	const filePath = `src/tests/temp-file-${targetSizeKB}kb`;
	const originalSizeKB = Math.floor(getOriginalSizeForBase64Target(targetSizeKB * 1024) / 1024);
	const originalContent = `This is a test file for upload. Target encoded size: ${targetSizeKB} KB.`;
	await fs.writeFile(filePath, Buffer.alloc(originalSizeKB * 1024, originalContent));

	// 1. 環境情報の取得
	const { chains: allChains, rpcEndpoints, restEndpoints: apiEndpoints } = await getChainResources();
	const dataChains = allChains.filter(c => c.type === 'datachain');
	const metaChain = allChains.find(c => c.type === 'metachain');
	if (!metaChain) { throw new Error('Metachain not found in Kubernetes resources.'); }
	const numDataChains = dataChains.length;
	if (numDataChains === 0) { throw new Error('No Datachains found in Kubernetes resources.'); }

	logger.info(`[GLOBAL_INFO] Upload Size (Encoded): ${targetSizeKB} KB`);
	logger.info(`[GLOBAL_INFO] Number of Data Chains: ${numDataChains}`);

	const fileSizeInBytes = originalSizeKB * 1024;
	let newChunkSize = Math.ceil(fileSizeInBytes / numDataChains);
	const blockSizeLimitBytes = CONFIG.BLOCK_SIZE_LIMIT_MB * 1024 * 1024;
	if (newChunkSize > blockSizeLimitBytes) { newChunkSize = blockSizeLimitBytes; }
	CHUNK_SIZE = newChunkSize;

	// 各チェーンのクライアントを初期化
	const chainClients = new Map<string, ExtendedChainClients>();
	for (const chain of allChains) {
		try {
			const mnemonic = await getCreatorMnemonic(chain.name);
			const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { hdPaths: [stringToPath(CONFIG.HD_PATH)] });
			const [account] = await wallet.getAccounts();
			if (!account) throw new Error(`Failed to get account from wallet for chain ${chain.name}`);
			const rpcUrl = rpcEndpoints[chain.name]!.replace('http', 'ws');
			const wsClient = new WebsocketClient(rpcUrl, (err) => { if (err) { logger.warn(`[${chain.name}] WebSocket connection error: ${err.message}`); } });
			await wsClient.execute({ jsonrpc: "2.0", method: "status", id: 1, params: [] });
			const tmClient = await Tendermint37Client.create(wsClient);
			const client = await SigningStargateClient.createWithSigner(tmClient, wallet, { registry: customRegistry, gasPrice: GasPrice.fromString(CONFIG.GAS_PRICE_STRING) });
			chainClients.set(chain.name, { client, account, tmClient, wsClient, restEndpoint: apiEndpoints[chain.name]! });
			logger.info(`[CLIENT_SETUP] Successful for chain: ${chain.name}`);
		} catch (e) {
			logger.error(`[CLIENT_SETUP] Failed to initialize client for chain ${chain.name}:`, e);
			throw e;
		}
	}

	// ★★★ 修正点1: チェーンごとに専用のジョブキューを作成 ★★★
	// 'account sequence mismatch'エラーを防ぐため、各チェーンへのトランザクションを
	// 完全に直列化します。そのために、チェーン名をキーとするMapを用意し、
	// 各チェーンが処理すべきジョブのリスト（キュー）を個別に管理します。
	const jobsByChain = new Map<string, UploadJob[]>();
	dataChains.forEach(chain => jobsByChain.set(chain.name, []));

	let chunkCounter = 0;
	const uniqueSuffix = `file-${Date.now()}`;

	const fileStream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
	for await (const chunk of fileStream) {
		const chunkIndex = `${uniqueSuffix}-${chunkCounter}`;
		// ラウンドロビン方式（順番に割り当て）で、このチャンクを担当するチェーンを決定
		const targetChainName = dataChains[chunkCounter % numDataChains]!.name;
		const job: UploadJob = { chunk: chunk as Buffer, index: chunkIndex, retries: 0 };
		// 担当チェーンの専用キューにジョブを追加
		jobsByChain.get(targetChainName)!.push(job);
		chunkCounter++;
	}
	const totalChunks = chunkCounter;
	logger.info(`[GLOBAL_INFO] File split into ${totalChunks} chunks (Size per chunk: ${Math.round(CHUNK_SIZE / 1024)} KB)`);

	// --- インジケーターの準備と初期化 ---
	const progressTracker = new Map<string, ChainProgress>();
	const multiBar = new cliProgress.MultiBar({
		clearOnComplete: false,
		hideCursor: true,
		format: '{chain} | {bar} | {percentage}% ({value}/{total}) | {eta}s ETA',
	}, cliProgress.Presets.shades_grey);

	// ★★★ 修正点2: 専用キューの長さに基づいてプログレスバーを初期化 ★★★
	// 各チェーンが担当するチャンク数が均等でない場合があるため、
	// それぞれの専用キューの実際のジョブ数を元にプログレスバーを設定します。
	for (const chain of dataChains) {
		const chainName = chain.name;
		const jobsForChain = jobsByChain.get(chainName)!;
		const totalForChain = jobsForChain.length;
		const newBar = multiBar.create(totalForChain, 0, { chain: chainName });
		progressTracker.set(chainName, {
			total: totalForChain,
			completed: 0,
			bar: newBar,
		});
		logger.info(`[ALLOCATION] Chain ${chainName} is responsible for ${totalForChain} chunks.`);
	}

	// --- チャンクアップロード処理 ---
	const firstChunkJob = jobsByChain.get(dataChains[0]!.name)?.[0];
	if (!firstChunkJob) { throw new Error('No chunks generated for upload.'); }
	const dataChainClient = chainClients.get(dataChains[0]!.name)!;
	const dummyMsg = {
		typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk',
		value: { creator: dataChainClient.account.address, index: firstChunkJob.index, data: firstChunkJob.chunk },
	};
	let estimatedGas;
	try {
		estimatedGas = await dataChainClient.client.simulate(dataChainClient.account.address, [dummyMsg], 'Gas Estimation');
		logger.info(`[GAS_SIMULATE] Initial estimated gas for one chunk (simulate): ${estimatedGas}`);
	} catch (e) {
		logger.error('[GAS_SIMULATE] Initial simulation failed!', e);
		throw e;
	}

	const uploadedChunks: { index: string; chain: string; }[] = [];

	// ★★★ 修正点3: ワーカーが自分専用のキューを処理するように変更 ★★★
	const worker = async (workerId: number) => {
		// workerIdはdataChains配列のインデックスに対応します。
		const targetChainName = dataChains[workerId]!.name;
		const targetClientInfo = chainClients.get(targetChainName)!;
		const chainProgress = progressTracker.get(targetChainName)!;
		// 共有キューではなく、自分に割り当てられた専用のジョブキューを取得します。
		const jobQueue = jobsByChain.get(targetChainName)!;

		logger.info(`[WORKER_START] Worker #${workerId} started, assigned to chain: ${targetChainName}`);

		// 自分専用のキューが空になるまで、ジョブを1つずつ処理します。
		// これにより、このワーカーが送信するトランザクションは必ず直列になります。
		while (jobQueue.length > 0) {
			const job = jobQueue.shift();
			if (!job) continue;

			try {
				await uploadChunk(
					targetClientInfo.client,
					targetClientInfo.account,
					job.index,
					job.chunk,
					estimatedGas
				);
				logger.info(`[UPLOAD_SUCCESS] Chunk ${job.index} successfully uploaded to ${targetChainName}.`);
				uploadedChunks.push({ index: job.index, chain: targetChainName });
				chainProgress.completed++;
				chainProgress.bar.update(chainProgress.completed);
			} catch (error) {
				logger.error(`[UPLOAD_FAIL] Chunk ${job.index} failed on ${targetChainName}. Error:`, error);
				if (job.retries < CONFIG.MAX_RETRIES) {
					logger.warn(`[RETRY] Chunk ${job.index} (Attempt ${job.retries + 1}/${CONFIG.MAX_RETRIES}). Backing off.`);
					job.retries++;
					await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_BACKOFF_MS));
					// 失敗したジョブは、自分のキューの"先頭"に戻します。
					// これにより、同じジョブをすぐに再試行し、他のジョブが先に処理されるのを防ぎます。
					jobQueue.unshift(job);
				} else {
					logger.error(`[CRITICAL_FAIL] Chunk ${job.index} failed after ${CONFIG.MAX_RETRIES} attempts on ${targetChainName}. Aborting worker.`);
					throw new Error(`Critical upload failure on chain ${targetChainName}.`);
				}
			}
		}
	};

	const workerPromises = [];
	// データチェーンの数だけワーカーを起動します。各ワーカーは1つのチェーンを専属で担当します。
	for (let i = 0; i < numDataChains; i++) {
		workerPromises.push(worker(i));
	}

	const startTime = Date.now();
	logger.info('[MAIN] Starting concurrent chunk uploads...');
	try {
		await Promise.all(workerPromises);
		logger.info('[MAIN] All chunks successfully uploaded.');
	} catch (e) {
		logger.error('[MAIN] A critical error occurred during chunk uploads. Flushing logs.');
		throw e;
	} finally {
		multiBar.stop();
		const endTime = Date.now();
		const totalUploadTimeMs = endTime - startTime;
		const totalUploadTimeSec = (totalUploadTimeMs / 1000).toFixed(2);
		const averageTimePerChunkMs = (totalUploadTimeMs / totalChunks).toFixed(2);
		console.log('\n--- 📊 Upload Performance ---');
		console.log(`Total Upload Time: ${totalUploadTimeSec} seconds`);
		console.log(`Average Time per Chunk: ${averageTimePerChunkMs} ms`);
		console.log('--------------------------\n');
	}

	// 3. マニフェストのアップロード
	const urlIndex = encodeURIComponent(siteUrl);
	uploadedChunks.sort((a, b) => parseInt(a.index.split('-').pop()!) - parseInt(b.index.split('-').pop()!));
	const manifest: Manifest = { filepath: path.basename(filePath), chunks: uploadedChunks, };
	const manifestString = JSON.stringify(manifest);
	logger.info('[MANIFEST] Uploading manifest to Metachain...');
	const { client: metaClient, account: metaAccount } = chainClients.get(metaChain.name)!;
	await uploadManifest(metaClient, metaAccount, urlIndex, manifestString);
	logger.info('[MANIFEST] Upload complete.');

	// トランザクションがブロックに取り込まれ、APIが認識するのを待つ
	logger.info('[VERIFICATION] Waiting for 2 seconds for manifest to be indexed...');
	await new Promise(resolve => setTimeout(resolve, 2000));

	// 4. 検証処理
	logger.info('[VERIFICATION] Starting verification process...');
	const manifestResponse = await queryStoredManifest(apiEndpoints[metaChain.name]!, urlIndex);
	const downloadedManifest = JSON.parse(manifestResponse.stored_manifest.manifest) as Manifest;
	logger.info(`[VERIFICATION] Manifest retrieved. Downloading ${downloadedManifest.chunks.length} chunks...`);
	const downloadedChunksBuffers: Buffer[] = [];
	await Promise.all(downloadedManifest.chunks.map(async (chunkInfo, i) => {
		const chunkResponse = await queryStoredChunk(chainClients.get(chunkInfo.chain)!.restEndpoint, chunkInfo.index);
		const chunkBuffer = Buffer.from(chunkResponse.stored_chunk.data, 'base64');
		downloadedChunksBuffers[i] = chunkBuffer;
	}));
	const reconstructedBuffer = Buffer.concat(downloadedChunksBuffers);
	const originalBuffer = await fs.readFile(filePath);
	if (Buffer.compare(originalBuffer, reconstructedBuffer) !== 0) { throw new Error('[VERIFICATION] Verification failed! Reconstructed file does not match the original.'); }
	logger.info('[VERIFICATION] Successful! The downloaded file matches the original.');

	// クリーンアップ
	await fs.unlink(filePath);
	logger.info(`[CLEANUP] Temporary file ${filePath} deleted.`);
	for (const { wsClient, tmClient } of chainClients.values()) {
		wsClient.disconnect();
		(tmClient as any).disconnect();
	}
	logger.info('[CLEANUP] All WebSocket connections closed.');
}

// 実行と最終的なエラーハンドリング
main().then(async () => {
	logger.info('[MAIN] Script finished successfully.');
	await flushLogs();
	process.exit(0);
}).catch(async err => {
	logger.error('Uncaught fatal error in main execution loop:', err);
	await flushLogs();
	process.exit(1);
});