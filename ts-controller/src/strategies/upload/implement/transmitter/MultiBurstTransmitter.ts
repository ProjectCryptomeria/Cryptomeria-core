// controller/src/strategies/upload/implement/transmitter/MultiBurstTransmitter.ts
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { EncodeObject } from '@cosmjs/proto-signing';
import { calculateFee, GasPrice, SignerData, StdFee } from '@cosmjs/stargate';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { DEFAULT_GAS_PRICE } from '../../../../core/ChainManager';
import {
	MsgCreateStoredChunk,
	RunnerContext,
	TransactionInfo,
} from '../../../../types/index';
import { log } from '../../../../utils/logger';
import { IProgressBar } from '../../../../utils/ProgressManager/IProgressManager';
import { ConfirmationOptions } from '../../../confirmation';
import { ChunkBatch, ChunkInfo, ChunkLocation } from '../../base/BaseCoreLogic';
import { IUploadTransmitter } from '../../interfaces/IUploadTransmitter';
// CometClient のインポートは不要
// import { CometClient } from '@cosmjs/tendermint-rpc';

/**
 * 「マルチバースト」方式（ノンス手動管理によるバッチ送信＆非同期確認）で
 * バッチを送信・確認する実行クラス。
 * (旧 BaseMultiBurstStrategy のロジック)
 */
export class MultiBurstTransmitter implements IUploadTransmitter {

	constructor() {
		log.debug('MultiBurstTransmitter がインスタンス化されました。');
	}

	/**
	 * 1バッチ分のTxを送信し、完了確認まで行うワーカー処理 (共通)
	 * (旧 processBatchWorker)
	 */
	public async transmitBatch(
		context: RunnerContext,
		batch: ChunkBatch,
		chainName: string,
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

			let confirmedCountInBatch = 0;
			const totalInBatch = batchTxHashes.length;

			const confirmOptions: ConfirmationOptions = {
				timeoutMs: config.confirmationStrategyOptions?.timeoutMs,

				// プログレスバー更新用のコールバック
				onProgress: (result) => {
					confirmedCountInBatch++;
					const isLast = confirmedCountInBatch === totalInBatch;

					if (result.success) {
						const status = isLast ? 'Batch Done' : 'Confirming...';
						bar.increment(1, { status: status });
					} else {
						const status = isLast ? 'Batch Failed!' : 'Tx Failed!';
						bar.increment(1, { status: status });
					}
				}
			};
			const results = await confirmationStrategy.confirmTransactions(context, chainName, batchTxHashes, confirmOptions);

			// 3. 結果記録 (PerformanceTracker 用)
			const txInfos: TransactionInfo[] = batchTxHashes.map((hash, i) => ({
				hash: hash,
				chainName: chainName,
				// @ts-ignore
				chunkIndex: batch.chunks[i]?.index, // デバッグ用
				...results.get(hash)!
			}));
			tracker.recordTransactions(txInfos);

			// 4. 失敗チェック
			const failedTxs = txInfos.filter(info => !info.success);
			if (failedTxs.length > 0) {
				log.error(`[MultiBurstTx ${chainName}] バッチ処理で ${failedTxs.length} 件のTxが失敗しました (例: ${failedTxs[0]?.error})。`);
				// (ステータスは onProgress の 'Batch Failed!' で更新済み)
				return null;
			}

			// 5. 成功
			const batchLocations: ChunkLocation[] = batch.chunks.map(chunk => ({
				index: chunk.index,
				chainName: chainName,
			}));
			return batchLocations;

		} catch (error) {
			log.error(`[MultiBurstTx ${chainName}] バッチ処理中にエラーが発生しました。`, error);
			bar.updatePayload({ status: 'Error' });
			return null;
		}
	}

	/**
	 * チャンクのバッチをノンス手動管理で逐次送信します (マルチバースト共通)
	 * (旧 sendChunkBatch)
	 */
	private async sendChunkBatch(
		context: RunnerContext,
		chainName: string,
		chunks: ChunkInfo[],
		gasLimit: string,
		bar: IProgressBar
	): Promise<string[]> {

		const { chainManager } = context;
		const account = chainManager.getChainAccount(chainName);
		const client = account.signingClient;

		// ★★★ 修正 (ここから) ★★★
		// Tx署名を開始する前に、ローカルのシーケンス番号を
		// チェーンの最新状態に強制的に同期させる
		try {
			await chainManager.resyncSequence(chainName);
		} catch (resyncError) {
			log.error(`[MultiBurstTx ${chainName}] 署名開始前のシーケンス再同期に失敗しました。`, resyncError);
			throw resyncError; // バッチ処理を失敗させる
		}
		// ★★★ 修正 (ここまで) ★★★

		// client.getCometClient() の呼び出しは不要

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

		log.debug(`[MultiBurstTx ${chainName}] ${messages.length} 件のTxをオフライン署名中... (Start Seq: ${currentSequence})`);

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

		log.debug(`[MultiBurstTx ${chainName}] ${txRawBytesList.length} 件のTxをブロードキャスト中...`);

		bar.updatePayload({ status: 'Broadcasting...' });

		for (const txBytes of txRawBytesList) {
			const hash = toHex(sha256(txBytes)).toUpperCase();
			txHashes.push(hash);
			try {
				// ★ 修正: client.broadcastTxSync(txBytes) を呼び出す
				client.broadcastTxSync(txBytes).catch(broadcastError => {
					// broadcastTxSync が失敗した場合 (CheckTx でエラーなど)
					log.warn(`[MultiBurstTx ${chainName}] Tx (Hash: ${hash}) の broadcastTxSync で非同期エラー発生。`, broadcastError);
				});
				log.debug(`[MultiBurstTx ${chainName}] Txブロードキャスト送信: ${hash.substring(0, 10)}...`);
			} catch (error: any) {
				log.error(`[MultiBurstTx ${chainName}] Tx (Hash: ${hash}) のブロードキャスト呼び出し中に例外発生。`, error);
			}
		}
		return txHashes;
	}
}