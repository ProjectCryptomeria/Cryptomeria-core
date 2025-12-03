// controller/src/experiments/configs/case3-Distribute-Poling.config.ts
import { ExperimentConfig } from '../../../types';

/**
 * Test Case 3: Distribute (Available + MultiBurst) + Polling
 * (★ 新フォーマットに対応)
 */
const config: ExperimentConfig = {
	description: 'Case 3: Distribute (Available + MultiBurst) + Polling',
	iterations: 3,

	tasks: [
		{
			description: '5MB, 4 chains, 256KB chunk',
			target: {
				type: 'sizeKB',
				value: 5 * 1024, // 5MB
			},
			chainCount: 4,
			chunkSize: 256 * 1024, // 256KB
		}
	],

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',
		// ★ 修正
		uploadAllocator: 'Available',  // Distribute -> Available
		uploadTransmitter: 'MultiBurst', // Distribute -> MultiBurst
		confirmation: 'Polling',
		download: 'Http',
		verification: 'BufferFull',
	},

	uploadStrategyOptions: {},
	confirmationStrategyOptions: {
		timeoutMs: 120000, // 2分
	},
};

export default config;