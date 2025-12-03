// controller/src/core/PerformanceTracker.ts
import { DownloadResult, TransactionInfo, UploadResult, VerificationResult } from '../types';
import { log } from '../utils/logger';

/**
 * 1回のイテレーションにおけるパフォーマンスメトリクスを記録・集計するクラス。
 */
export class PerformanceTracker {
	// ★ 修正: number -> bigint, 0 -> 0n
	private uploadStartTime: bigint = 0n;
	private uploadEndTime: bigint = 0n;
	private downloadStartTime: bigint = 0n;
	private downloadEndTime: bigint = 0n;

	private transactions: TransactionInfo[] = [];
	private manifestUrl: string = '';
	private usedChains: Set<string> = new Set();

	private originalDataHash?: string;
	private downloadedDataHash?: string;
	private chunkSizeUsedBytes?: number;
	private verificationResult?: VerificationResult;

	constructor() {
		this.reset();
	}

	/**
	 * 計測データをリセットし、新しいイテレーションの準備をします。
	 */
	public reset(): void {
		// ★ 修正: number -> bigint
		this.uploadStartTime = 0n;
		this.uploadEndTime = 0n;
		this.downloadStartTime = 0n;
		this.downloadEndTime = 0n;
		this.transactions = [];
		this.manifestUrl = '';
		this.usedChains = new Set();

		this.originalDataHash = undefined;
		this.downloadedDataHash = undefined;
		this.chunkSizeUsedBytes = undefined;
		this.verificationResult = undefined;
		log.debug('PerformanceTracker がリセットされました。');
	}

	// --- アップロード関連 ---

	public markUploadStart(): void {
		// ★ 修正: 1_000_000 -> 1_000_000n (bigintリテラル)
		this.uploadStartTime = process.hrtime.bigint() / 1_000_000n;
	}

	public markUploadEnd(): void {
		// ★ 修正: 1_000_000 -> 1_000_000n
		this.uploadEndTime = process.hrtime.bigint() / 1_000_000n;
	}

	/**
	 * 完了したトランザクションの情報を記録します。
	 * (変更なし)
	 */
	public recordTransaction(info: TransactionInfo): void {
		this.transactions.push(info);
		if (info.success) {
			this.usedChains.add(info.chainName);
		}
	}

	/**
	 * 完了した複数のトランザクション情報を一括で記録します。
	 * (変更なし)
	 */
	public recordTransactions(infos: TransactionInfo[]): void {
		for (const info of infos) {
			this.recordTransaction(info);
		}
	}

	public setManifestUrl(url: string): void {
		this.manifestUrl = url;
	}

	public setOriginalDataHash(hash: string): void {
		this.originalDataHash = hash;
	}

	public setChunkSizeUsed(bytes: number): void {
		this.chunkSizeUsedBytes = bytes;
	}

	/**
	 * 集計されたアップロード結果を返します。
	 * @returns {UploadResult}
	 */
	public getUploadResult(): UploadResult {
		const successTxs = this.transactions.filter(t => t.success);
		const totalTx = this.transactions.length;
		const successTx = successTxs.length;
		const failedTx = totalTx - successTx;

		const totalGasUsed = successTxs.reduce((sum, t) => sum + (t.gasUsed ?? 0n), 0n);
		const totalFee = successTxs.reduce((sum, t) => sum + (t.feeAmount ?? 0n), 0n);
		const avgGasPerTx = successTx > 0 ? totalGasUsed / BigInt(successTx) : 0n;

		// ★ 修正: durationMs を bigint 同士の差として計算
		const durationMs = this.uploadEndTime - this.uploadStartTime;

		return {
			startTime: this.uploadStartTime,
			endTime: this.uploadEndTime,
			durationMs: durationMs < 0n ? 0n : durationMs, // 負にならないよう
			totalTx: totalTx,
			successTx: successTx,
			failedTx: failedTx,
			totalGasUsed: totalGasUsed,
			totalFee: totalFee,
			avgGasPerTx: avgGasPerTx,
			usedChains: Array.from(this.usedChains).sort(),
			manifestUrl: this.manifestUrl,
			originalDataHash: this.originalDataHash,
			chunkSizeUsedBytes: this.chunkSizeUsedBytes,
		};
	}

	// --- ダウンロード関連 ---

	public markDownloadStart(): void {
		// ★ 修正: 1_000_000 -> 1_000_000n
		this.downloadStartTime = process.hrtime.bigint() / 1_000_000n;
	}

	public markDownloadEnd(): void {
		// ★ 修正: 1_000_000 -> 1_000_000n
		this.downloadEndTime = process.hrtime.bigint() / 1_000_000n;
	}

	public setDownloadedDataHash(hash: string): void {
		this.downloadedDataHash = hash;
	}

	/**
	 * 集計されたダウンロード結果を返します。
	 */
	public getDownloadResult(downloadedData: Buffer): DownloadResult {
		// ★ 修正: durationMs を bigint 同士の差として計算
		const durationMs = this.downloadEndTime - this.downloadStartTime;

		return {
			startTime: this.downloadStartTime,
			endTime: this.downloadEndTime,
			durationMs: durationMs < 0n ? 0n : durationMs, // 負にならないよう
			downloadedData: downloadedData,
			downloadedDataHash: this.downloadedDataHash,
		};
	}

	// --- 検証関連 ---

	public setVerificationResult(result: VerificationResult): void {
		this.verificationResult = result;
	}

	public getVerificationResult(): VerificationResult {
		if (!this.verificationResult) {
			log.warn('VerificationResult が設定される前に getVerificationResult が呼び出されました。');
			return { verified: false, message: '検証が実行されませんでした。' };
		}
		return this.verificationResult;
	}
}