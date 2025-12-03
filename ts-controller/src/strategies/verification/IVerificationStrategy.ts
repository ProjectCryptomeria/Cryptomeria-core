// controller/src/strategies/verification/IVerificationStrategy.ts
import type { VerificationResult } from '../../types/experiment';

/**
 * データ検証オプション
 */
export interface VerificationOptions {
	/** * 部分比較を行う場合の比較バイト数。
	 * 未指定の場合は全体比較を行う。
	 */
	compareBytes?: number;
}

/**
 * データ検証戦略（全体比較、部分比較など）を抽象化するインターフェース。
 * 実装クラス (BufferVerificationStrategy) によって具体的な検証ロジックを提供します。
 */
export interface IVerificationStrategy {
	/**
	 * 2つのデータBufferが同一であるかを検証します。
	 * @param originalData アップロード元のデータ
	 * @param downloadedData ダウンロードしたデータ
	 * @param options 検証オプション (例: 部分比較)
	 * @returns 検証結果 (成功/失敗、メッセージ)
	 */
	execute(
		originalData: Buffer,
		downloadedData: Buffer,
		options?: VerificationOptions
	): Promise<VerificationResult>;
}