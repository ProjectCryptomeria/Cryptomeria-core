// controller/src/strategies/confirmation/TxEventConfirmationStrategy.ts
import { Stream, Subscription } from 'xstream';
import { ConfirmationResult, RunnerContext } from '../../types';
import { log } from '../../utils/logger';
import { ConfirmationOptions } from './IConfirmationStrategy';
// toHex をインポート
import { toHex } from '@cosmjs/encoding';
// TxEvent 型をインポート
import { TxEvent } from "@cosmjs/tendermint-rpc/build/comet38";
import { BaseConfirmationStrategy } from './BaseConfirmationStrategy'; // ★ 基底クラスをインポート

/**
 * WebSocket の Tx イベント購読によって、トランザクションの完了を確認する戦略。
 * (★ BaseConfirmationStrategy を継承)
 */
export class TxEventConfirmationStrategy extends BaseConfirmationStrategy {

	private subscription: Subscription | null = null;
	// ★ 修正: クエリをクラスプロパティに移動
	private query: string = "tm.event = 'Tx'";

	constructor() {
		super(); // ★ 基底クラスのコンストラクタ
		log.debug('TxEventConfirmationStrategy がインスタンス化されました。');
	}

	/**
	 * 【実装】イベント購読を開始します。
	 * ★ 修正: totalTxCount を引数に追加
	 */
	protected _startConfirmationProcess(
		context: RunnerContext,
		chainName: string,
		pendingHashes: Set<string>,
		results: Map<string, ConfirmationResult>,
		options: ConfirmationOptions,
		totalTxCount: number // ★ 追加
	): Promise<void> {

		const { communicationStrategy } = context;
		this.subscription = null; // 初期化

		// 通信戦略が WebSocket (subscribe サポート) か確認
		if (!communicationStrategy.subscribe || !communicationStrategy.unsubscribe) {
			throw new Error('[TxEventConfirm] この戦略は WebSocketCommunicationStrategy (subscribe サポート) が必要です。');
		}

		// イベント待機用の Promise を作成 (タイムアウトは基底クラスが担当)
		return new Promise<void>((resolve, reject) => {
			try {
				// ★ 修正: クラスプロパティの query を使用
				const stream: Stream<TxEvent> = communicationStrategy.subscribe(this.query);
				log.debug(`[TxEventConfirm] イベントストリーム (Query: ${this.query}) を購読しました。`);

				// イベントストリームの処理を設定
				this.subscription = stream.subscribe({
					next: (event: TxEvent) => {
						// (デバッグログはコメントアウト)

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

							// ★ 修正: txHashes.length -> totalTxCount
							options.onProgress?.(results.size, totalTxCount);

							// すべてのTxが確認されたら Promise を resolve
							if (pendingHashes.size === 0) {
								log.success(`[TxEventConfirm] 全 ${totalTxCount} 件のTx確認が完了しました。`);
								resolve(); // ★ 全件完了したら resolve
							}
						} else {
							// 待機対象外のTxイベントは無視
							log.debug(`[TxEventConfirm] 待機対象外のTxイベント受信: ${receivedHash.substring(0, 10)}...`);
						}
					},
					error: (err: any) => {
						// ストリームでエラーが発生した場合
						log.error(`[TxEventConfirm] イベントストリームでエラーが発生しました (Query: ${this.query})。`, err);
						reject(err); // ★ 致命的エラーとして reject
					},
					complete: () => {
						// ストリームが予期せず完了した場合
						log.info(`[TxEventConfirm] イベントストリームが完了しました (Query: ${this.query})。`);
						if (pendingHashes.size > 0) {
							// まだ未確認のTxがあるのにストリームが完了した場合はエラー
							reject(new Error(`イベントストリームが早期に完了しました (${pendingHashes.size} 件未確認)。`));
						} else {
							// 正常完了
							resolve();
						}
					},
				});

			} catch (error) {
				// subscribe の呼び出し自体でエラーが発生した場合
				log.error(`[TxEventConfirm] イベント購読の開始に失敗しました。`, error);
				reject(error);
			}
		}); // --- Promise constructor end ---
	}

	/**
	 * 【実装】イベント購読を解除します。
	 */
	protected _cleanup(context: RunnerContext, chainName: string): void {
		// ★ 修正: communicationStrategy を使って unsubscribe するロジックは不要
		// (BaseConfirmationStrategy が subscription.unsubscribe() を呼ぶため)
		if (this.subscription) {
			try {
				this.subscription.unsubscribe();
				log.debug(`[TxEventConfirm] クリーンアップ: イベント購読 (Query: ${this.query}) を解除しました。`);
			} catch (e) {
				log.warn(`[TxEventConfirm] 購読解除中にエラー:`, e);
			}
			this.subscription = null;
		}
	}
}