import { ExperimentConfig } from '../../types';

/**
 * Test Case 2: Sequential (OneByOne) + TxEvent
 * - 1MB のダミーデータを生成
 * - 1 datachain ('data-0') のみを使用
 * - Sequential (ワンバイワン逐次) アップロード戦略
 * - TxEvent (完了確認)
 */
const config: ExperimentConfig = {
	description: 'Case 2: Sequential (OneByOne) + TxEvent',
	iterations: 3,

	// アップロード対象: 1MB
	target: {
		type: 'sizeKB',
		value: 1024,
	},

	// 使用する datachain の数 (1つ)
	chainCount: 1,

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',  // TxEvent のため WS 必須
		upload: 'Sequential',        // SequentialUploadStrategy (ワンバイワン)
		confirmation: 'TxEvent',       // ★ TxEvent
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
		timeoutMs: 120000, // 2分
	},

	targetUrlBase: `case2.test`,
};

export default config;