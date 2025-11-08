// controller/src/strategies/upload/AutoDistributeUploadStrategy.ts
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { EncodeObject } from '@cosmjs/proto-signing';
import { calculateFee, DeliverTxResponse, GasPrice, SignerData, StdFee } from '@cosmjs/stargate';
import { CometClient } from '@cosmjs/tendermint-rpc';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { DEFAULT_GAS_PRICE } from '../../core/ChainManager';
import {
	ChainInfo,
	Manifest,
	MsgCreateStoredChunk,
	MsgCreateStoredManifest,
	RunnerContext,
	TransactionInfo,
	UploadResult
} from '../../types';
import { log } from '../../utils/logger';
import { sleep } from '../../utils/retry';
import { IUploadStrategy } from './IUploadStrategy';

// デフォルトのチャンクサイズ (1MB)
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
// 一度に送信するバッチサイズ (Tx数)
const DEFAULT_BATCH_SIZE = 100;
// シミュレーション失敗時のフォールバックガスリミット
const FALLBACK_GAS_LIMIT = '60000000';

// Mempool 監視設定
const MEMPOOL_BYTES_LIMIT = 50 * 1024 * 1024; // 50MB
const MEMPOOL_POLL_INTERVAL_MS = 250;
const MEMPOOL_WAIT_TIMEOUT_MS = 30000; // 30秒

/**
 * 各 datachain の Mempool 状況を監視し、
 * 動的に（最も空いているチェーンに）チャンクバッチを割り当てる戦略。
 */
export class AutoDistributeUploadStrategy implements IUploadStrategy {
	constructor() {
		log.debug('AutoDistributeUploadStrategy がインスタンス化されました。');
	}

	/**
	 * 動的分散アップロード処理を実行します。
	 * @param context 実行コンテキスト
	 * @param data アップロード対象のデータ
	 * @param targetUrl このデータに関連付けるURL - エンコード前
	 */
	public async execute(
		context: RunnerContext,
		data: Buffer,
		targetUrl: string // ★ エンコード前のURLを受け取る
	): Promise<UploadResult> {

		// ★ 追加: UrlPathCodec をコンテキストから取得
		const { config, chainManager, tracker, confirmationStrategy, gasEstimationStrategy, urlPathCodec } = context;
		tracker.markUploadStart();
		// ★ 修正: ログにRaw URL を使用
		log.info(`[AutoDistribute] 開始... URL (Raw): ${targetUrl}, データサイズ: ${data.length} bytes`);

		// ★ 追加: URLを解析
		const urlParts = urlPathCodec.parseTargetUrl(targetUrl);

		// 1. 設定と対象チェーンの決定
		const options = config.uploadStrategyOptions ?? {};

		const allDatachains = chainManager.getDatachainInfos();
		const chainCount = config.chainCount && typeof config.chainCount === 'number'
			? config.chainCount
			: allDatachains.length;

		const targetDatachains = allDatachains.slice(0, chainCount);

		if (targetDatachains.length === 0) {
			throw new Error('[AutoDistribute] 利用可能な datachain が0件です。');
		}

		const metachain = chainManager.getMetachainInfo();
		const metachainAccount = chainManager.getChainAccount(metachain.name);

		const chunkSize = options.chunkSize === 'auto' || !options.chunkSize ? DEFAULT_CHUNK_SIZE : options.chunkSize;
		tracker.setChunkSizeUsed(chunkSize);

		const batchSize = DEFAULT_BATCH_SIZE;

		log.info(`[AutoDistribute] 対象チェーン: ${targetDatachains.map(c => c.name).join(', ')} (${targetDatachains.length}件)`);
		log.info(`[AutoDistribute] チャンクサイズ: ${chunkSize} bytes, バッチサイズ: ${batchSize} txs`);

		// 2. データチャンク化とインデックス生成
		const fileHash = toHex(sha256(data)).toLowerCase();
		const chunkIndexes: string[] = [];
		const chunks: Buffer[] = [];

		for (let i = 0; i < data.length; i += chunkSize) {
			const chunk = data.subarray(i, i + chunkSize);
			chunks.push(chunk);
			chunkIndexes.push(`${fileHash}-${chunks.length - 1}`);
		}
		log.info(`[AutoDistribute] データは ${chunks.length} 個のチャンクに分割されました。`);

		// 3. ガスシミュレーション
		let estimatedGasLimit = FALLBACK_GAS_LIMIT;
		if (chunks.length > 0 && chunks[0]) {
			const targetChainNameForSim = targetDatachains[0]!.name;
			const sampleMsg: EncodeObject = {
				typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk',
				value: {
					creator: chainManager.getAddress(targetChainNameForSim),
					index: chunkIndexes[0]!,
					data: chunks[0],
				} as MsgCreateStoredChunk
			};
			estimatedGasLimit = await gasEstimationStrategy.estimateGasLimit(
				context,
				targetChainNameForSim,
				sampleMsg
			);
		} else {
			log.warn('[AutoDistribute] チャンクデータが存在しないため、ガスシミュレーションをスキップします。');
		}

		// 4. 全チャンクをバッチに分割 (キューの作成)
		const totalBatches = Math.ceil(chunks.length / batchSize);
		const batchQueue: { chunks: Buffer[]; indexes: string[] }[] = [];

		for (let i = 0; i < totalBatches; i++) {
			const batchStartIndex = i * batchSize;
			const batchEndIndex = Math.min((i + 1) * batchSize, chunks.length);
			batchQueue.push({
				chunks: chunks.slice(batchStartIndex, batchEndIndex),
				indexes: chunkIndexes.slice(batchStartIndex, batchEndIndex),
			});
		}

		// 5. ワーカー（チェーン）プールの管理とMempool監視によるバッチ処理
		log.step(`[AutoDistribute] ${batchQueue.length} バッチを ${targetDatachains.length} チェーン（ワーカー）で処理開始... (GasLimit: ${estimatedGasLimit})`);

		let totalSuccess = true;
		const processingPromises = new Set<Promise<any>>();

		const chainClients = new Map<string, CometClient>();
		for (const chain of targetDatachains) {
			const client = await this.getTmClient(context, chain.name);
			chainClients.set(chain.name, client);
		}

		while (batchQueue.length > 0) {
			const availableChain = await this.findAvailableChain(chainClients);

			if (!availableChain) {
				log.error('[AutoDistribute] 空いているチェーンが見つかりませんでした (タイムアウト)。アップロードを中断します。');
				totalSuccess = false;
				break;
			}

			const nextBatch = batchQueue.shift();
			if (!nextBatch) {
				break;
			}

			log.info(`[AutoDistribute] バッチ ${totalBatches - batchQueue.length}/${totalBatches} を ${availableChain.name} に割り当て`);

			const promise = this.runBatchWorker(
				context,
				availableChain,
				nextBatch.chunks,
				nextBatch.indexes,
				estimatedGasLimit
			)
				.then(success => {
					if (!success) {
						totalSuccess = false;
					}
				})
				.finally(() => {
					processingPromises.delete(promise);
				});

			processingPromises.add(promise);
		}

		await Promise.all(Array.from(processingPromises));

		if (!totalSuccess) {
			log.error('[AutoDistribute] 一部またはすべてのチェーンでアップロードに失敗しました。マニフェスト登録をスキップします。');
			tracker.markUploadEnd();
			return tracker.getUploadResult();
		}

		log.step(`[AutoDistribute] 全 ${chunks.length} チャンクのアップロード完了。マニフェストを登録中...`);

		// --- ★ 修正: UrlParts を使用 ---
		// 6. マニフェスト作成 (キーはエンコード済みファイルパス)
		const manifest: Manifest = {
			[urlParts.filePathEncoded]: chunkIndexes, // ★ エンコード済みのパスをキーにする
		};
		const manifestContent = JSON.stringify(manifest);

		// 7. マニフェストを metachain にアップロード
		try {
			// ★ 修正: メッセージの url フィールドにエンコード済みのベース URL を使用
			const msg: MsgCreateStoredManifest = {
				creator: metachainAccount.address,
				index: urlParts.baseUrlEncoded, // ★ エンコード済みのベース URL
				domain: urlParts.baseUrlRaw,
				manifest: manifestContent,
			};

			const { gasUsed, transactionHash, height }: DeliverTxResponse = await metachainAccount.signingClient.signAndBroadcast(
				metachainAccount.address,
				[{ typeUrl: '/metachain.metastore.v1.MsgCreateStoredManifest', value: msg }],
				'auto'
			);

			// ★ 修正: ログには Raw 値を表示
			log.info(`[AutoDistribute] マニフェスト登録成功 (BaseURL: ${urlParts.baseUrlRaw}, FilePath: ${urlParts.filePathRaw})。TxHash: ${transactionHash}`);

			tracker.recordTransaction({
				hash: transactionHash,
				chainName: metachain.name,
				success: true,
				height: height,
				gasUsed: gasUsed,
				feeAmount: undefined,
			});
			// ★ 修正: Tracker には元の完全な URL を記録
			tracker.setManifestUrl(urlParts.original);

		} catch (error) {
			log.error(`[AutoDistribute] マニフェストの登録に失敗しました (BaseURL: ${urlParts.baseUrlRaw})。`, error);
		}

		// 8. 最終結果
		tracker.markUploadEnd();
		log.info(`[AutoDistribute] 完了。所要時間: ${tracker.getUploadResult().durationMs} ms`);
		return tracker.getUploadResult();
	}

	/**
	 * Mempool に空きがあるチェーンをポーリングして探す
	 */
	private async findAvailableChain(
		chainClients: Map<string, CometClient>
	): Promise<ChainInfo | null> {

		const startTime = Date.now();
		const chainNames = Array.from(chainClients.keys());

		while (Date.now() - startTime < MEMPOOL_WAIT_TIMEOUT_MS) {
			const checks = chainNames.map(async (name) => {
				const client = chainClients.get(name)!;
				try {
					if ('numUnconfirmedTxs' in client) {
						const status = await client.numUnconfirmedTxs();
						const bytes = parseInt(status.totalBytes.toString(), 10);
						return { name, bytes };
					} else {
						log.warn(`[Mempool] クライアント ${name} に numUnconfirmedTxs メソッドがありません。`);
						return { name, bytes: Infinity };
					}
				} catch (error: any) {
					log.warn(`[Mempool] ${name} の Mempool 監視中にエラー: ${error.message}`);
					return { name, bytes: Infinity };
				}
			});

			const statuses = await Promise.all(checks);
			const bestChain = statuses.sort((a, b) => a.bytes - b.bytes)[0];

			if (bestChain && bestChain.bytes < MEMPOOL_BYTES_LIMIT) {
				log.debug(`[Mempool] 空きチェーン発見: ${bestChain.name} (Bytes: ${bestChain.bytes})`);
				return { name: bestChain.name, type: 'datachain' };
			}

			log.debug(`[Mempool] 空きチェーンなし。待機中... (Min bytes: ${bestChain?.bytes ?? 'N/A'})`);
			await sleep(MEMPOOL_POLL_INTERVAL_MS);
		}

		return null; // タイムアウト
	}

	/**
	 * RPCクライアントを context から取得 (Mempool監視用)
	 */
	private async getTmClient(context: RunnerContext, chainName: string): Promise<CometClient> {
		const { communicationStrategy, infraService } = context;
		const rpcEndpoints = await infraService.getRpcEndpoints();
		const rpcEndpoint = rpcEndpoints[chainName];
		if (!rpcEndpoint) throw new Error(`RPCエンドポイントが見つかりません: ${chainName}`);

		const tmClient = communicationStrategy.getRpcClient(rpcEndpoint);
		if (!tmClient) throw new Error(`RPCクライアントが取得できません: ${chainName}`);

		if (!('numUnconfirmedTxs' in tmClient)) {
			throw new Error(`[Mempool] ${chainName} のクライアントは numUnconfirmedTxs をサポートしていません (HttpBatchClient?)`);
		}

		return tmClient as CometClient;
	}

	/**
	 * 1バッチ分のワーカー処理 (送信 + 確認)
	 */
	private async runBatchWorker(
		context: RunnerContext,
		chainInfo: ChainInfo,
		chunks: Buffer[],
		chunkIndexes: string[],
		estimatedGasLimit: string
	): Promise<boolean> {

		const { tracker, confirmationStrategy, config } = context;
		const chainName = chainInfo.name;

		try {
			const batchTxHashes = await this.sendChunkBatch(
				context,
				chainName,
				chunks,
				chunkIndexes,
				estimatedGasLimit
			);

			const confirmOptions = { timeoutMs: config.confirmationStrategyOptions?.timeoutMs };
			const results = await confirmationStrategy.confirmTransactions(context, chainName, batchTxHashes, confirmOptions);

			const txInfos: TransactionInfo[] = batchTxHashes.map(hash => ({
				hash: hash,
				chainName: chainName,
				...results.get(hash)!
			}));
			tracker.recordTransactions(txInfos);

			const failedTxs = txInfos.filter(info => !info.success);
			if (failedTxs.length > 0) {
				log.error(`[Worker ${chainName}] バッチ処理で ${failedTxs.length} 件のTxが失敗しました (例: ${failedTxs[0]?.error})。`);
				return false;
			}

			log.info(`[Worker ${chainName}] バッチ (${chunks.length} Tx) の処理が正常に完了しました。`);
			return true;

		} catch (error) {
			log.error(`[Worker ${chainName}] バッチ処理中にエラーが発生しました。`, error);
			return false;
		}
	}

	/**
	 * チャンクのバッチをノンス手動管理で逐次送信します。
	 */
	private async sendChunkBatch(
		context: RunnerContext,
		chainName: string,
		chunks: Buffer[],
		indexes: string[],
		gasLimit: string
	): Promise<string[]> {

		const { chainManager } = context;
		const account = chainManager.getChainAccount(chainName);
		const client = account.signingClient;

		let currentSequence = chainManager.getCurrentSequence(chainName);
		const accountNumber = chainManager.getAccountNumber(chainName);
		const chainId = await client.getChainId();

		const messages = chunks.map((chunk, i) => {
			const msg: MsgCreateStoredChunk = {
				creator: account.address,
				index: indexes[i]!,
				data: chunk,
			};
			return {
				typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk',
				value: msg,
			};
		});

		const txHashes: string[] = [];
		const txRawBytesList: Uint8Array[] = [];

		const gasPrice = GasPrice.fromString(DEFAULT_GAS_PRICE);
		const fee: StdFee = calculateFee(parseInt(gasLimit, 10), gasPrice);

		log.debug(`[sendChunkBatch ${chainName}] ${messages.length} 件のTxをオフライン署名中... (Start Seq: ${currentSequence}, GasLimit: ${gasLimit}, Fee: ${JSON.stringify(fee.amount)})`);

		for (const msg of messages) {
			const signerData: SignerData = {
				accountNumber: accountNumber,
				sequence: currentSequence,
				chainId: chainId,
			};

			const txRaw = await client.sign(
				account.address,
				[msg],
				fee,
				'',
				signerData
			);

			txRawBytesList.push(TxRaw.encode(txRaw).finish());
			currentSequence++;
		}

		chainManager.incrementSequence(chainName, messages.length);

		log.debug(`[sendChunkBatch ${chainName}] ${txRawBytesList.length} 件のTxをブロードキャスト中...`);

		for (const txBytes of txRawBytesList) {
			const hash = toHex(sha256(txBytes)).toUpperCase();
			txHashes.push(hash);

			try {
				const returnedHash = await client.broadcastTxSync(txBytes);
				log.debug(`[sendChunkBatch ${chainName}] Txブロードキャスト成功 (Sync): ${hash}`);

			} catch (error: any) {
				const errorMessage = error?.message || String(error);
				let errorDetails = '';
				try {
					errorDetails = JSON.stringify(error, (key, value) => {
						if (value instanceof Error) return { message: value.message, stack: value.stack };
						if (typeof value === 'bigint') return value.toString() + 'n';
						return value;
					}, 2);
				} catch {
					errorDetails = String(error);
				}
				log.error(`[sendChunkBatch ${chainName}] Tx (Hash: ${hash}) のブロードキャスト中に例外発生。メッセージ: ${errorMessage}\n詳細: ${errorDetails}`, error);
			}
		}

		return txHashes;
	}
}