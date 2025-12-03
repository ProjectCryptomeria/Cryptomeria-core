// controller/src/experiments/configs/case2-Sequential-TxEvent.config.ts
import { ExperimentConfig } from '../../../types';

/**
 * Test Case 2: Sequential (Static + OneByOne) + TxEvent
 * (★ 新フォーマットに対応)
 */
const config: ExperimentConfig = {
	description: 'Case 2: Sequential (Static + OneByOne) + TxEvent',
	iterations: 3,

	tasks: [
		{
			description: '1MB, 1 chain, 256KB chunk, data-0',
			target: {
				type: 'sizeKB',
				value: 1024, // 1MB
			},
			chainCount: 1,
			chunkSize: 256 * 1024, // 256KB
			targetChain: 'data-0', // StaticMultiAllocator が chainCount: 1 を見て data-0 を使う
		}
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
		timeoutMs: 120000, // 2分
	},
	targetUrlBase: `case2.test`,
};

export default config;