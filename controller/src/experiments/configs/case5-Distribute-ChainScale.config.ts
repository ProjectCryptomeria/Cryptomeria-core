import { ExperimentConfig } from '../../types';

/**
 * Test Case 5: Distribute (MultiBurst) Chain Scalability Test
 * (★ 新フォーマットに対応)
 * - 10MB のダミーデータを生成
 * - ★ datachain の数を [1, 2, 3, 4] と変化させて実行
 * - Distribute (マルチバースト) アップロード戦略
 * - TxEvent (完了確認)
 */
const config: ExperimentConfig = {
	description: 'Case 5: Distribute (MultiBurst) Chain Scalability Test',
	iterations: 2, // 各チェーン数ごとに2回実行

	// ★ 変更: tasks にスケーラビリティテストを定義
	tasks: [
		{
			description: '10MB, 1 chain, 256KB chunk',
			target: { type: 'sizeKB', value: 10240 }, // 10MB
			chainCount: 1,
			chunkSize: 256 * 1024, // 256KB
		},
		{
			description: '10MB, 2 chains, 256KB chunk',
			target: { type: 'sizeKB', value: 10240 },
			chainCount: 2,
			chunkSize: 256 * 1024,
		},
		{
			description: '10MB, 3 chains, 256KB chunk',
			target: { type: 'sizeKB', value: 10240 },
			chainCount: 3,
			chunkSize: 256 * 1024,
		},
		{
			description: '10MB, 4 chains, 256KB chunk',
			target: { type: 'sizeKB', value: 10240 },
			chainCount: 4,
			chunkSize: 256 * 1024,
		},
	],

	// ★ 変更: target, chainCount は削除

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',
		upload: 'Distribute',    // DistributeUploadStrategy (マルチバースト)
		confirmation: 'TxEvent',
		download: 'Http',
		verification: 'BufferFull',
	},

	// ★ 変更: uploadStrategyOptions から関連オプションを削除
	uploadStrategyOptions: {
		// (Distribute 戦略に固有のオプションがあればここに残す)
	},

	confirmationStrategyOptions: {
		timeoutMs: 180000, // 3分
	},
};

export default config;