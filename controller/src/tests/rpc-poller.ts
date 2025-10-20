import { JsonRpcRequest, JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import { WebsocketClient } from '@cosmjs/tendermint-rpc';
import * as k8s from '@kubernetes/client-node';
import * as fs from 'fs'; // Use synchronous fs for simplicity in logger path creation
import * as path from 'path';
import winston from 'winston';
import Transport from 'winston-transport';

// =================================================================================================
// 📚 I. CONFIG & TYPE DEFINITIONS
// =================================================================================================

const CONFIG = {
	K8S_NAMESPACE: 'raidchain',
	POLL_INTERVAL_MS: 5000,
	WEBSOCKET_CONNECT_TIMEOUT_MS: 5000, // WebSocket接続タイムアウト
	RECONNECT_DELAY_MS: 3000, // 再接続試行時の待機時間
};

interface TransformableInfo extends winston.Logform.TransformableInfo {
	level: string;
	message: string;
	[key: string]: any;
}

// =================================================================================================
// 📝 II. LOGGER UTILITIES (CLASS-BASED) - ほぼ変更なし
// =================================================================================================
class LoggerUtil {
	// ... (rpc-poller.ts と同様の実装) ...
	private readonly logBuffer: TransformableInfo[] = [];
	private readonly logger: winston.Logger;
	private readonly logFilePath: string;

	constructor() {
		const scriptFileName = path.basename(process.argv[1]!).replace(path.extname(process.argv[1]!), '');
		// Ensure directory exists synchronously before logger creation
		const logDir = path.join(process.cwd(), "src/tests/");
		try {
			if (!fs.existsSync(logDir)) {
				fs.mkdirSync(logDir, { recursive: true });
			}
		} catch (e) {
			console.error(`Error creating log directory ${logDir}:`, e);
		}
		this.logFilePath = path.join(logDir, `${scriptFileName}.log`);


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
					)
				})
			],
		});
	}

	public getLogger(): winston.Logger {
		return this.logger;
	}

	public async flushLogs() {
		if (this.logBuffer.length === 0) return;
		// Ensure directory exists before writing
		const logDir = path.dirname(this.logFilePath);
		try {
			await fs.promises.mkdir(logDir, { recursive: true });
		} catch (e) {
			console.error(`Error ensuring log directory ${logDir} exists:`, e);
			// Continue trying to write the log file anyway
		}

		const logContent = this.logBuffer
			.map(info => {
				const transformed = this.logger.format.transform(info, {});
				return transformed && (transformed as TransformableInfo).message && info.level !== 'info' ? (transformed as TransformableInfo).message : '';
			})
			.filter(line => line.length > 0)
			.join('\n');
		try {
			await fs.promises.writeFile(this.logFilePath, logContent + '\n', { flag: 'w' });
			console.error(`\n🚨 ログをファイルに書き込みました: ${this.logFilePath}`);
		} catch (e) {
			console.error('ERROR: Failed to write logs to file.', e);
		}
	}
}


const loggerUtil = new LoggerUtil();
const logger = loggerUtil.getLogger();

// =================================================================================================
// 💻 III. KUBERNETES UTILITIES - WebSocket URL を返すように修正
// =================================================================================================

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

/**
 * 指定されたチェーンのWebSocket RPCエンドポイントを取得する
 * @param targetChainName ポーリング対象のチェーン名
 * @returns WebSocket URL (例: "ws://localhost:30057")
 */
async function getRpcWsEndpoint(targetChainName: string): Promise<string> {
	let rpcEndpointHttp = '';
	const isLocal = process.env.NODE_ENV !== 'production';

	try {
		logger.info(`Fetching RPC endpoint for chain "${targetChainName}"...`);
		const resServices = await k8sApi.listNamespacedService({
			namespace: CONFIG.K8S_NAMESPACE,
			labelSelector: `app.kubernetes.io/instance=${targetChainName}`
		});
		const serviceName = `raidchain-${targetChainName}-headless`;
		const service = resServices.items.find(s => s.metadata?.name === serviceName);

		if (!service) throw new Error(`Service "${serviceName}" not found.`);

		if (isLocal) {
			const rpcPortInfo = service?.spec?.ports?.find(p => p.name === 'rpc');
			if (rpcPortInfo?.nodePort) {
				rpcEndpointHttp = `http://localhost:${rpcPortInfo.nodePort}`;
			} else {
				throw new Error(`RPC NodePort not found for service "${serviceName}".`);
			}
		} else {
			const podHostName = `raidchain-${targetChainName}-0`;
			const headlessServiceName = `raidchain-chain-headless`;
			rpcEndpointHttp = `http://${podHostName}.${headlessServiceName}.${CONFIG.K8S_NAMESPACE}.svc.cluster.local:26657`;
		}

		if (!rpcEndpointHttp) throw new Error(`Could not determine RPC endpoint.`);

		const rpcEndpointWs = rpcEndpointHttp.replace('http', 'ws'); // HTTP -> WS
		logger.info(`✅ WebSocket RPC endpoint found: ${rpcEndpointWs}`);
		return rpcEndpointWs;

	} catch (err) {
		logger.error(`Failed to get RPC endpoint for "${targetChainName}".`);
		if (err instanceof Error) logger.error(`   Error: ${err.message}`);
		else logger.error(`   Unknown error: ${err}`);
		throw err;
	}
}

// =================================================================================================
// ⚙️ V. CORE POLLING LOGIC (WebSocket版)
// =================================================================================================

let wsClient: WebsocketClient | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let rpcMethod: string = ''; // ポーリング対象のRPCメソッド名
let rpcParams: any = {}; // RPCメソッドのパラメータ

/**
 * WebSocketクライアントを初期化または再接続する
 * @param wsUrl 接続先WebSocket URL
 */
async function connectWebSocket(wsUrl: string) {
	if (reconnectTimer) clearTimeout(reconnectTimer); // 再接続タイマーをクリア
	if (wsClient) { // 既存のクライアントがあれば切断
		try {
			wsClient.disconnect();
		} catch (e) {
			logger.warn("Error disconnecting previous client (ignoring):", e);
		}
		wsClient = null;
	}

	logger.info(`🔌 Attempting to connect to WebSocket: ${wsUrl}...`);

	// エラーハンドラは、接続試行中および接続後に発生する可能性のあるエラーを処理
	const errorHandler = (error: any) => {
		logger.error(` WebSocket error: ${error?.message || error}. Attempting reconnect in ${CONFIG.RECONNECT_DELAY_MS}ms...`);
		if (pollTimer) clearTimeout(pollTimer); // ポーリングを一時停止
		wsClient = null; // クライアントを無効化
		// 再接続タイマーを設定（既に設定されていなければ）
		if (!reconnectTimer) {
			reconnectTimer = setTimeout(() => connectWebSocket(wsUrl), CONFIG.RECONNECT_DELAY_MS);
		}
	};

	wsClient = new WebsocketClient(wsUrl, errorHandler);

	try {
		// 接続試行 (タイムアウト付き) - executeで接続を確認
		const connectPromise = wsClient.execute({ jsonrpc: "2.0", method: "status", id: `connect-${Date.now()}`, params: {} });
		const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("WebSocket connection timed out")), CONFIG.WEBSOCKET_CONNECT_TIMEOUT_MS));

		await Promise.race([connectPromise, timeoutPromise]);

		logger.info("✅ WebSocket connected successfully.");
		// 接続成功したらポーリングを開始/再開
		scheduleNextPoll();

	} catch (error: any) {
		logger.error(` WebSocket connection failed: ${error?.message || error}`);
		wsClient = null; // 接続失敗したらクライアントをnullに
		// エラーハンドラが再接続を試みるはずだが、念のためタイマーを設定
		if (!reconnectTimer) {
			reconnectTimer = setTimeout(() => connectWebSocket(wsUrl), CONFIG.RECONNECT_DELAY_MS);
		}
	}
}

/**
 * 指定されたRPCメソッドをWebSocket経由で呼び出す
 */
async function pollRpcMethod() {
	// 修正: ポーリング前に明示的な接続チェックを行わない
	if (!wsClient) {
		logger.warn(" WebSocket client not initialized. Skipping poll.");
		// connectWebSocket が初期化/再接続を試みるはず
		return;
	}

	const requestId = `poll-${Date.now()}`;
	const request: JsonRpcRequest = {
		jsonrpc: "2.0",
		id: requestId,
		method: rpcMethod,
		params: rpcParams,
	};

	try {
		logger.info(` Pinging RPC method "${rpcMethod}" via WebSocket...`);
		// 修正: execute をそのまま呼び出す。接続が切れていればここでエラーが発生する想定。
		const response = await wsClient.execute(request) as JsonRpcSuccessResponse;

		logger.info(` Response received (ID: ${response.id}):\n${JSON.stringify(response.result, null, 2)}`);

		// 成功した場合のみ、次回のポーリングをスケジュール
		scheduleNextPoll(); // ← 成功パスに移動

	} catch (error) {
		logger.error(` Error during RPC call "${rpcMethod}" (potentially disconnected):`);
		if (error instanceof Error) {
			logger.error(`   Message: ${error.message}`);
		} else {
			logger.error(`   Unknown error: ${error}`);
		}
		// エラー発生時は、wsClientに登録されたerrorHandlerが再接続を試みるはずなので、
		// ここでは次回のポーリングをスケジュールしない。
		// errorHandler内で pollTimer のクリアが必要になる場合があるかもしれないが、
		// まずは errorHandler の挙動に任せる。
	}
	// 修正: finally ブロックでの scheduleNextPoll 呼び出しを削除
}

/**
 * 次回のポーリングをスケジュールする
 */
function scheduleNextPoll() {
	if (pollTimer) clearTimeout(pollTimer); // 既存のタイマーをクリア
	// 修正: 必ず wsClient が存在するかチェック
	if (wsClient) {
		pollTimer = setTimeout(pollRpcMethod, CONFIG.POLL_INTERVAL_MS);
	} else {
		logger.warn("Cannot schedule next poll, WebSocket client is not available.");
	}
}


/**
 * メイン処理
 */
async function main() {
	// 1. コマンドライン引数の解析
	const args = process.argv.slice(2);
	if (args.length < 2) {
		console.error("Usage: ts-node src/tests/rpc-poller-ws.ts <chain-name> <rpc-method> [rpc-params-json]");
		console.error("Example: ts-node src/tests/rpc-poller-ws.ts data-0 num_unconfirmed_txs");
		console.error("Example: ts-node src/tests/rpc-poller-ws.ts data-0 block_results '{\"height\": \"100\"}'");
		console.error("Example: ts-node src/tests/rpc-poller-ws.ts meta-0 status");
		process.exit(1);
	}
	const targetChainName = args[0]!;
	rpcMethod = args[1]!; // ポーリング対象のRPCメソッド名
	const rpcParamsString = args[2]; // オプションのJSONパラメータ文字列

	if (rpcParamsString) {
		try {
			rpcParams = JSON.parse(rpcParamsString);
			logger.info(` Using RPC parameters: ${JSON.stringify(rpcParams)}`);
		} catch (e) {
			logger.error(` Invalid JSON provided for RPC parameters: ${rpcParamsString}`);
			process.exit(1);
		}
	} else {
		rpcParams = {}; // パラメータなし
	}


	try {
		// 2. WebSocket RPCエンドポイントの取得
		const wsUrl = await getRpcWsEndpoint(targetChainName);

		// 3. WebSocket接続を開始 (接続成功後にポーリングが自動開始される)
		await connectWebSocket(wsUrl);

		// 無限に待機 (スクリプトが終了しないように)
		await new Promise(() => { });

	} catch (err) {
		logger.error('[MAIN] A fatal error occurred during setup:', err);
		await loggerUtil.flushLogs();
		process.exit(1);
	}
}

// 実行と最終的なエラーハンドリング
main().catch(async err => {
	logger.error('Uncaught fatal error in main execution loop:', err);
	await loggerUtil.flushLogs();
	process.exit(1);
});