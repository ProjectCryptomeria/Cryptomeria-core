// controller/src/experiments/configs/case9-Distribute-ChainScale.config.ts
import { ExperimentConfig } from '../../../types';

/**
 * Test Case 9: Distribute (Available + MultiBurst) Chain Scalability Test (100MB)
 * (★ 新フォーマットに対応)
 */
const config: ExperimentConfig = {
	description: 'Case 9: Distribute (Available + Burst) Chain Scalability Test (100MB)',
	iterations: 1,

	tasks: [
		{
			description: '100MB, 1 chain, 1MB chunk',
			target: { type: 'sizeKB', value: 102400 }, // 100MB
			chainCount: 1,
			chunkSize: 1024 * 1024, // 1MB
		},
		{
			description: '100MB, 2 chains, 1MB chunk',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 2,
			chunkSize: 1024 * 1024,
		},
		{
			description: '100MB, 3 chains, 1MB chunk',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 3,
			chunkSize: 1024 * 1024,
		},
		{
			description: '100MB, 4 chains, 1MB chunk',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 4,
			chunkSize: 1024 * 1024,
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
		timeoutMs: 600000, // 10分 (100MBのため延長)
	},
};

export default config;