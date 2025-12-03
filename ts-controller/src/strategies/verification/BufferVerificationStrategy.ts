// controller/src/strategies/verification/BufferVerificationStrategy.ts
import { VerificationResult } from '../../types';
import { log } from '../../utils/logger';
import { IVerificationStrategy, VerificationOptions } from './IVerificationStrategy';

/**
 * 2つの Buffer の内容を比較する検証戦略。
 * オプションで先頭Nバイトのみの部分比較もサポートします。
 */
export class BufferVerificationStrategy implements IVerificationStrategy {
	constructor() {
		log.debug('BufferVerificationStrategy がインスタンス化されました。');
	}

	/**
	 * 2つのデータBufferが同一であるかを検証します。
	 * @param originalData アップロード元のデータ
	 * @param downloadedData ダウンロードしたデータ
	 * @param options 検証オプション (compareBytes を指定すると部分比較)
	 * @returns 検証結果
	 */
	public async execute(
		originalData: Buffer,
		downloadedData: Buffer,
		options?: VerificationOptions
	): Promise<VerificationResult> {

		// 比較するバイト数を決定
		const compareBytes = options?.compareBytes;

		if (compareBytes !== undefined && compareBytes > 0) {
			// --- 部分比較 ---
			log.info(`部分検証を実行中 (先頭 ${compareBytes} バイト)...`);

			if (originalData.length < compareBytes || downloadedData.length < compareBytes) {
				const message = `データサイズが比較バイト数 (${compareBytes}) より不足しています。(Original: ${originalData.length}, Downloaded: ${downloadedData.length})`;
				log.warn(message);
				return { verified: false, message: message };
			}

			// Buffer.compare は、一致する場合は 0 を返す
			const result = Buffer.compare(
				originalData.subarray(0, compareBytes),
				downloadedData.subarray(0, compareBytes)
			);

			const verified = result === 0;
			const message = verified
				? `部分検証 (先頭 ${compareBytes} バイト) に成功しました。`
				: `部分検証 (先頭 ${compareBytes} バイト) に失敗しました。`;

			// --- ★ ログレベル変更 (info -> success/warn) ---
			if (verified) {
				log.success(message);
			} else {
				log.warn(message);
			}
			return { verified, message };

		} else {
			// --- 全体比較 ---
			log.info(`全体検証を実行中 (Original: ${originalData.length} bytes, Downloaded: ${downloadedData.length} bytes)...`);

			if (originalData.length !== downloadedData.length) {
				const message = `データサイズが一致しません。(Original: ${originalData.length}, Downloaded: ${downloadedData.length})`;
				log.warn(message);
				return { verified: false, message: message };
			}

			const result = Buffer.compare(originalData, downloadedData);
			const verified = result === 0;
			const message = verified
				? `全体検証に成功しました。`
				: `全体検証に失敗しました。`;

			// --- ★ ログレベル変更 (info -> success/warn) ---
			if (verified) {
				log.success(message);
			} else {
				log.warn(message);
			}
			return { verified, message };
		}
	}
}