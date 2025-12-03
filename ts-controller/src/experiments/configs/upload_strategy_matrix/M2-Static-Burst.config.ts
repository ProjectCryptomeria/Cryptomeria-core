// src/experiments/configs/upload_strategy_matrix/M2-Static-Burst.config.ts
import { ExperimentConfig } from '../../../types';

const config: ExperimentConfig = {
	description: 'Upload Matrix (M-2): Multi-Chain, Static Allocator (Mega_Chunk), MultiBurst Transmitter',
	iterations: 1,
	tasks: [
		{
			description: '100MB, 4 chains, 1MB chunk (M-2)',
			target: { type: 'sizeKB', value: 102400 },
			chainCount: 4,
			chunkSize: 1024 * 1024,
			targetChain: 'data-0', // StaticAllocator のため (chainCount を優先)
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