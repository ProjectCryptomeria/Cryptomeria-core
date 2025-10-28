// controller/src/strategies/gas/SimulationGasEstimationStrategy.ts
import { EncodeObject } from '@cosmjs/proto-signing';
import { RunnerContext } from '../../types/index';
import { log } from '../../utils/logger';
import { IGasEstimationStrategy } from './IGasEstimationStrategy';

// ガスシミュレーションのマージン
const GAS_SIMULATION_MARGIN = 1.5;
// シミュレーション失敗時のフォールバックガスリミット
const FALLBACK_GAS_LIMIT = '60000000';

/**
 * SigningStargateClient.simulate() を使用してガスリミットを見積もる戦略。
 */
export class SimulationGasEstimationStrategy implements IGasEstimationStrategy {
	constructor() {
		log.debug('SimulationGasEstimationStrategy がインスタンス化されました。');
	}

	public async estimateGasLimit(
		context: RunnerContext,
		targetChainName: string,
		sampleMessage: EncodeObject
	): Promise<string> {

		const { chainManager } = context;
		let estimatedGasLimit = FALLBACK_GAS_LIMIT; // デフォルト値

		try {
			const targetChain = chainManager.getChainAccount(targetChainName);
			log.info(`[GasSim] チェーン "${targetChainName}" でガス使用量をシミュレーション中... (Msg: ${sampleMessage.typeUrl})`);

			const gasUsed = await targetChain.signingClient.simulate(
				targetChain.address,
				[sampleMessage],
				'' // memo
			);

			const gasLimit = Math.ceil(gasUsed * GAS_SIMULATION_MARGIN);
			estimatedGasLimit = gasLimit.toString();
			log.info(`[GasSim] ガスシミュレーション結果: gasUsed=${gasUsed}, 推定ガスリミット (x${GAS_SIMULATION_MARGIN}): ${estimatedGasLimit}`);

		} catch (simError: any) {
			log.warn(`[GasSim] ガスシミュレーションに失敗しました。フォールバックのガスリミット (${estimatedGasLimit}) を使用します。エラー: ${simError.message}`);
		}

		return estimatedGasLimit;
	}
}