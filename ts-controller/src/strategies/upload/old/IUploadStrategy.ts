// controller/src/strategies/upload/IUploadStrategy.ts
import type { RunnerContext } from '../../../types';
import type { UploadResult } from '../../../types/experiment';

/**
 * データのアップロード戦略（分割方法、チェーンへの割り当て方、送信手順）を抽象化するインターフェース。
 * 実装クラス (SequentialUploadStrategy, RoundRobinUploadStrategy, AutoDistributeUploadStrategy) によって
 * 具体的なアップロードロジックを提供します。
 */
export interface IUploadStrategy {
	/**
	 * 指定されたデータを、指定されたURLに関連付けてRaidchainにアップロードします。
	 * @param context 実行に必要なツール群 (ChainManager, IConfirmationStrategyへのアクセスなど)
	 * @param data アップロード対象のデータ (Buffer)
	 * @param targetUrl このデータに関連付ける一意なURL (例: 'my-site/index.html')
	 * @returns アップロード結果 (所要時間、Tx数、ガス代など)
	 */
	execute(
		context: RunnerContext,
		data: Buffer,
		targetUrl: string
	): Promise<UploadResult>;
}