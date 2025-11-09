import { ExperimentConfig } from '../../types';

/**
 * Test Case 3: Distribute (MultiBurst) + Polling
 * - 5MB のダミーデータを生成
 * - 4 datachain を使用
 * - Distribute (マルチバースト) アップロード戦略
 * - Polling (完了確認)
 */
const config: ExperimentConfig = {
	description: 'Case 3: Distribute (MultiBurst) + Polling',
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
		communication: 'WebSocket', // Distribute 戦略 (Mempool監視) のため WS 必須
		upload: 'Distribute',     // DistributeUploadStrategy (マルチバースト)
		confirmation: 'Polling',    // ★ Polling
		download: 'Http',
		verification: 'BufferFull',
	},

	// アップロード戦略 (Distribute) 固有のオプション
	uploadStrategyOptions: {
		// チャンクサイズ: 256KB
		chunkSize: 256 * 1024,
	},

	confirmationStrategyOptions: {
		timeoutMs: 120000, // 2分
	},
};

export default config;