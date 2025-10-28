// controller/src/types/cosmos.ts

/**
 * datachain にチャンクデータを保存するためのメッセージ型
 * (datachain/x/datastore/types/tx.pb.go を参照)
 */
export interface MsgCreateStoredChunk {
	creator: string; // 送信者のアドレス
	index: string;   // チャンクの一意なインデックス (例: 'file-hash-0')
	data: Uint8Array; // チャンクのバイナリデータ
}

/**
 * metachain にマニフェスト情報を保存するためのメッセージ型
 * (metachain/x/metastore/types/tx.pb.go を参照)
 */
export interface MsgCreateStoredManifest {
	creator: string;  // 送信者のアドレス
	url: string;      // サイト/リソース群の一意なURL (例: 'my-site/')
	manifest: string; // ファイル構成情報 (JSON文字列)
}

/**
 * datachain からチャンクデータを取得する際のレスポンス型 (クエリ結果)
 * (datachain/x/datastore/types/query.pb.go StoredChunkResponse を参照)
 */
export interface StoredChunkResponse {
	stored_chunk: {
		index: string;
		data: string; // base64 encoded string
	};
}

/**
 * metachain からマニフェスト情報を取得する際のレスポンス型 (クエリ結果)
 * (metachain/x/metastore/types/query.pb.go ManifestResponse を参照)
 */
export interface StoredManifestResponse {
	manifest: {
		url: string;
		manifest: string; // JSON string of the Manifest interface
	};
}

/**
 * マニフェストJSON文字列をパースした後のオブジェクト型
 * (要件定義書 3.3. データ要件 metachain 構造を参照)
 */
export interface Manifest {
	[filePath: string]: string[]; // 例: { "/index.html": ["idx1", "idx2"], "/style.css": ["idx3"] }
}

/**
 * InfrastructureServiceが返すチェーン情報の型
 */
export type ChainType = 'datachain' | 'metachain';

export interface ChainInfo {
	name: string; // チェーン名 (例: 'data-0', 'meta-0')
	type: ChainType; // チェーンの種類
}

/**
 * チェーン名とエンドポイントURLのマッピング型
 */
export type ChainEndpoints = { [chainName: string]: string };