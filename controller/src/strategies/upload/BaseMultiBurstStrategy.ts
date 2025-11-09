// controller/src/strategies/upload/BaseMultiBurstStrategy.ts
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { EncodeObject } from '@cosmjs/proto-signing';
import { calculateFee, GasPrice, SignerData, StdFee } from '@cosmjs/stargate';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { DEFAULT_GAS_PRICE } from '../../core/ChainManager';
import {
	MsgCreateStoredChunk,
	RunnerContext,
	TransactionInfo,
} from '../../types/index';
import { log } from '../../utils/logger';
import { IProgressBar } from '../../utils/ProgressManager/IProgressManager';
import { ConfirmationOptions } from '../confirmation';
import { BaseUploadStrategy, ChunkBatch, ChunkInfo, ChunkLocation } from './BaseUploadStrategy';

const DEFAULT_BATCH_SIZE_PER_CHAIN = 100;

/**
 * 「マルチバースト」方式（ノンスねじ込みによるバッチ送信＆確認）の
 * 共通ロジックを提供する抽象基底クラス。
 */
export abstract class BaseMultiBurstStrategy extends BaseUploadStrategy {

	protected batchSizePerChain: number;

	constructor() {
		super();
		this.batchSizePerChain = DEFAULT_BATCH_SIZE_PER_CHAIN;
	}

	/**
	 * 【Template Method】マルチバースト方式のアップロード処理を実行します。
	 */
	protected async processUpload(
		context: RunnerContext,
		allChunks: ChunkInfo[],
		estimatedGasLimit: string
	): Promise<ChunkLocation[] | null> {

		log.info(`[${this.constructor.name}] ${allChunks.length} チャンクをマルチバースト方式で処理開始... (GasLimit: ${estimatedGasLimit})`);

		const locations = await this.distributeAndProcessMultiBurst(
			context,
			allChunks,
			estimatedGasLimit
		);

		if (locations === null) {
			log.error(`[${this.constructor.name}] マルチバースト処理が失敗しました。`);
			return null;
		}

		log.info(`[${this.constructor.name}] マルチバースト処理が正常に完了しました。 (処理チャンク数: ${locations.length})`);
		return locations;
	}

	/**
	 * 【抽象メソッド】スケジューリングロジック。
	 */
	protected abstract distributeAndProcessMultiBurst(
		context: RunnerContext,
		allChunks: ChunkInfo[],
		estimatedGasLimit: string
	): Promise<ChunkLocation[] | null>;


	/**
	 * 1バッチ分のTxを送信し、完了確認まで行うワーカー処理 (共通)
	 * (★ 修正: onProgress のロジックを修正)
	 */
	protected async processBatchWorker(
		context: RunnerContext,
		chainName: string,
		batch: ChunkBatch,
		estimatedGasLimit: string,
		bar: IProgressBar
	): Promise<ChunkLocation[] | null> {
		const { tracker, confirmationStrategy, config } = context;

		try {
			// 1. バッチ送信 (マルチバースト)
			bar.updatePayload({ status: 'Broadcasting...' });
			const batchTxHashes = await this.sendChunkBatch(
				context,
				chainName,
				batch.chunks,
				estimatedGasLimit,
				bar
			);

			// 2. 完了確認 (TxEvent または Polling)
			bar.updatePayload({ status: 'Confirming...' });

			// ★★★ 修正点 2 ★★★
			let confirmedCountInBatch = 0;
			const totalInBatch = batchTxHashes.length; // (ブロードキャストに成功したハッシュの総数)

			const confirmOptions: ConfirmationOptions = {
				timeoutMs: config.confirmationStrategyOptions?.timeoutMs,

				onProgress: (result) => {
					confirmedCountInBatch++;
					const isLast = confirmedCountInBatch === totalInBatch;

					if (result.success) {
						// 最後のTxならステータスを 'Batch Done' に
						const status = isLast ? 'Batch Done' : 'Confirming...';
						bar.increment(1, { status: status });
					} else {
						// 最後のTxが失敗なら 'Batch Failed!' に
						const status = isLast ? 'Batch Failed!' : 'Tx Failed!';
						bar.increment(1, { status: status });
					}
				}
			};
			const results = await confirmationStrategy.confirmTransactions(context, chainName, batchTxHashes, confirmOptions);
			// ★★★ (ここまで) ★★★

			// 3. 結果記録 (PerformanceTracker 用)
			const txInfos: TransactionInfo[] = batchTxHashes.map((hash, i) => ({
				hash: hash,
				chainName: chainName,
				// @ts-ignore
				chunkIndex: batch.chunks[i]?.index,
				...results.get(hash)!
			}));
			tracker.recordTransactions(txInfos);

			// 4. 失敗チェック
			const failedTxs = txInfos.filter(info => !info.success);
			if (failedTxs.length > 0) {
				log.error(`[MultiBurstWorker ${chainName}] バッチ処理で ${failedTxs.length} 件のTxが失敗しました (例: ${failedTxs[0]?.error})。`);
				// (ステータスは onProgress の 'Batch Failed!' で更新済み)
				return null;
			}

			// ★ 削除: bar.updatePayload({ status: 'Batch Done' });
			// (onProgress で 'Batch Done' が設定されるため不要)

			const batchLocations: ChunkLocation[] = batch.chunks.map(chunk => ({
				index: chunk.index,
				chainName: chainName,
			}));
			return batchLocations;

		} catch (error) {
			log.error(`[MultiBurstWorker ${chainName}] バッチ処理中にエラーが発生しました。`, error);
			bar.updatePayload({ status: 'Error' });
			return null;
		}
	}

	/**
	 * チャンクのバッチをノンス手動管理で逐次送信します (マルチバースト共通)
	 */
	protected async sendChunkBatch(
		context: RunnerContext,
		chainName: string,
		chunks: ChunkInfo[],
		gasLimit: string,
		bar: IProgressBar
	): Promise<string[]> {

		const { chainManager } = context;
		const account = chainManager.getChainAccount(chainName);
		const client = account.signingClient;

		let currentSequence = chainManager.getCurrentSequence(chainName);
		const accountNumber = chainManager.getAccountNumber(chainName);
		const chainId = await client.getChainId();

		const messages: EncodeObject[] = chunks.map(info => {
			const msg: MsgCreateStoredChunk = {
				creator: account.address,
				index: info.index,
				data: info.chunk,
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

		log.debug(`[sendChunkBatch ${chainName}] ${messages.length} 件のTxをオフライン署名中... (Start Seq: ${currentSequence})`);

		for (const msg of messages) {
			const signerData: SignerData = {
				accountNumber: accountNumber,
				sequence: currentSequence,
				chainId: chainId,
			};
			const txRaw = await client.sign(account.address, [msg], fee, '', signerData);
			txRawBytesList.push(TxRaw.encode(txRaw).finish());
			currentSequence++;
		}

		chainManager.incrementSequence(chainName, messages.length);

		log.debug(`[sendChunkBatch ${chainName}] ${txRawBytesList.length} 件のTxをブロードキャスト中...`);

		bar.updatePayload({ status: 'Broadcasting...' });

		for (const txBytes of txRawBytesList) {
			const hash = toHex(sha256(txBytes)).toUpperCase();
			txHashes.push(hash);
			try {
				client.broadcastTx(txBytes).catch(broadcastError => {
					log.warn(`[sendChunkBatch ${chainName}] Tx (Hash: ${hash}) のブロードキャストで非同期エラー発生。`, broadcastError);
				});
				log.debug(`[sendChunkBatch ${chainName}] Txブロードキャスト送信: ${hash.substring(0, 10)}...`);
			} catch (error: any) {
				log.error(`[sendChunkBatch ${chainName}] Tx (Hash: ${hash}) のブロードキャスト呼び出し中に例外発生。`, error);
			}
		}
		return txHashes;
	}
}