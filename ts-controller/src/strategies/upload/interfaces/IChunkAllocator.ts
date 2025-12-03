// controller/src/strategies/upload/interfaces/IChunkAllocator.ts
import { RunnerContext } from '../../../types';
import { ChunkInfo, UploadJob } from '../base/BaseCoreLogic';

/**
 * チャンクの「割当ロジック」を定義する契約（スケジューラー）。
 *
 * 責務: 全チャンクのリストを受け取り、どのチェーンに、どのようにグループ化して送るか
 * という実行計画（UploadJob[]）を立てる。
 */
export interface IChunkAllocator {
	/**
	 * チャンクリストを実行計画（ジョブリスト）に割り当てます。
	 * @param context 実行コンテキスト (Mempool監視やタスク設定へのアクセスに利用)
	 * @param allChunks 処理対象の全チャンク
	 * @returns 実行計画の配列
	 */
	allocateChunks(
		context: RunnerContext,
		allChunks: ChunkInfo[]
	): Promise<UploadJob[]>;
}