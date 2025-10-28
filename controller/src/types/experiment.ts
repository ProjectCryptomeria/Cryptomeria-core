// controller/src/types/experiment.ts

import { ChainManager } from "../core/ChainManager";
import { PerformanceTracker } from "../core/PerformanceTracker";
import { InfrastructureService } from "../infrastructure/InfrastructureService";
import { ICommunicationStrategy } from "../strategies/communication/ICommunicationStrategy";
import { IConfirmationStrategy } from "../strategies/confirmation/IConfirmationStrategy";

/**
 * 実験設定ファイル (experiments/configs/*.config.ts) の型
 */
export interface ExperimentConfig {
	description: string; // 実験の説明
	iterations: number;  // 繰り返し回数

	// アップロード対象のデータソース
	target: {
		type: 'sizeKB'; // ダミーデータを生成
		value: number;  // エンコード後の目標KBサイズ
	} | {
		type: 'filePath'; // 実ファイルを使用
		value: string;    // ファイルへのパス
	};

	// 実験に使用するチェーンの数 (datachain の数)
	// undefined の場合は InfrastructureService が検出した全てを使用
	chainCount?: number | number[]; // 単一指定 or スケーラビリティテスト用の複数指定

	// 使用する戦略モジュールの名前 (文字列)
	strategies: {
		communication: 'Http' | 'WebSocket';
		upload: 'Sequential' | 'RoundRobin' | 'AutoDistribute'; // | 'PipelinedAutoDistribute';
		confirmation: 'Polling' | 'TxEvent';
		download: 'Http'; // 現状は Http のみ
		verification: 'BufferFull' | 'BufferPartial';
	};

	// 各戦略に渡すオプション (オプション)
	communicationStrategyOptions?: any;
	uploadStrategyOptions?: {
		chunkSize?: number | 'auto'; // アップロード時のチャンクサイズ (バイト単位 or 'auto')
		targetChain?: string; // SequentialUploadStrategy で使用
		pipelineDepth?: number; // PipelinedAutoDistribute で使用
	};
	confirmationStrategyOptions?: {
		timeoutMs?: number; // 完了確認のタイムアウト (ミリ秒)
	};
	downloadStrategyOptions?: any;
	verificationStrategyOptions?: {
		compareBytes?: number; // BufferPartial で比較するバイト数
	};
}

/**
 * ExperimentRunner.run() が返す実験結果の型
 */
export interface ExperimentResult {
	config: ExperimentConfig;       // 実行された実験の設定
	iterationResults: IterationResult[]; // 各イテレーションの結果
	summary?: ExperimentSummary;     // 複数イテレーションの集計結果 (オプション)
}

/**
 * 1回のイテレーションの結果
 */
export interface IterationResult {
	iteration: number;
	uploadResult: UploadResult;
	downloadResult: DownloadResult;
	verificationResult: VerificationResult;
	chainCount: number; // このイテレーションで使用した datachain 数
}

/**
 * IUploadStrategy.execute() の戻り値型
 */
export interface UploadResult {
	startTime: bigint;          // アップロード開始時刻 (Unix ms)
	endTime: bigint;            // アップロード完了時刻 (Unix ms)
	durationMs: bigint;         // 所要時間 (ミリ秒)
	totalTx: number;            // 送信した総トランザクション数
	successTx: number;          // 成功したトランザクション数
	failedTx: number;           // 失敗したトランザクション数 (Broadcast/Confirm含む)
	totalGasUsed: bigint;       // 消費した総ガス量 (成功分のみ)
	totalFee: bigint;           // 支払った総手数料 (成功分のみ)
	avgGasPerTx: bigint;        // 成功したTxあたりの平均ガス
	usedChains: string[];       // 実際に使用されたチェーン名のリスト (ソート済み)
	manifestUrl: string;        // 登録されたマニフェストのURL
	originalDataHash?: string;  // 元データのハッシュ (検証用, オプション)
	chunkSizeUsedBytes?: number;// 実際に使用されたチャンクサイズ (autoの場合など)
}

/**
 * IDownloadStrategy.execute() の戻り値型
 */
export interface DownloadResult {
	startTime: bigint;
	endTime: bigint;
	durationMs: bigint;
	downloadedData: Buffer;
	downloadedDataHash?: string; // ダウンロードデータのハッシュ (検証用, オプション)
}

/**
 * IVerificationStrategy.execute() の戻り値型
 */
export interface VerificationResult {
	verified: boolean; // 検証成功/失敗
	message?: string;   // 失敗時の理由など (オプション)
}

/**
 * 複数イテレーションの集計結果
 */
export interface ExperimentSummary {
	case: string; // description or derived name
	iterations: number;
	avgUploadMs: number;
	avgDownloadMs: number;
	avgThroughputKBps: number; // (成功データ量 / 平均アップロード時間)
	avgGasPerKB: bigint;
	avgTotalGas: bigint;
	avgTotalFee: bigint;
	avgUsedChains: number;
	successRate: number; // (成功Tx / 総Tx) * 100
	verificationSuccessRate: number; // (検証成功回数 / イテレーション数) * 100
	// ... その他必要な集計値
}

/**
 * IConfirmationStrategy.confirmTransactions() の戻り値 Map の Value 型
 */
export interface ConfirmationResult {
	success: boolean;
	height?: number;     // 成功した場合のブロック高 (オプション)
	gasUsed?: bigint;    // 成功した場合のガス使用量 (オプション, DeliverTxResponseから取得)
	feeAmount?: bigint;  // 成功した場合の手数料 (オプション, DeliverTxResponseから取得)
	error?: string;      // 失敗した場合のエラーメッセージ (オプション)
}

/**
 * PerformanceTracker が記録するトランザクション情報
 */
export interface TransactionInfo extends ConfirmationResult {
	hash: string;
	chainName: string;
}


/**
 * 各戦略モジュール (Strategy) の実行時に渡されるコンテキストオブジェクト。
 */
export interface RunnerContext {
	/** 現在実行中の実験設定 */
	config: ExperimentConfig;

	/** チェーン接続や低レベル操作を管理するマネージャー */
	chainManager: ChainManager;

	/** K8s API と連携し、エンドポイントやニーモニックを取得するサービス */
	infraService: InfrastructureService;

	/** パフォーマンス（時間、ガス、Tx数など）を記録するトラッカー */
	tracker: PerformanceTracker;

	/** * 現在のイテレーションで選択されている通信戦略インスタンス。 */
	communicationStrategy: ICommunicationStrategy;

	/**
	 * 現在のイテレーションで選択されている完了確認戦略インスタンス。
	 * (主に UploadStrategy が内部で使用するためにコンテキスト経由で渡される)
	 */
	confirmationStrategy: IConfirmationStrategy; // ★ 修正
}