// controller/src/strategies/confirmation/TxEventConfirmationStrategy.ts
import { Stream, Subscription } from 'xstream';
import { ConfirmationResult, RunnerContext } from '../../types';
import { log } from '../../utils/logger';
import { ConfirmationOptions } from './IConfirmationStrategy';
// toHex をインポート
import { toHex } from '@cosmjs/encoding';
// TxEvent 型をインポート
import { TxEvent } from "@cosmjs/tendermint-rpc/build/comet38";
// ★ 修正: BaseConfirmationStrategy をインポート
import { BaseConfirmationStrategy } from './BaseConfirmationStrategy';

/**
 * WebSocket の Tx イベント購読によって、トランザクションの完了を確認する戦略。
 * (★ BaseConfirmationStrategy を継承)
 */
export class TxEventConfirmationStrategy extends BaseConfirmationStrategy {

	private subscription: Subscription | null = null;
	private query: string = "tm.event = 'Tx'";

	constructor() {
		super(); // ★ 基底クラスのコンストラクタ
		log.debug('TxEventConfirmationStrategy がインスタンス化されました。');
	}

	/**
	 * 【実装】イベント購読を開始します。
	 * ★ 修正: onProgress の呼び出し
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
				const stream: Stream<TxEvent> = communicationStrategy.subscribe(this.query);
				log.debug(`[TxEventConfirm] イベントストリーム (Query: ${this.query}) を購読しました。`);

				this.subscription = stream.subscribe({
					next: (event: TxEvent) => {
						const receivedHash = toHex(event.hash).toUpperCase();

						if (!event.result || event.height === undefined) {
							log.warn(`[TxEventConfirm] 受信したTxイベントに必要なプロパティ (result, height) がありません。Hash: ${receivedHash}`, event);
							return;
						}

						if (pendingHashes.has(receivedHash)) {
							pendingHashes.delete(receivedHash);

							const result: ConfirmationResult = {
								success: event.result.code === 0,
								height: event.height,
								gasUsed: typeof event.result.gasUsed === 'string'
									? BigInt(event.result.gasUsed)
									: (typeof event.result.gasUsed === 'bigint' ? event.result.gasUsed : undefined),
								feeAmount: undefined,
								error: event.result.code !== 0 ? event.result.log : undefined,
							};
							results.set(receivedHash, result);

							log.debug(`[TxEventConfirm] Tx確認完了 (Hash: ${receivedHash.substring(0, 10)}..., Success: ${result.success}, Height: ${result.height})`);

							// ★ 修正: 完了した result を onProgress に渡す
							options.onProgress?.(result);

							if (pendingHashes.size === 0) {
								// ★ 修正: log.success は stderr に出力される
								log.success(`[TxEventConfirm] 全 ${totalTxCount} 件のTx確認が完了しました。`);
								resolve();
							}
						} else {
							log.debug(`[TxEventConfirm] 待機対象外のTxイベント受信: ${receivedHash.substring(0, 10)}...`);
						}
					},
					error: (err: any) => {
						log.error(`[TxEventConfirm] イベントストリームでエラーが発生しました (Query: ${this.query})。`, err);
						reject(err);
					},
					complete: () => {
						log.info(`[TxEventConfirm] イベントストリームが完了しました (Query: ${this.query})。`);
						if (pendingHashes.size > 0) {
							reject(new Error(`イベントストリームが早期に完了しました (${pendingHashes.size} 件未確認)。`));
						} else {
							resolve();
						}
					},
				});

			} catch (error) {
				log.error(`[TxEventConfirm] イベント購読の開始に失敗しました。`, error);
				reject(error);
			}
		});
	}

	/**
	 * 【実装】イベント購読を解除します。
	 */
	protected _cleanup(context: RunnerContext, chainName: string): void {
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