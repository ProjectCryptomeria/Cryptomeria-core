import { ExperimentConfig } from '../../types';

/**
 * Test Case 7: Distribute (MultiBurst) Chunk Size Scalability Test
 * (★ 新フォーマットに対応)
 * - 10MB のダミーデータを生成
 * - 4 datachain を使用
 * - Distribute (マルチバースト) 戦略
 * - ★ チャンクサイズを [256KB, 512KB, 1MB, 5MB] と変化させて実行
 */
const config: ExperimentConfig = {
	description: 'Case 7: Distribute (MultiBurst) Chunk Size Scalability Test',
	iterations: 3, // このタスクリスト全体を3回実行

	// ★ 変更: tasks にタスクリストを定義
	tasks: [
		{
			description: '10MB, 4 chains, 256KB chunk',
			target: { type: 'sizeKB', value: 10240 }, // 10MB
			chainCount: 4,
			chunkSize: 256 * 1024, // 256KB
		},
		{
			description: '10MB, 4 chains, 512KB chunk',
			target: { type: 'sizeKB', value: 10240 },
			chainCount: 4,
			chunkSize: 512 * 1024, // 512KB
		},
		{
			description: '10MB, 4 chains, 1MB chunk',
			target: { type: 'sizeKB', value: 10240 },
			chainCount: 4,
			chunkSize: 1024 * 1024, // 1MB
		},
		{
			description: '10MB, 4 chains, 5MB chunk',
			target: { type: 'sizeKB', value: 10240 },
			chainCount: 4,
			chunkSize: 5 * 1024 * 1024, // 5MB
		},
	],

	// ★ 変更: target, chainCount は削除

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',
		upload: 'Distribute', // DistributeUploadStrategy (マルチバースト)
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