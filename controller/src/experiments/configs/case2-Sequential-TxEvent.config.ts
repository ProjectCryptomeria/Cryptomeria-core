import { ExperimentConfig } from '../../types';

/**
 * Test Case 2: Sequential (OneByOne) + TxEvent
 * (★ 新フォーマットに対応)
 */
const config: ExperimentConfig = {
	description: 'Case 2: Sequential (OneByOne) + TxEvent',
	iterations: 3,

	// ★ 変更: tasks にタスクを定義
	tasks: [
		{
			description: '1MB, 1 chain, 256KB chunk, data-0',
			target: {
				type: 'sizeKB',
				value: 1024, // 1MB
			},
			chainCount: 1,
			chunkSize: 256 * 1024, // 256KB
			targetChain: 'data-0', // Sequential 戦略用の指定
		}
	],

	// ★ 変更: target, chainCount は削除

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',  // TxEvent のため WS 必須
		upload: 'Sequential',        // SequentialUploadStrategy (ワンバイワン)
		confirmation: 'TxEvent',       // ★ TxEvent
		download: 'Http',
		verification: 'BufferFull',
	},

	// ★ 変更: uploadStrategyOptions から関連オプションを削除
	uploadStrategyOptions: {
		// (Sequential 戦略に固有のオプションがあればここに残す)
	},

	confirmationStrategyOptions: {
		timeoutMs: 120000, // 2分
	},

	targetUrlBase: `case2.test`,
};

export default config;