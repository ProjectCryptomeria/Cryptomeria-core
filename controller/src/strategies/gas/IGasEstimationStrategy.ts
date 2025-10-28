// controller/src/strategies/gas/IGasEstimationStrategy.ts
import { EncodeObject } from '@cosmjs/proto-signing';
import { RunnerContext } from '../../types/index';

/**
 * トランザクションのガスリミットを見積もる戦略のインターフェース。
 */
export interface IGasEstimationStrategy {
	/**
	 * 指定されたサンプルメッセージに基づいて、
	 * トランザクションに必要なガスリミットを見積もります。
	 * @param context 実行コンテキスト (ChainManager へのアクセスなど)
	 * @param targetChainName ガスを見積もる対象のチェーン名
	 * @param sampleMessage ガス使用量を見積もるための代表的なメッセージ (例: 最初のチャンク)
	 * @returns 見積もられたガスリミット (文字列)
	 */
	estimateGasLimit(
		context: RunnerContext,
		targetChainName: string,
		sampleMessage: EncodeObject // { typeUrl: string, value: any }
	): Promise<string>;
}