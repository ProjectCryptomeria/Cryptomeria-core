// controller/src/experiments/configs/case7-Distribute-ChunkSizeScale.config.ts
import { ExperimentConfig } from '../../../types';

/**
 * Test Case 7: Distribute (Available + MultiBurst) Chunk Size Scalability Test
 * (★ 新フォーマットに対応)
 */
const config: ExperimentConfig = {
	description: 'Case 7: Distribute (Available + MultiBurst) Chunk Size Scalability Test',
	iterations: 3,

	tasks: [
		{
			description: '10MB, 4 chains, 256KB chunk',
			target: { type: 'sizeKB', value: 10240 }, // 10MB
			chainCount: 4,
			chunkSize: 256 * 1024, // 256KB
		},
		{
			description: '10MB, 4 chains, 512KB chunk',
			target: { type: 'sizeKB', value: 10240 },
			chainCount: 4,
			chunkSize: 512 * 1024, // 512KB
		},
		{
			description: '10MB, 4 chains, 1MB chunk',
			target: { type: 'sizeKB', value: 10240 },
			chainCount: 4,
			chunkSize: 1024 * 1024, // 1MB
		},
		{
			description: '10MB, 4 chains, 5MB chunk',
			target: { type: 'sizeKB', value: 10240 },
			chainCount: 4,
			chunkSize: 5 * 1024 * 1024, // 5MB
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