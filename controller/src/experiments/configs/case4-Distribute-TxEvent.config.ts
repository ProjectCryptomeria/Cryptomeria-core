import { ExperimentConfig } from '../../types';

/**
 * Test Case 4: Distribute (MultiBurst) + TxEvent
 * (★ 新フォーマットに対応)
 */
const config: ExperimentConfig = {
	description: 'Case 4: Distribute (MultiBurst) + TxEvent',
	iterations: 3,

	// ★ 変更: tasks にタスクを定義
	tasks: [
		{
			description: '5MB, 4 chains, 256KB chunk',
			target: {
				type: 'sizeKB',
				value: 5 * 1024, // 5MB
			},
			chainCount: 4,
			chunkSize: 256 * 1024, // 256KB
		}
	],

	// ★ 変更: target, chainCount は削除

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket', // Distribute 戦略 (Mempool監視) のため WS 必須
		upload: 'Distribute',     // DistributeUploadStrategy (マルチバースト)
		confirmation: 'TxEvent',      // ★ TxEvent
		download: 'Http',
		verification: 'BufferFull',
	},

	// ★ 変更: uploadStrategyOptions から関連オプションを削除
	uploadStrategyOptions: {
		// (Distribute 戦略に固有のオプションがあればここに残す)
	},

	confirmationStrategyOptions: {
		timeoutMs: 120000, // 2分
	},
};

export default config;