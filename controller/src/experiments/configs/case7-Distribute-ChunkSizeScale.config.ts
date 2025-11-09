import { ExperimentConfig } from '../../types';

/**
 * Test Case 7: Distribute (MultiBurst) Chunk Size Test (256KB)
 * - 10MB のダミーデータを生成
 * - 4 datachain を使用
 * - Distribute (マルチバースト) 戦略
 * - ★ チャンクサイズ: 256KB
 * (※ 512KB, 1MB など、このファイルをコピーしてチャンクサイズを変更し、比較テストを行います)
 */
const config: ExperimentConfig = {
	description: 'Case 7: Distribute (MultiBurst) Chunk Size Test (256KB)',
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
		upload: 'Distribute', // DistributeUploadStrategy (マルチバースト)
		confirmation: 'TxEvent',
		download: 'Http',
		verification: 'BufferFull',
	},

	// アップロード戦略 (Distribute) 固有のオプション
	uploadStrategyOptions: {
		// ★ 比較対象のチャンクサイズ
		chunkSize: 256 * 1024,
	},

	confirmationStrategyOptions: {
		timeoutMs: 180000, // 3分
	},
};

export default config;