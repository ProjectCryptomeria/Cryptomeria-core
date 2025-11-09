// src/experiments/configs/upload_strategy_matrix/S4-RR-Burst.config.ts
import { ExperimentConfig } from '../../../types';

const config: ExperimentConfig = {
	description: 'Upload Matrix (S-4): Single-Chain, RoundRobin Allocator (Common_Queue), MultiBurst Transmitter',
	iterations: 1,
	tasks: [
		{
			description: '100MB, 1 chain, 1MB chunk (S-4)',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 1,
			chunkSize: 1024 * 1024,
		},
	],
	strategies: {
		communication: 'WebSocket',
		uploadAllocator: 'RoundRobin',
		uploadTransmitter: 'MultiBurst',
		confirmation: 'TxEvent',
		download: 'Http',
		verification: 'BufferFull',
	},
	confirmationStrategyOptions: {
		timeoutMs: 300000, // 5分
	},
};
export default config;