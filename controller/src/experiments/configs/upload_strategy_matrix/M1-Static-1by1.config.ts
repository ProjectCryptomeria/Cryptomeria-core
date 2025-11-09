// src/experiments/configs/upload_strategy_matrix/M1-Static-1by1.config.ts
import { ExperimentConfig } from '../../../types';

const config: ExperimentConfig = {
	description: 'Upload Matrix (M-1): Multi-Chain, Static Allocator (Mega_Chunk), OneByOne Transmitter',
	iterations: 1,
	tasks: [
		{
			description: '100MB, 4 chains, 1MB chunk (M-1)',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 4,
			chunkSize: 1024 * 1024,
			targetChain: 'data-0', // StaticAllocator のため (chainCount を優先)
		},
	],
	strategies: {
		communication: 'WebSocket',
		uploadAllocator: 'StaticMulti',
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