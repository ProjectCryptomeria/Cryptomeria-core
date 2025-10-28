// controller/src/experiments/configs/case2-manual.config.ts
import { ExperimentConfig } from '../../types';

/**
 * Test Case 2: Sequential (単一チェーン) テスト (小さめ)
 * - 256KB のダミーデータを生成
 * - 1 datachain ('data-1') のみを使用
 * - Sequential (逐次) アップロード戦略
 * - WebSocket + Polling (確認方法の比較用)
 */
const config: ExperimentConfig = {
	description: 'Case 2: Single Chain Sequential (Small)',
	iterations: 3,

	// アップロード対象: 256KB
	target: {
		type: 'sizeKB',
		value: 256,
	},

	// 使用する datachain の数 (1つ)
	chainCount: 1,

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',
		upload: 'Sequential',
		confirmation: 'Polling', // ★ 確認戦略を Polling に変更 (TxEvent との比較用)
		download: 'Http',
		verification: 'BufferFull',
	},

	// アップロード戦略 (Sequential) 固有のオプション
	uploadStrategyOptions: {
		// チャンクサイズ: 64KB (小さめ)
		chunkSize: 64 * 1024,

		// 対象とする datachain 名
		// (注: 実行環境に 'data-1' が存在することを前提とする)
		targetChain: 'data-1',
	},

	confirmationStrategyOptions: {
		timeoutMs: 60000, // 1分
	},
};

export default config;