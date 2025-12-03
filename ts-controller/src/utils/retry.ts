// controller/src/utils/retry.ts
import { log } from './logger';

/**
 * リトライ処理のオプション
 */
export interface RetryOptions {
	retries: number;        // 最大リトライ回数
	minTimeout: number;     // 最小待機時間 (ミリ秒)
	maxTimeout?: number;    // 最大待機時間 (ミリ秒, オプション)
	factor?: number;        // バックオフ係数 (デフォルト: 2)
	jitter?: boolean;       // ジッター（ランダム遅延）を有効にするか (デフォルト: false)
	onRetry?: (error: Error, attempt: number) => void; // リトライ時に実行されるコールバック (オプション)
}

/**
 * 指定された非同期関数をリトライします。
 * @param fn リトライ対象の非同期関数
 * @param options リトライオプション
 * @returns 非同期関数の実行結果
 * @throws リトライ回数上限に達した場合、最後に発生したエラーをスローします
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	options: RetryOptions
): Promise<T> {
	const {
		retries,
		minTimeout,
		maxTimeout = Infinity, // デフォルトは無限大
		factor = 2,
		jitter = false,
		onRetry,
	} = options;

	let attempt = 0;
	let lastError: Error | null = null;

	while (attempt <= retries) {
		try {
			// 非同期関数を実行
			return await fn();
		} catch (error: any) {
			lastError = error instanceof Error ? error : new Error(String(error));
			attempt++;

			// リトライ回数上限に達したらループを抜ける
			if (attempt > retries) {
				log.error(`リトライ上限 (${retries}回) に達しました。最終エラー: ${lastError.message}`);
				break; // ループを抜けて下の throw へ
			}

			// リトライ待機時間を計算
			let delay = Math.min(minTimeout * Math.pow(factor, attempt - 1), maxTimeout);

			// ジッターを追加する場合
			if (jitter) {
				delay = Math.random() * delay;
			}

			delay = Math.round(delay); // ミリ秒に丸める

			log.warn(`試行 ${attempt}/${retries} が失敗しました。 ${delay}ms 後にリトライします... エラー: ${lastError.message}`);

			// リトライコールバックを実行
			if (onRetry) {
				try {
					onRetry(lastError, attempt);
				} catch (callbackError) {
					log.error('リトライコールバック内でエラーが発生しました:', callbackError);
				}
			}

			// 指定時間待機
			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}

	// ループが完了（リトライ上限に達した）場合、最後に発生したエラーをスロー
	throw lastError ?? new Error('リトライ処理が失敗しましたが、エラーが記録されていません。');
}

/**
 * 単純な sleep 関数
 * @param ms 待機するミリ秒
 */
export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}