// src/experiments/configs/upload_strategy_matrix/M3_C-Random-1by1.config.ts
import { ExperimentConfig } from '../../../types';

const config: ExperimentConfig = {
	description: 'Upload Matrix (M-3_C): Multi-Chain, Random Allocator (Common_Queue), OneByOne Transmitter',
	iterations: 1,
	tasks: [
		{
			description: '100MB, 4 chains, 1MB chunk (M-3_C)',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 4,
			chunkSize: 1024 * 1024,
		},
	],
	strategies: {
		communication: 'WebSocket',
		uploadAllocator: 'Random',
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