// controller/src/strategies/download/IDownloadStrategy.ts
import type { RunnerContext } from '../../types';
import type { DownloadResult } from '../../types/experiment';

/**
 * データのダウンロード戦略（マニフェスト取得、チャンク取得、データ復元）を抽象化するインターフェース。
 * 実装クラス (HttpDownloadStrategy) によって具体的なダウンロードロジックを提供します。
 */
export interface IDownloadStrategy {
	/**
	 * 指定されたURLに関連付けられたデータをRaidchainからダウンロードし、復元します。
	 * @param context 実行に必要なツール群 (ICommunicationStrategyへのアクセスなど)
	 * @param targetUrl ダウンロード対象のURL (アップロード時に指定したもの)
	 * @returns ダウンロード結果 (復元データ、所要時間)
	 */
	execute(
		context: RunnerContext,
		targetUrl: string
	): Promise<DownloadResult>;
}