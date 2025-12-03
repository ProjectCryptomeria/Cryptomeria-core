// src/experiments/configs/upload_strategy_matrix/M4_D-Available-Burst.config.ts
import { ExperimentConfig } from '../../../types';

const config: ExperimentConfig = {
	description: 'Upload Matrix (M-4_D): Multi-Chain, Available Allocator (Common_Queue), MultiBurst Transmitter',
	iterations: 1,
	tasks: [
		{
			description: '100MB, 4 chains, 1MB chunk (M-4_D)',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 4,
			chunkSize: 1024 * 1024,
		},
	],
	strategies: {
		communication: 'WebSocket', // AvailableAllocator のため必須
		uploadAllocator: 'Available',
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