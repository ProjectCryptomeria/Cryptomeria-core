import { getApiEndpoints } from './k8s-client'; // getApiEndpoints をインポート
import { log } from './logger';

// --- Type Definitions for API Responses ---

/**
 * datachainに保存されているチャンクデータの構造
 */
export interface StoredChunk {
	index: string;
	data: string; // base64 encoded string
}

/**
 * /datachain/datastore/v1/stored_chunk/{index} のレスポンス型
 */
export interface StoredChunkResponse {
	stored_chunk: StoredChunk;
}

/**
 * metachainに保存されているマニフェストデータの構造
 */
export interface StoredManifest {
	url: string;
	manifest: string; // JSON string of the Manifest interface
}

/**
 * /metachain/metastore/v1/stored_manifest/{url} のレスポンス型
 */
export interface StoredManifestResponse {
	stored_manifest: StoredManifest;
}


// --- Private Helper Functions ---

let endpointsCache: { [key: string]: string } | null = null;

async function getRestEndpoints(): Promise<Record<string, string>> {
	if (endpointsCache) {
		return endpointsCache;
	}

	// ★★★ ここから修正 ★★★
	// 古い静的なエンドポイント生成ロジックを削除し、
	// k8s-clientに実装された動的な関数を呼び出すように変更
	const endpoints = await getApiEndpoints();
	endpointsCache = endpoints;
	return endpoints;
	// ★★★ ここまで修正 ★★★
}

/**
 * A generic fetch wrapper for querying the blockchain REST API.
 * @param {string} url - The API endpoint to query.
 * @returns {Promise<T>} - A promise that resolves to the JSON response, typed as T.
 */
async function queryChainAPI<T>(url: string): Promise<T> {
	log.info(`  🔍 Querying: ${url}`);
	const response = await fetch(url);
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Failed to query from ${url}: ${response.statusText} (${response.status}) - ${errorBody}`);
	}
	return await response.json() as T;
}


// --- Public Query Functions ---

export async function queryStoredChunk(chainName: string, index: string): Promise<StoredChunkResponse> {
	const endpoints = await getRestEndpoints();
	const restEndpoint = endpoints[chainName];
	if (!restEndpoint) {
		throw new Error(`REST endpoint not found for chain: ${chainName}`);
	}
	const url = `${restEndpoint}/datachain/datastore/v1/stored_chunk/${index}`;
	return queryChainAPI<StoredChunkResponse>(url);
}

export async function queryStoredManifest(chainName: string, url: string): Promise<StoredManifestResponse> {
	const endpoints = await getRestEndpoints();
	const restEndpoint = endpoints[chainName];
	if (!restEndpoint) {
		throw new Error(`REST endpoint not found for chain: ${chainName}`);
	}
	const queryUrl = `${restEndpoint}/metachain/metastore/v1/stored_manifest/${encodeURIComponent(url)}`;
	return queryChainAPI<StoredManifestResponse>(queryUrl);
}