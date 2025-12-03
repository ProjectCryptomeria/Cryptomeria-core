// controller/src/strategies/confirmation/IConfirmationStrategy.ts
import type { RunnerContext } from '../../types';
import type { ConfirmationResult } from '../../types/experiment';

/**
 * トランザクションの完了確認オプション
 */
export interface ConfirmationOptions {
	/** タイムアウト (ミリ秒) */
	timeoutMs?: number;

	/** * ★ 修正: プログレスバー更新等のためのコールバック (オプション)
	 * 1件確認が完了するたびに呼び出されます。
	 */
	onProgress?: (result: ConfirmationResult) => void;
}

/**
 * 送信済みトランザクションの完了（ブロックへの取り込みと実行結果）を確認する方法を抽象化するインターフェース。
 * 実装クラス (PollingConfirmationStrategy, TxEventConfirmationStrategy) によって具体的な確認手段を提供します。
 */
export interface IConfirmationStrategy {
	/**
	 * 指定されたトランザクションハッシュのリストがブロックに取り込まれたかを確認します。
	 * @param context 実行に必要なツール群 (ICommunicationStrategyへのアクセスなど)
	 * @param chainName 確認対象のチェーン名
	 * @param txHashes 確認対象のトランザクションハッシュの配列
	 * @param options タイムアウト設定などのオプション
	 * @returns Txハッシュをキーとし、確認結果 (ConfirmationResult) を値とする Map
	 */
	confirmTransactions(
		context: RunnerContext,
		chainName: string,
		txHashes: string[],
		options: ConfirmationOptions
	): Promise<Map<string, ConfirmationResult>>;
}