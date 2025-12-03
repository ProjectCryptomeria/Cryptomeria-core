// controller/src/strategies/communication/HttpCommunicationStrategy.ts
import { JsonRpcRequest, JsonRpcResponse } from '@cosmjs/json-rpc';
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
	private rpcClients = new Map<string, HttpBatchClient>();
	private restBaseUrls = new Map<string, string>();

	// ... (constructor, connect, disconnect, isConnected, sendRpcRequest, sendRestRequest, getRpcClient は変更なし) ...
	constructor() {
		log.debug('HttpCommunicationStrategy がインスタンス化されました。');
	}
	public async connect(endpoint: string): Promise<void> {
		if (!this.rpcClients.has(endpoint)) {
			log.debug(`[HTTP] RPCバッチクライアントを準備中: ${endpoint}`);
			const rpcBatchClient = new HttpBatchClient(endpoint);
			this.rpcClients.set(endpoint, rpcBatchClient);
		}
		if (!this.restBaseUrls.has(endpoint)) {
			log.debug(`[HTTP] REST API ベースURLを登録: ${endpoint}`);
			this.restBaseUrls.set(endpoint, endpoint);
		}
	}
	public async disconnect(): Promise<void> {
		log.debug('[HTTP] 通信クライアントをクリアします。');
		this.rpcClients.clear();
		this.restBaseUrls.clear();
	}
	public isConnected(): boolean {
		return this.rpcClients.size > 0 || this.restBaseUrls.size > 0;
	}
	public async sendRpcRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		log.warn('[HTTP] sendRpcRequest は直接サポートされていません。getRpcClient() を使用してください。');
		const client = this.rpcClients.values().next().value;
		if (!client) {
			throw new Error('[HTTP] RPCクライアントが初期化されていません。');
		}
		return client.execute(request);
	}
	public async sendRestRequest(path: string, params?: Record<string, any>): Promise<any> {
		const baseUrl = Array.from(this.restBaseUrls.keys()).find(url => path.startsWith(url));
		let fullUrl = baseUrl ? path : undefined;
		let searchParams = '';
		if (!fullUrl) {
			const matchingBaseUrl = Array.from(this.restBaseUrls.keys()).find(base => path.startsWith(base));
			fullUrl = path;
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
	public getRpcClient(endpoint: string): CometClient | HttpBatchClient | undefined {
		return this.rpcClients.get(endpoint);
	}

	/**
	 * HTTPはイベント購読をサポートしません。
	 * ★ 修正: シグネチャ変更
	 */
	public subscribe(endpoint: string, query: string): Stream<any> {
		throw new Error('HttpCommunicationStrategy はイベント購読 (subscribe) をサポートしていません。');
	}

	/**
	 * HTTPはイベント購読をサポートしません。
	 * ★ 修正: シグネチャ変更
	 */
	public unsubscribe(endpoint: string, query: string): void {
		// 何もしない
	}
}