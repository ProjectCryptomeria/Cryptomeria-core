import { ExperimentConfig } from '../../types';

/**
 * Test Case 1: Sequential (OneByOne) + Polling
 * - 1MB のダミーデータを生成
 * - 1 datachain ('data-0') のみを使用
 * - Sequential (ワンバイワン逐次) アップロード戦略
 * - Polling (完了確認)
 */
const config: ExperimentConfig = {
	description: 'Case 1: Sequential (OneByOne) + Polling',
	iterations: 1,

	// アップロード対象: 1MB
	target: {
		type: 'sizeKB',
		value: 1024,
	},

	// 使用する datachain の数 (1つ)
	chainCount: 1,

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket', // Polling は HTTP/WS どちらでも可
		upload: 'Sequential',     // SequentialUploadStrategy (ワンバイワン)
		confirmation: 'Polling',    // ★ Polling
		download: 'Http',
		verification: 'BufferFull',
	},

	// アップロード戦略 (Sequential) 固有のオプション
	uploadStrategyOptions: {
		// チャンクサイズ: 256KB
		chunkSize: 256 * 1024,

		// 対象とする datachain 名
		targetChain: 'data-0',
	},

	confirmationStrategyOptions: {
		timeoutMs: 60000, // 1分
	},
};

export default config;