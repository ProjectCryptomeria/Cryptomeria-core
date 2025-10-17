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

// =================================================================================================
// 📚 I. CONFIG & TYPE DEFINITIONS
// =================================================================================================

/**
 * すべての設定値をここに集約
 */
const CONFIG = {
	K8S_NAMESPACE: 'raidchain',
	SECRET_NAME: 'raidchain-mnemonics',
	BLOCK_SIZE_LIMIT_MB: 1,
	DEFAULT_CHUNK_SIZE: 16 * 1024,
	GAS_PRICE_STRING: '0.0000001uatom',
	GAS_MULTIPLIER: 1.5,
	HD_PATH: "m/44'/118'/0'/0/2",
	MAX_RETRIES: 3,
	RETRY_BACKOFF_MS: 500,
	DEFAULT_TEST_SIZE_KB: 100,
};

// 型定義
interface TransformableInfo extends winston.Logform.TransformableInfo {
	level: string;
	message: string;
	[key: string]: any;
}
interface StoredChunk { index: string; data: string; }
interface StoredChunkResponse { stored_chunk: StoredChunk; }
interface StoredManifestResponse { stored_manifest: { url: string; manifest: string; }; }
interface Manifest { filepath: string; chunks: { index: string; chain: string; }[]; }
interface ChainInfo { name: string; type: 'datachain' | 'metachain'; }
interface ChainEndpoints { [key: string]: string; }
interface ExtendedChainClients { client: SigningStargateClient; account: AccountData; tmClient: Tendermint37Client; wsClient: WebsocketClient; restEndpoint: string; }
interface UploadJob { chunk: Buffer; index: string; retries: number; }
interface ChainProgress { total: number; completed: number; bar: cliProgress.SingleBar; }

// プロトコルバッファ型定義とレジストリ
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

// =================================================================================================
// 📝 II. LOGGER UTILITIES (CLASS-BASED)
// =================================================================================================

/**
 * ログをメモリにバッファリングし、終了時にファイルに書き出すロガーユーティリティ
 */
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
			transports: [new LogBufferTransport(this.logBuffer)],
		});
	}

	public getLogger(): winston.Logger {
		return this.logger;
	}

	/**
	 * プログラム終了時またはエラー時にログをファイルに書き込む
	 */
	public async flushLogs() {
		if (this.logBuffer.length === 0) return;
		const logContent = this.logBuffer
			.map(info => {
				// transportで既にフォーマットされているが、念のため再度formatを通す
				const transformed = this.logger.format.transform(info, {});
				return transformed && (transformed as TransformableInfo).message ? (transformed as TransformableInfo).message : '';
			})
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
// 💻 III. KUBERNETES UTILITIES
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

// =================================================================================================
// 🚀 IV. CHAIN CLIENT & TRANSACTION MANAGEMENT (CLASS-BASED)
// =================================================================================================

/**
 * Cosmos SDKチェーンとのやり取りを管理するクラス
 */
class ChainManager {
	private readonly chainClients = new Map<string, ExtendedChainClients>();
	private readonly gasPrice: GasPrice;

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

	public getClients(): Map<string, ExtendedChainClients> {
		return this.chainClients;
	}

	/**
	 * チャンクをデータチェーンにアップロードする
	 */
	public async uploadChunk(chainName: string, chunkIndex: string, chunkData: Buffer, estimatedGas: number): Promise<DeliverTxResponse> {
		const { client, account } = this.getClientInfo(chainName);
		const msg = { typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk', value: { creator: account.address, index: chunkIndex, data: chunkData }, };
		const gasWanted = Math.round(estimatedGas * CONFIG.GAS_MULTIPLIER);
		logger.info(`[TX_PREP] Chunk ${chunkIndex} (Size: ${Math.round(chunkData.length / 1024)} KB). Gas Wanted: ${gasWanted}.`);
		const fee = calculateFee(gasWanted, this.gasPrice);
		return await client.signAndBroadcast(account.address, [msg], fee, 'Upload chunk');
	}

	/**
	 * マニフェストをメタチェーンにアップロードする
	 */
	public async uploadManifest(chainName: string, urlIndex: string, manifestString: string): Promise<DeliverTxResponse> {
		const { client, account } = this.getClientInfo(chainName);
		const msg = { typeUrl: '/metachain.metastore.v1.MsgCreateStoredManifest', value: { creator: account.address, url: urlIndex, manifest: manifestString }, };
		const gasEstimated = await client.simulate(account.address, [msg], 'Upload manifest');
		const fee = calculateFee(Math.round(gasEstimated * CONFIG.GAS_MULTIPLIER), this.gasPrice);
		return await client.signAndBroadcast(account.address, [msg], fee, 'Upload manifest');
	}

	/**
	 * マニフェストをメタチェーンから取得する
	 */
	public async queryStoredManifest(chainName: string, urlIndex: string): Promise<StoredManifestResponse> {
		const { restEndpoint } = this.getClientInfo(chainName);
		const queryUrl = `${restEndpoint}/metachain/metastore/v1/stored_manifest/${encodeURIComponent(urlIndex)}`;
		const response = await fetch(queryUrl);
		if (!response.ok) throw new Error(`Failed to query manifest: ${response.statusText}`);
		return await response.json() as StoredManifestResponse;
	}

	/**
	 * チャンクをデータチェーンから取得する
	 */
	public async queryStoredChunk(chainName: string, chunkIndex: string): Promise<StoredChunkResponse> {
		const { restEndpoint } = this.getClientInfo(chainName);
		const queryUrl = `${restEndpoint}/datachain/datastore/v1/stored_chunk/${encodeURIComponent(chunkIndex)}`;
		const response = await fetch(queryUrl);
		if (!response.ok) throw new Error(`Failed to query chunk: ${response.statusText}`);
		return await response.json() as StoredChunkResponse;
	}

	/**
	 * WebSocketクライアントをすべて切断する
	 */
	public closeAllConnections(): void {
		for (const { wsClient, tmClient } of this.chainClients.values()) {
			wsClient.disconnect();
			(tmClient as any).disconnect(); // disconnectの型定義が不完全な場合があるためany
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
	metaChain: ChainInfo,
	chunkSize: number
}> {
	// 1. 引数処理とファイル作成
	const args = process.argv.slice(2);
	const sizeIndex = args.indexOf('--size-kb');
	const targetSizeKB = (sizeIndex !== -1 && args[sizeIndex + 1]) ? parseInt(args[sizeIndex + 1]!, 10) : CONFIG.DEFAULT_TEST_SIZE_KB;

	if (isNaN(targetSizeKB) || targetSizeKB <= 0) {
		throw new Error(`Invalid --size-kb argument: ${targetSizeKB}. Must be a positive integer.`);
	}

	const filePath = `src/tests/temp-file-${targetSizeKB}kb`;
	// Base64エンコード後のサイズから逆算した元のサイズ
	const originalSizeKB = Math.floor(getOriginalSizeForBase64Target(targetSizeKB * 1024) / 1024);
	const originalContent = `This is a test file for upload. Target encoded size: ${targetSizeKB} KB.`;
	// 適切なサイズのファイルを生成
	await fs.writeFile(filePath, Buffer.alloc(originalSizeKB * 1024, originalContent));
	const fileSizeInBytes = originalSizeKB * 1024;
	logger.info(`[GLOBAL_INFO] Created temp file: ${filePath} (${fileSizeInBytes / 1024} KB)`);

	// 2. 環境情報の取得
	const { chains: allChains, rpcEndpoints, restEndpoints: apiEndpoints } = await getChainResources();
	const dataChains = allChains.filter(c => c.type === 'datachain');
	const metaChain = allChains.find(c => c.type === 'metachain');
	if (!metaChain) { throw new Error('Metachain not found in Kubernetes resources.'); }
	const numDataChains = dataChains.length;
	if (numDataChains === 0) { throw new Error('No Datachains found in Kubernetes resources.'); }

	// 3. チャンクサイズの決定
	let chunkSize = Math.ceil(fileSizeInBytes / numDataChains);
	const blockSizeLimitBytes = CONFIG.BLOCK_SIZE_LIMIT_MB * 1024 * 1024;
	if (chunkSize > blockSizeLimitBytes) {
		chunkSize = blockSizeLimitBytes;
		logger.warn(`[CHUNK_SIZE] Calculated chunk size exceeds block limit. Capping at ${chunkSize / (1024 * 1024)} MB.`);
	}
	logger.info(`[GLOBAL_INFO] Chunk Size per chain: ${Math.round(chunkSize / 1024)} KB`);

	// 4. クライアントの初期化
	await chainManager.initializeClients(allChains, rpcEndpoints, apiEndpoints);

	return { filePath, fileSizeInBytes, dataChains, metaChain, chunkSize };
}

/**
 * ファイルをチャンクに分割し、チェーンごとのジョブキューに割り当てる
 */
async function createUploadJobs(filePath: string, chunkSize: number, dataChains: ChainInfo[]): Promise<{ jobsByChain: Map<string, UploadJob[]>, totalChunks: number }> {
	const jobsByChain = new Map<string, UploadJob[]>();
	dataChains.forEach(chain => jobsByChain.set(chain.name, []));

	let chunkCounter = 0;
	const uniqueSuffix = `file-${Date.now()}`;
	const numDataChains = dataChains.length;

	const fileStream = createReadStream(filePath, { highWaterMark: chunkSize });
	for await (const chunk of fileStream) {
		const chunkIndex = `${uniqueSuffix}-${chunkCounter}`;
		const targetChainName = dataChains[chunkCounter % numDataChains]!.name; // ラウンドロビン
		const job: UploadJob = { chunk: chunk as Buffer, index: chunkIndex, retries: 0 };
		jobsByChain.get(targetChainName)!.push(job);
		chunkCounter++;
	}

	logger.info(`[ALLOCATION] File split into ${chunkCounter} chunks.`);
	dataChains.forEach(chain => {
		logger.info(`[ALLOCATION] Chain ${chain.name} assigned ${jobsByChain.get(chain.name)!.length} chunks.`);
	});

	return { jobsByChain, totalChunks: chunkCounter };
}

/**
 * チャンクアップロード用のワーカーを起動し、並列処理を実行する
 */
async function executeUploadWorkers(chainManager: ChainManager, jobsByChain: Map<string, UploadJob[]>, dataChains: ChainInfo[], estimatedGas: number): Promise<{ index: string; chain: string; }[]> {
	const uploadedChunks: { index: string; chain: string; }[] = [];
	const numDataChains = dataChains.length;
	const multiBar = new cliProgress.MultiBar({
		clearOnComplete: false,
		hideCursor: true,
		format: '{chain} | {bar} | {percentage}% ({value}/{total}) | {eta}s ETA',
	}, cliProgress.Presets.shades_grey);

	const progressTracker = new Map<string, ChainProgress>();
	for (const chain of dataChains) {
		const jobsForChain = jobsByChain.get(chain.name)!;
		const totalForChain = jobsForChain.length;
		const newBar = multiBar.create(totalForChain, 0, { chain: chain.name });
		progressTracker.set(chain.name, { total: totalForChain, completed: 0, bar: newBar });
	}

	const worker = async (workerId: number) => {
		const targetChainName = dataChains[workerId]!.name;
		const chainProgress = progressTracker.get(targetChainName)!;
		const jobQueue = jobsByChain.get(targetChainName)!;

		logger.info(`[WORKER_START] Worker #${workerId} started, assigned to chain: ${targetChainName}`);

		while (jobQueue.length > 0) {
			const job = jobQueue.shift();
			if (!job) continue;

			try {
				await chainManager.uploadChunk(targetChainName, job.index, job.chunk, estimatedGas);
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
					jobQueue.unshift(job); // キューの先頭に戻して再試行
				} else {
					logger.error(`[CRITICAL_FAIL] Chunk ${job.index} failed after ${CONFIG.MAX_RETRIES} attempts on ${targetChainName}. Aborting worker.`);
					throw new Error(`Critical upload failure on chain ${targetChainName}.`);
				}
			}
		}
	};

	const workerPromises = [];
	for (let i = 0; i < numDataChains; i++) {
		workerPromises.push(worker(i));
	}

	try {
		await Promise.all(workerPromises);
	} finally {
		multiBar.stop();
	}

	return uploadedChunks;
}

/**
 * アップロード後の検証とクリーンアップ
 */
async function finalizeProcess(chainManager: ChainManager, uploadedChunks: { index: string; chain: string; }[], metaChain: ChainInfo, filePath: string, siteUrl: string) {
	// 1. マニフェストのアップロード
	const urlIndex = encodeURIComponent(siteUrl);
	uploadedChunks.sort((a, b) => parseInt(a.index.split('-').pop()!) - parseInt(b.index.split('-').pop()!));
	const manifest: Manifest = { filepath: path.basename(filePath), chunks: uploadedChunks, };
	const manifestString = JSON.stringify(manifest);
	logger.info('[MANIFEST] Uploading manifest to Metachain...');
	await chainManager.uploadManifest(metaChain.name, urlIndex, manifestString);
	logger.info('[MANIFEST] Upload complete.');

	// 2. 検証処理
	logger.info('[VERIFICATION] Waiting for 2 seconds for manifest to be indexed...');
	await new Promise(resolve => setTimeout(resolve, 2000));

	logger.info('[VERIFICATION] Starting verification process...');
	const manifestResponse = await chainManager.queryStoredManifest(metaChain.name, urlIndex);
	const downloadedManifest = JSON.parse(manifestResponse.stored_manifest.manifest) as Manifest;

	const downloadedChunksBuffers: Buffer[] = [];
	await Promise.all(downloadedManifest.chunks.map(async (chunkInfo, i) => {
		const chunkResponse = await chainManager.queryStoredChunk(chunkInfo.chain, chunkInfo.index);
		const chunkBuffer = Buffer.from(chunkResponse.stored_chunk.data, 'base64');
		downloadedChunksBuffers[i] = chunkBuffer;
	}));

	const reconstructedBuffer = Buffer.concat(downloadedChunksBuffers);
	const originalBuffer = await fs.readFile(filePath);

	if (Buffer.compare(originalBuffer, reconstructedBuffer) !== 0) {
		throw new Error('[VERIFICATION] Verification failed! Reconstructed file does not match the original.');
	}
	logger.info('[VERIFICATION] Successful! The downloaded file matches the original.');

	// 3. クリーンアップ
	await fs.unlink(filePath);
	logger.info(`[CLEANUP] Temporary file ${filePath} deleted.`);
	chainManager.closeAllConnections();
	logger.info('[CLEANUP] All WebSocket connections closed.');
}

/**
 * メインのアップロード処理
 */
async function main() {
	const siteUrl = `UploadTest-${Date.now()}`;
	const chainManager = new ChainManager();
	let filePath: string | null = null;
	let totalChunks: number = 0;
	const startTime = Date.now();

	try {
		// 1. 環境設定、ファイル作成、クライアント初期化
		const setup = await setupEnvironment(chainManager);
		filePath = setup.filePath;
		const { dataChains, metaChain, chunkSize } = setup;

		// 2. チャンク分割とジョブの割り当て
		const { jobsByChain, totalChunks: chunksCount } = await createUploadJobs(setup.filePath, chunkSize, dataChains);
		totalChunks = chunksCount; // finallyブロックで使用するために保持

		// 3. ガス代のシミュレーション（最初のチャンクを使用）
		const firstChunkJob = jobsByChain.get(dataChains[0]!.name)?.[0];
		if (!firstChunkJob) { throw new Error('No chunks generated for upload.'); }
		const dataChainClient = chainManager.getClientInfo(dataChains[0]!.name);
		const dummyMsg = { typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk', value: { creator: dataChainClient.account.address, index: firstChunkJob.index, data: firstChunkJob.chunk }, };
		const estimatedGas = await dataChainClient.client.simulate(dataChainClient.account.address, [dummyMsg], 'Gas Estimation');
		logger.info(`[GAS_SIMULATE] Initial estimated gas for one chunk (simulate): ${estimatedGas}`);

		// 4. チャンクアップロード実行 (並列ワーカー)
		logger.info('[MAIN] Starting concurrent chunk uploads...');
		const uploadedChunks = await executeUploadWorkers(chainManager, jobsByChain, dataChains, estimatedGas);
		logger.info('[MAIN] All chunks successfully uploaded.');

		// 5. マニフェストアップロードと検証、クリーンアップ
		await finalizeProcess(chainManager, uploadedChunks, metaChain, setup.filePath, siteUrl);

	} catch (err) {
		logger.error('[MAIN] A fatal error occurred:', err);
		throw err;
	} finally {
		// パフォーマンス計測
		const endTime = Date.now();
		const totalUploadTimeMs = endTime - startTime;
		const totalUploadTimeSec = (totalUploadTimeMs / 1000).toFixed(2);
		const averageTimePerChunkMs = (totalChunks > 0 ? (totalUploadTimeMs / totalChunks) : 0).toFixed(2);
		console.log('\n--- 📊 Upload Performance ---');
		console.log(`Total Upload Time: ${totalUploadTimeSec} seconds`);
		console.log(`Average Time per Chunk: ${averageTimePerChunkMs} ms`);
		console.log('--------------------------\n');

		// クリーンアップ
		if (filePath) {
			// エラー時のファイル削除は、finalizeProcessに任せるか、別途エラー時にtry/catchで実行するのがより堅牢
			// ここでは一旦、finalizeProcessの実行が確実でない場合に備え、メインロジックのcatchで処理
		}
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