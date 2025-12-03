// controller/src/strategies/communication/ICommunicationStrategy.ts
import type { JsonRpcRequest, JsonRpcResponse } from '@cosmjs/json-rpc';
import { Stream } from 'xstream';
// ★ 修正: TendermintClient, HttpBatchClient をインポート
import { CometClient, HttpBatchClient } from '@cosmjs/tendermint-rpc';

/**
 * ブロックチェーンノードとの低レベルな通信方法（API呼び出し、イベント購読）を抽象化するインターフェース。
 */
export interface ICommunicationStrategy {
	/**
	 * 指定されたエンドポイントに接続します。
	 * (WebSocketでは接続を確立し、HTTPではHTTPクライアントを準備)
	 * @param endpoint 接続先エンドポイントURL (例: 'http://localhost:26657' or 'ws://localhost:26657/websocket')
	 */
	connect(endpoint: string): Promise<void>;

	/**
	 * 確立したすべての接続を切断します。
	 */
	disconnect(): Promise<void>; // ★ 修正: エンドポイント引数を削除

	/**
	 * いずれかの接続がアクティブか返します。
	 */
	isConnected(): boolean;

	/**
	 * JSON-RPC リクエストを送信します (主にRPCエンドポイント向け)。
	 */
	sendRpcRequest(request: JsonRpcRequest): Promise<JsonRpcResponse>;

	/**
	 * REST API リクエストを送信します (主にAPIエンドポイント向け)。
	 */
	sendRestRequest(path: string, params?: Record<string, any>): Promise<any>;

	/**
	 * ★ 修正: Tendermint RPC クライアントを取得するメソッドを追加
	 * 接続済みの Tendermint RPC クライアントを取得します。
	 * connect() が先に呼び出されている必要があります。
	 * @param endpoint 
	 */
	getRpcClient(endpoint: string): CometClient | HttpBatchClient | undefined;

	/**
	 * Tendermint イベントストリームを購読します (WebSocket戦略のみサポート)。
	 * ★ 修正: endpoint を引数に追加
	 */
	subscribe(endpoint: string, query: string): Stream<any>;

	/**
	 * イベント購読を解除します (WebSocket戦略のみサポート)。
	 * ★ 修正: endpoint を引数に追加
	 */
	unsubscribe(endpoint: string, query: string): void;
	
}