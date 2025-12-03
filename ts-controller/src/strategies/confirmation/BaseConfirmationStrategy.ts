// controller/src/strategies/confirmation/BaseConfirmationStrategy.ts
import { ConfirmationResult, RunnerContext } from '../../types';
import { log } from '../../utils/logger';
import { ConfirmationOptions, IConfirmationStrategy } from './IConfirmationStrategy';

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * 完了確認戦略の共通ロジック（タイムアウト、状態管理）を提供する抽象基底クラス。
 */
export abstract class BaseConfirmationStrategy implements IConfirmationStrategy {

	public async confirmTransactions(
		context: RunnerContext,
		chainName: string,
		txHashes: string[],
		options: ConfirmationOptions
	): Promise<Map<string, ConfirmationResult>> {

		const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const results = new Map<string, ConfirmationResult>();
		const pendingHashes = new Set<string>(txHashes.map(h => h.toUpperCase()));
		const totalTxCount = txHashes.length; // ★ 総数をここで取得

		if (totalTxCount === 0) {
			return results;
		}

		log.info(`[${this.constructor.name}] チェーン "${chainName}" で ${totalTxCount} 件のTxを確認開始 (Timeout: ${timeout}ms)`);

		let timeoutId: NodeJS.Timeout | null = null;
		let cleanupCalled = false; // 重複呼び出し防止フラグ

		// タイムアウト処理と後処理を行うPromise
		const timeoutPromise = new Promise<void>((_, reject) => {
			timeoutId = setTimeout(() => {
				log.warn(`[${this.constructor.name}] タイムアウト (${timeout}ms) しました。 ${pendingHashes.size} 件のTxが未確認です。`);
				reject(new Error(`確認タイムアウト (${pendingHashes.size} 件未確認)`));
			}, timeout);
		});

		// 派生クラスが実装する本体処理
		const confirmationPromise = this._startConfirmationProcess(
			context,
			chainName,
			pendingHashes,
			results,
			options,
			totalTxCount // ★ 総数を引数として渡す
		);

		// 共通のクリーンアップ関数
		const cleanup = () => {
			if (cleanupCalled) return;
			cleanupCalled = true;

			if (timeoutId) clearTimeout(timeoutId);
			this._cleanup(context, chainName); // 派生クラスの後処理

			// タイムアウトまたはエラー時に残ったハッシュを失敗としてマーク
			if (pendingHashes.size > 0) {
				log.warn(`[${this.constructor.name}] クリーンアップ時点で ${pendingHashes.size} 件のTxが未確認です。`);
				for (const hash of pendingHashes) {
					if (!results.has(hash)) {
						results.set(hash, {
							success: false,
							error: '確認タイムアウトまたはエラー',
							height: undefined, gasUsed: undefined, feeAmount: undefined,
						});
					}
				}
			}
			log.info(`[${this.constructor.name}] 確認終了。 (成功: ${Array.from(results.values()).filter(r => r.success).length}, 失敗: ${Array.from(results.values()).filter(r => !r.success).length})`);
		};

		try {
			// タイムアウトと本体処理を競わせる
			await Promise.race([
				confirmationPromise,
				timeoutPromise
			]);
		} catch (error: any) {
			log.warn(`[${this.constructor.name}] 待機中にエラーが発生しました: ${error.message}`);
		} finally {
			cleanup();
		}

		return results;
	}

	/**
	 * 【抽象メソッド】派生クラスが実装する確認プロセスの本体。
	 * このPromiseは、全件確認完了時に resolve するか、
	 * 致命的なエラー発生時に reject する必要があります。
	 * ★ 修正: totalTxCount を引数に追加
	 */
	protected abstract _startConfirmationProcess(
		context: RunnerContext,
		chainName: string,
		pendingHashes: Set<string>,
		results: Map<string, ConfirmationResult>,
		options: ConfirmationOptions,
		totalTxCount: number // ★ 追加
	): Promise<void>;

	/**
	 * 【抽象メソッド】派生クラスが実装するクリーンアップ処理。
	 * (例: WebSocketの購読解除、ポーリングループの停止フラグ設定)
	 */
	protected abstract _cleanup(
		context: RunnerContext,
		chainName: string
	): void;
}