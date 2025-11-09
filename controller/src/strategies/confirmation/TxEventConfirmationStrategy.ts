// controller/src/strategies/confirmation/TxEventConfirmationStrategy.ts
import { Stream, Subscription } from 'xstream';
import { ConfirmationResult, RunnerContext } from '../../types';
import { log } from '../../utils/logger';
import { ConfirmationOptions, IConfirmationStrategy } from './IConfirmationStrategy';
// toHex をインポート
import { toHex } from '@cosmjs/encoding';
// TxEvent 型をインポート
import { TxEvent } from "@cosmjs/tendermint-rpc/build/comet38/responses";

const DEFAULT_EVENT_TIMEOUT_MS = 60000;

// BigInt や Buffer/Uint8Array を文字列に変換する JSON.stringify の replacer 関数 (デバッグログ用)
function replacer(key: string, value: any): any {
	if (typeof value === 'bigint') {
		return value.toString();
	}
	if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
		return Buffer.from(value).toString('base64');
	}
	return value;
}

/**
 * WebSocket の Tx イベント購読によって、トランザクションの完了を確認する戦略。
 * event.hash を利用して効率的に照合します。
 */
export class TxEventConfirmationStrategy implements IConfirmationStrategy {
	constructor() {
		log.debug('TxEventConfirmationStrategy がインスタンス化されました。');
	}

	/**
	 * 指定されたトランザクションハッシュのリストがブロックに取り込まれたかを確認します。
	 * @param context 実行コンテキスト (WebSocketCommunicationStrategy へのアクセス)
	 * @param chainName 確認対象のチェーン名
	 * @param txHashes 確認対象のトランザクションハッシュの配列 (Hex文字列, 大文字)
	 * @param options タイムアウト設定などのオプション
	 * @returns Txハッシュをキーとし、確認結果 (ConfirmationResult) を値とする Map
	 */
	public async confirmTransactions(
		context: RunnerContext,
		chainName: string,
		txHashes: string[], // Hex文字列 (大文字) のリスト
		options: ConfirmationOptions
	): Promise<Map<string, ConfirmationResult>> {

		const { communicationStrategy } = context;
		const timeout = options.timeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS;

		log.info(`[TxEventConfirm] チェーン "${chainName}" で ${txHashes.length} 件のTxをイベント購読で確認開始 (Timeout: ${timeout}ms)`);

		// 通信戦略が WebSocket (subscribe サポート) か確認
		if (!communicationStrategy.subscribe || !communicationStrategy.unsubscribe) {
			throw new Error('[TxEventConfirm] この戦略は WebSocketCommunicationStrategy (subscribe サポート) が必要です。');
		}

		const results = new Map<string, ConfirmationResult>();
		// 確認対象ハッシュを大文字 Hex 文字列で Set に格納
		const pendingHashes = new Set<string>(txHashes.map(h => h.toUpperCase()));
		const query = "tm.event = 'Tx'";

		let stream: Stream<TxEvent> | null = null;
		let subscription: Subscription | null = null;
		let timer: NodeJS.Timeout | null = null;

		// イベント待機用の Promise を作成
		const confirmationPromise = new Promise<void>((resolve, reject) => {
			try {
				// イベントストリームを購読 (呼び出しごとに新規購読)
				stream = communicationStrategy.subscribe(query);
				log.debug(`[TxEventConfirm] イベントストリーム (Query: ${query}) を購読しました。`);

				// イベントストリームの処理を設定
				subscription = stream.subscribe({
					next: (event: TxEvent) => {
						// デバッグログ (RangeError 対策済み、必要なら有効化)
						/*
						try {
							const eventString = JSON.stringify(event, replacer, 2);
							log.debug(`[TxEventConfirm] 受信イベント:\n${eventString}`);
						} catch (stringifyError) {
							log.warn('[TxEventConfirm] 受信イベントの文字列化に失敗:', stringifyError);
						}
						*/

						// event.hash (Uint8Array) を Hex 文字列 (大文字) に変換
						const receivedHash = toHex(event.hash).toUpperCase();

						// 必要なプロパティ (result, height) の存在チェック
						if (!event.result || event.height === undefined) {
							log.warn(`[TxEventConfirm] 受信したTxイベントに必要なプロパティ (result, height) がありません。Hash: ${receivedHash}`, event);
							return;
						}

						// 待機中のハッシュリストに含まれているか確認
						if (pendingHashes.has(receivedHash)) {
							pendingHashes.delete(receivedHash); // 確認済みとして Set から削除

							// 確認結果を作成
							const result: ConfirmationResult = {
								success: event.result.code === 0,
								height: event.height,
								gasUsed: typeof event.result.gasUsed === 'string'
									? BigInt(event.result.gasUsed)
									: (typeof event.result.gasUsed === 'bigint' ? event.result.gasUsed : undefined),
								feeAmount: undefined, // イベントからは取得困難
								error: event.result.code !== 0 ? event.result.log : undefined,
							};
							results.set(receivedHash, result); // 結果を Map に保存

							log.debug(`[TxEventConfirm] Tx確認完了 (Hash: ${receivedHash.substring(0, 10)}..., Success: ${result.success}, Height: ${result.height})`);

							// 進捗コールバックを実行 (オプション)
							options.onProgress?.(results.size, txHashes.length);

							// すべてのTxが確認されたら Promise を resolve
							if (pendingHashes.size === 0) {
								// --- ★ ログレベル変更 (info -> success) ---
								log.success(`[TxEventConfirm] 全 ${txHashes.length} 件のTx確認が完了しました。`);
								resolve();
							}
						} else {
							// 待機対象外のTxイベントは無視
							log.debug(`[TxEventConfirm] 待機対象外のTxイベント受信: ${receivedHash.substring(0, 10)}...`);
						}
					},
					error: (err: any) => {
						// ストリームでエラーが発生した場合
						log.error(`[TxEventConfirm] イベントストリームでエラーが発生しました (Query: ${query})。`, err);
						reject(err); // Promise を reject
					},
					complete: () => {
						// ストリームが予期せず完了した場合
						log.info(`[TxEventConfirm] イベントストリームが完了しました (Query: ${query})。`);
						if (pendingHashes.size > 0) {
							// まだ未確認のTxがあるのにストリームが完了した場合はエラー
							reject(new Error(`イベントストリームが早期に完了しました (${pendingHashes.size} 件未確認)。`));
						} else {
							// 正常完了
							resolve();
						}
					},
				});

				// タイムアウトタイマーを設定
				timer = setTimeout(() => {
					log.warn(`[TxEventConfirm] タイムアウト (${timeout}ms) しました。 ${pendingHashes.size} 件のTxが未確認です。`);
					reject(new Error(`確認タイムアウト (${pendingHashes.size} 件未確認)`));
				}, timeout);

			} catch (error) {
				// subscribe の呼び出し自体でエラーが発生した場合
				log.error(`[TxEventConfirm] イベント購読の開始に失敗しました。`, error);
				reject(error);
			}
		}); // --- Promise constructor end ---

		// Promise が完了 (resolve or reject) した際のクリーンアップ処理
		confirmationPromise.finally(() => {
			log.debug('[TxEventConfirm] クリーンアップ処理を実行します...');
			if (timer) clearTimeout(timer); // タイムアウトタイマーをクリア
			if (subscription) {
				try {
					subscription.unsubscribe(); // イベント購読を解除
					log.debug(`[TxEventConfirm] イベント購読 (Query: ${query}) を解除しました。`);
				} catch (e) {
					log.warn(`[TxEventConfirm] 購読解除中にエラー:`, e);
				}
			}
		});

		// Promise の完了を待機
		try {
			await confirmationPromise;
		} catch (error: any) {
			// タイムアウトまたはその他のエラーが発生した場合
			log.warn(`[TxEventConfirm] 待機中にエラーが発生しました: ${error.message}`);
			// 未確認のTxを失敗として結果に追加
			for (const hash of pendingHashes) {
				if (!results.has(hash)) {
					results.set(hash, {
						success: false,
						error: error.message || 'イベント待機エラー',
						height: undefined, gasUsed: undefined, feeAmount: undefined,
					});
				}
			}
		}

		// 最終的な結果サマリーをログに出力
		log.info(`[TxEventConfirm] イベント確認終了。 (成功: ${Array.from(results.values()).filter(r => r.success).length}, 失敗: ${Array.from(results.values()).filter(r => !r.success).length})`);

		// 結果の Map を返す
		return results;
	}
}