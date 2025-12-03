// controller/src/strategies/upload/implement/allocator/StaticMultiAllocator.ts
import { RunnerContext } from '../../../../types';
import { log } from '../../../../utils/logger';
import { BaseCoreLogic, ChunkInfo, UploadJob } from '../../base/BaseCoreLogic';
import { IChunkAllocator } from '../../interfaces/IChunkAllocator';

/**
 * 「メガチャンク」（静的）割当ロジック。
 * 全チャンクを、利用可能なチェーン数で「事前」に均等分割し、
 * 各チェーンに固定的に割り当てる。
 *
 * (S-1, S-3, M-1, M-2 ケースに対応)
 */
export class StaticMultiAllocator implements IChunkAllocator {
	private coreLogic: BaseCoreLogic;

	constructor() {
		log.debug('StaticMultiAllocator がインスタンス化されました。');
		this.coreLogic = new BaseCoreLogic();
	}

	public async allocateChunks(
		context: RunnerContext,
		allChunks: ChunkInfo[]
	): Promise<UploadJob[]> {

		const { chainManager, currentTask } = context;

		if (!currentTask) {
			throw new Error('[StaticAllocator] context.currentTask が設定されていません。');
		}

		// 1. 利用するチェーンを決定
		const allDatachains = chainManager.getDatachainInfos();
		const chainCount = currentTask.chainCount ?? 1;
		const targetDatachains = allDatachains.slice(0, chainCount);

		if (targetDatachains.length === 0) {
			throw new Error('[StaticAllocator] 利用可能な datachain が0件です。');
		}

		log.info(`[StaticAllocator] ${allChunks.length} チャンクを ${targetDatachains.length} チェーンに静的に割り当てます。`);

		// 2. チャンクをチェーンごとに分割
		const jobsMap = new Map<string, ChunkInfo[]>();
		targetDatachains.forEach(chain => jobsMap.set(chain.name, []));

		allChunks.forEach((chunk, index) => {
			const chainIndex = index % targetDatachains.length;
			const chainName = targetDatachains[chainIndex]!.name;
			jobsMap.get(chainName)!.push(chunk);
		});

		// 3. UploadJob[] 形式に変換
		// Static 戦略では、1チェーン = 1バッチ = 1ジョブ とする
		const uploadJobs: UploadJob[] = [];
		for (const [chainName, chunks] of jobsMap.entries()) {
			if (chunks.length > 0) {
				uploadJobs.push({
					chainName: chainName,
					batch: {
						chunks: chunks
					}
				});
				log.debug(`[StaticAllocator] ${chainName} に ${chunks.length} チャンクを割り当てました。`);
			}
		}

		return uploadJobs;
	}
}