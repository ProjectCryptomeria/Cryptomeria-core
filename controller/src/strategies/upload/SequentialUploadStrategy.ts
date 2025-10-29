// controller/src/strategies/upload/SequentialUploadStrategy.ts
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { EncodeObject } from '@cosmjs/proto-signing';
import { calculateFee, DeliverTxResponse, GasPrice, SignerData, StdFee } from '@cosmjs/stargate';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { DEFAULT_GAS_PRICE } from '../../core/ChainManager';
import {
	Manifest,
	MsgCreateStoredChunk,
	MsgCreateStoredManifest,
	RunnerContext,
	TransactionInfo,
	UploadResult
} from '../../types/index'; // index を明示
import { log } from '../../utils/logger';
import { IUploadStrategy } from './IUploadStrategy';

// デフォルトのチャンクサイズ (1MB)
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
// 一度に送信するバッチサイズ (Tx数)
const DEFAULT_BATCH_SIZE = 100;
// シミュレーション失敗時のフォールバックガスリミット
const FALLBACK_GAS_LIMIT = '60000000';

/**
 * データを分割し、指定された単一の datachain に対して逐次的にアップロードする戦略。
 * ガスシミュレーションを利用してガスリミットを決定します。
 */
export class SequentialUploadStrategy implements IUploadStrategy {
	constructor() {
		log.debug('SequentialUploadStrategy がインスタンス化されました。');
	}

	/**
	 * 逐次アップロード処理を実行します。
	 * @param context 実行コンテキスト
	 * @param data アップロード対象のデータ
	 * @param targetUrl このデータに関連付けるURL (マニフェストのキー) - エンコード前
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
		log.info(`[SequentialUpload] 開始... URL (Raw): ${targetUrl}, データサイズ: ${data.length} bytes`);

		// ★ 追加: URLを解析
		const urlParts = urlPathCodec.parseTargetUrl(targetUrl);

		// 1. 設定と対象チェーンの決定
		const options = config.uploadStrategyOptions ?? {};
		const targetChainName = options.targetChain;
		if (!targetChainName) {
			throw new Error('[SequentialUpload] 設定 (uploadStrategyOptions.targetChain) で対象の datachain 名を指定する必要があります。');
		}
		const targetChain = chainManager.getChainAccount(targetChainName);
		if (targetChain.chainInfo.type !== 'datachain') {
			throw new Error(`[SequentialUpload] 対象チェーン "${targetChainName}" は datachain ではありません (Type: ${targetChain.chainInfo.type})。`);
		}

		const metachain = chainManager.getMetachainInfo();
		const metachainAccount = chainManager.getChainAccount(metachain.name);

		const chunkSize = options.chunkSize === 'auto' || !options.chunkSize ? DEFAULT_CHUNK_SIZE : options.chunkSize;
		tracker.setChunkSizeUsed(chunkSize);

		const batchSize = DEFAULT_BATCH_SIZE;

		log.info(`[SequentialUpload] 対象チェーン: ${targetChainName}, チャンクサイズ: ${chunkSize} bytes, バッチサイズ: ${batchSize} txs`);

		// 2. データチャンク化とインデックス生成
		const fileHash = toHex(sha256(data)).toLowerCase();
		const chunkIndexes: string[] = [];
		const chunks: Buffer[] = [];

		for (let i = 0; i < data.length; i += chunkSize) {
			const chunk = data.subarray(i, i + chunkSize);
			chunks.push(chunk);
			chunkIndexes.push(`${fileHash}-${chunks.length - 1}`);
		}
		log.info(`[SequentialUpload] データは ${chunks.length} 個のチャンクに分割されました。`);

		// 3. ガスシミュレーション
		let estimatedGasLimit = FALLBACK_GAS_LIMIT;
		if (chunks.length > 0 && chunks[0]) {
			const sampleMsg: EncodeObject = {
				typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk',
				value: {
					creator: targetChain.address,
					index: chunkIndexes[0]!,
					data: chunks[0],
				} as MsgCreateStoredChunk
			};
			estimatedGasLimit = await gasEstimationStrategy.estimateGasLimit(
				context,
				targetChainName,
				sampleMsg
			);
		} else {
			log.warn('[SequentialUpload] チャンクデータが存在しないため、ガスシミュレーションをスキップします。');
		}

		// 4. チャンクをバッチ処理でアップロード
		const totalBatches = Math.ceil(chunks.length / batchSize);
		let allTxHashes: string[] = [];

		for (let i = 0; i < totalBatches; i++) {
			const batchStartIndex = i * batchSize;
			const batchEndIndex = Math.min((i + 1) * batchSize, chunks.length);
			const batchChunks = chunks.slice(batchStartIndex, batchEndIndex);
			const batchIndexes = chunkIndexes.slice(batchStartIndex, batchEndIndex);

			log.step(`[SequentialUpload] バッチ ${i + 1}/${totalBatches} (${batchChunks.length} Tx) を "${targetChainName}" に送信中... (GasLimit: ${estimatedGasLimit})`);

			try {
				const batchTxHashes = await this.sendChunkBatch(
					context,
					targetChainName,
					batchChunks,
					batchIndexes,
					estimatedGasLimit
				);
				allTxHashes.push(...batchTxHashes);

				const confirmOptions = { timeoutMs: config.confirmationStrategyOptions?.timeoutMs };
				const results = await confirmationStrategy.confirmTransactions(context, targetChainName, batchTxHashes, confirmOptions);

				const txInfos: TransactionInfo[] = batchTxHashes.map(hash => ({
					hash: hash,
					chainName: targetChainName,
					...results.get(hash)!
				}));
				tracker.recordTransactions(txInfos);

				const failedTxs = txInfos.filter(info => !info.success);
				if (failedTxs.length > 0) {
					const firstError = failedTxs[0]?.error || '不明なエラー';
					throw new Error(`バッチ ${i + 1} で ${failedTxs.length} 件のTxが失敗しました (例: ${firstError})。アップロードを中断します。`);
				}

			} catch (error) {
				log.error(`[SequentialUpload] バッチ ${i + 1} の処理中にエラーが発生しました。`, error);
				tracker.markUploadEnd();
				return tracker.getUploadResult();
			}
		}

		log.step(`[SequentialUpload] 全 ${chunks.length} チャンクのアップロード完了。マニフェストを登録中...`);

		// --- ★ 修正: UrlParts を使用 ---
		// 5. マニフェスト作成 (キーはエンコード済みファイルパス)
		const manifest: Manifest = {
			[urlParts.filePathEncoded]: chunkIndexes, // ★ エンコード済みのパスをキーにする
		};
		const manifestContent = JSON.stringify(manifest);

		// 6. マニフェストを metachain にアップロード
		try {
			// ★ 修正: メッセージの url フィールドにエンコード済みのベース URL を使用
			const msg: MsgCreateStoredManifest = {
				creator: metachainAccount.address,
				url: urlParts.baseUrlEncoded, // ★ エンコード済みのベース URL
				manifest: manifestContent,
			};

			const { gasUsed, transactionHash, height }: DeliverTxResponse = await metachainAccount.signingClient.signAndBroadcast(
				metachainAccount.address,
				[{ typeUrl: '/metachain.metastore.v1.MsgCreateStoredManifest', value: msg }],
				'auto'
			);

			// ★ 修正: ログには Raw 値を表示
			log.info(`[SequentialUpload] マニフェスト登録成功 (BaseURL: ${urlParts.baseUrlRaw}, FilePath: ${urlParts.filePathRaw})。TxHash: ${transactionHash}`);

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
			log.error(`[SequentialUpload] マニフェストの登録に失敗しました (BaseURL: ${urlParts.baseUrlRaw})。`, error);
		}

		// 7. 最終結果
		tracker.markUploadEnd();
		log.info(`[SequentialUpload] 完了。所要時間: ${tracker.getUploadResult().durationMs} ms`);
		return tracker.getUploadResult();
	}

	/**
	 * チャンクのバッチをノンス手動管理で逐次送信します。
	 * @param gasLimit このバッチの各Txで使用するガスリミット
	 */
	private async sendChunkBatch(
		context: RunnerContext,
		chainName: string,
		chunks: Buffer[],
		indexes: string[],
		gasLimit: string // シミュレーション結果を受け取る
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
				if (returnedHash.toUpperCase() !== hash) {
					log.warn(`[sendChunkBatch ${chainName}] ブロードキャストされたTxハッシュ (${returnedHash}) が計算結果 (${hash}) と一致しません。`);
				}
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