// src/lib/performance-tracker.ts
import { performance } from 'perf_hooks';

/**
 * パフォーマンス測定結果を格納するインターフェース
 */
export interface PerformanceReport {
	durationMs: number;
	totalGasUsed: bigint;
	transactionCount: number;
	averageGasPerTransaction: bigint;
}

/**
 * ブロックチェーン操作のパフォーマンス（時間とガス使用量）を追跡するクラス
 */
export class PerformanceTracker {
	private startTime: number = 0;
	private endTime: number = 0;
	private totalGasUsed: bigint = 0n; // bigintで初期化
	private transactionCount: number = 0;

	/**
	 * タイマーを開始します。
	 */
	public start(): void {
		this.startTime = performance.now();
	}

	/**
	 * タイマーを停止します。
	 */
	public stop(): void {
		this.endTime = performance.now();
	}

	/**
	 * トランザクションのガス使用量を記録します。
	 * @param gasUsed - トランザクションで使用されたガス量
	 */
	public recordTransaction(gasUsed: bigint): void {
		this.totalGasUsed += gasUsed;
		this.transactionCount++;
	}

	/**
	 * 計測結果のレポートを生成します。
	 * @returns {PerformanceReport} パフォーマンスレポート
	 */
	public getReport(): PerformanceReport {
		const durationMs = this.endTime - this.startTime;
		const averageGasPerTransaction =
			this.transactionCount > 0 ? this.totalGasUsed / BigInt(this.transactionCount) : 0n;

		return {
			durationMs,
			totalGasUsed: this.totalGasUsed,
			transactionCount: this.transactionCount,
			averageGasPerTransaction: averageGasPerTransaction,
		};
	}
}