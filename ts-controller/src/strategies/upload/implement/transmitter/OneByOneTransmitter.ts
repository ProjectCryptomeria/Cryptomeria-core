// controller/src/strategies/upload/implement/transmitter/OneByOneTransmitter.ts
import { DeliverTxResponse } from '@cosmjs/stargate';
import { ConfirmationResult, MsgCreateStoredChunk, RunnerContext } from '../../../../types/index';
import { log } from '../../../../utils/logger';
import { IProgressBar } from '../../../../utils/ProgressManager/IProgressManager';
import { ChunkBatch, ChunkInfo, ChunkLocation } from '../../base/BaseCoreLogic';
import { IUploadTransmitter } from '../../interfaces/IUploadTransmitter';

/**
 * 「ワンバイワン」方式（1 Tx ずつ signAndBroadcast）でバッチを送信・確認する実行クラス。
 * (旧 BaseOneByOneStrategy のロジック)
 */
export class OneByOneTransmitter implements IUploadTransmitter {

	constructor() {
		log.debug('OneByOneTransmitter がインスタンス化されました。');
	}

	/**
	 * 1つのチャンクバッチを「ワンバイワン」方式で逐次処理します。
	 * この方式では estimatedGasLimit は使用されません ('auto')。
	 */
	public async transmitBatch(
		context: RunnerContext,
		batch: ChunkBatch,
		chainName: string,
		estimatedGasLimit: string, // 未使用
		bar: IProgressBar
	): Promise<ChunkLocation[] | null> {

		const successfulLocations: ChunkLocation[] = [];

		for (const chunk of batch.chunks) {
			const location = await this.processChunkOneByOne(context, chainName, chunk, bar);

			if (location === null) {
				log.error(`[OneByOneTx] チャンク ${chunk.index} の処理に失敗。バッチ処理を中断します。`);
				// (bar のステータスは processChunkOneByOne 内で更新される)
				return null;
			}
			successfulLocations.push(location);
		}

		// バッチが正常に完了 (ただし、onProgress側で 'Batch Done' にするのが望ましい)
		// bar.updatePayload({ status: 'Batch Done' });
		return successfulLocations;
	}

	/**
	 * 1件のチャンクを「ワンバイワン」方式で送信・確認します。
	 * (旧 BaseOneByOneStrategy.processChunkOneByOne)
	 */
	private async processChunkOneByOne(
		context: RunnerContext,
		chainName: string,
		chunk: ChunkInfo,
		bar: IProgressBar
	): Promise<ChunkLocation | null> {

		const { chainManager, tracker } = context;
		const account = chainManager.getChainAccount(chainName);

		const msg: MsgCreateStoredChunk = {
			creator: account.address,
			index: chunk.index,
			data: chunk.chunk,
		};

		let result: ConfirmationResult;

		try {
			// 1件ずつ送信し、完了(DeliverTxResponse)を待つ
			const { gasUsed, transactionHash, height, code, rawLog }: DeliverTxResponse =
				await account.signingClient.signAndBroadcast(
					account.address,
					[{ typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk', value: msg }],
					'auto' // ガス代は自動計算
				);

			const success = code === 0;

			result = {
				success: success,
				height: height,
				gasUsed: gasUsed,
				feeAmount: undefined, // 'auto' のため正確な手数料取得は困難
				error: success ? undefined : rawLog,
			};

			tracker.recordTransaction({
				hash: transactionHash,
				chainName: chainName,
				...result
			});

			if (!success) {
				log.warn(`[OneByOneTx] Tx失敗 (Chain: ${chainName}, Hash: ${transactionHash}): ${rawLog}`);
				bar.increment(1, { status: 'Tx Failed!' });
				return null;
			}

			// 成功時はバーの進捗を更新 (onProgressコールバックがないためここで更新)
			bar.increment(1, { status: 'Confirming...' }); // ワンバイワンは即確認完了
			return { index: chunk.index, chainName: chainName };

		} catch (error: any) {
			log.error(`[OneByOneTx] signAndBroadcast 中に例外発生 (Chain: ${chainName})。`, error);

			result = {
				success: false,
				error: error.message || 'Broadcast Error',
			};

			tracker.recordTransaction({
				hash: 'N/A (Broadcast Error)',
				chainName: chainName,
				...result
			});

			bar.increment(1, { status: 'Broadcast Error' });
			return null;
		}
	}
}