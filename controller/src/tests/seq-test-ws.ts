import { stringToPath } from '@cosmjs/crypto';
import { AccountData, DirectSecp256k1HdWallet, EncodeObject, GeneratedType, Registry } from '@cosmjs/proto-signing';
import { DeliverTxResponse, GasPrice, IndexedTx, SigningStargateClient, calculateFee } from '@cosmjs/stargate';
import { Tendermint37Client, WebsocketClient } from '@cosmjs/tendermint-rpc';
import * as k8s from '@kubernetes/client-node';
import cliProgress from 'cli-progress';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Reader, Writer } from 'protobufjs/minimal';
import winston from 'winston';
import Transport from 'winston-transport';
// 💡 修正点: TxRaw をインポート
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';

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
	DEFAULT_CHUNK_SIZE: 1 * 1024 * 1024,
	GAS_PRICE_STRING: '0.0000001uatom',
	GAS_MULTIPLIER: 1.5,
	HD_PATH: "m/44'/118'/0'/0/2",
	MAX_RETRIES: 3,
	RETRY_BACKOFF_MS: 500,
	// 💡 変更点: テスト量を少なくし、単一チェーンに集中
	DEFAULT_TEST_SIZE_KB: 500, // 500KBのテストファイル
	TARGET_CHAIN_NAME: 'data-0', // 💡 追加: ターゲットチェーンを固定
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
interface UploadJob { chunk: Buffer; index: string; retries: number; }
interface ChainProgress { total: number; completed: number; bar: cliProgress.SingleBar; }

// プロトコルバッファ型定義とレジストリ (MsgCreateStoredChunk のみ使用)
interface MsgCreateStoredChunk { creator: string; index: string; data: Uint8Array; }
const MsgCreateStoredChunkProto = { // 💡 修正: 名前の衝突を避けるためリネーム
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
const MsgCreateStoredManifestProto = { // 💡 修正: 名前の衝突を避けるためリネーム
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
	['/datachain.datastore.v1.MsgCreateStoredChunk', MsgCreateStoredChunkProto as GeneratedType], // 💡 修正: リネーム後の定数を使用
	['/metachain.metastore.v1.MsgCreateStoredManifest', MsgCreateStoredManifestProto as GeneratedType], // 💡 修正: リネーム後の定数を使用
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
				// コンソール出力も追加してリアルタイムの進捗を見やすくする
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
		// Console Transportのログを除外するために、レベルでフィルタリング
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
// 💻 III. KUBERNETES UTILITIES (TARGET_CHAIN_NAME のみを取得するように修正)
// =================================================================================================

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

/**
 * Kubernetesからターゲットチェーンのエンドポイントを取得する
 */
async function getChainResources(): Promise<{ chain: ChainInfo, rpcEndpoint: string, restEndpoint: string }> {
	const chainName = CONFIG.TARGET_CHAIN_NAME;
	const resPods = await k8sApi.listNamespacedPod({
		namespace: CONFIG.K8S_NAMESPACE,
		labelSelector: `app.kubernetes.io/instance=${chainName}`,
	});

	if (resPods.items.length === 0) {
		throw new Error(`Target chain pod ${chainName} not found in Kubernetes.`);
	}

	const chain: ChainInfo = { name: chainName, type: resPods.items[0]!.metadata!.labels!['app.kubernetes.io/component']! as any };

	let rpcEndpoint = '';
	let restEndpoint = '';
	const isLocal = process.env.NODE_ENV !== 'production';

	const resServices = await k8sApi.listNamespacedService({
		namespace: CONFIG.K8S_NAMESPACE,
		labelSelector: `app.kubernetes.io/instance=${chainName}`
	});

	const serviceName = `raidchain-${chain.name}-headless`;
	const service = resServices.items.find(s => s.metadata?.name === serviceName);

	if (isLocal) {
		const rpcPortInfo = service?.spec?.ports?.find(p => p.name === 'rpc');
		const apiPortInfo = service?.spec?.ports?.find(p => p.name === 'api');
		if (rpcPortInfo?.nodePort) { rpcEndpoint = `http://localhost:${rpcPortInfo.nodePort}`; }
		if (apiPortInfo?.nodePort) { restEndpoint = `http://localhost:${apiPortInfo.nodePort}`; }
	} else {
		rpcEndpoint = `http://raidchain-${chain.name}-0.raidchain-chain-headless.${CONFIG.K8S_NAMESPACE}.svc.cluster.local:26657`;
		restEndpoint = `http://raidchain-${chain.name}-0.raidchain-chain-headless.${CONFIG.K8S_NAMESPACE}.svc.cluster.local:1317`;
	}

	if (!rpcEndpoint || !restEndpoint) {
		throw new Error(`Failed to determine endpoints for chain ${chainName}. (Local mode: ${isLocal})`);
	}

	return { chain, rpcEndpoint, restEndpoint };
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
	public readonly gasPrice: GasPrice;

	constructor() {
		this.gasPrice = GasPrice.fromString(CONFIG.GAS_PRICE_STRING);
	}

	/**
	 * ターゲットチェーンのクライアントを初期化する
	 */
	public async initializeClient(chain: ChainInfo, rpcEndpoint: string, restEndpoint: string): Promise<void> {
		try {
			const mnemonic = await getCreatorMnemonic(chain.name);
			const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { hdPaths: [stringToPath(CONFIG.HD_PATH)] });
			const [account] = await wallet.getAccounts();
			if (!account) throw new Error(`Failed to get account from wallet for chain ${chain.name}`);

			const rpcUrl = rpcEndpoint.replace('http', 'ws');
			const wsClient = new WebsocketClient(rpcUrl, (err) => { if (err) { logger.warn(`[${chain.name}] WebSocket connection error: ${err.message}`); } });
			await wsClient.execute({ jsonrpc: "2.0", method: "status", id: 1, params: [] }); // 接続確認
			const tmClient = Tendermint37Client.create(wsClient);
			// 💡 変更点: createWithSigner を使用すると、ノンスの自動管理が可能
			const client = SigningStargateClient.createWithSigner(tmClient, wallet, { registry: customRegistry, gasPrice: this.gasPrice });

			this.chainClients.set(chain.name, { client, account, tmClient, wsClient, restEndpoint });
			logger.info(`[CLIENT_SETUP] Successful for chain: ${chain.name} (Address: ${account.address})`);
		} catch (e) {
			logger.error(`[CLIENT_SETUP] Failed to initialize client for chain ${chain.name}:`, e);
			throw e;
		}
	}

	public getClientInfo(chainName: string): ExtendedChainClients {
		const clientInfo = this.chainClients.get(chainName);
		if (!clientInfo) throw new Error(`Client not initialized for chain: ${chainName}`);
		return clientInfo;
	}

	/**
	 * チャンクをデータチェーンにアップロードする (連続送信)
	 * @returns Tx の配信レスポンス (ノンス情報を含む)
	 */
	public async uploadChunk(chainName: string, chunkIndex: string, chunkData: Buffer, gasWanted: number): Promise<DeliverTxResponse> {
		const { client, account } = this.getClientInfo(chainName);
		const msg = { typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk', value: { creator: account.address, index: chunkIndex, data: chunkData }, };

		const fee = calculateFee(gasWanted, this.gasPrice);

		logger.info(`[TX_PREP] Chunk ${chunkIndex} (Size: ${Math.round(chunkData.length / 1024)} KB). Gas Wanted: ${gasWanted}.`);

		// 💡 変更点: client.signAndBroadcast を使用するとノンスが自動で処理される
		return await client.signAndBroadcast(account.address, [msg], fee, `Sequential chunk ${chunkIndex}`);
	}

	// queryStoredManifest, queryStoredChunk, uploadManifest はテストから除外するため削除

	// 💡 新規追加: ノンスねじ込み方式で複数の独立したTxをブロードキャストし、完了を待つ
	/**
	 * 複数のメッセージを独立したトランザクションとしてノンスねじ込み方式で連続ブロードキャストし、
	 * すべてのTxがブロックに取り込まれるまで待機する。
	 * @param chainName ターゲットチェーン名
	 * @param messages ブロードキャストするメッセージの配列 (Txごと)
	 * @param estimatedGas 各Txに割り当てるガスの見積もり値
	 * @returns ブロックに取り込まれた全てのトランザクション結果 (IndexedTx)
	 */
	public async broadcastSequentialTxs(chainName: string, messages: EncodeObject[], estimatedGas: number): Promise<IndexedTx[]> {
		const { client, account } = this.getClientInfo(chainName);
		const gasWanted = Math.round(estimatedGas * CONFIG.GAS_MULTIPLIER);
		const fee = calculateFee(gasWanted, this.gasPrice);
		const totalTxs = messages.length;

		const accountInfo = await client.getAccount(account.address);
		if (!accountInfo) throw new Error(`Failed to get account info for ${account.address}`);

		let currentSequence = accountInfo.sequence;
		const accountNumber = accountInfo.accountNumber;
		const chainId = await client.getChainId();

		logger.info(`[SEQ_BROADCAST] Starting sequence: ${currentSequence}, Total Txs: ${totalTxs}.`);

		const txHashes: string[] = [];

		// 1. 署名と同期ブロードキャスト (ノンスねじ込み)
		for (let i = 0; i < totalTxs; i++) {
			const msg = messages[i]!;

			// 💡 署名: ノンス (sequence) を手動で指定し、署名する
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

			// 💡 ブロードキャスト: ブロックへの取り込みを待たずに送信 (ねじ込み)
			try {
				// broadcastTxSync はノードが Tx を受け入れたかだけを確認し、Txハッシュを即座に返す
				const resultHash = await client.broadcastTxSync(txRaw);
				txHashes.push(resultHash);

				logger.info(`[TX_SENT] Tx ${i} sent. Hash: ${resultHash.substring(0, 10)}... (Sequence: ${currentSequence})`);

			} catch (error) {
				logger.error(`[CRITICAL_FAIL] Failed to broadcast Tx ${i}. Error:`, error);
				throw new Error(`Broadcast failure: ${error}`);
			}

			currentSequence++; // 成功/失敗に関わらず、手動で次のノンスに進める
		}

		// 2. 全Txがブロックに取り込まれるのを待機し、結果を確認する
		const inclusionPromises = txHashes.map(hash =>
			// 💡 新しいヘルパー関数を使用して、Txが見つかるまでポーリングさせる
			waitForTxInclusion(client, hash)
		);

		// すべての Tx がブロックに取り込まれるのを待機 (並列処理)
		const results = await Promise.all(inclusionPromises);

		for (const result of results) {
			if (result.code !== 0) {
				// Tx がブロックに取り込まれたが、実行が失敗したケース
				logger.error(`[TX_FAILED_DELIVER] Tx with hash ${result.hash.substring(0, 10)}... failed execution. Log: ${result.rawLog}`);
				throw new Error(`Tx execution failed on chain for hash ${result.hash}`);
			}
		}

		logger.info(`[SEQ_BROADCAST] All ${totalTxs} transactions successfully committed to block.`);
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
	chunkSize: number,
	chainInfo: ChainInfo
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
	const originalContent = `This is a test file for sequential upload.`;
	// 💡 修正: Buffer.allocでファイルサイズを確保
	await fs.writeFile(filePath, Buffer.alloc(fileSizeInBytes, originalContent));
	logger.info(`[GLOBAL_INFO] Created temp file: ${filePath} (${fileSizeInBytes / 1024} KB)`);

	// 2. 環境情報の取得
	const { chain: chainInfo, rpcEndpoint, restEndpoint } = await getChainResources();
	const chunkSize = CONFIG.DEFAULT_CHUNK_SIZE;
	logger.info(`[GLOBAL_INFO] Chunk Size: ${Math.round(chunkSize / 1024)} KB`);

	// 3. クライアントの初期化
	await chainManager.initializeClient(chainInfo, rpcEndpoint, restEndpoint);

	return { filePath, chunkSize, chainInfo };
}

/**
 * ファイルをチャンクに分割し、ジョブとして準備する
 */
async function createUploadJobs(filePath: string, chunkSize: number): Promise<UploadJob[]> {
	const jobQueue: UploadJob[] = [];
	let chunkCounter = 0;
	const uniqueSuffix = `seq-test-${Date.now()}`;

	const fileStream = createReadStream(filePath, { highWaterMark: chunkSize });
	for await (const chunk of fileStream) {
		const chunkIndex = `${uniqueSuffix}-${chunkCounter}`;
		const job: UploadJob = { chunk: chunk as Buffer, index: chunkIndex, retries: 0 };
		jobQueue.push(job);
		chunkCounter++;
	}

	logger.info(`[ALLOCATION] File split into ${chunkCounter} sequential chunks.`);
	return jobQueue;
}

// 💡 修正 1: Txがブロックに取り込まれるのを待つ関数
async function waitForTxInclusion(client: SigningStargateClient, hash: string): Promise<IndexedTx> {
	const MAX_POLLING_ATTEMPTS = 40;
	const POLLING_INTERVAL_MS = 2000; // 2秒間隔

	for (let i = 0; i < MAX_POLLING_ATTEMPTS; i++) {
		// getTx は DeliverTxResponse | null を返す
		const result = await client.getTx(hash);

		if (result) {
			// Txがブロックに取り込まれたことを確認
			// 注意: この関数は Tx が見つかったことだけを保証し、実行結果 (code=0) のチェックは呼び出し元で行うことが多い
			// ただし、このスクリプトでは、実行失敗を早期に検出するため、ここで code=0 のチェックを行う
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

/**
 * チャンクを連続でアップロードする
 */
async function executeSequentialUpload(chainManager: ChainManager, jobQueue: UploadJob[], estimatedGas: number): Promise<void> {
	const chainName = CONFIG.TARGET_CHAIN_NAME;
	const { account } = chainManager.getClientInfo(chainName);
	const totalChunks = jobQueue.length;

	// チャンクジョブからメッセージの配列を作成
	const messages: EncodeObject[] = jobQueue.map(job => ({
		typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk',
		value: { creator: account.address, index: job.index, data: job.chunk },
	}));

	const singleBar = new cliProgress.SingleBar({
		clearOnComplete: false,
		hideCursor: true,
		format: '{chain} | {bar} | {percentage}% ({value}/{total}) | {eta}s ETA | Status: {status}',
	}, cliProgress.Presets.shades_grey);

	singleBar.start(totalChunks, 0, { chain: chainName, status: 'Signing & Broadcasting' });

	// 💡 変更点: 新しく作成した broadcastSequentialTxs を呼び出す
	try {
		const results = await chainManager.broadcastSequentialTxs(chainName, messages, estimatedGas);
		singleBar.update(totalChunks, { status: `Confirmed up to block ${results[results.length - 1]?.height}` });
	} catch (e) {
		singleBar.update(totalChunks, { status: 'FAILED' });
		throw e;
	} finally {
		singleBar.stop();
	}

	logger.info('[MAIN] All sequential chunks successfully uploaded and confirmed.');
}

/**
 * メインの連続アップロード処理
 */
async function main() {
	const chainManager = new ChainManager();
	let filePath: string | null = null;
	let totalChunks: number = 0;
	const startTime = Date.now();

	try {
		// 1. 環境設定、ファイル作成、クライアント初期化
		const { filePath: fp, chunkSize, chainInfo } = await setupEnvironment(chainManager);
		filePath = fp;

		// 2. チャンク分割とジョブの準備
		const jobQueue = await createUploadJobs(filePath, chunkSize);
		totalChunks = jobQueue.length;

		// 3. ガス代のシミュレーション（最初のチャンクを使用）
		const firstChunkJob = jobQueue[0];
		if (!firstChunkJob) { throw new Error('No chunks generated for upload.'); }
		const dataChainClient = chainManager.getClientInfo(chainInfo.name);
		const dummyMsg = { typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk', value: { creator: dataChainClient.account.address, index: firstChunkJob.index, data: firstChunkJob.chunk }, };
		// 💡 注意: シミュレーションは Base64 エンコード前のサイズで行われる
		const estimatedGas = await dataChainClient.client.simulate(dataChainClient.account.address, [dummyMsg], 'Gas Estimation');
		logger.info(`[GAS_SIMULATE] Initial estimated gas for one chunk: ${estimatedGas}. Gas Wanted: ${Math.round(estimatedGas * CONFIG.GAS_MULTIPLIER)}.`);

		// 4. チャンクアップロード実行 (連続送信)
		logger.info('[MAIN] Starting sequential chunk uploads to single chain...');
		// 💡 変更点: executeSequentialUpload の内部で新関数が使われるようになったため、この関数はシンプルに呼び出すだけ
		await executeSequentialUpload(chainManager, jobQueue, estimatedGas);

		// 5. クリーンアップ
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
		console.log('\n--- 📊 Sequential Upload Performance ---');
		console.log(`Total Chunks: ${totalChunks}`);
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