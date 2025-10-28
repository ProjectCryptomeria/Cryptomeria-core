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
import { sleep, withRetry } from '../../utils/retry';
import { ICommunicationStrategy } from './ICommunicationStrategy';

// 接続リトライオプション
const CONNECT_RETRIES = 5;
const CONNECT_RETRY_DELAY_MS = 2000;

/**
 * WebSocket を使用する通信戦略。
 * 永続的な接続を維持し、RPCリクエストとイベント購読をサポートします。
 */
export class WebSocketCommunicationStrategy implements ICommunicationStrategy {
	// エンドポイントURL -> WebsocketClient インスタンス
	private wsClients = new Map<string, WebsocketClient>();
	// エンドポイントURL -> Tendermint37Client インスタンス
	private rpcClients = new Map<string, Comet38Client>();
	// 購読クエリ -> Subscription インスタンス
	private subscriptions = new Map<string, Subscription>();

	private isConnectedFlag = false;

	constructor() {
		log.debug('WebSocketCommunicationStrategy がインスタンス化されました。');
	}

	/**
	 * 指定されたWebSocketエンドポイントに接続します。
	 * @param endpoint 接続先エンドポイントURL (例: 'ws://localhost:26657/websocket')
	 */
	public async connect(endpoint: string): Promise<void> {
		if (this.rpcClients.has(endpoint)) {
			log.debug(`[WS] エンドポイント ${endpoint} は既に接続済み（または接続試行済み）です。`);
			return;
		}

		log.debug(`[WS] エンドポイント ${endpoint} への接続を開始します...`);

		try {
			// リトライ付きで接続を試行
			const wsClient = await withRetry(
				() => this.attemptWsConnect(endpoint),
				{
					retries: CONNECT_RETRIES,
					minTimeout: CONNECT_RETRY_DELAY_MS,
					onRetry: (error, attempt) => {
						log.warn(`[WS] 接続失敗 (試行 ${attempt}/${CONNECT_RETRIES})。リトライします...: ${error.message}`);
					},
				}
			);

			// Tendermint クライアントを作成
			const tmClient = Comet38Client.create(wsClient);

			this.wsClients.set(endpoint, wsClient);
			this.rpcClients.set(endpoint, tmClient);
			this.isConnectedFlag = true;
			log.info(`[WS] エンドポイント ${endpoint} への接続が確立しました。`);

		} catch (error: any) {
			log.error(`[WS] エンドポイント ${endpoint} への接続に最終的に失敗しました。`, error);
			throw new Error(`WebSocket 接続失敗 (Endpoint: ${endpoint}): ${error.message}`);
		}
	}

	/**
	 * WebsocketClient の接続試行（1回分）
	 */
	private attemptWsConnect(endpoint: string): Promise<WebsocketClient> {
		return new Promise((resolve, reject) => {
			const wsClient = new WebsocketClient(endpoint, (error: Error) => {
				// エラーハンドラ (接続失敗時に呼び出される)
				log.warn(`[WS] 接続エラー (Endpoint: ${endpoint}): ${error.message}`);
				reject(error); // withRetry がキャッチする
			});

			// 接続成功時のハンドラがないため、
			// 接続が確立したか（または失敗したか）をポーリングする必要がある
			const checkConnection = async () => {
				// WebsocketClient には 'connected' イベントがないため、
				// TendermintClient.create が成功するかどうかで判断する
				// ...が、TendermintClient.create は wsClient を引数に取るだけ

				// 代わりに、WebsocketClient の内部状態 (socket) を確認する (非推奨だが他に手段がない)
				// @ts-ignore (private プロパティ 'socket' へのアクセス)
				if (wsClient.socket && wsClient.socket.readyState === WebSocket.OPEN) {
					resolve(wsClient);
					// @ts-ignore
				} else if (wsClient.socket && wsClient.socket.readyState > WebSocket.OPEN) {
					reject(new Error('WebSocket 接続が確立前に閉じられました。'));
				} else {
					// まだ接続中
					await sleep(100); // 少し待機
					if (this.rpcClients.has(endpoint)) {
						// 別の非同期処理で既に接続完了していた場合
						resolve(this.wsClients.get(endpoint)!);
					} else {
						// 再度チェック (ただし、これだとタイムアウトがない)
						// -> WebsocketClient がコンストラクタでエラーハンドラを呼ぶことを期待する
					}
				}
			};

			// Note: WebsocketClient はコンストラクタ内で即座に接続を開始し、
			// 失敗した場合はエラーハンドラを呼び出す設計になっている。
			// 成功した場合に resolve する明確なトリガーがない。
			// ここでは、エラーハンドラが呼ばれなければ成功したとみなし、
			// Tendermint37Client.create (次のステップ) に任せる。
			// withRetry が機能するためには、コンストラクタがエラーを throw するか、
			// エラーハンドラ経由で reject が呼ばれる必要がある。

			// -> シンプル化: エラーハンドラで reject し、成功時は Tendermint37Client.create に進ませる
			//    ただし、Tendermint37Client.create が失敗した場合もリトライさせたい

			// -> `WebsocketClient` のコンストラクタはエラーをスローしない。
			//    `Tendermint37Client.create(wsClient)` が `wsClient.connected` プロミスを待つ。
			//    `wsClient.connected` が reject された場合、`create` がエラーをスローする。

			// -> `withRetry` の対象を `Tendermint37Client.create` に変更する方が適切

			// -> いや、ICommunicationStrategy の connect は TendermintClient を返さない。
			//    このメソッド内でクライアントを作成し、保持する必要がある。

			// -> 再考: wsClient.connected プロミスを直接待つ
			const healthCheckQuery:JsonRpcRequest = { 
				jsonrpc: "2.0", 
				method: "status", 
				id: `connect-${Date.now()}`, 
				params: {} 
			};
			wsClient.execute(healthCheckQuery).then(
				() => {
					log.debug(`[WS] WebsocketClient 接続成功 (Endpoint: ${endpoint})`);
					resolve(wsClient);
				},
				(error) => {
					// エラーハンドラ (上記) が既に reject しているはずだが、念のため
					log.warn(`[WS] wsClient.connected プロミスが reject されました: ${error.message}`);
					reject(error);
				}
			);

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