// controller/src/experiments/configs/case8-Sequential-ChainScale.config.ts
import { ExperimentConfig } from '../../../types';

/**
 * Test Case 8: Sequential (Static + OneByOne) Chain Scalability Test (100MB)
 * (★ 新フォーマットに対応)
 */
const config: ExperimentConfig = {
	description: 'Case 8: Sequential (Static + 1by1) Chain Scalability Test (100MB)',
	iterations: 1,

	tasks: [
		{
			description: '100MB, 1 chain, 1MB chunk',
			target: { type: 'sizeKB', value: 102400 }, // 100MB
			chainCount: 1,
			chunkSize: 1024 * 1024, // 1MB
			targetChain: 'data-0', // StaticMultiAllocator が chainCount: 1 を見て data-0 を使う
		},
		{
			description: '100MB, 2 chains, 1MB chunk',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 2,
			chunkSize: 1024 * 1024,
			targetChain: 'data-0',
		},
		{
			description: '100MB, 3 chains, 1MB chunk',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 3,
			chunkSize: 1024 * 1024,
			targetChain: 'data-0',
		},
		{
			description: '100MB, 4 chains, 1MB chunk',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 4,
			chunkSize: 1024 * 1024,
			targetChain: 'data-0',
		},
	],

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',
		// ★ 修正
		uploadAllocator: 'StaticMulti', // Sequential -> StaticMulti
		uploadTransmitter: 'OneByOne',  // Sequential -> OneByOne
		confirmation: 'TxEvent',
		download: 'Http',
		verification: 'BufferFull',
	},

	uploadStrategyOptions: {},
	confirmationStrategyOptions: {
		timeoutMs: 600000, // 10分 (100MB, 1by1 のため延長)
	},
};

export default config;