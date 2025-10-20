import { stringToPath } from '@cosmjs/crypto';
import { AccountData, DirectSecp256k1HdWallet, EncodeObject, GeneratedType, Registry } from '@cosmjs/proto-signing';
import { calculateFee, GasPrice, SigningStargateClient } from '@cosmjs/stargate';
// ★ 修正点1: TxEvent のインポートパスを明示的に指定
import { Comet38Client, WebsocketClient } from "@cosmjs/tendermint-rpc";
import { TxEvent } from "@cosmjs/tendermint-rpc/build/comet38/responses"; // ★ 明示的なパス
import { Listener, Stream } from "xstream";

import { sleep } from "@cosmjs/utils";
import * as k8s from '@kubernetes/client-node';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import * as fs from 'fs';
import * as path from 'path';
import { Writer } from 'protobufjs/minimal';
import winston from 'winston';
import Transport from 'winston-transport';
// 修正点4: 不要な Subscription インポートを削除

// =================================================================================================
// 📚 I. CONFIG & TYPE DEFINITIONS (変更なし)
// =================================================================================================
const CONFIG = { /* ... (変更なし) ... */
	K8S_NAMESPACE: 'raidchain',
	SECRET_NAME: 'raidchain-mnemonics',
	GAS_PRICE_STRING: '0.0000001uatom',
	GAS_MULTIPLIER: 1.5,
	HD_PATH: "m/44'/118'/0'/0/2",
	TARGET_CHAIN_NAME: 'data-0',
	NUM_TRANSACTIONS: 100,
	DATA_SIZE_BYTES: 50 * 1024,
	TX_EVENT_TIMEOUT_MS: 60000,
	WEBSOCKET_CONNECT_TIMEOUT_MS: 5000,
	RECONNECT_DELAY_MS: 3000,
};
interface TransformableInfo extends winston.Logform.TransformableInfo { level: string; message: string;[key: string]: any; }
interface ChainInfo { name: string; type: 'datachain' | 'metachain'; }
interface ExtendedChainClients {
	client: SigningStargateClient;
	account: AccountData;
	tmClient: Comet38Client; // ★ 修正
	wsClient: WebsocketClient;
}
interface MsgCreateStoredChunk { creator: string; index: string; data: Uint8Array; }
const MsgCreateStoredChunkProto = { /* ... (変更なし) ... */
	create(base?: Partial<MsgCreateStoredChunk>): MsgCreateStoredChunk { return { creator: base?.creator ?? "", index: base?.index ?? "", data: base?.data ?? new Uint8Array(), }; },
	encode(message: MsgCreateStoredChunk, writer: Writer = Writer.create()): Writer {
		if (message.creator !== '') { writer.uint32(10).string(message.creator); }
		if (message.index !== '') { writer.uint32(18).string(message.index); }
		if (message.data.length !== 0) { writer.uint32(26).bytes(message.data); }
		return writer;
	},
	decode(input: import("protobufjs").Reader | Uint8Array, length?: number | undefined): MsgCreateStoredChunk { throw new Error("Method not implemented."); } // decodeは省略
};
const customRegistry = new Registry([
	['/datachain.datastore.v1.MsgCreateStoredChunk', MsgCreateStoredChunkProto as GeneratedType],
]);

// =================================================================================================
// 📝 II. LOGGER UTILITIES (変更なし)
// =================================================================================================
class LoggerUtil { /* ... (変更なし) ... */
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
// 💻 III. KUBERNETES UTILITIES (変更なし)
// =================================================================================================
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

async function getRpcWsEndpoint(targetChainName: string): Promise<string> { /* ... (変更なし) ... */
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
async function getCreatorMnemonic(chainName: string): Promise<string> { /* ... (変更なし) ... */
	const res = await k8sApi.readNamespacedSecret({
		name: CONFIG.SECRET_NAME,
		namespace: CONFIG.K8S_NAMESPACE,
	});
	const encodedMnemonic = res.data?.[`${chainName}.mnemonic`];
	if (!encodedMnemonic) throw new Error(`Secret does not contain mnemonic for ${chainName}.`);
	return Buffer.from(encodedMnemonic, 'base64').toString('utf-8');
}

// =================================================================================================
// 🚀 IV. CHAIN CLIENT & TRANSACTION MANAGEMENT (修正あり)
// =================================================================================================
class ChainManager {
	private chainClientInfo: ExtendedChainClients | null = null;
	public readonly gasPrice: GasPrice;
	private wsUrl: string = '';

	constructor() {
		this.gasPrice = GasPrice.fromString(CONFIG.GAS_PRICE_STRING);
	}

	public async initializeClient(wsUrl: string): Promise<void> {
		this.wsUrl = wsUrl;
		const chainName = CONFIG.TARGET_CHAIN_NAME;
		try {
			const mnemonic = await getCreatorMnemonic(chainName);
			const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { hdPaths: [stringToPath(CONFIG.HD_PATH)] });
			const [account] = await wallet.getAccounts();
			if (!account) throw new Error(`Failed to get account from wallet`);

			const wsClient = new WebsocketClient(wsUrl, (err) => {
				logger.error(` WebSocket error: ${err?.message || err}. Attempting reconnect...`);
				this.reconnectClient();
			});

			// ★ 修正点5: connect() -> connected()
			const connectPromise = wsClient.execute({ jsonrpc: "2.0", method: "status", id: 1, params: [] }); // 接続確認
			const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("WebSocket connection timed out")), CONFIG.WEBSOCKET_CONNECT_TIMEOUT_MS));
			await Promise.race([connectPromise, timeoutPromise]);

			// ★ 修正点1: CometBFTClient -> Comet38Client
			const tmClient = Comet38Client.create(wsClient);
			const client = SigningStargateClient.createWithSigner(tmClient, wallet, { registry: customRegistry, gasPrice: this.gasPrice });

			this.chainClientInfo = { client, account, tmClient, wsClient };
			logger.info(`[CLIENT_SETUP] Successful for chain: ${chainName} (Address: ${account.address})`);
		} catch (e) {
			logger.error(`[CLIENT_SETUP] Failed to initialize client for chain ${chainName}:`, e);
			if (this.chainClientInfo?.wsClient) {
				this.chainClientInfo.wsClient.disconnect();
			}
			this.chainClientInfo = null;
			throw e;
		}
	}

	// reconnectClient (変更なし)
	private async reconnectClient(): Promise<void> { /* ... (変更なし) ... */
		if (!this.wsUrl) return; // URL がなければ何もしない
		logger.info(`Attempting to reconnect in ${CONFIG.RECONNECT_DELAY_MS}ms...`);
		await sleep(CONFIG.RECONNECT_DELAY_MS);
		try {
			await this.initializeClient(this.wsUrl);
		} catch (error) {
			logger.error("Reconnection failed:", error);
			// さらに待機して再試行
			this.reconnectClient();
		}
	}

	public getClientInfo(): ExtendedChainClients {
		if (!this.chainClientInfo) throw new Error(`Client not initialized`);
		return this.chainClientInfo;
	}

	// broadcastSequentialTxs (変更なし)
	public async broadcastSequentialTxs(messages: EncodeObject[], estimatedGas: number): Promise<string[]> { /* ... (変更なし) ... */
		const { client, account } = this.getClientInfo();
		const gasWanted = Math.round(estimatedGas * CONFIG.GAS_MULTIPLIER);
		const fee = calculateFee(gasWanted, this.gasPrice);
		const totalTxs = messages.length;

		const accountInfo = await client.getAccount(account.address);
		if (!accountInfo) throw new Error(`Failed to get account info`);

		let currentSequence = accountInfo.sequence;
		const accountNumber = accountInfo.accountNumber;
		const chainId = await client.getChainId();

		logger.info(`[SEQ_BROADCAST] Starting sequence: ${currentSequence}, Total Txs: ${totalTxs}.`);
		const txHashes: string[] = [];

		for (let i = 0; i < totalTxs; i++) {
			const msg = messages[i]!;
			const signedTx = await client.sign(
				account.address, [msg], fee, `Tx ${i + 1}/${totalTxs} (Seq: ${currentSequence})`,
				{ accountNumber, sequence: currentSequence, chainId }
			);
			const txRaw = Uint8Array.from(TxRaw.encode(signedTx).finish());

			try {
				const resultHash = await client.broadcastTxSync(txRaw);
				txHashes.push(resultHash);
				logger.info(` -> Tx ${i + 1} sent. Hash: ${resultHash.substring(0, 10)}... (Seq: ${currentSequence})`);
			} catch (error) {
				logger.error(`[CRITICAL_FAIL] Failed to broadcast Tx ${i + 1}. Error:`, error);
				// 一部失敗しても続行するが、ハッシュは記録しておく
				txHashes.push(`ERROR_BROADCASTING_TX_${i + 1}`);
			}
			currentSequence++;
		}
		logger.info(`[SEQ_BROADCAST] Finished broadcasting ${totalTxs} transactions.`);
		return txHashes;
	}

	// closeConnection (変更なし)
	public closeConnection(): void { /* ... (変更なし) ... */
		if (this.chainClientInfo?.wsClient) {
			this.chainClientInfo.wsClient.disconnect();
			logger.info(`[CLEANUP] WebSocket connection closed.`);
		}
		this.chainClientInfo = null;
	}
}

// =================================================================================================
// ⚙️ V. CORE LOGIC (Txイベント監視 - 修正あり)
// =================================================================================================

// waitForTxInclusionWithEvents 関数の内容を置き換え

/**
 * 指定されたTxハッシュリストの完了をTxイベントで監視する (単一購読版)
 */
async function waitForTxInclusionWithEvents(tmClient: Comet38Client, targetHashes: string[]): Promise<Map<string, boolean>> {
	const confirmationStatus = new Map<string, boolean>();
	// ★ 待機対象のハッシュを Set に入れて効率化
	const targetHashSet = new Set<string>();
	targetHashes.forEach(hash => {
		confirmationStatus.set(hash, false);
		if (!hash.startsWith("ERROR_BROADCASTING")) {
			targetHashSet.add(hash.toUpperCase()); // 大文字で比較するため
		}
	});

	let confirmedCount = 0;
	const expectedConfirmations = targetHashSet.size; // 実際に待つべき数

	// ★ リスナーとストリームを1つだけ管理
	let stream: Stream<TxEvent> | null = null;
	let listener: Listener<TxEvent> | null = null;
	let timeoutId: NodeJS.Timeout | null = null;

	return new Promise((resolve, reject) => {

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			// ★ 単一のリスナーを解除
			if (stream && listener) {
				try {
					stream.removeListener(listener);
					logger.info("[EVENT_WAIT] Cleaned up the listener.");
				} catch (e) {
					logger.warn("Error removing listener (ignoring):", e);
				}
			}
			stream = null;
			listener = null;
		};

		timeoutId = setTimeout(() => {
			cleanup();
			const unconfirmed = Array.from(confirmationStatus.entries())
				.filter(([hash, confirmed]) => targetHashSet.has(hash.toUpperCase()) && !confirmed) // 待機対象のみ
				.map(([hash, _]) => hash.substring(0, 10) + "...");
			logger.error(`[EVENT_WAIT] Timeout after ${CONFIG.TX_EVENT_TIMEOUT_MS}ms. ${confirmedCount}/${expectedConfirmations} confirmed.`);
			logger.error(` Unconfirmed: ${unconfirmed.join(', ')}`);
			reject(new Error(`Timeout waiting for Tx events. Only ${confirmedCount}/${expectedConfirmations} confirmed.`));
		}, CONFIG.TX_EVENT_TIMEOUT_MS);

		// --- ★ 単一のイベント購読 ---
		const query = `tm.event = 'Tx'`;
		stream = tmClient.subscribeTx(query) as Stream<TxEvent>; // 型アサーション

		listener = {
			next: (event: TxEvent) => {
				const receivedHash = Buffer.from(event.hash).toString("hex").toUpperCase();

				// 待機中のハッシュに含まれていて、まだ確認されていなければ処理
				if (targetHashSet.has(receivedHash) && confirmationStatus.get(receivedHash) === false) {
					const success = event.result.code === 0;
					logger.info(`[EVENT_RECV] Tx ${receivedHash.substring(0, 10)}... confirmed in block ${event.height}. Success: ${success}`);
					confirmationStatus.set(receivedHash, success); // ハッシュをキーにして結果を保存
					confirmedCount++;

					// 全ての待機対象が確認されたかチェック
					if (confirmedCount === expectedConfirmations) {
						logger.info(`[EVENT_WAIT] All ${confirmedCount} expected transactions confirmed.`);
						cleanup();
						resolve(confirmationStatus);
					}
				}
				// 待機対象外のTxイベントは無視
			},
			error: (err: any) => {
				logger.error(`[EVENT_ERROR] Error in the main Tx subscription stream:`, err);
				cleanup(); // エラー発生時は購読を中止
				reject(err); // Promiseを失敗させる
			},
			complete: () => {
				logger.warn(`[EVENT_COMPLETE] Main Tx subscription stream completed unexpectedly.`);
				// ストリームが予期せず終了した場合、未完了なら失敗とする
				if (confirmedCount < expectedConfirmations) {
					reject(new Error("Subscription stream ended before all transactions were confirmed."));
				}
				cleanup();
			},
		};

		stream.addListener(listener);
		logger.info(`[EVENT_SUB] Subscribed to all Tx events.`);
		// --- ★ 単一購読ここまで ---

		// コーナーケース
		if (expectedConfirmations === 0 && targetHashes.length > 0) {
			logger.warn("[EVENT_WAIT] No transactions to wait for (all failed broadcasting?).");
			cleanup();
			resolve(confirmationStatus);
		} else if (targetHashes.length === 0) {
			logger.info("[EVENT_WAIT] No transactions were sent.");
			cleanup();
			resolve(confirmationStatus);
		}

	}); // return new Promise
}

// =================================================================================================
// 🚀 MAIN EXECUTION (変更なし)
// =================================================================================================
async function main() {
	const chainManager = new ChainManager();
	const startTime = Date.now();

	try {
		// ... (クライアント初期化、メッセージ作成、ガス見積もり、送信は変更なし) ...
		// 1. WebSocketエンドポイント取得 & クライアント初期化
		const wsUrl = await getRpcWsEndpoint(CONFIG.TARGET_CHAIN_NAME);
		await chainManager.initializeClient(wsUrl);
		const { client, account, tmClient } = chainManager.getClientInfo(); // tmClient も取得

		// 2. 送信するメッセージを作成
		logger.info(`Preparing ${CONFIG.NUM_TRANSACTIONS} transactions...`);
		const messages: EncodeObject[] = [];
		const uniqueSuffix = `tx-event-test-${Date.now()}`;

		logger.info("Starting message creation loop..."); // ★ 追加ログ1

		for (let i = 0; i < CONFIG.NUM_TRANSACTIONS; i++) {
			const index = `${uniqueSuffix}-${i}`;
			// logger.info(`Creating message ${i + 1}`); // 必要ならループ内にもログを追加
			const data = Buffer.alloc(CONFIG.DATA_SIZE_BYTES, `Data for ${index}`);
			messages.push({
				typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk',
				value: { creator: account.address, index: index, data: data },
			});
		}

		logger.info(`Finished message creation loop. ${messages.length} messages created.`); // ★ 追加ログ2

		// 3. ガス代の見積もり (最初のメッセージを使用)
		const dummyMsg = messages[0]!;
		if (!dummyMsg) {
			throw new Error("No messages were created, cannot simulate gas.");
		}

		logger.info("Simulating gas for the first transaction..."); // ★ 追加ログ3
		const estimatedGas = await client.simulate(account.address, [dummyMsg], 'Gas Estimation');
		// ↓ 元の次のログ
		logger.info(`[GAS_SIMULATE] Estimated gas: ${estimatedGas}. Gas Wanted: ${Math.round(estimatedGas * CONFIG.GAS_MULTIPLIER)}.`);

		// 4. トランザクションを連続送信
		logger.info(`Broadcasting ${CONFIG.NUM_TRANSACTIONS} transactions...`);
		const txHashes = await chainManager.broadcastSequentialTxs(messages, estimatedGas);
		const broadcastEndTime = Date.now();
		logger.info(`Broadcasting finished in ${(broadcastEndTime - startTime) / 1000}s.`);

		// 5. Txイベントで完了を待機 (tmClient を渡す)
		logger.info(`Waiting for ${txHashes.filter(h => !h.startsWith("ERROR_BROADCASTING")).length} transactions inclusion via Tx events (Timeout: ${CONFIG.TX_EVENT_TIMEOUT_MS / 1000}s)...`);
		const confirmationResults = await waitForTxInclusionWithEvents(tmClient, txHashes); // tmClient を使用
		const confirmationEndTime = Date.now();


		// ... (結果集計、終了処理は変更なし) ...
		// 6. 結果集計
		let successCount = 0;
		let broadcastFailCount = 0;
		let executionFailCount = 0; // イベントは来たが実行失敗 or タイムアウト
		confirmationResults.forEach((confirmedAndSuccess, hash) => {
			if (hash.startsWith("ERROR_BROADCASTING")) {
				broadcastFailCount++;
			} else if (confirmedAndSuccess === true) {
				successCount++;
			} else { // confirmedAndSuccess が false
				executionFailCount++;
			}
		});

		logger.info('\n--- Test Summary ---');
		logger.info(`Total Transactions Sent Attempted: ${CONFIG.NUM_TRANSACTIONS}`);
		logger.info(`Successfully Broadcast & Executed: ${successCount}`);
		logger.info(`Broadcast Failures: ${broadcastFailCount}`);
		logger.info(`Execution Failures or Timeout: ${executionFailCount}`);
		logger.info(`Total Time: ${(confirmationEndTime - startTime) / 1000} seconds`);
		logger.info(`  (Broadcasting: ${(broadcastEndTime - startTime) / 1000}s, Confirmation: ${(confirmationEndTime - broadcastEndTime) / 1000}s)`);

		// ブロードキャスト失敗 + 実行失敗 + タイムアウト が0件の場合のみ成功
		if (executionFailCount > 0 || broadcastFailCount > 0) {
			throw new Error("Test finished with failures.");
		}

		logger.info("✅ Test completed successfully!");


	} catch (err) {
		logger.error('[MAIN] A fatal error occurred:', err);
		throw err;
	} finally {
		chainManager.closeConnection();
		await loggerUtil.flushLogs();
	}
}

// 実行
main().then(() => {
	process.exit(0);
}).catch(err => {
	console.error("Test script failed:", err);
	process.exit(1);
});