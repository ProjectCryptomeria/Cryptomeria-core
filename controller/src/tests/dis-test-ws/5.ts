import { stringToPath } from '@cosmjs/crypto';
import { AccountData, DirectSecp256k1HdWallet, EncodeObject, GeneratedType, Registry, } from '@cosmjs/proto-signing';
import { calculateFee, GasPrice, SigningStargateClient } from '@cosmjs/stargate';
import { Comet38Client, WebsocketClient } from '@cosmjs/tendermint-rpc';
import { TxEvent } from "@cosmjs/tendermint-rpc/build/comet38/responses";
import { sleep } from "@cosmjs/utils";
import * as k8s from '@kubernetes/client-node';
import cliProgress from 'cli-progress';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import * as fs from 'fs'; // fs.stat のために使用
import * as path from 'path';
import { Reader, Writer } from 'protobufjs/minimal';
import winston from 'winston';
import Transport from 'winston-transport';
import { Listener, Stream } from "xstream";

// =================================================================================================
// 📚 I. CONFIG & TYPE DEFINITIONS
// =================================================================================================

/**
 * すべての設定値をここに集約
 */
const CONFIG = {
	K8S_NAMESPACE: 'raidchain',
	SECRET_NAME: 'raidchain-mnemonics',
	BLOCK_SIZE_LIMIT_MB: 20,
	DEFAULT_CHUNK_SIZE: 512 * 1024,

	// --- ブロック充填率 & パイプライン設定 ---
	EFFECTIVE_BLOCK_SIZE_RATIO: 0.5, // 1ブロックあたりの目標充填率 (例: 0.25 = 25%) ★ タイムアウト対策で 0.5 から縮小
	PIPELINE_MAX_PENDING_BATCHES: 1,  // 同時に完了を待つバッチの最大数

	// --- Mempool 監視設定 (バイトサイズベース) ---
	MEMPOOL_BYTES_LIMIT: 5 * 1024 * 1024, // Mempoolの合計バイトサイズ上限 (例: 5MB)
	MEMPOOL_CHECK_INTERVAL_MS: 5000,     // Mempoolチェック間隔 (ミリ秒)

	// --- その他設定 ---
	TX_OVERHEAD_RATIO: 1.1,             // TXサイズの見積もり用オーバーヘッド係数
	RECONNECT_DELAY_MS: 3000,           // WebSocket再接続試行間隔
	WEBSOCKET_CONNECT_TIMEOUT_MS: 5000, // WebSocket接続タイムアウト
	GAS_PRICE_STRING: '0.0000001uatom', // ガス価格
	GAS_MULTIPLIER: 1.5,                // ガス見積もりに対する乗数
	HD_PATH: "m/44'/118'/0'/0/2",        // HDウォレットパス
	RETRY_BACKOFF_MS: 500,              // リトライ時の基本待機時間
	DEFAULT_TEST_SIZE_KB: 100 * 1024,   // デフォルトのテストデータサイズ (エンコード後KB)
	TX_EVENT_TIMEOUT_MS: 120000,        // Txイベントの待機タイムアウト (ミリ秒)
};

// 型定義
interface TransformableInfo extends winston.Logform.TransformableInfo { level: string; message: string;[key: string]: any; }
interface ChainInfo { name: string; type: 'datachain' | 'metachain'; }
interface ChainEndpoints { [key: string]: string; }
interface ExtendedChainClients { client: SigningStargateClient; account: AccountData; tmClient: Comet38Client; wsClient: WebsocketClient; restEndpoint: string; }
interface MegaChunkJob { buffer: Buffer; indexPrefix: string; chainName: string; retries: number; }

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
	// decode は実際には使わないので簡略化
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
	// decode は実際には使わないので簡略化
	decode(input: Reader | Uint8Array, length?: number): MsgCreateStoredManifest { const reader = input instanceof Reader ? input : new Reader(input); return { creator: "", url: "", manifest: "" }; }
};
const customRegistry = new Registry([
	['/datachain.datastore.v1.MsgCreateStoredChunk', MsgCreateStoredChunkProto as GeneratedType],
	['/metachain.metastore.v1.MsgCreateStoredManifest', MsgCreateStoredManifestProto as GeneratedType],
]);

// =================================================================================================
// 📝 II. LOGGER UTILITIES (CLASS-BASED) - 変更なし (ログ分離 修正済み)
// =================================================================================================

class LoggerUtil {
	private readonly logBuffer: TransformableInfo[] = [];
	private readonly logger: winston.Logger;
	private readonly logFilePath: string; // ★ エラーログ用ファイルパス
	private readonly allLogFilePath: string; // ★ 全ログ用ファイルパス

	constructor() {
		const scriptFileName = path.basename(process.argv[1]!).replace(path.extname(process.argv[1]!), '');
		// ログディレクトリが存在しない場合があるため確認・作成
		const logDir = path.join(process.cwd(), "src/tests/");
		try {
			if (!fs.existsSync(logDir)) {
				fs.mkdirSync(logDir, { recursive: true });
			}
		} catch (e) {
			console.error(`Error creating log directory ${logDir}:`, e);
		}
		this.logFilePath = path.join(logDir, `${scriptFileName}.error.log`); // ★ エラーログのパス
		this.allLogFilePath = path.join(logDir, `${scriptFileName}.all.log`); // ★ 全ログのパス

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
			level: 'debug', // ★ ファイルには debug レベルから書き込む
			format: winston.format.combine(
				winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
				winston.format.printf(info => `[${info.timestamp}] [${info.level.toUpperCase()}] - ${info.message} ${info.stack ? '\n' + info.stack : ''}`)
			),
			transports: [
				// 1. バッファ (最後のエラーサマリー用)
				new LogBufferTransport(this.logBuffer),
				// 2. リアルタイム全ログファイル
				new winston.transports.File({
					filename: this.allLogFilePath,
					format: winston.format.combine(
						winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
						winston.format.printf(info => `[${info.timestamp}] [${info.level.toUpperCase()}] - ${info.message} ${info.stack ? '\n' + info.stack : ''}`)
					),
					level: 'debug', // debugレベル以上の全ログを書き込む
					options: { flags: 'w' } // 実行のたびに上書き
				})
				// 3. コンソールトランスポートは削除 (プログレスバーとの競合回避)
			],
		});

		// 起動時に全ログファイルの場所を標準エラー出力に通知
		console.error(`[LOGGER] ログはファイルに出力されます: ${this.allLogFilePath}`);
	}

	public getLogger(): winston.Logger {
		return this.logger;
	}

	public async flushLogs() {
		if (this.logBuffer.length === 0) return;
		// ディレクトリ存在確認を追加
		const logDir = path.dirname(this.logFilePath);
		try {
			fs.mkdirSync(logDir, { recursive: true });
		} catch (e) {
			console.error(`Error ensuring log directory ${logDir} exists:`, e);
		}
		const logContent = this.logBuffer
			.map(info => {
				const transformed = this.logger.format.transform(info, {});
				// ログレベルがinfoでないメッセージのみファイルに書き込む (エラー等)
				return transformed && (transformed as any).message && info.level !== 'info' ? (transformed as any).message : '';
			})
			.filter(line => line.length > 0)
			.join('\n');

		// ★ エラーログファイルへの書き込み
		if (logContent.length > 0) { // エラーがある場合のみ書き込む
			try {
				// this.logFilePath は .error.log になっている
				fs.writeFileSync(this.logFilePath, logContent + '\n', { flag: 'w' });
				// 標準エラー出力に、エラーログファイルの場所を通知
				console.error(`\n🚨 エラーログをファイルに書き込みました: ${this.logFilePath}`);
			} catch (e) {
				console.error('ERROR: Failed to write error logs to file.', e);
			}
		}
	}
}

const loggerUtil = new LoggerUtil();
const logger = loggerUtil.getLogger();

// =================================================================================================
// 💻 III. KUBERNETES UTILITIES - 変更なし
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
	// Podラベルからチェーン名とタイプを取得
	const chains: ChainInfo[] = resPods.items.map(pod => ({
		name: pod.metadata!.labels!['app.kubernetes.io/instance']!,
		type: pod.metadata!.labels!['app.kubernetes.io/component']! as any,
	}));
	const rpcEndpoints: ChainEndpoints = {};
	const restEndpoints: ChainEndpoints = {};
	const isLocal = process.env.NODE_ENV !== 'production'; // ローカル開発環境かどうかの判定

	// Service情報を取得してエンドポイントを構築
	const resServices = await k8sApi.listNamespacedService({
		namespace: CONFIG.K8S_NAMESPACE,
		labelSelector: "app.kubernetes.io/category=chain" // チェーン関連のServiceを絞り込み
	});

	for (const chain of chains) {
		const serviceName = `raidchain-${chain.name}-headless`; // Headless Service名
		const service = resServices.items.find(s => s.metadata?.name === serviceName);
		if (isLocal) { // ローカルの場合 (NodePortを想定)
			const rpcPortInfo = service?.spec?.ports?.find(p => p.name === 'rpc');
			const apiPortInfo = service?.spec?.ports?.find(p => p.name === 'api');
			if (rpcPortInfo?.nodePort) { rpcEndpoints[chain.name] = `http://localhost:${rpcPortInfo.nodePort}`; }
			if (apiPortInfo?.nodePort) { restEndpoints[chain.name] = `http://localhost:${apiPortInfo.nodePort}`; }
		} else { // クラスター内部の場合 (ClusterIP/Headless Service FQDN)
			const podHostName = `raidchain-${chain.name}-0`; // StatefulSetのPod名 (例: raidchain-data-0-0)
			const headlessServiceName = `raidchain-chain-headless`; // values.yaml等で定義された共通のHeadless Service名
			rpcEndpoints[chain.name] = `http://${podHostName}.${headlessServiceName}.${CONFIG.K8S_NAMESPACE}.svc.cluster.local:26657`;
			restEndpoints[chain.name] = `http://${podHostName}.${headlessServiceName}.${CONFIG.K8S_NAMESPACE}.svc.cluster.local:1317`;
		}
		// エンドポイントが見つからない場合はエラーログ
		if (!rpcEndpoints[chain.name]) logger.warn(`RPC endpoint not found for ${chain.name}`);
		if (!restEndpoints[chain.name]) logger.warn(`REST endpoint not found for ${chain.name}`);
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
	const encodedMnemonic = res.data?.[`${chainName}.mnemonic`]; // Secret内のキー (例: data-0.mnemonic)
	if (!encodedMnemonic) throw new Error(`Secret ${CONFIG.SECRET_NAME} does not contain mnemonic for ${chainName}.`);
	// Base64デコードして返す
	return Buffer.from(encodedMnemonic, 'base64').toString('utf-8');
}

// =================================================================================================
// 🚀 IV. CHAIN CLIENT & TRANSACTION MANAGEMENT (★ 大幅修正)
// =================================================================================================

// ---------------------------------------------------------------------------------
// ★ 新設: TxEventSubscriber クラス
// ワーカーごとに1つの購読を維持し、バッチ待機を管理する
// ---------------------------------------------------------------------------------

/**
 * 1つのWebSocket購読を維持し、複数のバッチ待機処理を管理するクラス
 */
class TxEventSubscriber {
	private readonly tmClient: Comet38Client;
	private readonly bar: cliProgress.SingleBar;
	private readonly chainName: string; // ログ用

	private stream: Stream<TxEvent> | null = null;
	private listener: Listener<TxEvent> | null = null;
	private isSubscribed = false;

	// 待機中のジョブを管理する (Key: TxHash (Uppercase))
	private pendingJobs = new Map<string, {
		jobInfo: BatchWaitJob;
	}>();

	// 待機中のバッチジョブ (Promise) を管理する
	private activeJobs = new Set<BatchWaitJob>();

	constructor(tmClient: Comet38Client, bar: cliProgress.SingleBar, chainName: string) {
		this.tmClient = tmClient;
		this.bar = bar;
		this.chainName = chainName;
	}

	/**
	 * イベントストリームの購読を開始し、共有リスナーをアタッチする
	 */
	public async start(): Promise<void> {
		if (this.isSubscribed) return;

		const query = `tm.event = 'Tx'`;
		this.stream = this.tmClient.subscribeTx(query) as Stream<TxEvent>;

		this.listener = {
			next: (event: TxEvent) => {
				this.onEvent(event);
			},
			error: (err: any) => {
				logger.error(`[${this.chainName}] [EVENT_ERROR] Critical error in Tx subscription stream:`, err);
				// すべての待機中ジョブをエラーで強制終了させる
				this.activeJobs.forEach(job => {
					job.masterReject(new Error(`Tx subscription stream error: ${err.message}`));
				});
				this.cleanup(); // リスナーをクリーンアップ
			},
			complete: () => {
				logger.warn(`[${this.chainName}] [EVENT_COMPLETE] Tx subscription stream completed unexpectedly.`);
				// リスナーが止まったので、開いているジョブがあればタイムアウトを待たずに終了させる
				this.activeJobs.forEach(job => {
					job.masterResolve(job.confirmationStatus); // 現在の状態で完了させる
				});
				this.cleanup();
			},
		};

		this.stream.addListener(this.listener);
		this.isSubscribed = true;
		logger.debug(`[${this.chainName}] [EVENT_SUB] Subscribed to all Tx events.`);
	}

	/**
	 * 購読を停止し、リスナーを解除する
	 */
	public stop(): void {
		this.cleanup();
	}

	/**
	 * 内部リスナー: イベントを処理し、該当する待機ジョブに振り分ける
	 */
	private onEvent(event: TxEvent): void {
		const receivedHash = Buffer.from(event.hash).toString("hex").toUpperCase();

		const pending = this.pendingJobs.get(receivedHash);

		// 該当する待機ジョブがなければ無視
		if (!pending) {
			// logger.debug(`[${this.chainName}] [EVENT_RECV] Received event for unknown hash: ${receivedHash.substring(0, 10)}...`);
			return;
		}

		const job = pending.jobInfo;

		// すでに確認済みの場合は重複ログ（デバッグレベル）
		if (job.confirmationStatus.get(receivedHash)?.height) {
			logger.debug(`[${this.chainName}] [EVENT_RECV] Received duplicate confirmation for Tx ${receivedHash.substring(0, 10)}...`);
			return;
		}

		// ---------------------------------
		// 該当ジョブのステータスを更新
		// ---------------------------------
		const success = event.result.code === 0;
		const height = event.height;
		logger.debug(`[${this.chainName}] [EVENT_RECV] Tx ${receivedHash.substring(0, 10)}... confirmed in block ${height}. Success: ${success}`);

		// 1. バッチの結果Mapを更新
		job.confirmationStatus.set(receivedHash, { success, height });
		// 2. このバッチで確認済みのカウントを増やす
		job.confirmedCountInBatch++;
		// 3. 待機中リストから削除
		this.pendingJobs.delete(receivedHash);

		// 4. プログレスバー更新
		const totalCompleted = job.completedTxOffset + job.confirmedCountInBatch;
		const elapsedMs = Date.now() - job.batchStartTime;
		const txPerSec = (job.confirmedCountInBatch * 1000 / Math.max(elapsedMs, 1)).toFixed(2);
		job.bar.update(totalCompleted, {
			height: height,
			tx_per_sec: txPerSec,
			status: `Confirming (${job.confirmedCountInBatch}/${job.totalTxInBatch})`
		});

		// 5. このバッチが完了したかチェック
		if (job.confirmedCountInBatch === job.expectedConfirmations) {
			logger.info(`[${this.chainName}] [EVENT_WAIT] All ${job.confirmedCountInBatch} expected transactions confirmed for this batch.`);
			job.cleanupTimeout(); // タイムアウトをクリア
			this.activeJobs.delete(job); // アクティブジョブから削除
			job.masterResolve(job.confirmationStatus); // このバッチのPromiseを解決
		}
	}

	/**
	 * クリーンアップ処理
	 */
	private cleanup(): void {
		if (this.stream && this.listener) {
			try {
				this.stream.removeListener(this.listener);
				logger.debug(`[${this.chainName}] [EVENT_CLEANUP] Cleaned up the listener.`);
			} catch (e) {
				logger.warn(`[${this.chainName}] Error removing listener (ignoring):`, e);
			}
		}
		this.stream = null;
		this.listener = null;
		this.isSubscribed = false;
		// 念のため保留中のジョブもクリア
		this.pendingJobs.clear();
		this.activeJobs.clear();
	}

	/**
	 * 指定されたTxハッシュリストの完了を待機する (Promiseを返す)
	 * (旧 waitForTxInclusionWithEvents の役割)
	 */
	public waitForTxs(
		targetHashes: string[],
		completedTxOffset: number,
		totalTxInBatch: number // バッチ内の総Tx数
	): Promise<Map<string, { success: boolean; height: number | undefined }>> {

		// このバッチ待機ジョブの全体を管理するPromise
		return new Promise((resolve, reject) => {

			const confirmationStatus = new Map<string, { success: boolean; height: number | undefined }>();
			const targetHashSet = new Set<string>();

			targetHashes.forEach(hash => {
				if (hash.startsWith("ERROR_BROADCASTING")) {
					confirmationStatus.set(hash, { success: false, height: undefined });
				} else {
					confirmationStatus.set(hash, { success: false, height: undefined }); // 初期値
					targetHashSet.add(hash.toUpperCase());
				}
			});

			const expectedConfirmations = targetHashSet.size;

			// 監視対象が0（ブロードキャスト失敗のみ）なら即完了
			if (expectedConfirmations === 0) {
				logger.info(`[${this.chainName}] [EVENT_WAIT] No valid transactions to wait for in this batch.`);
				resolve(confirmationStatus);
				return;
			}

			let timeoutId: NodeJS.Timeout | null = null;

			// バッチ待機ジョブの情報を生成
			const job: BatchWaitJob = {
				confirmationStatus,
				expectedConfirmations,
				confirmedCountInBatch: 0,
				totalTxInBatch,
				batchStartTime: Date.now(),
				bar: this.bar,
				completedTxOffset,
				masterResolve: resolve,
				masterReject: reject,
				cleanupTimeout: () => {
					if (timeoutId) clearTimeout(timeoutId);
				}
			};

			// タイムアウト処理
			timeoutId = setTimeout(() => {
				const unconfirmed = Array.from(confirmationStatus.entries())
					.filter(([hash, status]) => targetHashSet.has(hash.toUpperCase()) && !status.height)
					.map(([hash, _]) => hash.substring(0, 10) + "...");
				logger.error(`[${this.chainName}] [EVENT_WAIT] Timeout (${CONFIG.TX_EVENT_TIMEOUT_MS / 1000}s) waiting for Tx events. ${job.confirmedCountInBatch}/${expectedConfirmations} confirmed.`);
				logger.error(` Unconfirmed: ${unconfirmed.join(', ')}`);

				// タイムアウト時は、保留中のハッシュをリストから削除
				targetHashSet.forEach(hash => {
					if (!confirmationStatus.get(hash)?.height) {
						this.pendingJobs.delete(hash);
					}
				});

				this.activeJobs.delete(job); // アクティブジョブから削除
				resolve(confirmationStatus); // タイムアウト時は Map をそのまま返す
			}, CONFIG.TX_EVENT_TIMEOUT_MS);

			// このジョブをアクティブリストに追加
			this.activeJobs.add(job);

			// 待機対象の全ハッシュを、共有の pendingJobs Map に登録
			targetHashSet.forEach(hash => {
				this.pendingJobs.set(hash, { jobInfo: job });
			});

			logger.debug(`[${this.chainName}] [EVENT_WAIT] Waiting for ${expectedConfirmations} TXs for this batch...`);

		}); // return new Promise
	}
}

/**
 * TxEventSubscriber 内部でバッチ待機情報を管理するための型
 */
interface BatchWaitJob {
	confirmationStatus: Map<string, { success: boolean; height: number | undefined }>;
	expectedConfirmations: number;
	confirmedCountInBatch: number;
	totalTxInBatch: number;
	batchStartTime: number;
	bar: cliProgress.SingleBar;
	completedTxOffset: number;
	masterResolve: (value: Map<string, { success: boolean; height: number | undefined }>) => void;
	masterReject: (reason?: any) => void;
	cleanupTimeout: () => void;
}


// ---------------------------------------------------------------------------------
// ChainManager クラス (★ waitForBatchInclusionWithEvents メソッドを削除)
// ---------------------------------------------------------------------------------

/**
 * Cosmos SDKチェーンとのやり取りを管理するクラス
 */
class ChainManager {
	private readonly chainClients = new Map<string, ExtendedChainClients>();
	public readonly gasPrice: GasPrice;

	private allChains: ChainInfo[] = [];
	private rpcEndpoints: ChainEndpoints = {};
	private restEndpoints: ChainEndpoints = {};

	constructor() {
		this.gasPrice = GasPrice.fromString(CONFIG.GAS_PRICE_STRING);
	}

	/**
	 * 内部メソッド (k8sリソースを使用) - 変更なし
	 */
	private async setupSingleClient(chain: ChainInfo, rpcEndpoints: ChainEndpoints, restEndpoints: ChainEndpoints): Promise<void> {
		const chainName = chain.name;
		try {
			const mnemonic = await getCreatorMnemonic(chainName);
			const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { hdPaths: [stringToPath(CONFIG.HD_PATH)] });
			const [account] = await wallet.getAccounts();
			if (!account) throw new Error(`Failed to get account from wallet for chain ${chainName}`);

			const rpcUrl = rpcEndpoints[chainName]!.replace('http', 'ws'); // WebSocket URL に変換
			const wsClient = new WebsocketClient(rpcUrl, (err) => { // エラーハンドラを設定
				if (err) { logger.warn(`[${chainName}] WebSocket connection error: ${err.message}. Will attempt reconnect on next operation.`); }
				// 必要であればここで再接続処理をトリガーすることも可能
			});

			// 接続確認: `execute` を使って status を取得し、タイムアウトを設定
			const connectPromise = wsClient.execute({ jsonrpc: "2.0", method: "status", id: `connect-${Date.now()}`, params: {} });
			const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("WebSocket connection timed out")), CONFIG.WEBSOCKET_CONNECT_TIMEOUT_MS));
			await Promise.race([connectPromise, timeoutPromise]);
			logger.debug(`[${chainName}] WebSocket connected via status check.`);

			// Tendermint37Client を WebSocketClient から作成
			const tmClient = Comet38Client.create(wsClient);
			// SigningStargateClient を Tendermint37Client から作成
			const client = SigningStargateClient.createWithSigner(tmClient, wallet, { registry: customRegistry, gasPrice: this.gasPrice });

			// クライアント情報を Map に保存
			this.chainClients.set(chainName, { client, account, tmClient, wsClient, restEndpoint: restEndpoints[chainName]! });
			logger.info(`[CLIENT_SETUP] Successful for chain: ${chainName} (Address: ${account.address})`);
		} catch (e) {
			logger.error(`[CLIENT_SETUP] Failed to initialize client for chain ${chainName}:`, e);
			// 失敗した場合、wsClient が存在すれば切断を試みる
			const existingClient = this.chainClients.get(chainName);
			if (existingClient?.wsClient) {
				try { existingClient.wsClient.disconnect(); } catch { }
			}
			this.chainClients.delete(chainName); // 失敗したクライアント情報は削除
			throw e; // エラーを再スロー
		}
	}

	/**
	 * すべてのチェーンのクライアントを初期化する - 変更なし
	 */
	public async initializeClients(allChains: ChainInfo[], rpcEndpoints: ChainEndpoints, restEndpoints: ChainEndpoints): Promise<void> {
		this.allChains = allChains;
		this.rpcEndpoints = rpcEndpoints;
		this.restEndpoints = restEndpoints;

		// 各チェーンに対して setupSingleClient を並列実行
		const initPromises = allChains.map(chain =>
			this.setupSingleClient(chain, rpcEndpoints, restEndpoints)
				.catch(e => logger.error(`[INIT_FAIL] Skipping client for ${chain.name} due to error.`)) // 個別エラーはログ出力のみ
		);
		await Promise.allSettled(initPromises); // 全ての初期化試行完了を待つ

		// 少なくとも1つの datachain クライアントが初期化されているか確認
		const dataChainNames = allChains.filter(c => c.type === 'datachain').map(c => c.name);
		const initializedDataChains = dataChainNames.filter(name => this.chainClients.has(name));
		if (initializedDataChains.length === 0 && dataChainNames.length > 0) {
			throw new Error("Failed to initialize any datachain clients.");
		}
		logger.info(`[INIT_COMPLETE] Initialized clients for: ${Array.from(this.chainClients.keys()).join(', ')}`);
	}

	/**
	 * 指定されたチェーンのクライアントを再接続する (k8sリソース情報を使用) - 変更なし
	 */
	public async reconnectClient(chainName: string): Promise<void> {
		logger.warn(`[${chainName}] Attempting to reconnect client...`);

		// 古いクライアント情報の取得と切断
		const oldClientInfo = this.chainClients.get(chainName);
		if (oldClientInfo) {
			try {
				oldClientInfo.wsClient.disconnect();
				// Tendermint37Client には disconnect メソッドがない場合があるため try-catch
				try { (oldClientInfo.tmClient as any)?.disconnect(); } catch { }
			} catch (e) {
				logger.warn(`[${chainName}] Error during old client disconnection (ignoring):`, e);
			}
		}
		this.chainClients.delete(chainName); // 古い情報を削除

		// チェーン情報を取得
		const chainInfo = this.allChains.find(c => c.name === chainName);
		if (!chainInfo) {
			throw new Error(`[${chainName}] Cannot reconnect: ChainInfo not found.`);
		}

		// 再度セットアップを実行
		await this.setupSingleClient(chainInfo, this.rpcEndpoints, this.restEndpoints);
		logger.info(`[${chainName}] Reconnection attempt finished.`);
	}

	// getClientInfo (変更なし)
	public getClientInfo(chainName: string): ExtendedChainClients {
		const clientInfo = this.chainClients.get(chainName);
		if (!clientInfo) throw new Error(`Client not initialized for chain: ${chainName}`);
		return clientInfo;
	}

	// Mempool バイトサイズ取得メソッド (変更なし)
	/**
	 * Mempoolの未確認Tx合計バイトサイズを取得する
	 */
	public async getMempoolTotalBytes(chainName: string): Promise<number> {
		const { tmClient } = this.getClientInfo(chainName);
		try {
			// Tendermint37Client の numUnconfirmedTxs は totalBytes を含むオブジェクトを返す
			const result = await tmClient.numUnconfirmedTxs();
			const bytes = Number(result.totalBytes); // total_bytes を数値に変換
			return isNaN(bytes) ? 0 : bytes;
		} catch (error) {
			logger.warn(`[${chainName}] Failed to get mempool total_bytes:`, error);
			throw error; // エラーを再スローして waitForMempoolSpace で処理させる
		}
	}

	// ★ 削除: waitForBatchInclusionWithEvents メソッド
	// (TxEventSubscriber クラスがこの役割を担うため不要になった)


	/**
	 * 送信専用の関数 - 変更なし
	 */
	public async broadcastSequentialTxs(
		chainName: string,
		messages: EncodeObject[],
		estimatedGas: number,
		bar: cliProgress.SingleBar,
		completedTxOffset: number = 0, // バー表示のためのオフセット
		currentSequenceRef: { sequence: number } // 外部で管理されるシーキンス番号
	): Promise<string[]> {
		const { client, account } = this.getClientInfo(chainName);
		const gasWanted = Math.round(estimatedGas * CONFIG.GAS_MULTIPLIER);
		const fee = calculateFee(gasWanted, this.gasPrice);
		const totalTxsInBatch = messages.length;

		// アカウント情報取得（accountNumberのため）
		// 注意: シーキンスは外部の currentSequenceRef を使用
		const accountInfo = await client.getAccount(account.address);
		if (!accountInfo) throw new Error(`Failed to get account info for ${account.address} on ${chainName}`);
		const accountNumber = accountInfo.accountNumber;
		const chainId = await client.getChainId();

		const txHashes: string[] = [];
		logger.debug(`[${chainName}] Starting broadcast loop. Initial sequence: ${currentSequenceRef.sequence}`);

		for (let i = 0; i < totalTxsInBatch; i++) {
			const msg = messages[i]!;
			const sequence = currentSequenceRef.sequence; // 現在のシーキンスを使用

			// トランザクション署名
			const signedTx = await client.sign(
				account.address, [msg], fee,
				`Batch Tx ${i + 1}/${totalTxsInBatch} (Seq: ${sequence})`, // メモ
				{ accountNumber, sequence, chainId }
			);
			const txRaw = Uint8Array.from(TxRaw.encode(signedTx).finish());

			try {
				// 同期ブロードキャスト (Mempoolに追加されるまで待つ)
				const resultHash = await client.broadcastTxSync(txRaw);
				txHashes.push(resultHash);
				currentSequenceRef.sequence++; // 成功したらシーキンスをインクリメント
				logger.debug(` -> [${chainName}] Tx ${i + 1} sent. Hash: ${resultHash.substring(0, 10)}... (Seq: ${sequence})`);

				// プログレスバー更新 (送信状況を表示)
				bar.update(completedTxOffset, { status: `Broadcasting ${txHashes.length}/${totalTxsInBatch}` });

			} catch (error: any) {
				// ブロードキャスト失敗
				logger.error(`[CRITICAL_FAIL] Tx (Seq ${sequence}) failed to broadcast on ${chainName}. Error:`, error);
				// 失敗したTxのハッシュとしてエラーを示す文字列を入れる（イベント待機でスキップするため）
				txHashes.push(`ERROR_BROADCASTING_TX_${i + 1}_SEQ_${sequence}`);
				// ★ 重要: ブロードキャスト失敗時はシーキンスをインクリメントしない！
				// 次のリトライ時に同じシーキンス番号が再利用されるようにする
				// （ただし、現在のリトライロジックはシーキンス再取得を行うので、ここでのインクリメント有無は影響小）
				throw new Error(`Broadcast failure (Seq ${sequence}) on ${chainName}: ${error.message}`); // エラーをスローしてリトライをトリガー
			}
		}
		logger.debug(`[${chainName}] Finished broadcast loop. Final sequence: ${currentSequenceRef.sequence}`);
		return txHashes;
	}

	/**
	 * WebSocketクライアントをすべて切断する - 変更なし
	 */
	public closeAllConnections(): void {
		logger.info('[CLEANUP] Closing all WebSocket connections...');
		for (const [chainName, { wsClient, tmClient }] of this.chainClients.entries()) {
			try {
				wsClient.disconnect();
				// Tendermint37Client には disconnect メソッドがない場合がある
				try { (tmClient as any)?.disconnect(); } catch { }
				logger.debug(`[${chainName}] WebSocket connection closed.`);
			} catch (e) {
				logger.warn(`[${chainName}] Error closing connection (ignoring):`, e);
			}
		}
		this.chainClients.clear(); // Mapをクリア
	}
}

// =================================================================================================
// ⚙️ V. CORE BUSINESS LOGIC (MAIN) - ★ 修正
// =================================================================================================

/**
 * Base64エンコード後の目標サイズから、元のデータサイズを計算 - 変更なし
 */
function getOriginalSizeForBase64Target(targetEncodedSizeInBytes: number): number {
	// Base64 は 3 バイトを 4 バイトにエンコードするため、約 3/4 になる
	return Math.floor(targetEncodedSizeInBytes * 3 / 4);
}

/**
 * メモリバッファ (ダミーデータ) または実ファイルを読み込む - 変更なし
 */
async function setupEnvironment(chainManager: ChainManager): Promise<{
	filePath: string,
	fileBuffer: Buffer,
	fileSizeInBytes: number,
	dataChains: ChainInfo[],
	metaChain: ChainInfo | null,
	megaChunkSize: number
}> {
	// --- 1. 引数処理 ---
	const args = process.argv.slice(2);
	const sizeIndex = args.indexOf('--size-kb');
	let filePath: string;
	let fileBuffer: Buffer;
	let fileSizeInBytes: number; // オリジナルデータサイズ

	if (sizeIndex !== -1 && args[sizeIndex + 1]) {
		// (A) --size-kb 指定: ダミーデータ生成
		const targetEncodedSizeKB = parseInt(args[sizeIndex + 1]!, 10);
		if (isNaN(targetEncodedSizeKB) || targetEncodedSizeKB <= 0) throw new Error(`Invalid --size-kb: ${args[sizeIndex + 1]}`);
		const targetEncodedSizeBytes = targetEncodedSizeKB * 1024;
		fileSizeInBytes = getOriginalSizeForBase64Target(targetEncodedSizeBytes); // オリジナルサイズ逆算
		filePath = `memory-buffer-${targetEncodedSizeKB}kb-encoded`;
		logger.info(`[SETUP] Generating dummy data (Original: ~${(fileSizeInBytes / 1024 / 1024).toFixed(2)} MB, Target Encoded: ${targetEncodedSizeKB} KB)...`);
		fileBuffer = Buffer.alloc(fileSizeInBytes, `Dummy data for ${filePath}.`);
	} else if (args[0]) {
		// (B) ファイルパス指定: ファイル読み込み
		filePath = args[0];
		try {
			const stats = fs.statSync(filePath);
			fileBuffer = fs.readFileSync(filePath);
			fileSizeInBytes = stats.size;
			const fileSizeMB = (fileSizeInBytes / 1024 / 1024).toFixed(2);
			logger.info(`[SETUP] Loaded file: ${filePath} (${fileSizeMB} MB)`);
			const estimatedEncodedSizeMB = (fileSizeInBytes * 4 / 3 / 1024 / 1024).toFixed(2);
			logger.info(`          (Estimated encoded upload size: ~${estimatedEncodedSizeMB} MB)`);
		} catch (e) { throw new Error(`Failed to read file ${filePath}: ${e}`); }
	} else {
		// (C) デフォルト: ダミーデータ生成
		const targetEncodedSizeKB = CONFIG.DEFAULT_TEST_SIZE_KB;
		const targetEncodedSizeBytes = targetEncodedSizeKB * 1024;
		fileSizeInBytes = getOriginalSizeForBase64Target(targetEncodedSizeBytes);
		filePath = `memory-buffer-${targetEncodedSizeKB}kb-encoded-default`;
		logger.info(`[SETUP] No input specified. Generating default dummy data (Original: ~${(fileSizeInBytes / 1024 / 1024).toFixed(2)} MB, Target Encoded: ${targetEncodedSizeKB} KB)...`);
		fileBuffer = Buffer.alloc(fileSizeInBytes, `Default dummy data.`);
	}

	// --- 2. 環境情報取得 (k8s) ---
	logger.info("[SETUP] Fetching Kubernetes resources...");
	const { chains: allChains, rpcEndpoints, restEndpoints } = await getChainResources();
	const dataChains = allChains.filter(c => c.type === 'datachain');
	const metaChain = allChains.find(c => c.type === 'metachain') || null;
	const numDataChains = dataChains.length;
	if (numDataChains === 0) throw new Error('No Datachains found in Kubernetes.');
	logger.info(`[SETUP] Found ${numDataChains} datachains: ${dataChains.map(c => c.name).join(', ')}`);
	if (metaChain) logger.info(`[SETUP] Found metachain: ${metaChain.name}`); else logger.warn('[SETUP] Metachain not found.');

	// --- 3. メガチャンクサイズ計算 ---
	const megaChunkSize = Math.ceil(fileSizeInBytes / numDataChains);
	logger.info(`[SETUP] MegaChunk size per chain: ~${Math.round(megaChunkSize / 1024)} KB`);
	logger.info(`[SETUP] MiniChunk (TX) size: ${Math.round(CONFIG.DEFAULT_CHUNK_SIZE / 1024)} KB`);

	// --- 4. クライアント初期化 ---
	logger.info("[SETUP] Initializing chain clients...");
	await chainManager.initializeClients(allChains, rpcEndpoints, restEndpoints);

	return { filePath, fileBuffer, fileSizeInBytes, dataChains, metaChain, megaChunkSize };
}

/**
 * ファイルをメガチャンクに分割し、チェーンごとのジョブキューに割り当てる - 変更なし
 */
async function createMegaChunkJobs(fileBuffer: Buffer, megaChunkSize: number, dataChains: ChainInfo[]): Promise<{ jobsByChain: Map<string, MegaChunkJob[]>, totalMegaChunks: number }> {
	const jobsByChain = new Map<string, MegaChunkJob[]>();
	dataChains.forEach(chain => jobsByChain.set(chain.name, []));
	let chunkCounter = 0;
	const uniqueSuffix = `dist-seq-test-${Date.now()}`;
	const numDataChains = dataChains.length;
	let offset = 0;

	logger.info(`[CHUNK_SPLIT] Splitting buffer (size: ${fileBuffer.length} B) into MegaChunks (size: ${megaChunkSize} B)...`);
	while (offset < fileBuffer.length) {
		const end = Math.min(offset + megaChunkSize, fileBuffer.length);
		const buffer = fileBuffer.slice(offset, end);
		const indexPrefix = `${uniqueSuffix}-mega-${chunkCounter}`; // 各メガチャンクの一意なプレフィックス
		const targetChainIndex = chunkCounter % numDataChains;
		const targetChainName = dataChains[targetChainIndex]!.name; // ラウンドロビンで割り当て

		const job: MegaChunkJob = { buffer, indexPrefix, chainName: targetChainName, retries: 0 };
		jobsByChain.get(targetChainName)!.push(job);

		logger.debug(` -> MegaChunk ${chunkCounter}: ${buffer.length} B assigned to ${targetChainName}`);
		offset = end;
		chunkCounter++;
	}

	logger.info(`[CHUNK_SPLIT] Buffer split into ${chunkCounter} MegaChunks.`);
	dataChains.forEach(chain => {
		logger.info(`  -> Chain ${chain.name} assignment: ${jobsByChain.get(chain.name)!.length} MegaChunks.`);
	});

	return { jobsByChain, totalMegaChunks: chunkCounter };
}


/**
 * Mempoolの合計バイトサイズが閾値を下回るまで待機する - 変更なし
 */
async function waitForMempoolSpace(
	chainManager: ChainManager,
	chainName: string,
	bar: cliProgress.SingleBar,
	currentValue: number // バー表示用の現在値
) {
	const MEMPOOL_LIMIT_BYTES = CONFIG.MEMPOOL_BYTES_LIMIT; // バイトサイズ上限を使用
	let isReconnecting = false;
	let attempt = 0;

	while (true) {
		attempt++;
		try {
			// 1. ヘルスチェックとMempool合計バイトサイズ取得
			logger.debug(`[${chainName}] Checking mempool space (Attempt ${attempt})...`);
			const currentBytes = await chainManager.getMempoolTotalBytes(chainName);
			logger.debug(`[${chainName}] Current mempool size: ${currentBytes} bytes`);

			if (isReconnecting) { // 再接続直後
				logger.info(`[${chainName}] Reconnection successful.`);
				bar.update(currentValue, { status: `Reconnected. Resuming...` });
				isReconnecting = false;
			}

			if (currentBytes < MEMPOOL_LIMIT_BYTES) {
				logger.debug(`[${chainName}] Mempool has space (${currentBytes} < ${MEMPOOL_LIMIT_BYTES}). Proceeding.`);
				return; // 空きあり、成功
			}

			// 空きがない場合
			const currentMB = (currentBytes / 1024 / 1024).toFixed(1);
			const limitMB = (MEMPOOL_LIMIT_BYTES / 1024 / 1024).toFixed(1);
			logger.info(`[${chainName}] Mempool full (${currentMB}/${limitMB} MB). Waiting ${CONFIG.MEMPOOL_CHECK_INTERVAL_MS}ms...`);
			bar.update(currentValue, { status: `Mempool full (${currentMB}/${limitMB} MB). Waiting...` });
			await sleep(CONFIG.MEMPOOL_CHECK_INTERVAL_MS); // sleep 関数を使用

		} catch (e: any) {
			// 失敗：接続エラー等
			logger.warn(`[${chainName}] Mempool check failed (Attempt ${attempt}, Error: ${e.message}). Retrying connection...`);
			bar.update(currentValue, { status: `Connection error. Reconnecting...` });
			isReconnecting = true;
			try {
				// 2. 再接続試行
				await chainManager.reconnectClient(chainName);
				// 再接続成功、ループの最初に戻って再チェック
			} catch (reconnectError: any) {
				// 3. 再接続失敗
				logger.error(`[${chainName}] Reconnection failed. Waiting ${CONFIG.RECONNECT_DELAY_MS}ms before retry...`, reconnectError.message);
				bar.update(currentValue, { status: `Reconnect failed. Waiting...` });
				await sleep(CONFIG.RECONNECT_DELAY_MS); // sleep を使用
				// ループの最初に戻って再試行
			}
		}
	}
}


/**
 * 堅牢なリトライロジックを実装したワーカー (★ TxEventSubscriber を使用するよう修正)
 */
async function executeDistributionWorkers(chainManager: ChainManager, megaJobsByChain: Map<string, MegaChunkJob[]>, dataChains: ChainInfo[], estimatedGas: number): Promise<void> {

	// --- バッチサイズ計算 (変更なし) ---
	const MINI_CHUNK_SIZE_BYTES = CONFIG.DEFAULT_CHUNK_SIZE;
	const ESTIMATED_ENCODED_MINI_CHUNK_SIZE = Math.ceil(MINI_CHUNK_SIZE_BYTES * 4 / 3);
	const MINI_CHUNK_SIZE_WITH_OVERHEAD = ESTIMATED_ENCODED_MINI_CHUNK_SIZE * CONFIG.TX_OVERHEAD_RATIO;
	// ★ CONFIG.EFFECTIVE_BLOCK_SIZE_RATIO が 0.25 に変更されている
	const TARGET_BATCH_BYTES = CONFIG.BLOCK_SIZE_LIMIT_MB * 1024 * 1024 * CONFIG.EFFECTIVE_BLOCK_SIZE_RATIO;
	const DYNAMIC_BATCH_SIZE = Math.max(1, Math.floor(TARGET_BATCH_BYTES / MINI_CHUNK_SIZE_WITH_OVERHEAD));

	logger.info(`[GLOBAL_INFO] Dynamic Batch Size: ${DYNAMIC_BATCH_SIZE} TXs per batch (~${(DYNAMIC_BATCH_SIZE * MINI_CHUNK_SIZE_WITH_OVERHEAD / 1024 / 1024).toFixed(1)} MB encoded)`);
	logger.info(`[GLOBAL_INFO] Target Block Fill Ratio: ${CONFIG.EFFECTIVE_BLOCK_SIZE_RATIO * 100}% (~${(TARGET_BATCH_BYTES / 1024 / 1024).toFixed(1)} MB)`);
	logger.info(`[GLOBAL_INFO] Pipeline depth: ${CONFIG.PIPELINE_MAX_PENDING_BATCHES}`);
	logger.info(`[GLOBAL_INFO] Mempool Limit: ${(CONFIG.MEMPOOL_BYTES_LIMIT / 1024 / 1024).toFixed(1)} MB`);

	// --- プログレスバー設定 (変更なし) ---
	const multiBar = new cliProgress.MultiBar({
		clearOnComplete: false,
		hideCursor: true,
		format: '{chain} | {bar} | {percentage}% ({value}/{total}) | ETA: {eta_formatted} | TX/s: {tx_per_sec} | Status: {status} | Height: {height}',
		stream: process.stdout
	}, cliProgress.Presets.shades_grey);

	// --- ワーカー処理 (★ 修正) ---
	const workerPromises = dataChains.map(chain => {
		const chainName = chain.name;
		const megaJobQueue = megaJobsByChain.get(chainName)!;
		if (!megaJobQueue || megaJobQueue.length === 0) {
			logger.info(`[${chainName}] No jobs assigned, skipping worker.`);
			return Promise.resolve(); // 仕事がなければ即完了
		}

		// このチェーンの総ミニチャンク数を計算
		const totalMiniChunks = megaJobQueue.reduce((sum, job) => sum + Math.ceil(job.buffer.length / MINI_CHUNK_SIZE_BYTES), 0);
		const bar = multiBar.create(totalMiniChunks, 0, { chain: chainName.padEnd(8), tx_per_sec: '0.00', status: 'Initializing', height: 'N/A' });

		// ★ ワーカーごとの購読マネージャをセットアップ
		let subscriber: TxEventSubscriber | null = null;

		return (async () => { // 各ワーカーの非同期関数
			let totalConfirmedTxCount = 0; // このワーカーで確認されたTx総数
			try {
				const { account, tmClient } = chainManager.getClientInfo(chainName);

				// ★ 購読マネージャを初期化
				subscriber = new TxEventSubscriber(tmClient, bar, chainName);
				await subscriber.start(); // 購読を開始

				const messages: EncodeObject[] = [];

				// 1. 全メガチャンクをミニチャンク (Tx) に分割 (変更なし)
				logger.debug(`[${chainName}] Splitting MegaChunks into MiniChunks...`);
				for (const megaJob of megaJobQueue) {
					const megaChunkBuffer = megaJob.buffer;
					let miniOffset = 0;
					let internalChunkIndex = 0;
					while (miniOffset < megaChunkBuffer.length) {
						const miniEnd = Math.min(miniOffset + MINI_CHUNK_SIZE_BYTES, megaChunkBuffer.length);
						const miniBuffer = megaChunkBuffer.slice(miniOffset, miniEnd);
						const miniIndex = `${megaJob.indexPrefix}-mini-${internalChunkIndex}`;
						const msg = { typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk', value: { creator: account.address, index: miniIndex, data: miniBuffer }, };
						messages.push(msg);
						miniOffset = miniEnd;
						internalChunkIndex++;
					}
				}
				bar.update(0, { status: `Ready (${totalMiniChunks} TXs)` });
				logger.info(`[WORKER_START] ${chainName} ready with ${totalMiniChunks} TXs.`);

				// 2. メッセージ配列を DYNAMIC_BATCH_SIZE ごとにバッチ化 (変更なし)
				const messageBatches: EncodeObject[][] = [];
				for (let i = 0; i < messages.length; i += DYNAMIC_BATCH_SIZE) {
					messageBatches.push(messages.slice(i, i + DYNAMIC_BATCH_SIZE));
				}
				logger.info(`[WORKER_INFO] ${chainName} split into ${messageBatches.length} batches (Batch Size: ${DYNAMIC_BATCH_SIZE}).`);

				const currentSequenceRef = { sequence: 0 }; // シーキンス番号管理用
				const inclusionWaiters: Promise<Map<string, { success: boolean; height: number | undefined }>>[] = [];
				let hasFailures = false; // ワーカー内で失敗が発生したか

				// 3. 堅牢なリトライ付きバッチ処理ループ
				for (let batchIndex = 0; batchIndex < messageBatches.length; /* インクリメントは成功時のみ */) {
					const batchMessages = messageBatches[batchIndex]!;
					const BATCH_ID = `Batch ${batchIndex + 1}/${messageBatches.length}`;
					let currentBatchTxHashes: string[] = []; // このバッチで送信したハッシュ

					try {
						// (3a) Mempoolチェック (変更なし)
						bar.update(totalConfirmedTxCount, { status: `${BATCH_ID} Mempool Check` });
						await waitForMempoolSpace(chainManager, chainName, bar, totalConfirmedTxCount);

						// (3b) シーキンスの再取得 (変更なし)
						if (currentSequenceRef.sequence === 0) {
							logger.info(`[${chainName}] Fetching sequence before ${BATCH_ID}...`);
							const acc = await chainManager.getClientInfo(chainName).client.getAccount(account.address);
							if (!acc) throw new Error(`Failed to get account info for ${account.address}`);
							currentSequenceRef.sequence = acc.sequence;
							logger.info(`[${chainName}] Sequence set to ${currentSequenceRef.sequence}`);
						}

						// (3c) 同期バッチ送信 (変更なし)
						bar.update(totalConfirmedTxCount, { status: `${BATCH_ID} Broadcasting` });
						currentBatchTxHashes = await chainManager.broadcastSequentialTxs(
							chainName, batchMessages, estimatedGas, bar, totalConfirmedTxCount, currentSequenceRef
						);
						logger.info(`[${chainName}] ${BATCH_ID} broadcasted ${currentBatchTxHashes.length} TXs (Seq ${currentSequenceRef.sequence - currentBatchTxHashes.length} - ${currentSequenceRef.sequence - 1}).`);

						// ★ (3d) 購読マネージャに待機を依頼
						const waiterPromise = subscriber.waitForTxs(
							currentBatchTxHashes,
							totalConfirmedTxCount, // イベントハンドラ内でバーを進めるためのオフセット
							batchMessages.length
						);

						// (3e) 結果処理 (変更なし - totalConfirmedTxCount の更新ロジックも前回修正済み)
						inclusionWaiters.push(waiterPromise.then(resultsMap => {
							let confirmedInThisBatch = 0;
							let failuresInThisBatch = 0;
							resultsMap.forEach((status, hash) => {
								if (hash.startsWith("ERROR_BROADCASTING")) {
								} else if (status.success && status.height) {
									confirmedInThisBatch++;
								} else {
									failuresInThisBatch++; // 確認失敗 or タイムアウト
								}
							});

							// ★ ワーカーの総カウントを更新する
							totalConfirmedTxCount += confirmedInThisBatch;

							logger.info(`[WORKER_PIPE] ${chainName} ${BATCH_ID} finished waiting. ${confirmedInThisBatch}/${currentBatchTxHashes.length} confirmed.`);
							if (failuresInThisBatch > 0) {
								hasFailures = true; // 失敗フラグを立てる
								logger.error(`[WORKER_FAIL] ${chainName} ${BATCH_ID} had ${failuresInThisBatch} failures or timed out!`);
							}
							return resultsMap;
						}));

						// (3f) 背圧 (変更なし)
						if (inclusionWaiters.length >= CONFIG.PIPELINE_MAX_PENDING_BATCHES) {
							logger.debug(`[${chainName}] Pipeline full (${inclusionWaiters.length}). Waiting for a batch to complete...`);
							bar.update(totalConfirmedTxCount, { status: `Waiting (Pipeline)` });
							await inclusionWaiters.shift();
							logger.debug(`[${chainName}] Pipeline has space. Proceeding.`);
						}

						// (3g) 成功。次のバッチへ
						batchIndex++;

					} catch (error: any) {
						// (3h) 送信失敗時のリトライロジック (変更なし)
						logger.warn(`[${chainName}] Failed during ${BATCH_ID} (Broadcast/Sign?). Error: ${error.message}. Retrying...`);
						bar.update(totalConfirmedTxCount, { status: `${BATCH_ID} Failed. Retrying...` });
						currentSequenceRef.sequence = 0;
						await sleep(CONFIG.RECONNECT_DELAY_MS);
					}
				} // バッチループ (for)

				// 4. 残りの待機プロセスをすべて待つ (変更なし)
				logger.info(`[${chainName}] All batches sent. Waiting for ${inclusionWaiters.length} final confirmations...`);
				bar.update(totalConfirmedTxCount, { status: `Final Confirmations` });
				await Promise.all(inclusionWaiters);

				// --- 最終的なバーの更新とチェック --- (変更なし)
				bar.update(totalConfirmedTxCount, { status: `Finished` });

				if (hasFailures) {
					logger.error(`[WORKER_FAIL] Worker for ${chainName} finished with detected failures or timeouts.`);
					throw new Error(`Worker for ${chainName} had failures.`);
				}
				if (totalConfirmedTxCount < totalMiniChunks) {
					logger.error(`[WORKER_INCOMPLETE] Worker for ${chainName} finished but only ${totalConfirmedTxCount}/${totalMiniChunks} TXs were confirmed successfully.`);
					throw new Error(`Worker for ${chainName} did not confirm all transactions (${totalConfirmedTxCount}/${totalMiniChunks}).`);
				}

				logger.info(`[WORKER_SUCCESS] ${chainName} completed successfully.`);

			} catch (criticalError) { // ワーカー全体の catch
				bar.stop(); // エラー時にバーを停止
				logger.error(`[CRITICAL_FAIL] Worker failed for ${chainName}. Error:`, criticalError);
				throw new Error(`Critical worker failure on chain ${chainName}: ${criticalError}`); // エラーを上に伝播
			} finally {
				// ★ (5) 購読を停止する
				if (subscriber) {
					subscriber.stop();
				}
			}
		})(); // async IIFE
	}); // dataChains.map

	// --- 全ワーカーの完了待機 (変更なし) ---
	try {
		const results = await Promise.allSettled(workerPromises);
		const failedWorkers = results.filter(r => r.status === 'rejected');
		if (failedWorkers.length > 0) {
			logger.error(`[MAIN] ${failedWorkers.length}/${dataChains.length} workers failed.`);
			throw new Error(`${failedWorkers.length} workers failed. See logs for details.`);
		}
		logger.info("[MAIN] All workers completed successfully.");
	} finally {
		multiBar.stop(); // すべてのバーを停止
	}
}


/**
 * メインの分散アップロード処理 - 変更なし
 */
async function main() {
	const chainManager = new ChainManager();
	let filePath: string | null = null;
	let totalChunksCalculated: number = 0; // 計算された総チャンク数
	const startTime = Date.now();

	try {
		// 1. 環境設定 (ファイル読み込み/生成、k8sリソース取得、クライアント初期化)
		const {
			filePath: fPath,
			fileBuffer,
			fileSizeInBytes, // オリジナルサイズ
			dataChains,
			metaChain, // 今回は未使用
			megaChunkSize
		} = await setupEnvironment(chainManager);
		filePath = fPath; // ログ用

		// 2. ファイルをメガチャンクに分割 & ジョブ割り当て
		const { jobsByChain } = await createMegaChunkJobs(fileBuffer, megaChunkSize, dataChains);

		// 総ミニチャンク数を事前に計算 (パフォーマンス計測用)
		totalChunksCalculated = dataChains.reduce((total, chain) => {
			const jobs = jobsByChain.get(chain.name) || [];
			return total + jobs.reduce((sum, job) => sum + Math.ceil(job.buffer.length / CONFIG.DEFAULT_CHUNK_SIZE), 0);
		}, 0);
		logger.info(`[MAIN] Calculated total MiniChunks to upload: ${totalChunksCalculated}`);

		// 3. ガス代のシミュレーション (最初のデータチェーンで)
		const firstDataChainName = dataChains[0]?.name;
		if (!firstDataChainName) throw new Error("No data chains available for gas simulation.");
		const firstMegaJob = jobsByChain.get(firstDataChainName)?.[0];
		if (!firstMegaJob) {
			logger.warn('[GAS_SIMULATE] No jobs assigned to the first data chain. Using fallback gas.');
			// throw new Error('No mega chunks generated for upload.');
		}

		let estimatedGas: number = 5000000; // フォールバック値
		if (firstMegaJob) {
			const firstMiniChunk = firstMegaJob.buffer.subarray(0, CONFIG.DEFAULT_CHUNK_SIZE);
			const dataChainClientInfo = chainManager.getClientInfo(firstDataChainName);
			const dummyMsg: EncodeObject = {
				typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk',
				value: { creator: dataChainClientInfo.account.address, index: 'gas-simulation-dummy-0', data: firstMiniChunk },
			};

			try {
				logger.info(`[GAS_SIMULATE] Simulating gas on ${firstDataChainName}...`);
				estimatedGas = await dataChainClientInfo.client.simulate(dataChainClientInfo.account.address, [dummyMsg], 'Gas Estimation');
				logger.info(`[GAS_SIMULATE] Initial estimated gas per MiniChunk: ${estimatedGas}. Gas Wanted per TX: ${Math.round(estimatedGas * CONFIG.GAS_MULTIPLIER)}.`);
			} catch (simError) {
				logger.warn("[GAS_SIMULATE] Initial simulation failed. Using fallback gas value.", simError);
				// estimatedGas はフォールバック値のまま
			}
		} else {
			logger.warn("[GAS_SIMULATE] No jobs for first chain, cannot simulate accurately. Using fallback gas.");
		}


		// 4. チャンクアップロード実行 (イベント版 + Mempoolバイトサイズ監視)
		logger.info('[MAIN] Starting distributed chunk upload with event confirmation...');
		await executeDistributionWorkers(chainManager, jobsByChain, dataChains, estimatedGas);

		// 5. クリーンアップ
		logger.info(`[CLEANUP] Upload process seemingly complete for: ${filePath}.`);

	} catch (err) {
		logger.error('[MAIN] A fatal error occurred during the upload process:', err);
		throw err; // エラーを再スローしてスクリプトを失敗させる
	} finally {
		// 6. 接続切断
		chainManager.closeAllConnections();

		// パフォーマンス計測と表示
		const endTime = Date.now();
		const totalUploadTimeMs = endTime - startTime;
		const totalUploadTimeSec = (totalUploadTimeMs / 1000).toFixed(2);
		const averageTimePerChunkMs = (totalChunksCalculated > 0 ? (totalUploadTimeMs / totalChunksCalculated) : 0).toFixed(2);
		// スループット (Chunks per Second)
		const chunksPerSec = (totalChunksCalculated > 0 && totalUploadTimeMs > 0 ? (totalChunksCalculated * 1000 / totalUploadTimeMs) : 0).toFixed(2);

		// ★ ログと分離するため、最終結果は標準出力 (stdout) に出す
		console.log('\n--- 📊 Distributed Upload Performance (Event Confirmation) ---');
		console.log(`Target Data Source: ${filePath}`);
		console.log(`Total Mini-Chunks Calculated: ${totalChunksCalculated}`);
		console.log(`Total Upload Time: ${totalUploadTimeSec} seconds`);
		console.log(`Average Time per Chunk: ${averageTimePerChunkMs} ms`);
		console.log(`Throughput: ${chunksPerSec} chunks/sec`);
		console.log('------------------------------------------------------------\n');

		// ログファイルのフラッシュ
		await loggerUtil.flushLogs();
	}
}

// 実行と最終的なエラーハンドリング
main().then(() => {
	logger.info('[MAIN] Script finished successfully.');
	// flushLogs は finally ブロックで呼ばれるのでここでは不要
	process.exit(0);
}).catch(err => {
	// エラーメッセージは logger によってファイルに書き込まれている
	// 標準エラー出力にも簡潔にエラーを通知
	console.error(`\n[MAIN] Script execution failed. See logs for details.`);
	// flushLogs は finally ブロックで呼ばれるはずだが念のため
	loggerUtil.flushLogs().finally(() => process.exit(1));
});