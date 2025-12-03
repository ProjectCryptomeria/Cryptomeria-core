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
	// ★ 追加: どこのエンドポイントで購読したか記憶する
	private subscribedEndpoint: string | null = null;

	constructor() {
		super(); // ★ 基底クラスのコンストラクタ
		log.debug('TxEventConfirmationStrategy がインスタンス化されました。');
	}

	/**
	 * 【実装】イベント購読を開始します。
	 * ★ 修正: infraService.getRpcEndpoints() (遅延の原因) を
	 * ★ chainManager.getRpcEndpoint() (キャッシュ済み) に変更
	 */
	protected _startConfirmationProcess( // ★ async を削除
		context: RunnerContext,
		chainName: string,
		pendingHashes: Set<string>,
		results: Map<string, ConfirmationResult>,
		options: ConfirmationOptions,
		totalTxCount: number
	): Promise<void> { // ★ Promise<void> のまま

		// ★ 修正: infraService ではなく chainManager を使用
		const { communicationStrategy, chainManager } = context;
		this.subscription = null; // 初期化
		this.subscribedEndpoint = null; // 初期化

		// 通信戦略が WebSocket (subscribe サポート) か確認
		if (!communicationStrategy.subscribe || !communicationStrategy.unsubscribe) {
			throw new Error('[TxEventConfirm] この戦略は WebSocketCommunicationStrategy (subscribe サポート) が必要です。');
		}

		// ★ 修正: エンドポイントを chainManager から同期的に取得
		let endpoint: string;
		try {
			endpoint = chainManager.getRpcEndpoint(chainName);
		} catch (error) {
			return Promise.reject(error); // 即時エラー
		}

		this.subscribedEndpoint = endpoint; // ★ 後で cleanup するために記憶

		// イベント待機用の Promise を作成
		return new Promise<void>((resolve, reject) => {
			try {
				// ★ 修正: subscribe に endpoint を渡す
				const stream: Stream<TxEvent> = communicationStrategy.subscribe(endpoint, this.query);
				log.debug(`[TxEventConfirm @ ${chainName}] イベントストリーム (Query: ${this.query}) を購読しました。`);

				this.subscription = stream.subscribe({
					next: (event: TxEvent) => {
						const receivedHash = toHex(event.hash).toUpperCase();

						if (!event.result || event.height === undefined) {
							log.warn(`[TxEventConfirm @ ${chainName}] 受信したTxイベントに必要なプロパティ (result, height) がありません。Hash: ${receivedHash}`, event);
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

							log.debug(`[TxEventConfirm @ ${chainName}] Tx確認完了 (Hash: ${receivedHash.substring(0, 10)}..., Success: ${result.success}, Height: ${result.height})`);

							options.onProgress?.(result);

							if (pendingHashes.size === 0) {
								log.debug(`[TxEventConfirm @ ${chainName}] 全 ${totalTxCount} 件のTx確認が完了しました。`);
								resolve();
							}
						} else {
							log.debug(`[TxEventConfirm @ ${chainName}] 待機対象外のTxイベント受信: ${receivedHash.substring(0, 10)}...`);
						}
					},
					error: (err: any) => {
						log.error(`[TxEventConfirm @ ${chainName}] イベントストリームでエラーが発生しました (Query: ${this.query})。`, err);
						reject(err);
					},
					complete: () => {
						log.info(`[TxEventConfirm @ ${chainName}] イベントストリームが完了しました (Query: ${this.query})。`);
						if (pendingHashes.size > 0) {
							reject(new Error(`イベントストリームが早期に完了しました (${pendingHashes.size} 件未確認)。`));
						} else {
							resolve();
						}
					},
				});

			} catch (error) {
				log.error(`[TxEventConfirm @ ${chainName}] イベント購読の開始に失敗しました。`, error);
				reject(error);
			}
		});
	}

	/**
	 * 【実装】イベント購読を解除します。
	 * ★ 修正: 記憶したエンドポイントを使って unsubscribe する
	 */
	protected _cleanup(context: RunnerContext, chainName: string): void {
		const { communicationStrategy } = context;

		if (this.subscription && this.subscribedEndpoint) {
			try {
				// ★ 修正: どのエンドポイントの購読を解除するか指定
				communicationStrategy.unsubscribe(this.subscribedEndpoint, this.query);
				log.debug(`[TxEventConfirm @ ${chainName}] クリーンアップ: イベント購読 (Query: ${this.query}) を解除しました。`);
			} catch (e) {
				log.warn(`[TxEventConfirm @ ${chainName}] 購読解除中にエラー:`, e);
			}
		}
		this.subscription = null;
		this.subscribedEndpoint = null;
	}
}