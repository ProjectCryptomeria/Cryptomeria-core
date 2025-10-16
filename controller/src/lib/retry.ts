import { log } from './logger';

export interface RetryOptions {
	retries: number;
	minTimeout: number; // 最初の待機時間 (ms)
	factor: number;    // 待機時間の増加率
	jitter: boolean;   // ジッター（ゆらぎ）の有無
}

/**
 * T型のPromiseを返す任意の非同期関数を指定されたオプションでリトライ実行します。
 * @param fn - リトライ対象の非同期関数
 * @param options - リトライ設定
 * @returns {Promise<T>} 非同期関数の実行結果
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	options: RetryOptions
): Promise<T> {
	let lastError: Error | undefined;
	let timeout = options.minTimeout;

	for (let i = 0; i < options.retries; i++) {
		try {
			return await fn();
		} catch (error: any) {
			lastError = error;
			if (i < options.retries - 1) {
				log.warn(`Attempt ${i + 1}/${options.retries} failed. Retrying in ${timeout.toFixed(0)} ms... Error: ${error.message}`);
				await new Promise(resolve => setTimeout(resolve, timeout));

				// 次のタイムアウトを計算
				timeout *= options.factor;
				if (options.jitter) {
					// タイムアウト時間に±30%程度のランダムなゆらぎを追加
					const jitterValue = timeout * 0.6 * (Math.random() - 0.5); // -0.3 to +0.3
					timeout += jitterValue;
				}
			}
		}
	}
	log.error(`Function failed after ${options.retries} retries.`);
	throw lastError;
}