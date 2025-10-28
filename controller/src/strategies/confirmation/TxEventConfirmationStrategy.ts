// controller/src/strategies/confirmation/TxEventConfirmationStrategy.ts
import { Stream, Subscription } from 'xstream';
import { ConfirmationResult, RunnerContext } from '../../types';
import { log } from '../../utils/logger';
import { ICommunicationStrategy } from '../communication/ICommunicationStrategy';
import { ConfirmationOptions, IConfirmationStrategy } from './IConfirmationStrategy';

// Txイベントのタイムアウト
const DEFAULT_EVENT_TIMEOUT_MS = 60000; // 60秒

/**
 * WebSocket の Tx イベント購読によって、トランザクションの完了を確認する戦略。
 * Pollingよりも高速かつ低負荷ですが、WebSocket接続が必須です。
 */
export class TxEventConfirmationStrategy implements IConfirmationStrategy {

	// 購読中のストリームを管理 (チェーン名 -> クエリ -> ストリーム)
	private activeStreams = new Map<string, Map<string, Stream<any>>>();
	// 購読インスタンス (解除用)
	private activeSubscriptions = new Map<string, Subscription>();

	constructor() {
		log.debug('TxEventConfirmationStrategy がインスタンス化されました。');
	}

	/**
	 * 指定されたトランザクションハッシュのリストがブロックに取り込まれたかを確認します。
	 * @param context 実行コンテキスト (WebSocketCommunicationStrategy へのアクセス)
	 * @param chainName 確認対象のチェーン名
	 * @param txHashes 確認対象のトランザクションハッシュの配列
	 * @param options タイムアウト設定などのオプション
	 * @returns Txハッシュをキーとし、確認結果 (ConfirmationResult) を値とする Map
	 */
	public async confirmTransactions(
		context: RunnerContext,
		chainName: string,
		txHashes: string[],
		options: ConfirmationOptions
	): Promise<Map<string, ConfirmationResult>> {

		const { communicationStrategy } = context;
		const timeout = options.timeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS;

		log.info(`[TxEventConfirm] チェーン "${chainName}" で ${txHashes.length} 件のTxをイベント購読で確認開始 (Timeout: ${timeout}ms)`);

		// 1. 通信戦略が WebSocket か確認 (subscribe メソッドの存在チェック)
		if (!communicationStrategy.subscribe || !communicationStrategy.unsubscribe) {
			throw new Error('[TxEventConfirm] この戦略は WebSocketCommunicationStrategy (subscribe サポート) が必要です。');
		}

		// 2. 結果を格納する Map と、未確認のハッシュを管理する Set
		const results = new Map<string, ConfirmationResult>();
		const pendingHashes = new Set<string>(txHashes);

		// 3. Txイベント購読クエリを作成
		// (tx_search とは異なり、subscribe は複数のハッシュを OR で指定できないため、
		//  'tm.event = 'Tx'' ですべてのTxイベントを受け取り、クライアント側でフィルタリングする)
		const query = "tm.event = 'Tx'";

		// 4. イベントハンドラ (Promise) をセットアップ
		const confirmationPromise = new Promise<void>((resolve, reject) => {

			let stream: Stream<any>;
			try {
				// ストリームを購読 (または既存のストリームを取得)
				stream = this.getStream(communicationStrategy, chainName, query);
			} catch (error) {
				return reject(error); // 購読失敗
			}

			const subscription = stream.subscribe({
				next: (event: any) => {
					// イベントデータ (event.TxResult または event.txResult) からハッシュと結果を取得
					// tendermint-rpc v0.30+ (Cosmos SDK v0.46+)
					const txResult = event?.txResult; // CometBFT 0.38
					const tendermintTxResult = event?.TxResult; // Tendermint 0.37

					const resultData = txResult ?? tendermintTxResult;

					if (!resultData || !resultData.tx) {
						log.warn(`[TxEventConfirm] 受信したTxイベントの形式が無効です。`, event);
						return;
					}

					// Tx のハッシュを計算 (Base64エンコードされた tx データから)
					// (注: イベントは Tx のハッシュを直接返さない。
					//      txResult.hash は CometBFT 0.38 では存在するが、0.37 にはない。
					//      txResult.tx (Base64) から計算するのが確実)

					// ... と思ったが、v0.30 の TxEvent (WebsocketClient) は tx: Uint8Array を返す
					//     v0.29 までは tx: string (Base64) だった

					//     Tendermint37Client.subscribeTx は v0.30 イベント (TxEvent) を返す
					//     TxEvent = { height, index, tx: Uint8Array, result: TxResult }

					const txBytes: Uint8Array = resultData.tx; // v0.30 (Tendermint 0.37)
					const txResultData = resultData.result;   // v0.30

					if (!txBytes || !txResultData) {
						log.warn(`[TxEventConfirm] 受信したTxイベントの形式が無効です (tx または result がない)。`, event);
						return;
					}

					// Txハッシュの計算 (dis-test-ws/5.ts の TxEventSubscriber.hash() と同じロジック)
					// (これは非常に高コストだが、イベントにはハッシュが含まれていないため仕方ない)
					// TODO: 高速な SHA256 実装 (例: @noble/hashes) を使う
					// const hash = crypto.createHash('sha256').update(txBytes).digest('hex').toUpperCase();

					// --- 代替案 ---
					// TxEvent (v0.30) には `hash` プロパティ (string) が含まれているはず
					// (tendermint-rpc/build/tendermint37/responses.d.ts TxEvent)
					const hash = event?.hash; // Base64エンコードされたハッシュ文字列

					if (!hash) {
						log.warn(`[TxEventConfirm] 受信したTxイベントに 'hash' プロパティがありません。ハッシュ計算は未実装です。`);
						return;
					}

					if (pendingHashes.has(hash)) {
						// 待機していたTxだった
						pendingHashes.delete(hash);

						const result: ConfirmationResult = {
							success: txResultData.code === 0,
							height: resultData.height,
							gasUsed: BigInt(txResultData.gasUsed ?? 0),
							feeAmount: undefined, // TxEvent から手数料を取得するのは困難 (TxRawのデコードが必要)
							error: txResultData.code !== 0 ? txResultData.log : undefined,
						};
						results.set(hash, result);

						log.debug(`[TxEventConfirm] Tx確認完了 (Hash: ${hash.substring(0, 10)}..., Success: ${result.success})`);

						// オプションのプログレスコールバック
						options.onProgress?.(results.size, txHashes.length);

						if (pendingHashes.size === 0) {
							resolve(); // すべて確認完了
						}
					}
				},
				error: (err: any) => {
					log.error(`[TxEventConfirm] イベントストリームでエラーが発生しました (Query: ${query})。`, err);
					reject(err); // Promise を reject
				},
				complete: () => {
					log.info(`[TxEventConfirm] イベントストリームが完了しました (Query: ${query})。`);
					// ストリームが完了したが、まだペンディング中のTxがある場合はタイムアウト扱い
					if (pendingHashes.size > 0) {
						reject(new Error('イベントストリームが早期に完了しました。'));
					} else {
						resolve();
					}
				},
			});

			// この confirmTransactions 呼び出し専用の購読として保存
			const subscriptionId = `${chainName}-${Date.now()}`;
			this.activeSubscriptions.set(subscriptionId, subscription);

			// タイムアウト処理
			const timer = setTimeout(() => {
				log.warn(`[TxEventConfirm] タイムアウト (${timeout}ms) しました。 ${pendingHashes.size} 件のTxが未確認です。`);
				subscription.unsubscribe(); // タイムアウトしたら購読を解除
				this.activeSubscriptions.delete(subscriptionId);
				reject(new Error(`確認タイムアウト (${pendingHashes.size} 件未確認)`));
			}, timeout);

			// Promise が解決 (resolve or reject) したら、タイマーと購読をクリーンアップ
			confirmationPromise.finally(() => {
				clearTimeout(timer);
				if (this.activeSubscriptions.has(subscriptionId)) {
					// タイムアウト *以外* で完了した場合
					subscription.unsubscribe();
					this.activeSubscriptions.delete(subscriptionId);
				}
				// ストリーム自体 (activeStreams) は共有リソースのため、ここでは解除しない
			});
		});

		// 5. 待機
		try {
			await confirmationPromise;
		} catch (error: any) {
			log.warn(`[TxEventConfirm] 待機中にエラーが発生しました: ${error.message}`);
			// タイムアウトまたはエラーで未確認のTxを失敗扱いにする
			for (const hash of pendingHashes) {
				if (!results.has(hash)) {
					results.set(hash, {
						success: false,
						error: error.message || 'イベント待機エラー',
						height: undefined,
						gasUsed: undefined,
						feeAmount: undefined,
					});
				}
			}
		}

		log.info(`[TxEventConfirm] イベント確認終了。 (成功: ${Array.from(results.values()).filter(r => r.success).length}, 失敗: ${Array.from(results.values()).filter(r => !r.success).length})`);

		return results;
	}

	/**
	 * 共有ストリームを取得または新規作成します。
	 * (注意: xstream の共有は複雑なため、ここでは単純に都度購読します)
	 */
	private getStream(
		commStrategy: ICommunicationStrategy,
		chainName: string,
		query: string
	): Stream<any> {

		// TODO: ストリームの共有と参照カウント (現状は都度購読)

		// if (!this.activeStreams.has(chainName)) {
		//     this.activeStreams.set(chainName, new Map());
		// }
		// const chainStreams = this.activeStreams.get(chainName)!;
		// if (!chainStreams.has(query)) {
		//     log.info(`[TxEventConfirm] チェーン "${chainName}" で新しいイベントストリーム (Query: ${query}) を購読します。`);
		//     const stream = commStrategy.subscribe(query);
		//     chainStreams.set(query, stream);
		// }
		// return chainStreams.get(query)!;

		// シンプルに都度購読
		log.debug(`[TxEventConfirm] チェーン "${chainName}" でイベント (Query: ${query}) を新規購読します。`);
		return commStrategy.subscribe(query);
	}

	/**
	 * (ExperimentRunner 終了時に呼ばれる想定の) クリーンアップメソッド
	 */
	public cleanup(): void {
		log.info('[TxEventConfirm] すべてのアクティブな購読をクリーンアップします...');
		for (const [id, sub] of this.activeSubscriptions.entries()) {
			try {
				sub.unsubscribe();
				log.debug(`[TxEventConfirm] 購読 ${id} を解除しました。`);
			} catch (e) {
				log.warn(`[TxEventConfirm] 購読 ${id} の解除中にエラー:`, e);
			}
		}
		this.activeSubscriptions.clear();
		this.activeStreams.clear(); // ストリームのキャッシュもクリア
	}
}