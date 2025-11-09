// src/experiments/configs/upload_strategy_matrix/S3-Static-Burst.config.ts
import { ExperimentConfig } from '../../../types';

const config: ExperimentConfig = {
	description: 'Upload Matrix (S-3): Single-Chain, Static Allocator (Mega_Chunk), MultiBurst Transmitter',
	iterations: 1,
	tasks: [
		{
			description: '100MB, 1 chain, 1MB chunk (S-3)',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 1,
			chunkSize: 1024 * 1024,
			targetChain: 'data-0', // StaticAllocator (単一) のため指定
		},
	],
	strategies: {
		communication: 'WebSocket',
		uploadAllocator: 'StaticMulti',
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