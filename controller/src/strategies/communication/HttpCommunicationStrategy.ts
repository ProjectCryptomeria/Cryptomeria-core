// controller/src/strategies/communication/HttpCommunicationStrategy.ts
import { JsonRpcRequest, JsonRpcResponse } from '@cosmjs/json-rpc';
// ★ 修正: HttpClient は HttpBatchClient が内部で利用するため、明示的なインポートは不要
import { CometClient, HttpBatchClient } from '@cosmjs/tendermint-rpc';
import { Stream } from 'xstream';
import { log } from '../../utils/logger';
import { ICommunicationStrategy } from './ICommunicationStrategy';

declare const fetch: (url: RequestInfo, init?: RequestInit) => Promise<Response>;

/**
 * HTTP/REST および JSON-RPC (HTTP POST) を使用する通信戦略。
 * WebSocket イベント購読はサポートしません。
 */
export class HttpCommunicationStrategy implements ICommunicationStrategy {
	private rpcClients = new Map<string, HttpBatchClient>(); // エンドポイントごとのRPCバッチクライアント
	private restBaseUrls = new Map<string, string>(); // エンドポイントごとのRESTベースURL (API用)
	// ★ 修正: httpClients プロパティは不要なため削除
	// private httpClients = new Map<string, HttpClient>();

	constructor() {
		log.debug('HttpCommunicationStrategy がインスタンス化されました。');
	}

	/**
	 * HTTPクライアントを準備します (実際の接続はリクエスト時に行われる)。
	 * @param endpoint エンドポイントURL (RPC または API)。RPC/API 両方で使うため、ベースURLを登録する。
	 */
	public async connect(endpoint: string): Promise<void> {

		// RPC エンドポイント (例: http://localhost:26657)
		// REST API エンドポイント (例: http://localhost:1317)

		if (!this.rpcClients.has(endpoint)) {
			log.debug(`[HTTP] RPCバッチクライアントを準備中: ${endpoint}`);

			// ★ 修正: HttpClient のインスタンス化を削除
			// const httpClient = new HttpClient(endpoint);

			// ★ 修正: HttpBatchClient のコンストラクタには endpoint (string) を直接渡す
			const rpcBatchClient = new HttpBatchClient(endpoint);

			// ★ 修正: httpClients へのセットを削除
			// this.httpClients.set(endpoint, httpClient);
			this.rpcClients.set(endpoint, rpcBatchClient);
		}

		// REST API のベースURLも登録
		if (!this.restBaseUrls.has(endpoint)) {
			log.debug(`[HTTP] REST API ベースURLを登録: ${endpoint}`);
			this.restBaseUrls.set(endpoint, endpoint);
		}
	}

	/**
	 * HTTPはステートレスなため、切断処理は不要です。クライアントインスタンスをクリアします。
	 */
	public async disconnect(): Promise<void> {
		log.debug('[HTTP] 通信クライアントをクリアします。');
		this.rpcClients.clear();
		// ★ 修正: httpClients のクリアを削除
		// this.httpClients.clear();
		this.restBaseUrls.clear();
	}

	public isConnected(): boolean {
		// HTTPは常時接続ではないため、クライアントが準備されていれば true とする
		return this.rpcClients.size > 0 || this.restBaseUrls.size > 0;
	}

	/**
	 * JSON-RPC リクエストを送信します (バッチ処理)。
	 */
	public async sendRpcRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		log.warn('[HTTP] sendRpcRequest は直接サポートされていません。getRpcClient() を使用してください。');
		// 仮に最初のエンドポイントで実行
		const client = this.rpcClients.values().next().value;
		if (!client) {
			throw new Error('[HTTP] RPCクライアントが初期化されていません。');
		}
		return client.execute(request);
	}

	/**
	 * REST API リクエストを送信します (fetch を使用)。
	 */
	public async sendRestRequest(path: string, params?: Record<string, any>): Promise<any> {
		// どのベースURLを使うか？ -> path にホスト名が含まれていない
		// HttpDownloadStrategy が connect() で API エンドポイントを登録することを期待

		// path から適切なベースURLを探す (非効率)
		const baseUrl = Array.from(this.restBaseUrls.keys()).find(url => path.startsWith(url));
		let fullUrl = baseUrl ? path : undefined; // path が既にフルURLの場合
		let searchParams = '';

		if (!fullUrl) {
			// path が /cosmos/... のような相対パスの場合、最初に見つかった API ベースURL を使う (危険)
			// -> HttpDownloadStrategy 側でフルパス (http://.../cosmos/...) を渡すように修正したため、
			//    ここでは登録されているベースURLから適切なものを探す

			const matchingBaseUrl = Array.from(this.restBaseUrls.keys()).find(base => path.startsWith(base));

			if (matchingBaseUrl) {
				// path は既にフルパスだった
				fullUrl = path;
			} else {
				// path が相対パス (/cosmos/...) だった場合
				// どのベースURLを使うか特定できない。
				// HttpDownloadStrategy がフルパスを渡す前提に変更したため、
				// ここでベースURLを付与するロジックは削除する。

				// throw new Error(`[HTTP] REST API のベースURLが設定されていません (Path: ${path})。connect() で API エンドポイントを登録してください。`);

				// Note: HttpDownloadStrategy 側で ${metachainApiUrl}${manifestPath} として
				// フルのURLを渡すように実装したため、このロジックはフルURLを前提とする。
				fullUrl = path;
			}
		}

		if (params) {
			searchParams = '?' + new URLSearchParams(params).toString();
		}

		log.debug(`[HTTP] RESTリクエスト送信: ${fullUrl}${searchParams}`);

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
			log.error(`[HTTP] RESTリクエスト失敗 (${fullUrl}):`, error);
			throw error;
		}
	}

	/**
	 * 接続済みの Tendermint RPC クライアント (HttpBatchClient) を取得します。
	 */
	public getRpcClient(endpoint: string): CometClient | HttpBatchClient | undefined {
		return this.rpcClients.get(endpoint);
	}

	/**
	 * HTTPはイベント購読をサポートしません。
	 */
	public subscribe(query: string): Stream<any> {
		throw new Error('HttpCommunicationStrategy はイベント購読 (subscribe) をサポートしていません。');
	}

	/**
	 * HTTPはイベント購読をサポートしません。
	 */
	public unsubscribe(query: string): void {
		// 何もしない
	}
}