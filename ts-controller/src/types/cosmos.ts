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
	creator: string;
	index: string;
	domain: string;
	manifest: string;
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
	stored_manifest: {
		index: string;
		domain: string;
		manifest: string;
		creator: string;
	};
}

// ★★★ 修正箇所 (ここから) ★★★

/**
 * チャンクの保存場所を示すタプル
 * 形式: [ チャンクインデックス (e.g., "hash-0"), chainMapインデックス (e.g., 0) ]
 */
export type ChunkLocationTuple = [string, number];

/**
 * マニフェストJSON文字列をパースした後のオブジェクト型 (圧縮形式)
 */
export interface Manifest {
	/**
	 * datachain名 と マッピング番号 の辞書
	 * (例: { "data-0": 0, "data-1": 1, "data-2": 2 })
	 */
	chainMap: { [chainName: string]: number };

	/**
	 * ファイルパスごとのチャンク情報
	 * (例: { "/index.html": [ ["idx1", 0], ["idx2", 1] ] })
	 */
	files: {
		[filePath: string]: ChunkLocationTuple[];
	};
}
// ★★★ 修正箇所 (ここまで) ★★★


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