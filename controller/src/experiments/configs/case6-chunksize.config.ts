// controller/src/experiments/configs/case6-chunksize-256kb.config.ts
// (ファイル名を変更して case6-chunksize.config.ts としても良い)
import { ExperimentConfig } from '../../types';

/**
 * Test Case 6: チャンクサイズ比較テスト (256KB 編)
 * - 10MB のダミーデータを生成
 * - 4 datachain を使用
 * - AutoDistribute 戦略
 * - ★ チャンクサイズ: 256KB
 */
const config: ExperimentConfig = {
	description: 'Case 6: Chunk Size Test (256KB)',
	iterations: 3,

	// アップロード対象: 10MB
	target: {
		type: 'sizeKB',
		value: 10240,
	},

	// 使用する datachain の数 (4つ)
	chainCount: 4,

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',
		upload: 'AutoDistribute',
		confirmation: 'TxEvent',
		download: 'Http',
		verification: 'BufferFull',
	},

	// アップロード戦略 (AutoDistribute) 固有のオプション
	uploadStrategyOptions: {
		// ★ 比較対象のチャンクサイズ
		chunkSize: 256 * 1024,
	},

	confirmationStrategyOptions: {
		timeoutMs: 180000, // 3分
	},
};

export default config;