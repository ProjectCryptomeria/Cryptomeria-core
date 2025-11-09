import { ExperimentConfig } from '../../types';

/**
 * Test Case 5: Distribute (MultiBurst) Chain Scalability Test
 * - 10MB のダミーデータを生成
 * - datachain の数を [1, 2, 3, 4] と変化させて実行
 * - Distribute (マルチバースト) アップロード戦略
 * - TxEvent (完了確認)
 */
const config: ExperimentConfig = {
	description: 'Case 5: Distribute (MultiBurst) Chain Scalability Test',
	iterations: 2, // 各チェーン数ごとに2回実行

	// アップロード対象: 10MB (1024 * 10 KB)
	target: {
		type: 'sizeKB',
		value: 10240,
	},

	// ★ スケーラビリティテスト: 1, 2, 3, 4 チェーンで実行
	chainCount: [1, 2, 3, 4],

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',
		upload: 'Distribute',    // DistributeUploadStrategy (マルチバースト)
		confirmation: 'TxEvent',
		download: 'Http',
		verification: 'BufferFull',
	},

	// アップロード戦略 (Distribute) 固有のオプション
	uploadStrategyOptions: {
		// チャンクサイズ: 256KB
		chunkSize: 256 * 1024,
	},

	confirmationStrategyOptions: {
		timeoutMs: 180000, // 3分
	},
};

export default config;