import { stringToPath } from '@cosmjs/crypto';
import { AccountData, DirectSecp256k1HdWallet, GeneratedType, Registry } from '@cosmjs/proto-signing';
import { Coin, DeliverTxResponse, GasPrice, SigningStargateClient } from '@cosmjs/stargate';
import { Tendermint37Client, WebsocketClient } from '@cosmjs/tendermint-rpc';
import * as k8s from '@kubernetes/client-node';
import cliProgress from 'cli-progress';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Reader, Writer } from 'protobufjs/minimal';
import winston from 'winston';
import Transport from 'winston-transport';
// 💡 修正点 1: Bech32 の代わりに toBech32 をインポート
import { toBech32 } from '@cosmjs/encoding';

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
	DEFAULT_CHUNK_SIZE: 16 * 1024,
	GAS_PRICE_STRING: '0.0000001uatom',
	GAS_MULTIPLIER: 1.5,
	HD_PATH: "m/44'/118'/0'/0/2",
	MAX_RETRIES: 3,
	RETRY_BACKOFF_MS: 500,
	DEFAULT_TEST_SIZE_KB: 100,
	// 監視対象のチェーン名
	TARGET_CHAIN_NAME: 'data-0',
	// Cosmos SDK のデフォルトのプレフィックス
	BECH32_PREFIX: 'cosmos',
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

// プロトコルバッファ型定義とレジストリ (監視スクリプトでは不要だが、既存コードに合わせて残す)
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
			transports: [
				new LogBufferTransport(this.logBuffer),
				// ブロック監視のメイン処理を見やすくするためコンソール出力も追加
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

	/**
	 * プログラム終了時またはエラー時にログをファイルに書き込む
	 */
	public async flushLogs() {
		if (this.logBuffer.length === 0) return;
		const logContent = this.logBuffer
			.map(info => {
				// transportで既にフォーマットされているが、念のため再度formatを通す
				const transformed = this.logger.format.transform(info, {});
				// Console Transportのログを除く
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
	// 監視対象チェーンのみフィルタリング
	const chains: ChainInfo[] = resPods.items
		.filter(pod => pod.metadata!.labels!['app.kubernetes.io/instance']! === CONFIG.TARGET_CHAIN_NAME)
		.map(pod => ({
			name: pod.metadata!.labels!['app.kubernetes.io/instance']!,
			type: pod.metadata!.labels!['app.kubernetes.io/component']! as any,
		}));

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
			// Cluster internal access
			rpcEndpoints[chain.name] = `http://raidchain-${chain.name}-0.raidchain-chain-headless.${CONFIG.K8S_NAMESPACE}.svc.cluster.local:26657`;
			restEndpoints[chain.name] = `http://raidchain-${chain.name}-0.raidchain-chain-headless.${CONFIG.K8S_NAMESPACE}.svc.cluster.local:1317`;
		}
	}
	return { chains, rpcEndpoints, restEndpoints };
}

/**
 * Kubernetes Secretからニーモニックを取得する
 * 監視スクリプトでは不要だが、Client初期化のために残す
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
	 * 監視対象チェーンのクライアントのみを初期化する
	 */
	public async initializeClients(allChains: ChainInfo[], rpcEndpoints: ChainEndpoints, restEndpoints: ChainEndpoints): Promise<void> {
		const chain = allChains.find(c => c.name === CONFIG.TARGET_CHAIN_NAME);
		if (!chain) {
			throw new Error(`Target chain ${CONFIG.TARGET_CHAIN_NAME} not found in resources.`);
		}

		try {
			// ニーモニックはClient作成に必要だが、ここでは監視が主目的なので使わない
			const mnemonic = await getCreatorMnemonic(chain.name);
			const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { hdPaths: [stringToPath(CONFIG.HD_PATH)], prefix: CONFIG.BECH32_PREFIX });
			const [account] = await wallet.getAccounts();
			if (!account) throw new Error(`Failed to get account from wallet for chain ${chain.name}`);

			// RPC URLをWS形式に変換
			const rpcUrl = rpcEndpoints[chain.name]!.replace('http', 'ws');

			// WebsocketClientをセットアップ
			const wsClient = new WebsocketClient(rpcUrl, (err) => {
				if (err) {
					logger.error(`[${chain.name}] WebSocket connection error: ${err.message}. Retrying in 5s...`);
					setTimeout(() => this.initializeClients(allChains, rpcEndpoints, restEndpoints), 5000);
				}
			});

			await wsClient.execute({ jsonrpc: "2.0", method: "status", id: 1, params: [] }); // 接続確認
			const tmClient = await Tendermint37Client.create(wsClient);

			// 署名機能は不要だが、既存の型定義に合わせるためStargateClientも作成
			const client = await SigningStargateClient.createWithSigner(tmClient, wallet, { registry: customRegistry, gasPrice: this.gasPrice });

			this.chainClients.set(chain.name, { client, account, tmClient, wsClient, restEndpoint: restEndpoints[chain.name]! });
			logger.info(`[CLIENT_SETUP] Successful for chain: ${chain.name} (Address: ${account.address}). RPC URL: ${rpcUrl}`);
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

	public getClients(): Map<string, ExtendedChainClients> {
		return this.chainClients;
	}

	// ----------------------------------------------
	// 監視スクリプトでは以下のメソッドは不要なので削除または簡略化
	// ----------------------------------------------
	public async uploadChunk(...args: any[]): Promise<DeliverTxResponse> { throw new Error("Method not implemented for monitoring script."); }
	public async uploadManifest(...args: any[]): Promise<DeliverTxResponse> { throw new Error("Method not implemented for monitoring script."); }
	public async queryStoredManifest(...args: any[]): Promise<StoredManifestResponse> { throw new Error("Method not implemented for monitoring script."); }
	public async queryStoredChunk(...args: any[]): Promise<StoredChunkResponse> { throw new Error("Method not implemented for monitoring script."); }


	/**
	 * WebSocketクライアントをすべて切断する
	 */
	public closeAllConnections(): void {
		for (const { wsClient, tmClient } of this.chainClients.values()) {
			wsClient.disconnect();
			(tmClient as any).disconnect(); // disconnectの型定義が不完全な場合があるためany
			logger.info(`[CLEANUP] Connection closed for ${CONFIG.TARGET_CHAIN_NAME}.`);
		}
	}
}

// =================================================================================================
// ⚙️ V. CORE BUSINESS LOGIC (MAIN)
// =================================================================================================

/**
 * TendermintのValidatorコンセンサスアドレス(Proposer Address)から、
 * 対応するCosmos SDKのアカウントアドレスを取得する。
 * @param proposerAddress Tendermintのコンセンサスアドレス (Uint8Array)
 * @returns Cosmosアカウントアドレス (例: cosmos1...)
 */
// 💡 修正点 2: toBech32 関数を使用するように変更
async function getCosmosAccountAddressFromProposer(proposerAddress: Uint8Array): Promise<string> {
	const proposerHex = Buffer.from(proposerAddress).toString('hex').toUpperCase();

	try {
		// Tendermintのコンセンサスアドレスのバイト列を、
		// toBech32 関数を使って Cosmos アカウントアドレスのプレフィックスでエンコードします。
		const cosmosAddress = toBech32(CONFIG.BECH32_PREFIX, proposerAddress);
		return cosmosAddress;
	} catch (e) {
		logger.warn(`[ADDR_CONV_ERROR] Failed to convert proposer address ${proposerHex} to Cosmos address:`, e);
		return `TENDERMINT_HEX:${proposerHex}`;
	}
}

/**
 * 特定のCosmosアドレスの残高を取得する
 * @param client StargateClient (残高クエリ用)
 * @param address アカウントアドレス
 * @returns 資金情報 (Coinオブジェクトの配列)
 */
async function getAccountBalances(client: SigningStargateClient, address: string): Promise<readonly Coin[]> {
	try {
		// addressが有効なCosmosアドレス形式でない場合はエラーになるため、try-catchでラップ
		const balances = await client.getAllBalances(address);
		return balances;
	} catch (e) {
		logger.error(`[BALANCE_QUERY_ERROR] Failed to fetch balances for ${address}:`, e);
		return [{ amount: 'ERROR', denom: 'ERROR' }];
	}
}

/**
 * ブロック生成イベントの監視を開始する
 */
async function startBlockMonitoring(chainManager: ChainManager): Promise<void> {
	const chainName = CONFIG.TARGET_CHAIN_NAME;
	const { tmClient, client } = chainManager.getClientInfo(chainName);

	logger.info(`✅ ${chainName} のブロック生成イベントの購読を開始しました。`);

	const subscription = tmClient.subscribeNewBlock();

	subscription.addListener({
		next: async (event: any) => {

			const blockHeader = event.header;
			const height = blockHeader.height;
			const blockTxs = event.txs;

			if (!blockHeader) {
				logger.warn(`[EVENT_PARSE] Received NewBlockEvent but could not find header data:`, event);
				return;
			}

			// tmClient.block(height) を使用して正確なブロックハッシュを取得
			let blockHash: Uint8Array;
			try {
				const blockResponse: any = await tmClient.block(height);
				blockHash = blockResponse.blockId.hash;
			} catch (e) {
				logger.error(`[RPC_ERROR] Failed to fetch block details for height ${height}. Falling back to lastCommitHash:`, e);
				blockHash = blockHeader.lastCommitHash;
			}

			// 💡 修正点 3: 変更後のアドレス変換関数を使用
			const proposerTendermintAddress = blockHeader.proposerAddress; // Uint8Array
			const proposerCosmosAddress = await getCosmosAccountAddressFromProposer(proposerTendermintAddress);

			// 💡 修正点 4: ブロック作成者の残高を取得
			let balances: readonly Coin[] = [];
			// 変換に失敗していない場合のみ残高を取得
			if (!proposerCosmosAddress.startsWith('TENDERMINT_HEX')) {
				balances = await getAccountBalances(client, proposerCosmosAddress);
			}

			// 抽出した情報を整形して出力
			logger.info(`--------------------------------------------------------------------------------`);
			logger.info(`🧱 NEW BLOCK | CHAIN: ${chainName}`);
			logger.info(`- HEIGHT: ${height}`);

			// 正確なブロックハッシュを出力
			logger.info(`- HASH: ${Buffer.from(blockHash).toString('hex').toUpperCase()}`);

			logger.info(`- TIME: ${new Date(blockHeader.time).toISOString()}`);
			logger.info(`- TX COUNT: ${blockTxs.length}`);

			// ブロック作成者の情報を追加
			logger.info(`- PROPOSER (Consensus Key): ${Buffer.from(proposerTendermintAddress).toString('hex').toUpperCase()}`);
			logger.info(`- PROPOSER (Cosmos Address): ${proposerCosmosAddress}`);
			logger.info(`- PROPOSER (Balance): ${balances.map(b => `${b.amount}${b.denom}`).join(', ')}`);

			// トランザクションハッシュをすべて取得して表示
			logger.info(`- TRANSACTIONS[${blockTxs.length}]:`);
			if (blockTxs.length > 0) {
				blockTxs.forEach((tx: Uint8Array, index: number) => {
					const txBase64 = tx ? Buffer.from(tx)
						.toString('base64').substring(0, 40) + '...'
						: 'N/A';
					logger.info(`  ${txBase64}`);
				});
			}
			logger.info(`--------------------------------------------------------------------------------`);
		},
		// エラーが発生したときに実行されるコールバック
		error: (err: any) => {
			logger.error(`[STREAM_ERROR] Block subscription error on ${chainName}:`, err);
			// 監視プロセスが落ちないように、エラーはログに記録するのみ
		},
		// ストリームが終了したときに実行されるコールバック (通常は到達しない)
		complete: () => {
			logger.warn(`[STREAM_COMPLETE] Block subscription unexpectedly completed on ${chainName}.`);
		},
	});

	// 購読が停止しないように無限に待機するPromiseを返す
	return new Promise<void>(() => { });
}

/**
 * メインの監視処理
 */
async function main() {
	const chainManager = new ChainManager();

	try {
		// 1. 環境設定とクライアント初期化
		const { chains, rpcEndpoints, restEndpoints } = await getChainResources();
		await chainManager.initializeClients(chains, rpcEndpoints, restEndpoints);

		// 2. ブロック監視の開始
		await startBlockMonitoring(chainManager);

		// 監視プロセスは意図的に終了させない
		// 終了させる場合はCtrl+Cなどで停止

	} catch (err) {
		logger.error('[MAIN] A fatal error occurred:', err);
		throw err;
	} finally {
		// 監視プロセスは永続的に実行されるため、通常はここには到達しない
		// ただし、エラーで終了した場合は接続を閉じる
		chainManager.closeAllConnections();
	}
}

// 実行と最終的なエラーハンドリング
main().then(async () => {
	// ここは、通常到達しない (監視は無限ループのため)
	logger.info('[MAIN] Script finished successfully.');
}).catch(async err => {
	logger.error('Uncaught fatal error in main execution loop:', err);
	await loggerUtil.flushLogs();
	process.exit(1);
});