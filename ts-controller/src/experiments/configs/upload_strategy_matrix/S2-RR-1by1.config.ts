// src/experiments/configs/upload_strategy_matrix/S2-RR-1by1.config.ts
import { ExperimentConfig } from '../../../types';

const config: ExperimentConfig = {
	description: 'Upload Matrix (S-2): Single-Chain, RoundRobin Allocator (Common_Queue), OneByOne Transmitter',
	iterations: 1,
	tasks: [
		{
			description: '100MB, 1 chain, 1MB chunk (S-2)',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 1,
			chunkSize: 1024 * 1024,
		},
	],
	strategies: {
		communication: 'WebSocket',
		uploadAllocator: 'RoundRobin',
		uploadTransmitter: 'OneByOne',
		confirmation: 'TxEvent',
		download: 'Http',
		verification: 'BufferFull',
	},
	confirmationStrategyOptions: {
		timeoutMs: 600000, // 10分 (1by1のため長め)
	},
};
export default config;