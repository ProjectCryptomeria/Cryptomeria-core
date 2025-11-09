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
import { BaseUploadStrategy, ChunkBatch, ChunkInfo } from './BaseUploadStrategy';

// 各チェーンが一度に送信するバッチサイズ (Tx数) のデフォルト
const DEFAULT_BATCH_SIZE_PER_CHAIN = 100;

/**
 * 「マルチバースト」方式（ノンスねじ込みによるバッチ送信＆確認）の
 * 共通ロジックを提供する抽象基底クラス。
 */
export abstract class BaseMultiBurstStrategy extends BaseUploadStrategy {

	protected batchSizePerChain: number;

	constructor() {
		super();
		// バッチサイズは config からも読めるようにするとより柔軟だが、一旦固定
		this.batchSizePerChain = DEFAULT_BATCH_SIZE_PER_CHAIN;
	}

	/**
	 * 【Template Method】マルチバースト方式のアップロード処理を実行します。
	 * 派生クラスは、スケジューリングロジック (distributeAndProcessMultiBurst) のみを実装します。
	 */
	protected async processUpload(
		context: RunnerContext,
		allChunks: ChunkInfo[],
		estimatedGasLimit: string
	): Promise<boolean> {

		log.step(`[${this.constructor.name}] ${allChunks.length} チャンクをマルチバースト方式で処理開始... (GasLimit: ${estimatedGasLimit})`);

		// 【抽象メソッド】派生クラス（具象戦略）がスケジューリングを実行
		const success = await this.distributeAndProcessMultiBurst(
			context,
			allChunks,
			estimatedGasLimit
		);

		log.info(`[${this.constructor.name}] マルチバースト処理が完了しました。 (Success: ${success})`);
		return success;
	}

	/**
	 * 【抽象メソッド】スケジューリングロジック。
	 * 派生クラスは、全チャンクをどのようにバッチ化し、
	 * どのチェーンに割り当てて処理 (processBatchWorker) するかを定義します。
	 */
	protected abstract distributeAndProcessMultiBurst(
		context: RunnerContext,
		allChunks: ChunkInfo[],
		estimatedGasLimit: string
	): Promise<boolean>;


	/**
	 * 1バッチ分のTxを送信し、完了確認まで行うワーカー処理 (共通)
	 */
	protected async processBatchWorker(
		context: RunnerContext,
		chainName: string,
		batch: ChunkBatch,
		estimatedGasLimit: string
	): Promise<boolean> {
		const { tracker, confirmationStrategy, config } = context;

		try {
			// 1. バッチ送信 (マルチバースト)
			const batchTxHashes = await this.sendChunkBatch(
				context,
				chainName,
				batch.chunks,
				estimatedGasLimit
			);

			// 2. 完了確認 (TxEvent または Polling)
			const confirmOptions = { timeoutMs: config.confirmationStrategyOptions?.timeoutMs };
			const results = await confirmationStrategy.confirmTransactions(context, chainName, batchTxHashes, confirmOptions);

			// 3. 結果記録
			const txInfos: TransactionInfo[] = batchTxHashes.map(hash => ({
				hash: hash,
				chainName: chainName,
				...results.get(hash)!
			}));
			tracker.recordTransactions(txInfos);

			// 4. 失敗チェック
			const failedTxs = txInfos.filter(info => !info.success);
			if (failedTxs.length > 0) {
				log.error(`[MultiBurstWorker ${chainName}] バッチ処理で ${failedTxs.length} 件のTxが失敗しました (例: ${failedTxs[0]?.error})。`);
				return false;
			}

			log.info(`[MultiBurstWorker ${chainName}] バッチ (${batch.chunks.length} Tx) の処理が正常に完了しました。`);
			return true;

		} catch (error) {
			log.error(`[MultiBurstWorker ${chainName}] バッチ処理中にエラーが発生しました。`, error);
			return false;
		}
	}

	/**
	 * チャンクのバッチをノンス手動管理で逐次送信します (マルチバースト共通)
	 */
	protected async sendChunkBatch(
		context: RunnerContext,
		chainName: string,
		chunks: ChunkInfo[],
		gasLimit: string
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

		for (const txBytes of txRawBytesList) {
			const hash = toHex(sha256(txBytes)).toUpperCase();
			txHashes.push(hash);
			try {
				await client.broadcastTxSync(txBytes);
				log.debug(`[sendChunkBatch ${chainName}] Txブロードキャスト成功 (Sync): ${hash.substring(0, 10)}...`);
			} catch (error: any) {
				log.error(`[sendChunkBatch ${chainName}] Tx (Hash: ${hash}) のブロードキャスト中に例外発生。`, error);
			}
		}
		return txHashes;
	}
}