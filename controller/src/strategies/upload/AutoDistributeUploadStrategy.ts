// controller/src/strategies/upload/AutoDistributeUploadStrategy.ts
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { DeliverTxResponse, SignerData } from '@cosmjs/stargate';
import { TendermintClient } from '@cosmjs/tendermint-rpc';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
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

// Mempool 監視設定 (dis-test-ws/5.ts を参考)
// このバイト数以下なら「空いている」と判断
const MEMPOOL_BYTES_LIMIT = 50 * 1024 * 1024; // 50MB
// Mempool 監視のポーリング間隔
const MEMPOOL_POLL_INTERVAL_MS = 250;
// Mempool 監視のタイムアウト (この時間待っても空かなければエラー)
const MEMPOOL_WAIT_TIMEOUT_MS = 30000; // 30秒

/**
 * 各 datachain の Mempool 状況を監視し、
 * 動的に（最も空いているチェーンに）チャンクバッチを割り当てる戦略。
 * (dis-test-ws/2.ts ～ 5.ts のロジックをベース)
 */
export class AutoDistributeUploadStrategy implements IUploadStrategy {
	constructor() {
		log.debug('AutoDistributeUploadStrategy がインスタンス化されました。');
	}

	/**
	 * 動的分散アップロード処理を実行します。
	 * @param context 実行コンテキスト
	 * @param data アップロード対象のデータ
	 * @param targetUrl このデータに関連付けるURL
	 */
	public async execute(
		context: RunnerContext,
		data: Buffer,
		targetUrl: string
	): Promise<UploadResult> {

		const { config, chainManager, tracker, confirmationStrategy } = context;
		tracker.markUploadStart();
		log.info(`[AutoDistribute] 開始... URL: ${targetUrl}, データサイズ: ${data.length} bytes`);

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

		// 3. 全チャンクをバッチに分割 (キューの作成)
		// ラウンドロビンとは異なり、この時点ではチェーンに割り当てない
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

		// 4. ワーカー（チェーン）プールの管理とMempool監視によるバッチ処理
		log.step(`[AutoDistribute] ${batchQueue.length} バッチを ${targetDatachains.length} チェーン（ワーカー）で処理開始...`);

		let totalSuccess = true;
		const processingPromises = new Set<Promise<any>>();

		// 各チェーンのRPCクライアントを取得 (Mempool監視用)
		const chainClients = new Map<string, TendermintClient>();
		for (const chain of targetDatachains) {
			const client = await this.getTmClient(context, chain.name);
			chainClients.set(chain.name, client);
		}

		while (batchQueue.length > 0) {
			// 4a. 空いているチェーンを探す
			const availableChain = await this.findAvailableChain(chainClients);

			if (!availableChain) {
				log.error('[AutoDistribute] 空いているチェーンが見つかりませんでした (タイムアウト)。アップロードを中断します。');
				totalSuccess = false;
				break; // while ループを抜ける
			}

			// 4b. キューから次のバッチを取り出す
			const nextBatch = batchQueue.shift();
			if (!nextBatch) {
				break; // キューが空になった (findAvailableChain との競合)
			}

			log.info(`[AutoDistribute] バッチ ${totalBatches - batchQueue.length}/${totalBatches} を ${availableChain.name} に割り当て`);

			// 4c. ワーカー処理（バッチ送信と確認）を非同期で実行
			const promise = this.runBatchWorker(
				context,
				availableChain,
				nextBatch.chunks,
				nextBatch.indexes
			)
				.then(success => {
					if (!success) {
						totalSuccess = false; // 1件でも失敗したら全体を失敗
					}
				})
				.finally(() => {
					processingPromises.delete(promise); // 完了したらSetから削除
				});

			processingPromises.add(promise); // 実行中のPromiseをSetに追加
		}

		// 4d. すべての処理が完了するのを待つ
		await Promise.all(Array.from(processingPromises));


		if (!totalSuccess) {
			log.error('[AutoDistribute] 一部またはすべてのチェーンでアップロードに失敗しました。マニフェスト登録をスキップします。');
			tracker.markUploadEnd();
			return tracker.getUploadResult();
		}

		log.step(`[AutoDistribute] 全 ${chunks.length} チャンクのアップロード完了。マニフェストを登録中...`);

		// 5. マニフェスト作成
		const manifest: Manifest = {
			[targetUrl]: chunkIndexes,
		};
		const manifestContent = JSON.stringify(manifest);

		// 6. マニフェストを metachain にアップロード
		try {
			const msg: MsgCreateStoredManifest = {
				creator: metachainAccount.address,
				url: targetUrl,
				manifest: manifestContent,
			};

			const { gasUsed, transactionHash, height }: DeliverTxResponse = await metachainAccount.signingClient.signAndBroadcast(
				metachainAccount.address,
				[{ typeUrl: '/metachain.metastore.v1.MsgCreateStoredManifest', value: msg }],
				'auto'
			);

			log.info(`[AutoDistribute] マニフェスト登録成功。TxHash: ${transactionHash}`);

			tracker.recordTransaction({
				hash: transactionHash,
				chainName: metachain.name,
				success: true,
				height: height,
				gasUsed: gasUsed,
				feeAmount: undefined,
			});
			tracker.setManifestUrl(targetUrl);

		} catch (error) {
			log.error(`[AutoDistribute] マニフェストの登録に失敗しました。`, error);
		}

		// 7. 最終結果
		tracker.markUploadEnd();
		log.info(`[AutoDistribute] 完了。所要時間: ${tracker.getUploadResult().durationMs} ms`);
		return tracker.getUploadResult();
	}

	/**
	 * Mempool に空きがあるチェーンをポーリングして探す
	 */
	private async findAvailableChain(
		chainClients: Map<string, TendermintClient>
	): Promise<ChainInfo | null> {

		const startTime = Date.now();
		const chainNames = Array.from(chainClients.keys());

		while (Date.now() - startTime < MEMPOOL_WAIT_TIMEOUT_MS) {
			// 全チェーンの Mempool 状況を並列で確認
			const checks = chainNames.map(async (name) => {
				const client = chainClients.get(name)!;
				try {
					// 'unconfirmed_txs' RPC (Tendermint 0.37+) または 'num_unconfirmed_txs' (0.34)
					// Comet38Client (0.38) には numUnconfirmedTxs() がある
					if ('numUnconfirmedTxs' in client) {
						const status = await client.numUnconfirmedTxs();
						const bytes = parseInt(status.totalBytes.toString(), 10);
						// const count = parseInt(status.totalTxs, 10);
						return { name, bytes };
					} else {
						log.warn(`[Mempool] クライアント ${name} に numUnconfirmedTxs メソッドがありません。`);
						return { name, bytes: Infinity }; // 監視できないチェーンは対象外
					}
				} catch (error: any) {
					log.warn(`[Mempool] ${name} の Mempool 監視中にエラー: ${error.message}`);
					return { name, bytes: Infinity }; // エラーが発生したチェーンは対象外
				}
			});

			const statuses = await Promise.all(checks);

			// 最も空いているチェーンを探す
			const bestChain = statuses.sort((a, b) => a.bytes - b.bytes)[0];

			if (bestChain && bestChain.bytes < MEMPOOL_BYTES_LIMIT) {
				log.debug(`[Mempool] 空きチェーン発見: ${bestChain.name} (Bytes: ${bestChain.bytes})`);
				// ChainInfo を返す (Map ではなく context から取得すべきだが...)
				// -> ここで context を参照できないため、名前だけ返す (修正)
				// -> いや、ChainManager から Client 取得時に ChainInfo も保持すべき
				// -> findAvailableChain に渡す Map を <string, {client, chainInfo}> にすべき

				// 仮修正: 名前に基づいて ChainInfo を生成
				return { name: bestChain.name, type: 'datachain' };
			}

			// 空きがない場合は待機
			log.debug(`[Mempool] 空きチェーンなし。待機中... (Min bytes: ${bestChain?.bytes ?? 'N/A'})`);
			await sleep(MEMPOOL_POLL_INTERVAL_MS);
		}

		return null; // タイムアウト
	}

	/**
	 * RPCクライアントを context から取得 (Mempool監視用)
	 */
	private async getTmClient(context: RunnerContext, chainName: string): Promise<TendermintClient> {
		const { communicationStrategy, infraService } = context;
		const rpcEndpoints = await infraService.getRpcEndpoints();
		const rpcEndpoint = rpcEndpoints[chainName];
		if (!rpcEndpoint) throw new Error(`RPCエンドポイントが見つかりません: ${chainName}`);

		const tmClient = communicationStrategy.getRpcClient(rpcEndpoint);
		if (!tmClient) throw new Error(`RPCクライアントが取得できません: ${chainName}`);

		// getRpcClient は (TendermintClient | HttpBatchClient) を返すため、
		// Mempool監視 (numUnconfirmedTxs) に必要な TendermintClient であることを確認
		if (!('numUnconfirmedTxs' in tmClient)) {
			throw new Error(`[Mempool] ${chainName} のクライアントは numUnconfirmedTxs をサポートしていません (HttpBatchClient?)`);
		}

		return tmClient as TendermintClient; // 型キャスト
	}


	/**
	 * 1バッチ分のワーカー処理 (送信 + 確認)
	 */
	private async runBatchWorker(
		context: RunnerContext,
		chainInfo: ChainInfo,
		chunks: Buffer[],
		chunkIndexes: string[]
	): Promise<boolean> {

		const { tracker, confirmationStrategy, config } = context;
		const chainName = chainInfo.name;

		try {
			// (SequentialUploadStrategy と同じ sendChunkBatch を使用)
			const batchTxHashes = await this.sendChunkBatch(
				context,
				chainName,
				chunks,
				chunkIndexes
			);

			// 完了確認 (バッチごと)
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
	 * (SequentialUploadStrategy から流用)
	 */
	private async sendChunkBatch(
		context: RunnerContext,
		chainName: string,
		chunks: Buffer[],
		indexes: string[]
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

		log.debug(`[sendChunkBatch ${chainName}] ${messages.length} 件のTxをオフライン署名中... (Start Seq: ${currentSequence})`);
		for (const msg of messages) {
			const signerData: SignerData = {
				accountNumber: accountNumber,
				sequence: currentSequence,
				chainId: chainId,
			};

			const txRaw = await client.sign(
				account.address,
				[msg],
				{ amount: [], gas: '20000000' },
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

			} catch (error) {
				log.error(`[sendChunkBatch ${chainName}] Tx (Hash: ${hash}) のブロードキャスト中に例外発生。`, error);
			}
		}

		return txHashes;
	}
}