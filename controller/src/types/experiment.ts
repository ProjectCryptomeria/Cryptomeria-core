// controller/src/types/experiment.ts

import { ChainManager } from "../core/ChainManager";
import { PerformanceTracker } from "../core/PerformanceTracker";
import { InfrastructureService } from "../infrastructure/InfrastructureService";
import { ICommunicationStrategy } from "../strategies/communication/ICommunicationStrategy";
import { IConfirmationStrategy } from "../strategies/confirmation/IConfirmationStrategy";
import { IGasEstimationStrategy } from "../strategies/gas/IGasEstimationStrategy";
// ★ 修正: IProgressManager のインポートパス
import { IProgressManager } from "../utils/ProgressManager/IProgressManager";
import { UrlPathCodec } from "../utils/UrlPathCodec";

// (TaskTarget, TaskOption, ExperimentConfig, ExperimentResult, IterationResult, ... 他の型 ... は変更なし)
export type TaskTarget = {
	type: 'sizeKB';
	value: number;
} | {
	type: 'filePath';
	value: string;
};
export interface TaskOption {
	description?: string;
	target: TaskTarget;
	chainCount: number;
	chunkSize: number | 'auto';
	targetChain?: string;
	pipelineDepth?: number;
}
export interface ExperimentConfig {
	description: string;
	iterations: number;
	tasks: TaskOption[];
	strategies: {
		communication: 'Http' | 'WebSocket';
		upload: 'Sequential' | 'Distribute';
		confirmation: 'Polling' | 'TxEvent';
		download: 'Http';
		verification: 'BufferFull' | 'BufferPartial';
	};
	communicationStrategyOptions?: any;
	uploadStrategyOptions?: {};
	confirmationStrategyOptions?: {
		timeoutMs?: number;
	};
	downloadStrategyOptions?: any;
	verificationStrategyOptions?: {
		compareBytes?: number;
	};
	targetUrlBase?: string;
}
export interface ExperimentResult {
	config: ExperimentConfig;
	iterationResults: IterationResult[];
	summary?: ExperimentSummary;
}
export interface IterationResult {
	iteration: number;
	task: TaskOption;
	chainCount: number;
	uploadResult: UploadResult;
	downloadResult: DownloadResult;
	verificationResult: VerificationResult;
}
export interface UploadResult {
	startTime: bigint;
	endTime: bigint;
	durationMs: bigint;
	totalTx: number;
	successTx: number;
	failedTx: number;
	totalGasUsed: bigint;
	totalFee: bigint;
	avgGasPerTx: bigint;
	usedChains: string[];
	manifestUrl: string;
	originalDataHash?: string;
	chunkSizeUsedBytes?: number;
}
export interface DownloadResult {
	startTime: bigint;
	endTime: bigint;
	durationMs: bigint;
	downloadedData: Buffer;
	downloadedDataHash?: string;
}
export interface VerificationResult {
	verified: boolean;
	message?: string;
}
export interface ExperimentSummary {
	case: string;
	iterations: number;
	avgUploadMs: number;
	avgDownloadMs: number;
	avgThroughputKBps: number;
	avgGasPerKB: bigint;
	avgTotalGas: bigint;
	avgTotalFee: bigint;
	avgUsedChains: number;
	successRate: number;
	verificationSuccessRate: number;
}
export interface ConfirmationResult {
	success: boolean;
	height?: number;
	gasUsed?: bigint;
	feeAmount?: bigint;
	error?: string;
}
export interface TransactionInfo extends ConfirmationResult {
	hash: string;
	chainName: string;
}
export interface UrlParts {
	original: string;
	baseUrlRaw: string;
	baseUrlEncoded: string;
	filePathRaw: string;
	filePathEncoded: string;
}


/**
 * 各戦略モジュール (Strategy) の実行時に渡されるコンテキストオブジェクト。
 */
export interface RunnerContext {
	/** 現在実行中の実験設定 */
	config: ExperimentConfig;

	/** 現在実行中のタスク設定 (ExperimentRunnerが設定) */
	currentTask?: TaskOption;

	/** チェーン接続や低レベル操作を管理するマネージャー */
	chainManager: ChainManager;

	/** K8s API と連携し、エンドポイントやニーモニックを取得するサービス */
	infraService: InfrastructureService;

	/** パフォーマンス（時間、ガス、Tx数など）を記録するトラッカー */
	tracker: PerformanceTracker;

	/** ★ 追加: プログレスバーUIを管理するマネージャー */
	progressManager: IProgressManager;

	/** * 現在のイテレーションで選択されている通信戦略インスタンス。 */
	communicationStrategy: ICommunicationStrategy;

	/**
	 * 現在のイテレーションで選択されている完了確認戦略インスタンス。
	 */
	confirmationStrategy: IConfirmationStrategy;

	/** 現在のイテレーションで使用するガス計算戦略インスタンス */
	gasEstimationStrategy: IGasEstimationStrategy;

	/** URL/パスのエンコード・デコード・分割を行うユーティリティ */
	urlPathCodec: UrlPathCodec;
}