// controller/src/strategies/upload/RoundRobinUploadStrategy.ts
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { calculateFee, DeliverTxResponse, GasPrice, SignerData, StdFee } from '@cosmjs/stargate';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { DEFAULT_GAS_PRICE } from '../../core/ChainManager'; // ★ 修正: ChainManager から定数をインポート
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
import { IUploadStrategy } from './IUploadStrategy';
import { EncodeObject } from '@cosmjs/proto-signing';

// デフォルトのチャンクサイズ (1MB)
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
// 各チェーンが一度に送信するバッチサイズ (Tx数)
const DEFAULT_BATCH_SIZE_PER_CHAIN = 100;
// 同時に処理するチェーン（ワーカー）の最大数
const MAX_CONCURRENT_WORKERS = 4;
// ★ 修正: 重複する定数を削除
// const DEFAULT_GAS_PRICE_STRING = '0.0025stake'; 
// シミュレーション失敗時のフォールバックガスリミット (SequentialUploadStrategyからコピー)
const FALLBACK_GAS_LIMIT = '60000000';

/**
 * 1チェーン (ワーカー) が担当するアップロードジョブの型
 */
type UploadJob = {
	chainInfo: ChainInfo;
	chunkIndexes: string[];
	chunks: Buffer[];
};

/**
 * チャンクを複数の datachain にラウンドロビン方式で割り当て、並列アップロードする戦略。
 * (dis-test-ws/1.ts のロジックをベース)
 */
export class RoundRobinUploadStrategy implements IUploadStrategy {
	constructor() {
		log.debug('RoundRobinUploadStrategy がインスタンス化されました。');
	}

	/**
	 * ラウンドロビン分散アップロード処理を実行します。
	 * @param context 実行コンテキスト
	 * @param data アップロード対象のデータ
	 * @param targetUrl このデータに関連付けるURL
	 */
	public async execute(
		context: RunnerContext,
		data: Buffer,
		targetUrl: string
	): Promise<UploadResult> {

		const { config, chainManager, tracker, confirmationStrategy, gasEstimationStrategy } = context; // gasEstimationStrategy を追加
		tracker.markUploadStart();
		log.info(`[RoundRobinUpload] 開始... URL: ${targetUrl}, データサイズ: ${data.length} bytes`);

		// 1. 設定と対象チェーンの決定
		const options = config.uploadStrategyOptions ?? {};

		const allDatachains = chainManager.getDatachainInfos();
		const chainCount = config.chainCount && typeof config.chainCount === 'number'
			? config.chainCount
			: allDatachains.length;

		const targetDatachains = allDatachains.slice(0, chainCount);

		if (targetDatachains.length === 0) {
			throw new Error('[RoundRobinUpload] 利用可能な datachain が0件です。');
		}

		const metachain = chainManager.getMetachainInfo();
		const metachainAccount = chainManager.getChainAccount(metachain.name);

		const chunkSize = options.chunkSize === 'auto' || !options.chunkSize ? DEFAULT_CHUNK_SIZE : options.chunkSize;
		tracker.setChunkSizeUsed(chunkSize);

		const batchSizePerChain = DEFAULT_BATCH_SIZE_PER_CHAIN;

		log.info(`[RoundRobinUpload] 対象チェーン: ${targetDatachains.map(c => c.name).join(', ')} (${targetDatachains.length}件)`);
		log.info(`[RoundRobinUpload] チャンクサイズ: ${chunkSize} bytes, チェーン毎バッチ: ${batchSizePerChain} txs`);

		// 2. データチャンク化とインデックス生成
		const fileHash = toHex(sha256(data)).toLowerCase();
		const chunkIndexes: string[] = [];
		const chunks: Buffer[] = [];

		for (let i = 0; i < data.length; i += chunkSize) {
			const chunk = data.subarray(i, i + chunkSize);
			chunks.push(chunk);
			chunkIndexes.push(`${fileHash}-${chunks.length - 1}`);
		}
		log.info(`[RoundRobinUpload] データは ${chunks.length} 個のチャンクに分割されました。`);

		// ★ 修正: ガスシミュレーションロジックを追加
		let estimatedGasLimit = FALLBACK_GAS_LIMIT;
		if (chunks.length > 0 && chunks[0]) {
			const targetChainNameForSim = targetDatachains[0]!.name; // 最初のdatachainでシミュレーション
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
			log.warn('[RoundRobinUpload] チャンクデータが存在しないため、ガスシミュレーションをスキップします。');
		}

		// 3. チャンクを各 datachain にラウンドロビンで割り当て (ジョブ作成)
		// ★ 修正: UploadJob の型定義を外部に移動させたため、ここは変更なし
		const jobs: Map<string, UploadJob> = new Map(targetDatachains.map(chain => [
			chain.name,
			{ chainInfo: chain, chunkIndexes: [], chunks: [] }
		]));

		for (let i = 0; i < chunks.length; i++) {
			const chainIndex = i % targetDatachains.length;
			const targetChain = targetDatachains[chainIndex]!;
			const job = jobs.get(targetChain.name)!;
			job.chunks.push(chunks[i]!);
			job.chunkIndexes.push(chunkIndexes[i]!);
		}

		// 4. 各チェーン（ワーカー）のアップロード処理を並列実行
		log.step(`[RoundRobinUpload] ${jobs.size} チェーンで並列アップロード処理を開始... (GasLimit: ${estimatedGasLimit})`); // ログに GasLimit を追加
		const workerPromises = Array.from(jobs.values()).map(job =>
			this.runWorker(context, job, batchSizePerChain, estimatedGasLimit) // estimatedGasLimit を渡す
		);

		let totalSuccess = true;
		try {
			const workerResults = await Promise.all(workerPromises);

			if (workerResults.some(success => !success)) {
				totalSuccess = false;
			}

		} catch (error) {
			log.error('[RoundRobinUpload] ワーカー処理中に予期せぬエラーが発生しました。', error);
			totalSuccess = false;
		}

		if (!totalSuccess) {
			log.error('[RoundRobinUpload] 一部またはすべてのチェーンでアップロードに失敗しました。マニフェスト登録をスキップします。');
			tracker.markUploadEnd();
			return tracker.getUploadResult();
		}

		log.step(`[RoundRobinUpload] 全 ${chunks.length} チャンクのアップロード完了。マニフェストを登録中...`);

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

			log.info(`[RoundRobinUpload] マニフェスト登録成功。TxHash: ${transactionHash}`);

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
			log.error(`[RoundRobinUpload] マニフェストの登録に失敗しました。`, error);
		}

		// 7. 最終結果
		tracker.markUploadEnd();
		log.info(`[RoundRobinUpload] 完了。所要時間: ${tracker.getUploadResult().durationMs} ms`);
		return tracker.getUploadResult();
	}

	/**
	 * 1チェーン担当のワーカー処理。
	 * ★ 修正: `job: UploadJob` がファイルスコープの型を参照するためエラー解消
	 */
	private async runWorker(
		context: RunnerContext,
		job: UploadJob,
		batchSize: number,
		estimatedGasLimit: string // 追加
	): Promise<boolean> {

		const { chainManager, tracker, confirmationStrategy, config } = context;
		const { chainInfo, chunks, chunkIndexes } = job;
		const chainName = chainInfo.name;

		log.info(`[Worker ${chainName}] 開始。担当チャンク数: ${chunks.length}`);

		const totalBatches = Math.ceil(chunks.length / batchSize);
		if (totalBatches === 0) {
			log.info(`[Worker ${chainName}] 担当チャンクが0件のため終了。`);
			return true;
		}

		for (let i = 0; i < totalBatches; i++) {
			const batchStartIndex = i * batchSize;
			const batchEndIndex = Math.min((i + 1) * batchSize, chunks.length);
			const batchChunks = chunks.slice(batchStartIndex, batchEndIndex);
			const batchIndexes = chunkIndexes.slice(batchStartIndex, batchEndIndex);

			log.info(`[Worker ${chainName}] バッチ ${i + 1}/${totalBatches} (${batchChunks.length} Tx) を送信中...`);

			try {
				const batchTxHashes = await this.sendChunkBatch(
					context,
					chainName,
					batchChunks,
					batchIndexes,
					estimatedGasLimit // 渡す
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
					log.error(`[Worker ${chainName}] バッチ ${i + 1} で ${failedTxs.length} 件のTxが失敗しました (例: ${failedTxs[0]?.error})。このワーカーを停止します。`);
					return false;
				}

			} catch (error) {
				log.error(`[Worker ${chainName}] バッチ ${i + 1} の処理中にエラーが発生しました。`, error);
				return false;
			}
		}

		log.info(`[Worker ${chainName}] 担当の全 ${chunks.length} チャンクの処理が正常に完了しました。`);
		return true;
	}

	/**
	 * チャンクのバッチをノンス手動管理で逐次送信します。
	 * (SequentialUploadStrategy のロジックに修正・統合)
	 */
	private async sendChunkBatch(
		context: RunnerContext,
		chainName: string,
		chunks: Buffer[],
		indexes: string[],
		gasLimit: string // 追加
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

		// ★ 修正: GasPrice, calculateFee を使用して Fee を計算
		const gasPrice = GasPrice.fromString(DEFAULT_GAS_PRICE); // DEFAULT_GAS_PRICE を使用
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
				fee, // 計算済みの fee を使用
				'', // memo
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
				// ★ 修正: エラーログを詳細化
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