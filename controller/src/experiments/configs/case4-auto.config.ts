// controller/src/experiments/configs/case4-auto.config.ts
import { ExperimentConfig } from '../../types';

/**
 * Test Case 4: AutoDistribute (Mempool 分散) 戦略の基本テスト
 * - 5MB のダミーデータを生成
 * - 4 datachain を使用 (固定)
 * - AutoDistribute (Mempool 監視) アップロード戦略
 * - WebSocket + TxEvent
 */
const config: ExperimentConfig = {
	description: 'Case 4: AutoDistribute Strategy Base Test',
	iterations: 3,

	// アップロード対象: 5MB
	target: {
		type: 'sizeKB',
		value: 5 * 1024,
	},

	// 使用する datachain の数 (4つ)
	chainCount: 4,

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',
		upload: 'AutoDistribute', // ★ Mempool 監視戦略
		confirmation: 'TxEvent',
		download: 'Http',
		verification: 'BufferFull',
	},

	// アップロード戦略 (AutoDistribute) 固有のオプション
	uploadStrategyOptions: {
		// チャンクサイズ: 256KB
		chunkSize: 256 * 1024,
	},

	confirmationStrategyOptions: {
		timeoutMs: 120000, // 2分
	},
};

export default config;