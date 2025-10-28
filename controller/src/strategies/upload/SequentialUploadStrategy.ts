// controller/src/strategies/upload/SequentialUploadStrategy.ts
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
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
// GasPrice と calculateFee をインポート
import { EncodeObject } from '@cosmjs/proto-signing';
import { calculateFee, DeliverTxResponse, GasPrice, SignerData, StdFee } from '@cosmjs/stargate';
import { DEFAULT_GAS_PRICE } from '../../core/ChainManager'; // ★ 修正: ChainManager から定数をインポート

// デフォルトのチャンクサイズ (1MB)
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
// 一度に送信するバッチサイズ (Tx数)
const DEFAULT_BATCH_SIZE = 100;
// ★ 修正: 重複する定数を削除
// const DEFAULT_GAS_PRICE_STRING = '0.0025stake';
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
	 * @param targetUrl このデータに関連付けるURL (マニフェストのキー)
	 */
	public async execute(
		context: RunnerContext,
		data: Buffer,
		targetUrl: string
	): Promise<UploadResult> {

		const { config, chainManager, tracker, confirmationStrategy, gasEstimationStrategy } = context;
		tracker.markUploadStart();
		log.info(`[SequentialUpload] 開始... URL: ${targetUrl}, データサイズ: ${data.length} bytes`);

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
				// sendChunkBatch に estimatedGasLimit を渡す
				const batchTxHashes = await this.sendChunkBatch(
					context,
					targetChainName,
					batchChunks,
					batchIndexes,
					estimatedGasLimit // ガスリミットを渡す
				);
				allTxHashes.push(...batchTxHashes);

				// 完了確認 (バッチごと)
				const confirmOptions = { timeoutMs: config.confirmationStrategyOptions?.timeoutMs };
				const results = await confirmationStrategy.confirmTransactions(context, targetChainName, batchTxHashes, confirmOptions);

				// 結果をトラッカーに記録
				const txInfos: TransactionInfo[] = batchTxHashes.map(hash => ({
					hash: hash,
					chainName: targetChainName,
					...results.get(hash)! // 結果が Map に存在することを前提とする (!)
				}));
				tracker.recordTransactions(txInfos);

				// 1件でも失敗したら中断
				const failedTxs = txInfos.filter(info => !info.success);
				if (failedTxs.length > 0) {
					// エラーメッセージに失敗理由を含める
					const firstError = failedTxs[0]?.error || '不明なエラー';
					throw new Error(`バッチ ${i + 1} で ${failedTxs.length} 件のTxが失敗しました (例: ${firstError})。アップロードを中断します。`);
				}

			} catch (error) {
				log.error(`[SequentialUpload] バッチ ${i + 1} の処理中にエラーが発生しました。`, error);
				tracker.markUploadEnd(); // 失敗時点で終了
				return tracker.getUploadResult(); // エラー発生時も、それまでの結果を返す
			}
		}

		log.step(`[SequentialUpload] 全 ${chunks.length} チャンクのアップロード完了。マニフェストを登録中...`);

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
				'auto' // マニフェスト送信はガス'auto'で
			);

			log.info(`[SequentialUpload] マニフェスト登録成功。TxHash: ${transactionHash}`);

			tracker.recordTransaction({
				hash: transactionHash,
				chainName: metachain.name,
				success: true,
				height: height,
				gasUsed: gasUsed,
				feeAmount: undefined, // 'auto' では fee を直接取得できない
			});
			tracker.setManifestUrl(targetUrl);

		} catch (error) {
			log.error(`[SequentialUpload] マニフェストの登録に失敗しました。`, error);
			// マニフェスト失敗でも、チャンクアップロードの結果は返す
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

		// ガス価格を取得 (デフォルトを使用)
		// ★ 修正: インポートした DEFAULT_GAS_PRICE を使用
		const gasPrice = GasPrice.fromString(DEFAULT_GAS_PRICE);
		// 手数料を計算
		const fee: StdFee = calculateFee(parseInt(gasLimit, 10), gasPrice);

		log.debug(`[sendChunkBatch ${chainName}] ${messages.length} 件のTxをオフライン署名中... (Start Seq: ${currentSequence}, GasLimit: ${gasLimit}, Fee: ${JSON.stringify(fee.amount)})`);
		for (const msg of messages) {
			const signerData: SignerData = {
				accountNumber: accountNumber,
				sequence: currentSequence,
				chainId: chainId,
			};

			// client.sign に計算済みの fee オブジェクトを渡す
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

		// ローカルのシーケンス番号を更新
		chainManager.incrementSequence(chainName, messages.length);

		// broadcastTxSync で一括送信
		log.debug(`[sendChunkBatch ${chainName}] ${txRawBytesList.length} 件のTxをブロードキャスト中...`);
		for (const txBytes of txRawBytesList) {
			const hash = toHex(sha256(txBytes)).toUpperCase();
			txHashes.push(hash);
			try {
				const returnedHash = await client.broadcastTxSync(txBytes);
				// 戻り値のハッシュが計算結果と一致するか確認 (デバッグ用)
				if (returnedHash.toUpperCase() !== hash) {
					log.warn(`[sendChunkBatch ${chainName}] ブロードキャストされたTxハッシュ (${returnedHash}) が計算結果 (${hash}) と一致しません。`);
				}
				log.debug(`[sendChunkBatch ${chainName}] Txブロードキャスト成功 (Sync): ${hash}`);
			} catch (error: any) {
				// ★ 修正: エラーログを詳細化
				const errorMessage = error?.message || String(error);
				let errorDetails = '';
				try {
					errorDetails = JSON.stringify(error, (key, value) => {
						// ErrorやBigIntのJSON化に対応
						if (value instanceof Error) return { message: value.message, stack: value.stack };
						if (typeof value === 'bigint') return value.toString() + 'n';
						return value;
					}, 2);
				} catch {
					errorDetails = String(error);
				}

				log.error(`[sendChunkBatch ${chainName}] Tx (Hash: ${hash}) のブロードキャスト中に例外発生。メッセージ: ${errorMessage}\n詳細: ${errorDetails}`, error);
				// エラーが発生してもハッシュはリストに追加し、Confirmation戦略に確認を委ねる
			}
		}

		return txHashes;
	}
}