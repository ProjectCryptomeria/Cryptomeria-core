// controller/src/experiments/configs/case1-limit-test.config.ts
import { ExperimentConfig } from '../../types'; // 型定義をインポート

/**
 * Test Case 1: 単一チェーン (Sequential) の限界性能テスト
 * - 1MB のダミーデータを生成
 * - 1 datachain のみを使用
 * - Sequential (逐次) アップロード戦略
 * - WebSocket + TxEvent (最速) で確認
 */
const config: ExperimentConfig = {
	description: 'Case 1: Single Chain Sequential Limit Test',
	iterations: 3, // 3回繰り返して平均を見る

	// アップロード対象: 1MB (1024 * 1024 bytes) のダミーデータ
	target: {
		type: 'sizeKB',
		value: 1024,
	},

	// 使用する datachain の数 (1つ)
	chainCount: 1,

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',  // 最速の通信
		upload: 'Sequential',        // 逐次アップロード
		confirmation: 'TxEvent',       // 最速の完了確認
		download: 'Http',            // 標準のダウンロード
		verification: 'BufferFull',  // 全体検証
	},

	// アップロード戦略 (Sequential) 固有のオプション
	uploadStrategyOptions: {
		// チャンクサイズ: 1MB (1024*1024)
		// (dis-test-ws/5.ts を参考に、ガスリミット 20M に収まる最大サイズを狙う)
		chunkSize: 1024 * 1024,

		// Sequential 戦略で必須: 対象とする datachain 名
		// (注: 実行環境に 'data-0' が存在することを前提とする)
		targetChain: 'data-0',
	},

	// 完了確認 (TxEvent) 固有のオプション
	confirmationStrategyOptions: {
		timeoutMs: 120000, // 2分 (1MB / 20MガスTx の完了を待つため長めに)
	},

	// 検証戦略のオプション (BufferFull なので不要)
	// verificationStrategyOptions: {},
};

export default config;