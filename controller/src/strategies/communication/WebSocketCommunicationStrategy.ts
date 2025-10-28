// controller/src/strategies/communication/WebSocketCommunicationStrategy.ts
import { JsonRpcRequest, JsonRpcResponse, JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import {
	Comet38Client,
	CometClient,
	HttpBatchClient, // getRpcClient の戻り値型のために必要
	WebsocketClient
} from '@cosmjs/tendermint-rpc';
import { Stream, Subscription } from 'xstream';
import { log } from '../../utils/logger';
import { withRetry } from '../../utils/retry';
import { ICommunicationStrategy } from './ICommunicationStrategy';

// 接続リトライオプション
const CONNECT_RETRIES = 5;
const CONNECT_RETRY_DELAY_MS = 2000;
// ★ 追加: ヘルスチェックのタイムアウト (接続試行ごとのタイムアウト)
const HEALTH_CHECK_TIMEOUT_MS = 5000; // 5秒

/**
 * WebSocket を使用する通信戦略。
 */
export class WebSocketCommunicationStrategy implements ICommunicationStrategy {
	private wsClients = new Map<string, WebsocketClient>();
	private rpcClients = new Map<string, Comet38Client>();
	private subscriptions = new Map<string, Subscription>();
	private isConnectedFlag = false;

	constructor() {
		log.debug('WebSocketCommunicationStrategy がインスタンス化されました。');
	}

	/**
	 * 指定されたWebSocketエンドポイントに接続します。
	 */
	public async connect(endpoint: string): Promise<void> {
		if (this.rpcClients.has(endpoint)) {
			log.debug(`[WS] エンドポイント ${endpoint} は既に接続済みです。`);
			return;
		}

		log.debug(`[WS] エンドポイント ${endpoint} への接続を開始します...`);

		try {
			// リトライ付きで接続試行 (attemptWsConnect 内でヘルスチェックも行う)
			const wsClient = await withRetry(
				() => this.attemptWsConnect(endpoint),
				{
					retries: CONNECT_RETRIES,
					minTimeout: CONNECT_RETRY_DELAY_MS,
					onRetry: (error, attempt) => {
						log.warn(`[WS] 接続試行 ${attempt}/${CONNECT_RETRIES} 失敗。リトライします...: ${error.message}`);
					},
				}
			);

			// Tendermint クライアントを作成
			// (attemptWsConnect でヘルスチェック済みなので、ここでは単純に作成)
			const tmClient = Comet38Client.create(wsClient);

			this.wsClients.set(endpoint, wsClient);
			this.rpcClients.set(endpoint, tmClient);
			this.isConnectedFlag = true;
			log.info(`[WS] エンドポイント ${endpoint} への接続が確立し、ヘルスチェックも成功しました。`);

		} catch (error: any) {
			log.error(`[WS] エンドポイント ${endpoint} への接続に最終的に失敗しました。`, error);
			// 念のため wsClient が残っていれば切断
			const wsClient = this.wsClients.get(endpoint);
			if (wsClient) {
				try { wsClient.disconnect(); } catch { }
				this.wsClients.delete(endpoint);
			}
			this.rpcClients.delete(endpoint);
			throw new Error(`WebSocket 接続失敗 (Endpoint: ${endpoint}): ${error.message}`);
		}
	}

	/**
	 * WebsocketClient の接続試行とヘルスチェック（1回分）
	 * ★★★ 修正箇所 ★★★
	 */
	private attemptWsConnect(endpoint: string): Promise<WebsocketClient> {
		return new Promise(async (resolve, reject) => { // ★ async を追加
			let wsClient: WebsocketClient | null = null;
			let healthCheckTimer: NodeJS.Timeout | null = null;

			// ヘルスチェックタイムアウトハンドラ
			const rejectOnTimeout = () => {
				if (wsClient) {
					try { wsClient.disconnect(); } catch { } // タイムアウトしたら切断試行
				}
				reject(new Error(`WebSocket ヘルスチェックタイムアウト (${HEALTH_CHECK_TIMEOUT_MS}ms)`));
			};

			try {
				// 1. WebsocketClient インスタンス作成とエラーハンドラ設定
				wsClient = new WebsocketClient(endpoint, (error: Error) => {
					// 接続プロセス中にエラーが発生した場合 (例: DNS解決失敗、接続拒否)
					log.warn(`[WS] 接続エラーハンドラ (Endpoint: ${endpoint}): ${error.message}`);
					if (healthCheckTimer) clearTimeout(healthCheckTimer); // タイムアウトをクリア
					reject(error); // withRetry がキャッチする
				});

				// 2. ヘルスチェックタイムアウトを設定
				healthCheckTimer = setTimeout(rejectOnTimeout, HEALTH_CHECK_TIMEOUT_MS);

				// 3. wsClient.connected プロミスを待つ (WebSocketレベルの接続完了)
				//    (これが reject された場合は上記エラーハンドラが呼ばれるはず)
				await wsClient.connected;
				log.debug(`[WS] WebsocketClient 接続完了 (Endpoint: ${endpoint})。ヘルスチェックを実行中...`);

				// 4. ★ ユーザー指摘のヘルスチェックを実行
				const healthCheckQuery: JsonRpcRequest = {
					jsonrpc: "2.0",
					method: "status", // Tendermint/CometBFT の status RPC
					id: `healthcheck-${Date.now()}`,
					params: {}
				};
				// wsClient.execute を使って RPC リクエストを送信
				await wsClient.execute(healthCheckQuery);

				// 5. ヘルスチェック成功
				log.debug(`[WS] ヘルスチェック成功 (Endpoint: ${endpoint})`);
				if (healthCheckTimer) clearTimeout(healthCheckTimer); // タイムアウトをクリア
				resolve(wsClient); // 接続成功として WebsocketClient を返す

			} catch (error) {
				// wsClient.connected の reject や wsClient.execute のエラー
				log.warn(`[WS] attemptWsConnect 中にエラーが発生しました:`, error);
				if (healthCheckTimer) clearTimeout(healthCheckTimer);
				if (wsClient) {
					try { wsClient.disconnect(); } catch { } // エラー時は切断試行
				}
				reject(error); // withRetry がキャッチする
			}
		});
	}


	/**
	 * すべての WebSocket 接続を切断します。
	 */
	public async disconnect(): Promise<void> {
		log.debug('[WS] すべての WebSocket 接続を切断します...');
		// すべての購読を解除
		for (const [query, subscription] of this.subscriptions.entries()) {
			try {
				subscription.unsubscribe();
				log.debug(`[WS] 購読を解除しました: ${query}`);
			} catch (e) {
				log.warn(`[WS] 購読解除中にエラー (Query: ${query}):`, e);
			}
		}
		this.subscriptions.clear();

		// すべてのクライアントを切断
		for (const [endpoint, tmClient] of this.rpcClients.entries()) {
			try {
				tmClient.disconnect();
				log.debug(`[WS] TendermintClient 切断完了: ${endpoint}`);
			} catch (e) {
				log.warn(`[WS] TendermintClient 切断中にエラー (Endpoint: ${endpoint}):`, e);
			}
		}
		// wsClients は tmClient.disconnect() によって内部的に切断されるはず

		this.rpcClients.clear();
		this.wsClients.clear();
		this.isConnectedFlag = false;
	}

	public isConnected(): boolean {
		return this.isConnectedFlag && this.rpcClients.size > 0;
	}

	/**
	 * JSON-RPC リクエストを送信します。
	 * @param request
	 */
	public async sendRpcRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		// どのエンドポイント使うか？ -> リクエスト自体にはエンドポイント情報がない。
		// このメソッドは ChainManager からは直接呼ばれず、
		// getRpcClient() 経由で取得したクライアントの .execute() が呼ばれる想定

		log.warn('[WS] sendRpcRequest は直接サポートされていません。getRpcClient() を使用してください。');
		// 仮に最初のエンドポイントで実行
		const client = this.rpcClients.values().next().value;
		if (!client) {
			throw new Error('[WS] RPCクライアントが初期化されていません。');
		}

		// Tendermint37Client には .execute() がない。.do() を使う
		// @ts-ignore
		const response = await client.do(request.method, request.params);
		// TendermintClient の応答を JsonRpcResponse にラップする (簡易的)
		return {
			jsonrpc: "2.0",
			id: request.id,
			result: response, // TendermintClient の do() は結果を直接返す
		} as JsonRpcSuccessResponse;
	}

	/**
	 * REST API リクエストを送信します (WebSocket戦略では非推奨)。
	 */
	public async sendRestRequest(path: string, params?: Record<string, any>): Promise<any> {
		log.warn('[WS] WebSocketCommunicationStrategy で REST API リクエスト (sendRestRequest) が呼び出されました。HttpCommunicationStrategy の使用を推奨します。');
		// HTTP戦略と同様の fetch をフォールバックとして実装
		const fullUrl = path; // HttpDownloadStrategy がフルパスを渡す前提
		let searchParams = '';
		if (params) {
			searchParams = '?' + new URLSearchParams(params).toString();
		}

		try {
			const response = await fetch(`${fullUrl}${searchParams}`, {
				method: 'GET',
				headers: { 'Accept': 'application/json' },
			});
			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`HTTPエラー ${response.status} (${response.statusText}): ${errorText}`);
			}
			return await response.json();
		} catch (error: any) {
			log.error(`[WS-REST_Fallback] RESTリクエスト失敗 (${fullUrl}):`, error);
			throw error;
		}
	}

	/**
	 * 接続済みの Tendermint RPC クライアント (Tendermint37Client) を取得します。
	 */
	public getRpcClient(endpoint: string): CometClient | HttpBatchClient | undefined {
		return this.rpcClients.get(endpoint);
	}

	/**
	 * Tendermint イベントストリームを購読します。
	 * @param query イベントクエリ (例: "tm.event = 'Tx' AND ...")
	 */
	public subscribe(query: string): Stream<any> {
		if (this.subscriptions.has(query)) {
			log.warn(`[WS] クエリ "${query}" は既に購読済みです。既存のストリームを返します。`);
			// TODO: 既存のストリームを返す方法 (xstream は難しい)
			// -> TxEventConfirmationStrategy 側で多重購読を管理する必要がある
		}

		// どのクライアントで購読するか？ -> 最初に見つかったクライアントを使用 (全ノードが同じイベントを流す前提)
		const client = this.rpcClients.values().next().value;
		if (!client) {
			throw new Error('[WS] イベント購読 (subscribe) を行う RPC クライアントが見つかりません。');
		}

		log.info(`[WS] イベント購読を開始します: ${query}`);
		const stream = client.subscribeTx(query); // subscribeTx はクエリを受け付ける

		// 購読を管理リストに追加 (解除のため)
		const subscription = stream.subscribe({
			next: (event) => {
				log.debug(`[WS Event] クエリ "${query}" でイベント受信`);
			},
			error: (err) => {
				log.error(`[WS Event] クエリ "${query}" のストリームでエラー:`, err);
				this.subscriptions.delete(query); // エラーが発生したらリストから削除
			},
			complete: () => {
				log.info(`[WS Event] クエリ "${query}" のストリームが完了しました。`);
				this.subscriptions.delete(query);
			},
		});

		this.subscriptions.set(query, subscription);
		return stream;
	}

	/**
	 * イベント購読を解除します。
	 * @param query 購読時に使用したクエリ
	 */
	public unsubscribe(query: string): void {
		const subscription = this.subscriptions.get(query);
		if (subscription) {
			log.info(`[WS] イベント購読を解除します: ${query}`);
			subscription.unsubscribe();
			this.subscriptions.delete(query);
		} else {
			log.warn(`[WS] 解除しようとした購読が見つかりません: ${query}`);
		}
	}
}