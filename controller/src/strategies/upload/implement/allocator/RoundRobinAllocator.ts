// controller/src/strategies/upload/implement/allocator/RoundRobinAllocator.ts
import { RunnerContext } from '../../../../types';
import { log } from '../../../../utils/logger';
import { BaseCoreLogic, ChunkInfo, UploadJob } from '../../base/BaseCoreLogic';
import { IChunkAllocator } from '../../interfaces/IChunkAllocator';

const DEFAULT_BATCH_SIZE_PER_CHAIN = 100; // (MultiBurst用)

/**
 * 「共通キュー」＋「ラウンドロビン」割当ロジック。
 * チャンクをバッチ化し、利用可能なチェーンに順番に割り当てる。
 *
 * (S-2, S-4, M-3_B, M-4_B ケースに対応)
 */
export class RoundRobinAllocator implements IChunkAllocator {
	private coreLogic: BaseCoreLogic;

	constructor() {
		log.debug('RoundRobinAllocator がインスタンス化されました。');
		this.coreLogic = new BaseCoreLogic();
	}

	public async allocateChunks(
		context: RunnerContext,
		allChunks: ChunkInfo[]
	): Promise<UploadJob[]> {

		const { chainManager, currentTask, config } = context;

		if (!currentTask) {
			throw new Error('[RoundRobinAllocator] context.currentTask が設定されていません。');
		}

		// 1. 利用するチェーンを決定
		const allDatachains = chainManager.getDatachainInfos();
		const chainCount = currentTask.chainCount ?? 1;
		const targetDatachains = allDatachains.slice(0, chainCount);

		if (targetDatachains.length === 0) {
			throw new Error('[RoundRobinAllocator] 利用可能な datachain が0件です。');
		}

		// 2. バッチサイズを決定
		// (OneByOne の場合は実質1)
		const batchSize = (config.strategies.upload === 'Sequential') // Sequential は OneByOneTransmitter を使う想定
			? 1
			: DEFAULT_BATCH_SIZE_PER_CHAIN; // TODO: options から取得

		const batches = this.coreLogic.createBatches(allChunks, batchSize);

		log.info(`[RoundRobinAllocator] ${allChunks.length} チャンク (${batches.length} バッチ) を ${targetDatachains.length} チェーンにラウンドロビンで割り当てます。`);

		// 3. バッチをチェーンにラウンドロビンで割り当て
		const uploadJobs: UploadJob[] = batches.map((batch, index) => {
			const chainIndex = index % targetDatachains.length;
			const chainName = targetDatachains[chainIndex]!.name;
			return {
				chainName: chainName,
				batch: batch
			};
		});

		return uploadJobs;
	}
}