import { stringToPath } from '@cosmjs/crypto';
import { AccountData, DirectSecp256k1HdWallet, EncodeObject, GeneratedType, Registry, } from '@cosmjs/proto-signing';
import { calculateFee, GasPrice, IndexedTx, SigningStargateClient } from '@cosmjs/stargate';
import { Tendermint37Client, WebsocketClient } from '@cosmjs/tendermint-rpc';
import * as k8s from '@kubernetes/client-node';
import cliProgress from 'cli-progress';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx'; // 💡 追加: TxRaw のインポート
import * as fs from 'fs/promises';
import * as path from 'path';
import { Reader, Writer } from 'protobufjs/minimal';
import winston from 'winston';
import Transport from 'winston-transport';

// =================================================================================================
// 📚 I. CONFIG & TYPE DEFINITIONS
// =================================================================================================

/**
 * すべての設定値をここに集約
 */
const CONFIG = {
	K8S_NAMESPACE: 'raidchain',
	SECRET_NAME: 'raidchain-mnemonics',
	// 💡 変更点: ブロックサイズ制限を20MBに設定 (Txの最大サイズ指標として)
	BLOCK_SIZE_LIMIT_MB: 20,
	// 💡 変更点: 1MB (1024KB) チャンクに設定 (TXチャンクサイズ)
	DEFAULT_CHUNK_SIZE: 500 * 1024,
	GAS_PRICE_STRING: '0.0000001uatom',
	GAS_MULTIPLIER: 1.5,
	HD_PATH: "m/44'/118'/0'/0/2",
	MAX_RETRIES: 3,
	RETRY_BACKOFF_MS: 500,
	// 💡 変更点: 100MB ファイルを想定 (5チェーン * 20MB)
	DEFAULT_TEST_SIZE_KB: 100 * 1024,
};

// 型定義 (簡略化のために一部フィールドを省略/anyを使用)
interface TransformableInfo extends winston.Logform.TransformableInfo { level: string; message: string;[key: string]: any; }
interface StoredChunk { index: string; data: string; }
interface StoredChunkResponse { stored_chunk: StoredChunk; }
interface StoredManifestResponse { stored_manifest: { url: string; manifest: string; }; }
interface Manifest { filepath: string; chunks: { index: string; chain: string; }[]; }
interface ChainInfo { name: string; type: 'datachain' | 'metachain'; }
interface ChainEndpoints { [key: string]: string; }
interface ExtendedChainClients { client: SigningStargateClient; account: AccountData; tmClient: Tendermint37Client; wsClient: WebsocketClient; restEndpoint: string; }
// 💡 変更点: メガチャンクを表すジョブと、その中に含まれるミニチャンクの情報を保持 (ワーカーチャンクサイズ)
interface MegaChunkJob { buffer: Buffer; indexPrefix: string; chainName: string; retries: number; }
interface MiniChunk { index: string; data: Buffer; gasWanted: number; }

// プロトコルバッファ型定義とレジストリ
interface MsgCreateStoredChunk { creator: string; index: string; data: Uint8Array; }
const MsgCreateStoredChunkProto = {
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
const MsgCreateStoredManifestProto = {
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
	['/datachain.datastore.v1.MsgCreateStoredChunk', MsgCreateStoredChunkProto as GeneratedType],
	['/metachain.metastore.v1.MsgCreateStoredManifest', MsgCreateStoredManifestProto as GeneratedType],
]);

// =================================================================================================
// 📝 II. LOGGER UTILITIES (CLASS-BASED)
// =================================================================================================

class LoggerUtil {
	private readonly logBuffer: TransformableInfo[] = [];
	private readonly logger: winston.Logger;
	private readonly logFilePath: string;

	constructor() {
		const scriptFileName = path.basename(process.argv[1]!).replace(path.extname(process.argv[1]!), '');
		this.logFilePath = path.join(process.cwd(), "src/tests/", `${scriptFileName}.log`);

		class LogBufferTransport extends Transport {
			private readonly buffer: TransformableInfo[];
			constructor(buffer: TransformableInfo[], opts?: Transport.TransportStreamOptions) {
				super(opts);
				this.buffer = buffer;
			}
			log(info: any, callback: () => void) {
				setImmediate(() => { this.emit('logged', info); });
				this.buffer.push(info);
				callback();
			}
		}

		this.logger = winston.createLogger({
			level: 'info',
			format: winston.format.combine(
				winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
				winston.format.printf(info => `[${info.timestamp}] [${info.level.toUpperCase()}] - ${info.message} ${info.stack ? '\n' + info.stack : ''}`)
			),
			transports: [
				new LogBufferTransport(this.logBuffer),
				new winston.transports.Console({
					format: winston.format.combine(
						winston.format.timestamp({ format: 'HH:mm:ss' }),
						winston.format.printf(info => `[${info.timestamp}] [${info.level.toUpperCase()}] - ${info.message}`)
					),
					level: 'info',
				})
			],
		});
	}

	public getLogger(): winston.Logger {
		return this.logger;
	}

	public async flushLogs() {
		if (this.logBuffer.length === 0) return;
		const logContent = this.logBuffer
			.map(info => {
				const transformed = this.logger.format.transform(info, {});
				return transformed && (transformed as TransformableInfo).message && info.level !== 'info' ? (transformed as TransformableInfo).message : '';
			})
			.filter(line => line.length > 0)
			.join('\n');
		try {
			await fs.writeFile(this.logFilePath, logContent + '\n', { flag: 'w' });
			console.error(`\n🚨 ログをファイルに書き込みました: ${this.logFilePath}`);
		} catch (e) {
			console.error('ERROR: Failed to write logs to file.', e);
		}
	}
}

const loggerUtil = new LoggerUtil();
const logger = loggerUtil.getLogger();

// =================================================================================================
// 💻 III. KUBERNETES UTILITIES (複数チェーン対応に戻す)
// =================================================================================================

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

/**
 * Kubernetesからチェーン情報とREST/RPCエンドポイントを取得する
 */
async function getChainResources(): Promise<{ chains: ChainInfo[], rpcEndpoints: ChainEndpoints, restEndpoints: ChainEndpoints }> {
	const resPods = await k8sApi.listNamespacedPod({
		namespace: CONFIG.K8S_NAMESPACE,
		labelSelector: 'app.kubernetes.io/component in (datachain, metachain)',
	});
	const chains: ChainInfo[] = resPods.items.map(pod => ({ name: pod.metadata!.labels!['app.kubernetes.io/instance']!, type: pod.metadata!.labels!['app.kubernetes.io/component']! as any, }));
	const rpcEndpoints: ChainEndpoints = {};
	const restEndpoints: ChainEndpoints = {};
	const isLocal = process.env.NODE_ENV !== 'production';
	const resServices = await k8sApi.listNamespacedService({
		namespace: CONFIG.K8S_NAMESPACE,
		labelSelector: "app.kubernetes.io/category=chain"
	});
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
	const res = await k8sApi.readNamespacedSecret({
		name: CONFIG.SECRET_NAME,
		namespace: CONFIG.K8S_NAMESPACE,
	});
	const encodedMnemonic = res.data?.[`${chainName}.mnemonic`];
	if (!encodedMnemonic) throw new Error(`Secret does not contain mnemonic for ${chainName}.`);
	return Buffer.from(encodedMnemonic, 'base64').toString('utf-8');
}

// 💡 新規追加: Txがブロックに取り込まれるのを待つ関数
// ChainManagerの外に定義し、共通ヘルパーとする
async function waitForTxInclusion(client: SigningStargateClient, hash: string): Promise<IndexedTx> {
	const MAX_POLLING_ATTEMPTS = 40;
	const POLLING_INTERVAL_MS = 2000; // 2秒間隔

	for (let i = 0; i < MAX_POLLING_ATTEMPTS; i++) {
		const result = await client.getTx(hash);

		if (result) {
			if (result.code !== 0) {
				// 実行は失敗したが、ブロックには含まれている
				throw new Error(`Tx execution failed (Code: ${result.code}, Log: ${result.rawLog})`);
			}
			return result;
		}

		// ブロックに取り込まれるのを待つために待機
		await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
	}

	throw new Error(`Transaction ${hash} was not included in a block after ${MAX_POLLING_ATTEMPTS} attempts.`);
}

// =================================================================================================
// 🚀 IV. CHAIN CLIENT & TRANSACTION MANAGEMENT (CLASS-BASED)
// =================================================================================================

/**
 * Cosmos SDKチェーンとのやり取りを管理するクラス
 */
class ChainManager {
	private readonly chainClients = new Map<string, ExtendedChainClients>();
	public readonly gasPrice: GasPrice;

	constructor() {
		this.gasPrice = GasPrice.fromString(CONFIG.GAS_PRICE_STRING);
	}

	/**
	 * すべてのチェーンのクライアントを初期化する
	 */
	public async initializeClients(allChains: ChainInfo[], rpcEndpoints: ChainEndpoints, restEndpoints: ChainEndpoints): Promise<void> {
		const initPromises = allChains.map(async (chain) => {
			try {
				const mnemonic = await getCreatorMnemonic(chain.name);
				const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { hdPaths: [stringToPath(CONFIG.HD_PATH)] });
				const [account] = await wallet.getAccounts();
				if (!account) throw new Error(`Failed to get account from wallet for chain ${chain.name}`);

				const rpcUrl = rpcEndpoints[chain.name]!.replace('http', 'ws');
				const wsClient = new WebsocketClient(rpcUrl, (err) => { if (err) { logger.warn(`[${chain.name}] WebSocket connection error: ${err.message}`); } });
				await wsClient.execute({ jsonrpc: "2.0", method: "status", id: 1, params: [] }); // 接続確認
				const tmClient = Tendermint37Client.create(wsClient);
				const client = SigningStargateClient.createWithSigner(tmClient, wallet, { registry: customRegistry, gasPrice: this.gasPrice });

				this.chainClients.set(chain.name, { client, account, tmClient, wsClient, restEndpoint: restEndpoints[chain.name]! });
				logger.info(`[CLIENT_SETUP] Successful for chain: ${chain.name} (Address: ${account.address})`);
			} catch (e) {
				logger.error(`[CLIENT_SETUP] Failed to initialize client for chain ${chain.name}:`, e);
				throw e;
			}
		});
		await Promise.all(initPromises);
	}

	public getClientInfo(chainName: string): ExtendedChainClients {
		const clientInfo = this.chainClients.get(chainName);
		if (!clientInfo) throw new Error(`Client not initialized for chain: ${chainName}`);
		return clientInfo;
	}


	// 💡 新規追加: ノンスねじ込み方式で複数の独立したTxをブロードキャストし、完了を待つ
	/**
	 * 複数のメッセージを独立したトランザクションとしてノンスねじ込み方式で連続ブロードキャストし、
	 * すべてのTxがブロックに取り込まれるまで待機する。
	 * * @param chainName ターゲットチェーン名
	 * @param messages ブロードキャストするメッセージの配列 (Txごと)
	 * @param estimatedGas 各Txに割り当てるガスの見積もり値
	 * @param bar cliProgress.SingleBar (進捗更新用)
	 * @returns ブロックに取り込まれた全てのトランザクション結果 (IndexedTx)
	 */
	public async broadcastSequentialTxs(chainName: string, messages: EncodeObject[], estimatedGas: number, bar: cliProgress.SingleBar): Promise<IndexedTx[]> {
		const { client, account } = this.getClientInfo(chainName);
		const gasWanted = Math.round(estimatedGas * CONFIG.GAS_MULTIPLIER);
		const fee = calculateFee(gasWanted, this.gasPrice);
		const totalTxs = messages.length;

		const accountInfo = await client.getAccount(account.address);
		if (!accountInfo) throw new Error(`Failed to get account info for ${account.address}`);

		let currentSequence = accountInfo.sequence;
		const accountNumber = accountInfo.accountNumber;
		const chainId = await client.getChainId();

		const txHashes: string[] = [];
		let completedTxCount = 0;
		const txStartTime = Date.now();

		// 1. 署名と同期ブロードキャスト (ノンスねじ込み)
		for (let i = 0; i < totalTxs; i++) {
			const msg = messages[i]!;

			// 署名
			const signedTx = await client.sign(
				account.address,
				[msg], // 単一のメッセージをTxとして署名
				fee,
				`Sequential Tx ${i} (Seq: ${currentSequence})`,
				{
					accountNumber: accountNumber,
					sequence: currentSequence,
					chainId: chainId,
				}
			);

			const txRaw = Uint8Array.from(TxRaw.encode(signedTx).finish());

			// ブロードキャスト (ねじ込み)
			try {
				const resultHash = await client.broadcastTxSync(txRaw);
				txHashes.push(resultHash);

			} catch (error) {
				logger.error(`[CRITICAL_FAIL] Tx ${i} failed to broadcast on ${chainName}. Error:`, error);
				throw new Error(`Broadcast failure on ${chainName}: ${error}`);
			}

			currentSequence++; // 成功/失敗に関わらず、手動で次のノンスに進める
		}

		// 2. 全Txがブロックに取り込まれるのを待機し、結果を確認する
		bar.update(completedTxCount, { status: 'Waiting for inclusion...' }); // ブロードキャスト完了時のステータス更新

		const inclusionPromises = txHashes.map(hash =>
			waitForTxInclusion(client, hash)
		);

		// すべての Tx がブロックに取り込まれるのを待機 (並列処理)
		const results = await Promise.all(inclusionPromises.map((p, index) => p.then(result => {
			// 個別Txが完了するごとにプログレスバーを更新
			completedTxCount++;
			const txPerSec = (completedTxCount * 1000 / (Date.now() - txStartTime)).toFixed(2);
			bar.update(completedTxCount, { height: result.height, tx_per_sec: txPerSec, status: 'Confirming' });
			return result;
		}).catch(e => {
			// エラーが発生した場合、即座に例外を再スローして Promise.all を停止させる
			throw e;
		})));


		// 💡 修正点: 完了時のログ出力を削除。完了表示は executeDistributionWorkers 側の bar.update に任せる。
		// logger.info(`[${chainName}] All ${totalTxs} transactions successfully committed to block (End Seq: ${currentSequence - 1}).`);
		return results;
	}


	/**
	 * WebSocketクライアントをすべて切断する
	 */
	public closeAllConnections(): void {
		for (const { wsClient, tmClient } of this.chainClients.values()) {
			wsClient.disconnect();
			(tmClient as any).disconnect();
		}
	}
}

// =================================================================================================
// ⚙️ V. CORE BUSINESS LOGIC (MAIN)
// =================================================================================================

/**
 * Base64エンコード後のサイズを元に元のファイルサイズを計算
 */
function getOriginalSizeForBase64Target(targetSizeInBytes: number): number {
	// 4バイトのエンコードデータから3バイトの元データが得られるため、* 3 / 4
	return Math.floor(targetSizeInBytes * 3 / 4);
}

/**
 * ファイルの準備とクライアントの初期化
 */
async function setupEnvironment(chainManager: ChainManager): Promise<{
	filePath: string,
	fileSizeInBytes: number,
	dataChains: ChainInfo[],
	metaChain: ChainInfo | null,
	megaChunkSize: number
}> {
	// 1. 引数処理とファイル作成
	const args = process.argv.slice(2);
	const sizeIndex = args.indexOf('--size-kb');
	const targetSizeKB = (sizeIndex !== -1 && args[sizeIndex + 1]) ? parseInt(args[sizeIndex + 1]!, 10) : CONFIG.DEFAULT_TEST_SIZE_KB;

	if (isNaN(targetSizeKB) || targetSizeKB <= 0) {
		throw new Error(`Invalid --size-kb argument: ${targetSizeKB}. Must be a positive integer.`);
	}

	const filePath = `src/tests/temp-file-${targetSizeKB}kb`;
	const originalSizeKB = Math.floor(getOriginalSizeForBase64Target(targetSizeKB * 1024) / 1024);
	const fileSizeInBytes = originalSizeKB * 1024;
	const originalContent = `This is a test file for distributed sequential upload.`;
	await fs.writeFile(filePath, Buffer.alloc(fileSizeInBytes, originalContent));
	logger.info(`[GLOBAL_INFO] Created temp file: ${filePath} (${fileSizeInBytes / 1024} KB)`);

	// 2. 環境情報の取得
	const { chains: allChains, rpcEndpoints, restEndpoints: apiEndpoints } = await getChainResources();
	const dataChains = allChains.filter(c => c.type === 'datachain');
	const metaChain = allChains.find(c => c.type === 'metachain') || null;
	const numDataChains = dataChains.length;
	if (numDataChains === 0) { throw new Error('No Datachains found in Kubernetes resources.'); }

	// 💡 ワーカーチャンクサイズの決定: ファイルサイズ / チェーン数
	const megaChunkSize = Math.ceil(fileSizeInBytes / numDataChains);
	logger.info(`[GLOBAL_INFO] DataChains found: ${numDataChains}. Worker Chunk Size (MegaChunk) per chain: ${Math.round(megaChunkSize / 1024)} KB`);
	logger.info(`[GLOBAL_INFO] TX Chunk Size (MiniChunk): ${Math.round(CONFIG.DEFAULT_CHUNK_SIZE / 1024)} KB`);

	// 3. クライアントの初期化
	await chainManager.initializeClients(allChains, rpcEndpoints, apiEndpoints);

	return { filePath, fileSizeInBytes, dataChains, metaChain, megaChunkSize };
}

/**
 * ファイルをメガチャンクに分割し、チェーンごとのジョブキューに割り当てる
 */
async function createMegaChunkJobs(filePath: string, megaChunkSize: number, dataChains: ChainInfo[]): Promise<{ jobsByChain: Map<string, MegaChunkJob[]>, totalMegaChunks: number }> {
	const jobsByChain = new Map<string, MegaChunkJob[]>();
	dataChains.forEach(chain => jobsByChain.set(chain.name, []));

	let chunkCounter = 0;
	const uniqueSuffix = `dist-seq-test-${Date.now()}`;
	const numDataChains = dataChains.length;

	const fileBuffer = await fs.readFile(filePath);
	let offset = 0;

	while (offset < fileBuffer.length) {
		const end = Math.min(offset + megaChunkSize, fileBuffer.length);
		const buffer = fileBuffer.slice(offset, end);

		const indexPrefix = `${uniqueSuffix}-mega-${chunkCounter}`;
		const targetChainName = dataChains[chunkCounter % numDataChains]!.name; // ラウンドロビン

		const job: MegaChunkJob = { buffer: buffer, indexPrefix: indexPrefix, chainName: targetChainName, retries: 0 };
		jobsByChain.get(targetChainName)!.push(job);

		offset = end;
		chunkCounter++;
	}

	logger.info(`[ALLOCATION] File split into ${chunkCounter} MegaChunks (Worker Chunks).`);
	dataChains.forEach(chain => {
		logger.info(`[ALLOCATION] Chain ${chain.name} assigned ${jobsByChain.get(chain.name)!.length} MegaChunks.`);
	});

	return { jobsByChain, totalMegaChunks: chunkCounter };
}

/**
 * 各チェーン担当のワーカーを起動し、メガチャンクをミニチャンクに分割し連続送信する
 */
async function executeDistributionWorkers(chainManager: ChainManager, megaJobsByChain: Map<string, MegaChunkJob[]>, dataChains: ChainInfo[], estimatedGas: number): Promise<void> {

	const multiBar = new cliProgress.MultiBar({
		clearOnComplete: false,
		hideCursor: true,
		format: '{chain} | {bar} | {percentage}% ({value}/{total}) | {eta}s ETA | TX/s: {tx_per_sec} | Status: {status} | Height: {height}',
	}, cliProgress.Presets.shades_grey);

	const workerPromises = dataChains.map(chain => {
		const chainName = chain.name;
		const megaJobQueue = megaJobsByChain.get(chainName)!;

		// メガジョブの合計ミニチャンク数 (Tx数) を計算
		const totalMiniChunks = megaJobQueue.reduce((sum, job) => sum + Math.ceil(job.buffer.length / CONFIG.DEFAULT_CHUNK_SIZE), 0);
		const bar = multiBar.create(totalMiniChunks, 0, { chain: chainName, tx_per_sec: '0.00', status: 'Pending', height: 'N/A' });

		return (async () => {
			const { account } = chainManager.getClientInfo(chainName);
			let miniChunkCounter = 0;
			const messages: EncodeObject[] = [];

			// 1. 全メガチャンクをミニチャンク (Tx) に分割し、メッセージ配列を作成
			for (const megaJob of megaJobQueue) {
				const megaChunkBuffer = megaJob.buffer;
				let miniOffset = 0;
				let internalChunkIndex = 0;

				while (miniOffset < megaChunkBuffer.length) {
					const miniEnd = Math.min(miniOffset + CONFIG.DEFAULT_CHUNK_SIZE, megaChunkBuffer.length);
					const miniBuffer = megaChunkBuffer.slice(miniOffset, miniEnd);
					const miniIndex = `${megaJob.indexPrefix}-mini-${internalChunkIndex}`;

					const msg = { typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk', value: { creator: account.address, index: miniIndex, data: miniBuffer }, };
					messages.push(msg);

					miniOffset = miniEnd;
					internalChunkIndex++;
				}
			}

			bar.update(0, { status: `Total ${totalMiniChunks} TXs ready` });
			logger.info(`[WORKER_START] Worker for ${chainName} ready with ${totalMiniChunks} mini-chunks (TXs).`);

			// 2. ノンスねじ込みによる連続送信を実行
			try {
				bar.update(0, { status: 'Signing & Broadcasting' });
				const results = await chainManager.broadcastSequentialTxs(chainName, messages, estimatedGas, bar);
				bar.update(totalMiniChunks, { status: `Finished (Height: ${results[results.length - 1]?.height})` });
			} catch (error) {
				// クリティカルな失敗として扱い、ワーカーを停止
				bar.update(bar.getTotal(), { status: 'CRITICAL FAILED' });
				logger.error(`[CRITICAL_FAIL] Upload failed on ${chainName}. Error:`, error);
				throw new Error(`Critical upload failure on chain ${chainName}.`);
			}
		})();
	});

	try {
		await Promise.all(workerPromises);
	} finally {
		multiBar.stop();
	}
}

/**
 * メインの分散アップロード処理
 */
async function main() {
	const chainManager = new ChainManager();

	let filePath: string | null = null;
	let totalChunks: number = 0;
	let megaChunkSize: number = 0;
	let dataChains: ChainInfo[] = [];

	const startTime = Date.now();

	try {
		// 1. 環境設定、ファイル作成、クライアント初期化
		const setup = await setupEnvironment(chainManager);
		filePath = setup.filePath;
		dataChains = setup.dataChains;
		megaChunkSize = setup.megaChunkSize;

		// 2. ファイルをメガチャンクに分割し、チェーンに割り当て
		const { jobsByChain } = await createMegaChunkJobs(filePath, megaChunkSize, dataChains);

		// 3. ガス代のシミュレーション（ミニチャンクを使用）
		const firstMegaJob = jobsByChain.get(dataChains[0]!.name)?.[0];
		if (!firstMegaJob) { throw new Error('No mega chunks generated for upload.'); }

		const firstMiniChunk = firstMegaJob.buffer.slice(0, CONFIG.DEFAULT_CHUNK_SIZE);

		const dataChainClient = chainManager.getClientInfo(dataChains[0]!.name);
		const dummyMsg = { typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk', value: { creator: dataChainClient.account.address, index: 'dummy-0', data: firstMiniChunk }, };
		const estimatedGas = await dataChainClient.client.simulate(dataChainClient.account.address, [dummyMsg], 'Gas Estimation');
		logger.info(`[GAS_SIMULATE] Initial estimated gas for one 1MB chunk: ${estimatedGas}. Gas Wanted: ${Math.round(estimatedGas * CONFIG.GAS_MULTIPLIER)}.`);

		// 4. チャンクアップロード実行 (分散並列 + 内部ノンスねじ込み)
		logger.info('[MAIN] Starting distributed sequential chunk uploads (Noncing via workers)...');
		await executeDistributionWorkers(chainManager, jobsByChain, dataChains, estimatedGas);

		// 5. Total Chunks の最終計算
		for (const chainName of dataChains.map(c => c.name)) {
			const megaJobQueue = jobsByChain.get(chainName)!;
			totalChunks += megaJobQueue.reduce((sum, job) => sum + Math.ceil(job.buffer.length / CONFIG.DEFAULT_CHUNK_SIZE), 0);
		}

		// 6. クリーンアップ
		await fs.unlink(filePath);
		logger.info(`[CLEANUP] Temporary file ${filePath} deleted.`);
		chainManager.closeAllConnections();

	} catch (err) {
		logger.error('[MAIN] A fatal error occurred:', err);
		throw err;
	} finally {
		// パフォーマンス計測
		const endTime = Date.now();
		const totalUploadTimeMs = endTime - startTime;
		const totalUploadTimeSec = (totalUploadTimeMs / 1000).toFixed(2);

		const averageTimePerChunkMs = (totalChunks > 0 ? (totalUploadTimeMs / totalChunks) : 0).toFixed(2);

		console.log('\n--- 📊 Distributed Sequential Upload Performance ---');
		console.log(`Total Mini-Chunks Sent: ${totalChunks}`);
		console.log(`Total Upload Time: ${totalUploadTimeSec} seconds`);
		console.log(`Average Time per Chunk: ${averageTimePerChunkMs} ms`);
		console.log('--------------------------\n');
	}
}

// 実行と最終的なエラーハンドリング
main().then(async () => {
	logger.info('[MAIN] Script finished successfully.');
	await loggerUtil.flushLogs();
	process.exit(0);
}).catch(async err => {
	logger.error('Uncaught fatal error in main execution loop:', err);
	await loggerUtil.flushLogs();
	process.exit(1);
});