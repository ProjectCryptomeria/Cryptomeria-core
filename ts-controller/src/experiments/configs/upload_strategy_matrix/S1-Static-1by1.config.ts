// src/experiments/configs/upload_strategy_matrix/S1-Static-1by1.config.ts
import { ExperimentConfig } from '../../../types';

const config: ExperimentConfig = {
	description: 'Upload Matrix (S-1): Single-Chain, Static Allocator (Mega_Chunk), OneByOne Transmitter',
	iterations: 1,
	tasks: [
		{
			description: '100MB, 1 chain, 1MB chunk (S-1)',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 1,
			chunkSize: 1024 * 1024,
			targetChain: 'data-0', // StaticAllocator (単一) のため指定
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