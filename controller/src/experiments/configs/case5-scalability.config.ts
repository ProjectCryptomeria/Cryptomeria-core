// controller/src/experiments/configs/case5-scalability.config.ts
import { ExperimentConfig } from '../../types'; // 型定義をインポート

/**
 * Test Case 5: 分散 (AutoDistribute) 戦略のスケーラビリティテスト
 * - 10MB のダミーデータを生成
 * - datachain の数を [1, 2, 3, 4] と変化させて実行
 * - AutoDistribute (Mempool 監視) アップロード戦略
 * - WebSocket + TxEvent (最速)
 */
const config: ExperimentConfig = {
	description: 'Case 5: AutoDistribute Scalability Test',
	iterations: 2, // 各チェーン数ごとに2回実行

	// アップロード対象: 10MB (1024 * 10 KB)
	target: {
		type: 'sizeKB',
		value: 10240,
	},

	// ★ スケーラビリティテスト: 1, 2, 3, 4 チェーンで実行
	chainCount: [1, 2, 3, 4],
	// (注: 実行環境に 4台の datachain が存在することを前提とする)

	// 使用する戦略モジュール
	strategies: {
		communication: 'WebSocket',  // 最速の通信
		upload: 'AutoDistribute',    // Mempool 監視による動的分散
		confirmation: 'TxEvent',       // 最速の完了確認
		download: 'Http',            // 標準のダウンロード
		verification: 'BufferFull',  // 全体検証
	},

	// アップロード戦略 (AutoDistribute) 固有のオプション
	uploadStrategyOptions: {
		// チャンクサイズ: 256KB
		// (分散戦略では小さめのチャンクで素早く割り当てる方が効率的と仮定)
		chunkSize: 256 * 1024,
	},

	// 完了確認 (TxEvent) 固有のオプション
	confirmationStrategyOptions: {
		timeoutMs: 180000, // 3分 (10MBのアップロード完了を待つため長めに)
	},
};

export default config;