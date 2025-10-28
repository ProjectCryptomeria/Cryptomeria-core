// controller/src/experiments/configs/case3-roundrobin.config.ts
import { ExperimentConfig } from '../../types';

/**
 * Test Case 3: RoundRobin (均等分散) 戦略の基本テスト
 * - 5MB のダミーデータを生成
 * - 4 datachain を使用
 * - RoundRobin (均等分散) アップロード戦略
 * - WebSocket + TxEvent
 */
const config: ExperimentConfig = {
	description: 'Case 3: RoundRobin Strategy Base Test',
	iterations: 3,

	// アップロード対象: 5MB (5 * 1024 KB)
	target: {
		type: 'sizeKB',
		value: 5 * 1024,
	},

	// 使用する datachain の数 (4つ)
	chainCount: 4,

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',
		upload: 'RoundRobin', // ★ ラウンドロビン戦略
		confirmation: 'TxEvent',
		download: 'Http',
		verification: 'BufferFull',
	},

	// アップロード戦略 (RoundRobin) 固有のオプション
	uploadStrategyOptions: {
		// チャンクサイズ: 256KB (分散のため小さめ)
		chunkSize: 256 * 1024,
	},

	confirmationStrategyOptions: {
		timeoutMs: 120000, // 2分
	},
};

export default config;