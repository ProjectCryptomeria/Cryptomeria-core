// controller/src/strategies/upload/interfaces/IUploadTransmitter.ts
import { RunnerContext } from '../../../types';
import { IProgressBar } from '../../../utils/ProgressManager/IProgressManager';
import { ChunkBatch, ChunkLocation } from '../base/BaseCoreLogic';

/**
 * Txの「送信・確認方式」を定義する契約（エグゼキューター）。
 *
 * 責務: 1つのTx実行ジョブ（バッチと送信先チェーン）を受け取り、
 * 低レベルのTx署名、送信、完了確認を実行し、結果を返す。
 */
export interface IUploadTransmitter {
	/**
	 * 1つのチャンクバッチを、指定されたチェーンに送信・確認します。
	 * @param context 実行コンテキスト (ChainManager, IConfirmationStrategy へのアクセスに利用)
	 * @param batch 処理すべきチャンクのバッチ
	 * @param chainName 送信先のチェーン名
	 * @param estimatedGasLimit 1 Tx あたりのガスリミット (MultiBurst用)
	 * @param bar 進捗報告用のプログレスバーインスタンス
	 * @returns 成功したチャンクの場所情報リスト。失敗した場合は null。
	 */
	transmitBatch(
		context: RunnerContext,
		batch: ChunkBatch,
		chainName: string,
		estimatedGasLimit: string,
		bar: IProgressBar
	): Promise<ChunkLocation[] | null>;
}