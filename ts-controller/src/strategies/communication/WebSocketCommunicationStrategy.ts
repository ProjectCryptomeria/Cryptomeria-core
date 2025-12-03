// controller/src/strategies/communication/WebSocketCommunicationStrategy.ts
import { JsonRpcRequest, JsonRpcResponse, JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import {
	Comet38Client,
	CometClient,
	HttpBatchClient,
	WebsocketClient
} from '@cosmjs/tendermint-rpc';
import { Stream, Subscription } from 'xstream';
import { log } from '../../utils/logger';
import { withRetry } from '../../utils/retry';
import { ICommunicationStrategy } from './ICommunicationStrategy';

const CONNECT_RETRIES = 5;
const CONNECT_RETRY_DELAY_MS = 2000;
const HEALTH_CHECK_TIMEOUT_MS = 5000;

/**
 * WebSocket を使用する通信戦略。
 */
export class WebSocketCommunicationStrategy implements ICommunicationStrategy {
	private wsClients = new Map<string, WebsocketClient>();
	private rpcClients = new Map<string, Comet38Client>();
	// ★ 修正: サブスクリプション管理をエンドポイントごと、クエリごとに変更
	private subscriptions = new Map<string, Map<string, Subscription>>(); // Map<endpoint, Map<query, Subscription>>
	private isConnectedFlag = false;

	constructor() {
		log.debug('WebSocketCommunicationStrategy がインスタンス化されました。');
	}

	// ... (connect, attemptWsConnect は変更なし) ...
	public async connect(endpoint: string): Promise<void> {
		if (this.rpcClients.has(endpoint)) {
			log.debug(`[WS] エンドポイント ${endpoint} は既に接続済みです。`);
			return;
		}
		log.debug(`[WS] エンドポイント ${endpoint} への接続を開始します...`);
		try {
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
			const tmClient = Comet38Client.create(wsClient);
			this.wsClients.set(endpoint, wsClient);
			this.rpcClients.set(endpoint, tmClient);
			this.isConnectedFlag = true;
			log.success(`[WS] エンドポイント ${endpoint} への接続が確立し、ヘルスチェックも成功しました。`);
		} catch (error: any) {
			log.error(`[WS] エンドポイント ${endpoint} への接続に最終的に失敗しました。`, error);
			const wsClient = this.wsClients.get(endpoint);
			if (wsClient) {
				try { wsClient.disconnect(); } catch { }
				this.wsClients.delete(endpoint);
			}
			this.rpcClients.delete(endpoint);
			throw new Error(`WebSocket 接続失敗 (Endpoint: ${endpoint}): ${error.message}`);
		}
	}
	private attemptWsConnect(endpoint: string): Promise<WebsocketClient> {
		return new Promise(async (resolve, reject) => {
			let wsClient: WebsocketClient | null = null;
			let healthCheckTimer: NodeJS.Timeout | null = null;
			const rejectOnTimeout = () => {
				if (wsClient) {
					try { wsClient.disconnect(); } catch { }
				}
				reject(new Error(`WebSocket ヘルスチェックタイムアウト (${HEALTH_CHECK_TIMEOUT_MS}ms)`));
			};
			try {
				wsClient = new WebsocketClient(endpoint, (error: Error) => {
					log.warn(`[WS] 接続エラーハンドラ (Endpoint: ${endpoint}): ${error.message}`);
					if (healthCheckTimer) clearTimeout(healthCheckTimer);
					reject(error);
				});
				healthCheckTimer = setTimeout(rejectOnTimeout, HEALTH_CHECK_TIMEOUT_MS);
				await wsClient.connected;
				log.debug(`[WS] WebsocketClient 接続完了 (Endpoint: ${endpoint})。ヘルスチェックを実行中...`);
				const healthCheckQuery: JsonRpcRequest = {
					jsonrpc: "2.0",
					method: "status",
					id: `healthcheck-${Date.now()}`,
					params: {}
				};
				await wsClient.execute(healthCheckQuery);
				log.debug(`[WS] ヘルスチェック成功 (Endpoint: ${endpoint})`);
				if (healthCheckTimer) clearTimeout(healthCheckTimer);
				resolve(wsClient);
			} catch (error) {
				log.warn(`[WS] attemptWsConnect 中にエラーが発生しました:`, error);
				if (healthCheckTimer) clearTimeout(healthCheckTimer);
				if (wsClient) {
					try { wsClient.disconnect(); } catch { }
				}
				reject(error);
			}
		});
	}

	/**
	 * すべての WebSocket 接続を切断します。
	 * ★ 修正: 階層化されたサブスクリプションマップをクリア
	 */
	public async disconnect(): Promise<void> {
		log.debug('[WS] すべての WebSocket 接続を切断します...');
		// すべての購読を解除
		for (const [endpoint, endpointSubscriptions] of this.subscriptions.entries()) {
			for (const [query, subscription] of endpointSubscriptions.entries()) {
				try {
					subscription.unsubscribe();
					log.debug(`[WS] 購読を解除しました (Endpoint: ${endpoint}, Query: ${query})`);
				} catch (e) {
					log.warn(`[WS] 購読解除中にエラー (Endpoint: ${endpoint}, Query: ${query}):`, e);
				}
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

		this.rpcClients.clear();
		this.wsClients.clear();
		this.isConnectedFlag = false;
	}

	// ... (isConnected, sendRpcRequest, sendRestRequest, getRpcClient は変更なし) ...
	public isConnected(): boolean {
		return this.isConnectedFlag && this.rpcClients.size > 0;
	}
	public async sendRpcRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		log.warn('[WS] sendRpcRequest は直接サポートされていません。getRpcClient() を使用してください。');
		const client = this.rpcClients.values().next().value;
		if (!client) {
			throw new Error('[WS] RPCクライアントが初期化されていません。');
		}
		// @ts-ignore
		const response = await client.do(request.method, request.params);
		return {
			jsonrpc: "2.0",
			id: request.id,
			result: response,
		} as JsonRpcSuccessResponse;
	}
	public async sendRestRequest(path: string, params?: Record<string, any>): Promise<any> {
		log.warn('[WS] WebSocketCommunicationStrategy で REST API リクエスト (sendRestRequest) が呼び出されました。HttpCommunicationStrategy の使用を推奨します。');
		const fullUrl = path;
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
	public getRpcClient(endpoint: string): CometClient | HttpBatchClient | undefined {
		return this.rpcClients.get(endpoint);
	}

	/**
	 * Tendermint イベントストリームを購読します。
	 * ★ 修正: バグのあったロジックを修正し、endpoint 固有のクライアントを使用
	 * @param endpoint 購読対象のエンドポイント
	 * @param query イベントクエリ (例: "tm.event = 'Tx' AND ...")
	 */
	public subscribe(endpoint: string, query: string): Stream<any> {
		// ★ 修正: エンドポイント固有のクライアントを取得
		const client = this.rpcClients.get(endpoint);
		if (!client) {
			throw new Error(`[WS] イベント購読 (subscribe) を行う RPC クライアントが見つかりません (Endpoint: ${endpoint})。connect() が呼ばれましたか？`);
		}

		// ★ 修正: エンドポイント固有のサブスクリプションマップを取得
		if (!this.subscriptions.has(endpoint)) {
			this.subscriptions.set(endpoint, new Map<string, Subscription>());
		}
		const endpointSubscriptions = this.subscriptions.get(endpoint)!;

		// ★ 修正: 既存のサブスクリプションロジックを修正
		if (endpointSubscriptions.has(query)) {
			log.warn(`[WS] エンドポイント "${endpoint}" のクエリ "${query}" は既に購読済みです。\n(注: xstream の仕様上、既存ストリームの再利用は困難なため、新規に購読し直します。\n古いサブスクリプションが残らないよう、呼び出し側 (TxEventConfirmationStrategy) で\n適切に _cleanup (unsubscribe) を呼び出す必要があります)`);

			// 古いサブスクリプションを強制解除
			this.unsubscribe(endpoint, query);
		}

		log.info(`[WS] イベント購読を開始します (Endpoint: ${endpoint}, Query: ${query})`);
		const stream = client.subscribeTx(query);

		const subscription = stream.subscribe({
			next: (event) => {
				log.debug(`[WS Event @ ${endpoint}] クエリ "${query}" でイベント受信`);
			},
			error: (err) => {
				log.error(`[WS Event @ ${endpoint}] クエリ "${query}" のストリームでエラー:`, err);
				endpointSubscriptions.delete(query); // エラーが発生したらリストから削除
			},
			complete: () => {
				log.info(`[WS Event @ ${endpoint}] クエリ "${query}" のストリームが完了しました。`);
				endpointSubscriptions.delete(query);
			},
		});

		endpointSubscriptions.set(query, subscription);
		return stream;
	}

	/**
	 * イベント購読を解除します。
	 * ★ 修正: 階層化されたマップからサブスクリプションを削除
	 * @param endpoint 購読対象のエンドポイント
	 * @param query 購読時に使用したクエリ
	 */
	public unsubscribe(endpoint: string, query: string): void {
		const endpointSubscriptions = this.subscriptions.get(endpoint);
		if (!endpointSubscriptions) {
			log.warn(`[WS] 解除しようとしたエンドポイントが見つかりません: ${endpoint}`);
			return;
		}

		const subscription = endpointSubscriptions.get(query);
		if (subscription) {
			log.info(`[WS] イベント購読を解除します (Endpoint: ${endpoint}, Query: ${query})`);
			subscription.unsubscribe();
			endpointSubscriptions.delete(query);
		} else {
			log.warn(`[WS] 解除しようとした購読が見つかりません (Endpoint: ${endpoint}, Query: ${query})`);
		}
	}
}