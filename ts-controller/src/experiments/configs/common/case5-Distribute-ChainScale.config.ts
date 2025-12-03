// controller/src/experiments/configs/case5-Distribute-ChainScale.config.ts
import { ExperimentConfig } from '../../../types';

/**
 * Test Case 5: Distribute (Available + MultiBurst) Chain Scalability Test
 * (★ 新フォーマットに対応)
 */
const config: ExperimentConfig = {
	description: 'Case 5: Distribute (Available + MultiBurst) Chain Scalability Test',
	iterations: 2,

	tasks: [
		{
			description: '10MB, 1 chain, 256KB chunk',
			target: { type: 'sizeKB', value: 10240 }, // 10MB
			chainCount: 1,
			chunkSize: 256 * 1024, // 256KB
		},
		{
			description: '10MB, 2 chains, 256KB chunk',
			target: { type: 'sizeKB', value: 10240 },
			chainCount: 2,
			chunkSize: 256 * 1024,
		},
		{
			description: '10MB, 3 chains, 256KB chunk',
			target: { type: 'sizeKB', value: 10240 },
			chainCount: 3,
			chunkSize: 256 * 1024,
		},
		{
			description: '10MB, 4 chains, 256KB chunk',
			target: { type: 'sizeKB', value: 10240 },
			chainCount: 4,
			chunkSize: 256 * 1024,
		},
	],

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',
		// ★ 修正
		uploadAllocator: 'Available',  // Distribute -> Available
		uploadTransmitter: 'MultiBurst', // Distribute -> MultiBurst
		confirmation: 'TxEvent',
		download: 'Http',
		verification: 'BufferFull',
	},

	uploadStrategyOptions: {},
	confirmationStrategyOptions: {
		timeoutMs: 180000, // 3分
	},
};

export default config;