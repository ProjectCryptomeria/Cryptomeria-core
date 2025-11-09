// controller/src/strategies/upload/implement/allocator/RandomAllocator.ts
import { RunnerContext } from '../../../../types';
import { log } from '../../../../utils/logger';
import { BaseCoreLogic, ChunkInfo, UploadJob } from '../../base/BaseCoreLogic';
import { IChunkAllocator } from '../../interfaces/IChunkAllocator';

const DEFAULT_BATCH_SIZE_PER_CHAIN = 100; // (MultiBurst用)

/**
 * 「共通キュー」＋「ランダム」割当ロジック。
 * チャンクをバッチ化し、利用可能なチェーンにランダムに割り当てる。
 *
 * (M-3_C, M-4_C ケースに対応)
 */
export class RandomAllocator implements IChunkAllocator {
	private coreLogic: BaseCoreLogic;

	constructor() {
		log.debug('RandomAllocator がインスタンス化されました。');
		this.coreLogic = new BaseCoreLogic();
	}

	public async allocateChunks(
		context: RunnerContext,
		allChunks: ChunkInfo[]
	): Promise<UploadJob[]> {

		const { chainManager, currentTask, config } = context;

		if (!currentTask) {
			throw new Error('[RandomAllocator] context.currentTask が設定されていません。');
		}

		// 1. 利用するチェーンを決定
		const allDatachains = chainManager.getDatachainInfos();
		const chainCount = currentTask.chainCount ?? 1;
		const targetDatachains = allDatachains.slice(0, chainCount);

		if (targetDatachains.length === 0) {
			throw new Error('[RandomAllocator] 利用可能な datachain が0件です。');
		}

		// 2. バッチサイズを決定
		const batchSize = (config.strategies.upload === 'Sequential')
			? 1
			: DEFAULT_BATCH_SIZE_PER_CHAIN;

		const batches = this.coreLogic.createBatches(allChunks, batchSize);

		log.info(`[RandomAllocator] ${allChunks.length} チャンク (${batches.length} バッチ) を ${targetDatachains.length} チェーンにランダムで割り当てます。`);

		// 3. バッチをチェーンにランダムで割り当て
		const uploadJobs: UploadJob[] = batches.map((batch) => {
			const chainIndex = Math.floor(Math.random() * targetDatachains.length);
			const chainName = targetDatachains[chainIndex]!.name;
			return {
				chainName: chainName,
				batch: batch
			};
		});

		return uploadJobs;
	}
}