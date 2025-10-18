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
    BLOCK_SIZE_LIMIT_MB: 15,
    DEFAULT_CHUNK_SIZE: 512 * 1024,
    // 💡 修正: ログに基づき 0.4 (約8MB) に変更
    EFFECTIVE_BLOCK_SIZE_RATIO: 0.8, // 40%
    TX_OVERHEAD_RATIO: 1.1, // 10%
    
    // 💡 新規追加: パイプライン制御 (先行送信するバッチ数)
    PIPELINE_MAX_PENDING_BATCHES: 2, 
    
    // 💡 新規追加: Mempool監視と再接続のための設定
    MEMPOOL_TX_LIMIT: 80, // Mempoolがこの数未満になるまで待機
    MEMPOOL_CHECK_INTERVAL_MS: 5000, // Mempoolが満杯の時の待機時間
    RECONNECT_DELAY_MS: 3000, // 再接続試行時の待機時間
    WEBSOCKET_CONNECT_TIMEOUT_MS: 5000, // WebSocket接続タイムアウト

    GAS_PRICE_STRING: '0.0000001uatom',
    GAS_MULTIPLIER: 1.5,
    HD_PATH: "m/44'/118'/0'/0/2",
    MAX_RETRIES: 3,
    RETRY_BACKOFF_MS: 500,
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

// 💡 修正: Txがブロックに取り込まれるのを待つ関数 (ポーリング設定変更)
// ChainManagerの外に定義し、共通ヘルパーとする
async function waitForTxInclusion(client: SigningStargateClient, hash: string): Promise<IndexedTx> {
    // 💡 修正: 1秒おきに80回 (80秒タイムアウト)
    // 32秒のブロックタイムに対応するため
    const MAX_POLLING_ATTEMPTS = 200;
    const POLLING_INTERVAL_MS = 500; 

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

    // 💡 K8sリソース情報をクラスプロパティとして保持
    private allChains: ChainInfo[] = [];
    private rpcEndpoints: ChainEndpoints = {};
    private restEndpoints: ChainEndpoints = {};

    constructor() {
        this.gasPrice = GasPrice.fromString(CONFIG.GAS_PRICE_STRING);
    }

    /**
     * 💡 修正: initializeClients で使用する内部メソッドとして切り出す
     */
    private async setupSingleClient(chain: ChainInfo, rpcEndpoints: ChainEndpoints, restEndpoints: ChainEndpoints): Promise<void> {
        const chainName = chain.name;
        try {
            const mnemonic = await getCreatorMnemonic(chainName);
            const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { hdPaths: [stringToPath(CONFIG.HD_PATH)] });
            const [account] = await wallet.getAccounts();
            if (!account) throw new Error(`Failed to get account from wallet for chain ${chainName}`);

            const rpcUrl = rpcEndpoints[chainName]!.replace('http', 'ws');
            const wsClient = new WebsocketClient(rpcUrl, (err) => { 
                if (err) { logger.warn(`[${chainName}] WebSocket connection error: ${err.message}`); } 
            });
            
            // 接続試行 (タイムアウト付き)
            const connectPromise = wsClient.execute({ jsonrpc: "2.0", method: "status", id: 1, params: [] });
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("WebSocket connection timed out")), CONFIG.WEBSOCKET_CONNECT_TIMEOUT_MS));
            
            // タイムアウトを検知するために Promise.race を使用
            await Promise.race([connectPromise, timeoutPromise]);
            
            const tmClient = Tendermint37Client.create(wsClient);
            const client = SigningStargateClient.createWithSigner(tmClient, wallet, { registry: customRegistry, gasPrice: this.gasPrice });

            this.chainClients.set(chainName, { client, account, tmClient, wsClient, restEndpoint: restEndpoints[chainName]! });
            logger.info(`[CLIENT_SETUP] Successful for chain: ${chainName} (Address: ${account.address})`);
        } catch (e) {
            logger.error(`[CLIENT_SETUP] Failed to initialize client for chain ${chainName}:`, e);
            throw e;
        }
    }

    /**
     * すべてのチェーンのクライアントを初期化する
     */
    public async initializeClients(allChains: ChainInfo[], rpcEndpoints: ChainEndpoints, restEndpoints: ChainEndpoints): Promise<void> {
        // 💡 K8sリソース情報を保持（再接続時に使用）
        this.allChains = allChains;
        this.rpcEndpoints = rpcEndpoints;
        this.restEndpoints = restEndpoints;
        
        const initPromises = allChains.map(chain => 
            this.setupSingleClient(chain, rpcEndpoints, restEndpoints)
        );
        await Promise.all(initPromises);
    }

    /**
     * 💡 新規追加: 指定されたチェーンのクライアントを再接続する
     */
    public async reconnectClient(chainName: string): Promise<void> {
        logger.warn(`[${chainName}] Attempting to reconnect client...`);
        
        // 1. 古い接続を明示的に切断
        const oldClientInfo = this.chainClients.get(chainName);
        if (oldClientInfo) {
            try {
                oldClientInfo.wsClient.disconnect();
                (oldClientInfo.tmClient as any).disconnect();
            } catch (e) {
                logger.warn(`[${chainName}] Error during old client disconnection (ignoring):`, e);
            }
        }
        
        // 2. K8sリソース情報を使って新しいクライアントをセットアップ
        const chainInfo = this.allChains.find(c => c.name === chainName);
        if (!chainInfo) {
            throw new Error(`[${chainName}] Cannot reconnect: ChainInfo not found.`);
        }
        
        // setupSingleClient が this.chainClients.set() を行う
        await this.setupSingleClient(chainInfo, this.rpcEndpoints, this.restEndpoints);
    }


    public getClientInfo(chainName: string): ExtendedChainClients {
        const clientInfo = this.chainClients.get(chainName);
        if (!clientInfo) throw new Error(`Client not initialized for chain: ${chainName}`);
        return clientInfo;
    }

    /**
     * 💡 新規追加: Mempoolの未確認Tx数を取得する (ヘルスチェック兼用)
     */
    public async getMempoolTxCount(chainName: string): Promise<number> {
        const { tmClient } = this.getClientInfo(chainName);
        
        // unconfirmedTxs は接続チェックとして機能する
        // limit=1 を指定して、Txリスト自体は取得しないようにし、負荷を最小限にする
        const {total} = await tmClient.numUnconfirmedTxs(); 
        return isNaN(total) ? 0 : total;
    }

    /**
     * 💡 復活: 待機専用の関数
     * @param chainName ターゲットチェーン名
     * @param txHashes 待機するTxハッシュの配列
     * @param bar cliProgress.SingleBar (進捗更新用)
     * @param completedTxOffset このバッチ開始前の完了数
     * @param totalTxInBatch このバッチの総数
     * @returns ブロックに取り込まれた全てのトランザクション結果 (IndexedTx)
     */
    public async waitForBatchInclusion(
        chainName: string,
        txHashes: string[],
        bar: cliProgress.SingleBar,
        completedTxOffset: number, // このバッチ開始前の完了数
        totalTxInBatch: number // このバッチの総数
    ): Promise<IndexedTx[]> {
        const { client } = this.getClientInfo(chainName);
        let completedTxCountInBatch = 0;
        const txStartTime = Date.now();
        
        const inclusionPromises = txHashes.map(hash =>
            waitForTxInclusion(client, hash) // 💡 ポーリング設定を変更したヘルパー関数
        );

        const results = await Promise.all(inclusionPromises.map((p, index) => p.then(result => {
            completedTxCountInBatch++;
            const totalCompleted = completedTxOffset + completedTxCountInBatch;
            const txPerSec = (completedTxCountInBatch * 1000 / (Date.now() - txStartTime)).toFixed(2);
            
            bar.update(totalCompleted, { 
                height: result.height, 
                tx_per_sec: txPerSec, 
                status: `Confirming (${completedTxCountInBatch}/${totalTxInBatch})` 
            });
            return result;
        }).catch(e => {
            throw e;
        })));
        
        return results;
    }

    /**
     * 💡 修正: こちらは「送信専用」の関数とする (待機ロジックを削除)
     * @param currentSequenceRef 💡ノンスを外部から参照渡しで管理
     * @returns 成功した Tx ハッシュの配列
     */
    public async broadcastSequentialTxs(
        chainName: string, 
        messages: EncodeObject[], 
        estimatedGas: number, 
        bar: cliProgress.SingleBar,
        completedTxOffset: number = 0,
        currentSequenceRef: { sequence: number } // 💡 ノンスを外部から参照渡しで管理
    ): Promise<string[]> { // 💡 戻り値を IndexedTx[] から string[] (ハッシュ配列) に変更
        
        const { client, account } = this.getClientInfo(chainName);
        const gasWanted = Math.round(estimatedGas * CONFIG.GAS_MULTIPLIER);
        const fee = calculateFee(gasWanted, this.gasPrice);
        const totalTxsInBatch = messages.length; 

        const accountInfo = await client.getAccount(account.address);
        if (!accountInfo) throw new Error(`Failed to get account info for ${account.address}`);
        
        const accountNumber = accountInfo.accountNumber;
        const chainId = await client.getChainId();

        const txHashes: string[] = [];
        // 💡 削除: 待機ロジック (completedTxCountInBatch, txStartTime)

        // 1. 署名と同期ブロードキャスト (ノンスねじ込み)
        for (let i = 0; i < totalTxsInBatch; i++) {
            const msg = messages[i]!;
            const sequence = currentSequenceRef.sequence; // 参照から取得

            const signedTx = await client.sign(
                account.address, [msg], fee,
                `Batch Tx (Seq: ${sequence})`,
                { accountNumber, sequence, chainId }
            );
            const txRaw = Uint8Array.from(TxRaw.encode(signedTx).finish());

            try {
                const resultHash = await client.broadcastTxSync(txRaw);
                txHashes.push(resultHash);
                currentSequenceRef.sequence++; // 💡 参照元のノンスをインクリメント
                
                // 💡 修正: バーの値 (value) は変更せず、status のみ更新
                bar.update(completedTxOffset, { status: `Broadcasting ${txHashes.length}/${totalTxsInBatch}` });

            } catch (error) {
                logger.error(`[CRITICAL_FAIL] Tx (Seq ${sequence}) failed to broadcast on ${chainName}. Error:`, error);
                // 💡 再接続を促すためにエラーをスロー
                throw new Error(`Broadcast failure (Seq ${sequence}) on ${chainName}: ${error}`); 
            }
        }

        // 💡 削除: 待機ロジック (waitForTxInclusion, Promise.all)
        
        return txHashes; // 💡 送信したハッシュのリストを返す
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


// 💡 新規追加: Mempool待機＆ヘルスチェックヘルパー
/**
 * Mempoolに空きができるまで待機し、その過程で接続ヘルスチェックを行う
 */
async function waitForMempoolSpace(
    chainManager: ChainManager, 
    chainName: string, 
    bar: cliProgress.SingleBar,
    currentValue: number // プログレスバーの現在値
) {
    const MEMPOOL_LIMIT = CONFIG.MEMPOOL_TX_LIMIT;
    let isReconnecting = false; // 再接続中フラグ
    
    while (true) {
        try {
            // 1. ヘルスチェックとMempool件数取得を試みる
            const count = await chainManager.getMempoolTxCount(chainName);
            
            // 接続成功
            if (isReconnecting) {
                logger.info(`[${chainName}] Reconnection successful.`);
                bar.update(currentValue, { status: `Reconnected. Resuming...` });
                isReconnecting = false;
            }
            
            if (count < MEMPOOL_LIMIT) {
                // 成功：Mempoolに空きあり
                return; 
            }
            
            // 成功：Mempoolが満杯
            bar.update(currentValue, { status: `Mempool full (${count} txs). Waiting...` });
            await new Promise(resolve => setTimeout(resolve, CONFIG.MEMPOOL_CHECK_INTERVAL_MS));
            
        } catch (e: any) {
            // 失敗：接続エラーの可能性
            logger.warn(`[${chainName}] Mempool check failed (Connection error?). Retrying connection...`, e.message);
            bar.update(currentValue, { status: `Connection error. Reconnecting...` });
            isReconnecting = true;
            
            try {
                // 2. 再接続を試みる
                await chainManager.reconnectClient(chainName); 
                // 成功した場合、次のループの冒頭で `getMempoolTxCount` が成功し、フラグがリセットされる
            } catch (reconnectError: any) {
                // 3. 再接続失敗
                logger.error(`[${chainName}] Reconnection failed. Waiting...`, reconnectError.message);
                bar.update(currentValue, { status: `Reconnect failed. Waiting...` });
                await new Promise(resolve => setTimeout(resolve, CONFIG.RECONNECT_DELAY_MS));
            }
        }
    }
}


/**
 * 💡 修正点: ヘルスチェック付きパイプライン処理を実装
 */
async function executeDistributionWorkers(chainManager: ChainManager, megaJobsByChain: Map<string, MegaChunkJob[]>, dataChains: ChainInfo[], estimatedGas: number): Promise<void> {

    // 💡 修正点: ログに基づき、動的なバッチサイズ（件数）を計算
    const MINI_CHUNK_SIZE_WITH_OVERHEAD = CONFIG.DEFAULT_CHUNK_SIZE * CONFIG.TX_OVERHEAD_RATIO;
    const TARGET_BATCH_BYTES = CONFIG.BLOCK_SIZE_LIMIT_MB * 1024 * 1024 * CONFIG.EFFECTIVE_BLOCK_SIZE_RATIO;
    // 1ブロックに安全に入ると推定されるTx件数
    const DYNAMIC_BATCH_SIZE = Math.max(1, Math.floor(TARGET_BATCH_BYTES / MINI_CHUNK_SIZE_WITH_OVERHEAD));

    logger.info(`[GLOBAL_INFO] Dynamic Batch Size calculated: ${DYNAMIC_BATCH_SIZE} TXs per batch (Target: ${Math.round(TARGET_BATCH_BYTES / 1024 / 1024)}MB / Block)`);
    logger.info(`[GLOBAL_INFO] Pipeline depth (pending batches): ${CONFIG.PIPELINE_MAX_PENDING_BATCHES}`);


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

            // 💡 変更点: メッセージ配列を DYNAMIC_BATCH_SIZE ごとにバッチ化
            const messageBatches: EncodeObject[][] = [];
            for (let i = 0; i < messages.length; i += DYNAMIC_BATCH_SIZE) {
                messageBatches.push(messages.slice(i, i + DYNAMIC_BATCH_SIZE));
            }
            logger.info(`[WORKER_INFO] ${chainName} split into ${messageBatches.length} batches (Size: ${DYNAMIC_BATCH_SIZE}).`);

            let completedTxOffset = 0; // 💡 「完了済み」Tx数

            // 💡 修正: ノンス情報をワーカー内で管理 (再接続後も一貫性を保つため)
            let accountInfo;
            try {
                 accountInfo = await chainManager.getClientInfo(chainName).client.getAccount(account.address);
            } catch (e) {
                 // 起動直後に接続失敗した場合、Mempoolチェックで再接続させる
                 logger.warn(`[${chainName}] Initial getAccount failed. Will retry via Mempool check...`);
                 accountInfo = { sequence: 0 }; // 仮の値
            }
            
            const currentSequenceRef = { sequence: accountInfo?.sequence ?? 0 }; // 参照オブジェクト

            // 💡 変更点: ヘルスチェック付きパイプライン処理
            const inclusionWaiters: Promise<IndexedTx[]>[] = []; // 待機専用リスト

            try {
                for (let batchIndex = 0; batchIndex < messageBatches.length; batchIndex++) {
                    const batchMessages = messageBatches[batchIndex]!;
                    
                    // 💡 (1) Mempoolチェック ＆ ヘルスチェック (送信前に実行)
                    // bar の値は「完了済みTx数」を渡す
                    bar.update(completedTxOffset, { status: `Batch ${batchIndex + 1}/${messageBatches.length} Checking mempool...` });
                    await waitForMempoolSpace(chainManager, chainName, bar, completedTxOffset);
                    
                    // 💡 (1b) もしノンスが初期化されていなければ、再接続後に再取得
                    if (currentSequenceRef.sequence === 0) {
                        logger.info(`[${chainName}] Re-fetching sequence after connection recovery.`);
                        const postRecoveryAccount = await chainManager.getClientInfo(chainName).client.getAccount(account.address);
                        if(postRecoveryAccount){
                            currentSequenceRef.sequence = postRecoveryAccount.sequence;
                            logger.info(`[${chainName}] Sequence set to ${currentSequenceRef.sequence}`);
                        }
                    }


                    // 💡 (2) 同期バッチ送信 (送信専用)
                    // bar の値は「完了済みTx数」を渡す
                    bar.update(completedTxOffset, { status: `Batch ${batchIndex + 1}/${messageBatches.length} Signing & Broadcasting` });
                    
                    const txHashes = await chainManager.broadcastSequentialTxs(
                        chainName, 
                        batchMessages, 
                        estimatedGas, 
                        bar,
                        completedTxOffset, // 💡 バーの更新オフセット
                        currentSequenceRef // 💡 ノンス参照を渡す
                    );
                    
                    // 💡 (3) 待機プロセスを非同期で開始
                    const waiterPromise = chainManager.waitForBatchInclusion(
                        chainName,
                        txHashes,
                        bar,
                        completedTxOffset, // オフセット (このバッチの開始地点)
                        batchMessages.length      // このバッチの総数
                    );
                    
                    // 待機リストに追加し、完了したらオフセットを更新
                    inclusionWaiters.push(waiterPromise.then(results => {
                        completedTxOffset += results.length; // 💡 完了時にオフセットを増やす
                        return results;
                    }));

                    // 💡 (4) 待機リストが溜まりすぎたら待つ (背圧)
                    if (inclusionWaiters.length >= CONFIG.PIPELINE_MAX_PENDING_BATCHES) { 
                       bar.update(completedTxOffset, { status: `Waiting (Pipeline full)...` });
                       // 💡 一番古いバッチの完了を待つ (shift() してリストから削除)
                       await inclusionWaiters.shift(); 
                    }
                }

                // 💡 (5) 残りの待機プロセスをすべて待つ
                bar.update(completedTxOffset, { status: 'All batches sent. Waiting for final confirmations...' });
                await Promise.all(inclusionWaiters);

                bar.update(totalMiniChunks, { status: `Finished` });

            } catch (error) {
                // broadcastSequentialTxs がエラーをスローした場合
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
        
        let estimatedGas: number;
        try {
            estimatedGas = await dataChainClient.client.simulate(dataChainClient.account.address, [dummyMsg], 'Gas Estimation');
        } catch (simError) {
            logger.warn("[GAS_SIMULATE] Initial simulation failed, likely due to connection issue. Using fallback gas.", simError);
            estimatedGas = 5000000; // 💡 フォールバックのガス代 (512KBのデータサイズに基づく仮の値)
            // 💡 Mempoolチェックで再接続されることを期待
        }

        logger.info(`[GAS_SIMULATE] Initial estimated gas for one ${Math.round(CONFIG.DEFAULT_CHUNK_SIZE / 1024)}KB chunk: ${estimatedGas}. Gas Wanted: ${Math.round(estimatedGas * CONFIG.GAS_MULTIPLIER)}.`);

        // 4. チャンクアップロード実行 (分散並列 + 内部ノンスねじ込み + 動的バッチ処理 + ヘルスチェック)
        logger.info('[MAIN] Starting distributed sequential chunk uploads (Pipelined + HealthCheck + Mempool aware)...');
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