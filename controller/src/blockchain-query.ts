// (★★★ このファイルは新しい内容で完全に置き換えてください ★★★)
import { NODE_PORT_API_START } from './config';

type ChainName = 'data-0' | 'data-1' | 'meta-0';
type QueryResponse = { [key: string]: any };

/**
 * 実行環境に応じて、各チェーンのREST APIエンドポイントURLを動的に生成する
 */
function getRestEndpoints(): { [key: string]: string } {
	const endpoints: { [key: string]: string } = {};
	const chainNames = ['data-0', 'data-1', 'meta-0'];
	const isLocal = process.env.EXECUTION_MODE === 'local';

	chainNames.forEach((chainName, index) => {
		if (isLocal) {
			// ローカル開発モード: 正しく公開されたAPI用NodePortに接続
			const apiNodePort = NODE_PORT_API_START + index;
			endpoints[chainName] = `http://host.docker.internal:${apiNodePort}`;
		} else {
			// クラスタ内実行モード: K8sの内部DNS名を使用
			const podName = `raidchain-${chainName}-0`;
			const serviceName = `raidchain-chain-headless`;
			endpoints[chainName] = `http://${podName}.${serviceName}.raidchain.svc.cluster.local:1317`;
		}
	});
	return endpoints;
}


/**
 * datachainから保存されたチャンクをクエリで取得する
 * @param chainName クエリ対象のdatachain名 ('data-0' | 'data-1')
 * @param index 取得したいチャンクのインデックス
 * @returns クエリ結果のJSONオブジェクト
 */
export async function queryStoredChunk(chainName: 'data-0' | 'data-1', index: string): Promise<QueryResponse> {
	const endpoints = getRestEndpoints();
	const restEndpoint = endpoints[chainName];
	// scaffoldで生成されたクエリパス
	const url = `${restEndpoint}/datachain/datastore/v1/stored_chunk/${index}`;

	console.log(`  🔍 Querying: ${url}`);
	const response = await fetch(url);
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Failed to query stored chunk from ${url}: ${response.statusText} (${response.status}) - ${errorBody}`);
	}
	return await response.json();
}

/**
 * metachainから保存されたマニフェストをクエリで取得する
 * @param url 取得したいマニフェストのURL
 * @returns クエリ結果のJSONオブジェクト
 */
export async function queryStoredManifest(url: string): Promise<QueryResponse> {
	const endpoints = getRestEndpoints();
	const restEndpoint = endpoints['meta-0'];
	// scaffoldで生成されたクエリパス
	const queryUrl = `${restEndpoint}/metachain/metastore/v1/stored_manifest/${encodeURIComponent(url)}`;

	console.log(`  🔍 Querying: ${queryUrl}`);
	const response = await fetch(queryUrl);
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Failed to query manifest from ${queryUrl}: ${response.statusText} (${response.status}) - ${errorBody}`);
	}
	return await response.json();
}