// controller/src/strategies/upload/SequentialUploadStrategy.ts
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { DeliverTxResponse, SignerData } from '@cosmjs/stargate';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import {
	Manifest,
	MsgCreateStoredChunk,
	MsgCreateStoredManifest,
	RunnerContext,
	TransactionInfo,
	UploadResult
} from '../../types';
import { log } from '../../utils/logger';
import { IUploadStrategy } from './IUploadStrategy';

// デフォルトのチャンクサイズ (1MB)
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
// 一度に送信するバッチサイズ (Tx数)
const DEFAULT_BATCH_SIZE = 100;

/**
 * データを分割し、指定された単一の datachain に対して逐次的にアップロードする戦略。
 * (seq-test-ws.ts のロジックをベース)
 */
export class SequentialUploadStrategy implements IUploadStrategy {
	constructor() {
		log.debug('SequentialUploadStrategy がインスタンス化されました。');
	}

	/**
	 * 逐次アップロード処理を実行します。
	 * (execute メソッドは前回の修正から変更なし)
	 */
	public async execute(
		context: RunnerContext,
		data: Buffer,
		targetUrl: string
	): Promise<UploadResult> {

		const { config, chainManager, tracker, confirmationStrategy } = context;
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

		// 3. チャンクをバッチ処理でアップロード
		const totalBatches = Math.ceil(chunks.length / batchSize);
		let allTxHashes: string[] = [];

		for (let i = 0; i < totalBatches; i++) {
			const batchStartIndex = i * batchSize;
			const batchEndIndex = Math.min((i + 1) * batchSize, chunks.length);
			const batchChunks = chunks.slice(batchStartIndex, batchEndIndex);
			const batchIndexes = chunkIndexes.slice(batchStartIndex, batchEndIndex);

			log.step(`[SequentialUpload] バッチ ${i + 1}/${totalBatches} (${batchChunks.length} Tx) を "${targetChainName}" に送信中...`);

			try {
				const batchTxHashes = await this.sendChunkBatch(
					context,
					targetChainName,
					batchChunks,
					batchIndexes
				);
				allTxHashes.push(...batchTxHashes);

				// 完了確認 (バッチごと)
				const confirmOptions = { timeoutMs: config.confirmationStrategyOptions?.timeoutMs };
				const results = await confirmationStrategy.confirmTransactions(context, targetChainName, batchTxHashes, confirmOptions);

				// 結果をトラッカーに記録
				const txInfos: TransactionInfo[] = batchTxHashes.map(hash => ({
					hash: hash,
					chainName: targetChainName,
					...results.get(hash)!
				}));
				tracker.recordTransactions(txInfos);

				// 1件でも失敗したら中断
				const failedTxs = txInfos.filter(info => !info.success);
				if (failedTxs.length > 0) {
					throw new Error(`バッチ ${i + 1} で ${failedTxs.length} 件のTxが失敗しました (例: ${failedTxs[0]?.error})。アップロードを中断します。`);
				}

			} catch (error) {
				log.error(`[SequentialUpload] バッチ ${i + 1} の処理中にエラーが発生しました。`, error);
				tracker.markUploadEnd();
				return tracker.getUploadResult();
			}
		}

		log.step(`[SequentialUpload] 全 ${chunks.length} チャンクのアップロード完了。マニフェストを登録中...`);

		// 4. マニフェスト作成
		const manifest: Manifest = {
			[targetUrl]: chunkIndexes,
		};
		const manifestContent = JSON.stringify(manifest);

		// 5. マニフェストを metachain にアップロード
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

			log.info(`[SequentialUpload] マニフェスト登録成功。TxHash: ${transactionHash}`);

			tracker.recordTransaction({
				hash: transactionHash,
				chainName: metachain.name,
				success: true,
				height: height,
				gasUsed: gasUsed,
				feeAmount: undefined, // "auto" では fee を直接取得できないため
			});
			tracker.setManifestUrl(targetUrl);

		} catch (error) {
			log.error(`[SequentialUpload] マニフェストの登録に失敗しました。`, error);
		}

		// 6. 最終結果
		tracker.markUploadEnd();
		log.info(`[SequentialUpload] 完了。所要時間: ${tracker.getUploadResult().durationMs} ms`);
		return tracker.getUploadResult();
	}

	/**
	 * チャンクのバッチをノンス手動管理で逐次送信します (seq-test-ws.ts のロジック)
	 * ★ 修正箇所
	 */
	private async sendChunkBatch(
		context: RunnerContext,
		chainName: string,
		chunks: Buffer[],
		indexes: string[]
	): Promise<string[]> {

		const { chainManager } = context;
		const account = chainManager.getChainAccount(chainName);
		const client = account.signingClient; // SigningStargateClient

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

		// 2. トランザクションをオフラインで署名
		log.debug(`[SequentialUpload] ${messages.length} 件のTxをオフライン署名中... (Start Seq: ${currentSequence})`);
		for (const msg of messages) {
			const signerData: SignerData = {
				accountNumber: accountNumber,
				sequence: currentSequence,
				chainId: chainId,
			};

			const txRaw = await client.sign(
				account.address,
				[msg],
				{ amount: [], gas: '20000000' }, // ガス代は多めに
				'',
				signerData
			);

			txRawBytesList.push(TxRaw.encode(txRaw).finish());
			currentSequence++;
		}

		// 3. ローカルのシーケンス番号を更新
		chainManager.incrementSequence(chainName, messages.length);

		// 4. broadcastTxSync で一括送信
		log.debug(`[SequentialUpload] ${txRawBytesList.length} 件のTxをブロードキャスト中...`);

		for (const txBytes of txRawBytesList) {
			// ハッシュ計算 (ConfirmationStrategy に渡すため、ブロードキャスト前に計算)
			const hash = toHex(sha256(txBytes)).toUpperCase();
			txHashes.push(hash);

			try {
				// ★ 修正 (エラー1): broadcastTxSync は Promise<string> (Txハッシュ) を返す
				const returnedHash = await client.broadcastTxSync(txBytes);

				// ★ 修正 (エラー1): result.code チェックを削除。
				// 戻り値のハッシュと計算したハッシュが一致するか確認 (念のため)
				if (returnedHash.toUpperCase() !== hash) {
					log.warn(`[SequentialUpload] ブロードキャストされたTxハッシュ (${returnedHash}) が、計算したハッシュ (${hash}) と一致しません。`);
					// txHashes には計算したハッシュ (ローカル署名ベース) を使用し続ける
				} else {
					log.debug(`[SequentialUpload] Txブロードキャスト成功 (Sync): ${hash}`);
				}

			} catch (error) {
				// ブロードキャスト自体が失敗した場合 (Mempool full, ネットワークエラーなど)
				log.error(`[SequentialUpload] Tx (Hash: ${hash}) のブロードキャスト中に例外発生。`, error);
				// 例外が発生した場合も、ハッシュは txHashes に含まれているため、
				// ConfirmationStrategy が後で確認 (そして失敗) することになる。
			}
		}

		return txHashes;
	}
}