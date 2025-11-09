// controller/src/strategies/upload/SequentialUploadStrategy.ts
import { RunnerContext } from '../../types/index';
import { log } from '../../utils/logger';
import { BaseOneByOneStrategy } from './BaseOneByOneStrategy'; // ★ 修正
import { ChunkInfo } from './BaseUploadStrategy';
import { IUploadStrategy } from './IUploadStrategy';

/**
 * データを分割し、指定された単一の datachain に対して
 * 「ワンバイワン」方式で逐次的にアップロードする戦略。
 */
export class SequentialUploadStrategy extends BaseOneByOneStrategy implements IUploadStrategy { // ★ 修正

	constructor() {
		super(); // ★ 修正
		log.debug('SequentialUploadStrategy (OneByOne) がインスタンス化されました。');
	}

	/**
	 * 【戦略固有ロジック】
	 * すべてのチャンクを、設定で指定された単一のチェーンに割り当てます。
	 * ★★★ 変更点 ★★★
	 */
	protected distributeJobs(
		context: RunnerContext,
		allChunks: ChunkInfo[]
	): { chainName: string, chunk: ChunkInfo }[] {

		// ★ 変更: config.uploadStrategyOptions ではなく context.currentTask を参照
		const { chainManager, currentTask } = context;

		if (!currentTask) {
			throw new Error('[SequentialUpload] context.currentTask が設定されていません。');
		}

		// 1. 設定から対象チェーンを特定 (Sequential 固有)
		const targetChainName = currentTask.targetChain;
		if (!targetChainName) {
			throw new Error('[SequentialUpload] TaskOption に "targetChain" を指定する必要があります。');
		}
		// ★★★ 変更点 (ここまで) ★★★

		// 存在確認
		chainManager.getChainAccount(targetChainName);
		log.info(`[SequentialUpload] 戦略実行。対象チェーン: ${targetChainName}, 総チャンク数: ${allChunks.length}`);

		// 2. 全チャンクを単一チェーンに割り当てる (Sequential 固有)
		return allChunks.map(chunk => ({
			chainName: targetChainName,
			chunk: chunk,
		}));
	}

	// processUpload, processChunkOneByOne などのロジックは基底クラスが持つため不要
}