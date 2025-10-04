import { NODE_PORT_API_START } from './config';
import { ChainInfo, getChainInfo } from './k8s-client';

type ChainName = string;
type QueryResponse = { [key: string]: any };

let endpointsCache: { [key: string]: string } | null = null;

async function getRestEndpoints(): Promise<Record<string, string>> {
	if (endpointsCache) {
		return endpointsCache;
	}

	const chainInfos: ChainInfo[] = await getChainInfo();
	const endpoints: Record<string, string> = {};
	const isLocal = process.env.NODE_ENV !== 'production';

	console.log(`🌐 Generating REST API endpoints in "${isLocal ? 'local-nodeport' : 'cluster'}" mode...`);

	chainInfos.forEach((chain, index) => {
		const chainName = chain.name;
		if (isLocal) {
			const apiNodePort = NODE_PORT_API_START + index;
			endpoints[chainName] = `http://localhost:${apiNodePort}`;
		} else {
			const serviceName = `raidchain-chain-headless`;
			const podName = `raidchain-${chainName}-0`;
			endpoints[chainName] = `http://${podName}.${serviceName}.raidchain.svc.cluster.local:1317`;
		}
	});

	console.log('✅ REST Endpoints generated:', endpoints);
	endpointsCache = endpoints;
	return endpoints;
}

export async function queryStoredChunk(chainName: string, index: string): Promise<QueryResponse> {
	const endpoints = await getRestEndpoints();
	const restEndpoint = endpoints[chainName];
	if (!restEndpoint) {
		throw new Error(`REST endpoint not found for chain: ${chainName}`);
	}
	const url = `${restEndpoint}/bluzelle/curium/storage/stored_chunk/${index}`;

	console.log(`  🔍 Querying: ${url}`);
	const response = await fetch(url);
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Failed to query stored chunk from ${url}: ${response.statusText} (${response.status}) - ${errorBody}`);
	}
	return await response.json();
}

export async function queryStoredManifest(chainName: string, url: string): Promise<QueryResponse> {
	const endpoints = await getRestEndpoints();
	const restEndpoint = endpoints[chainName];
	if (!restEndpoint) {
		throw new Error(`REST endpoint not found for chain: ${chainName}`);
	}
	const queryUrl = `${restEndpoint}/bluzelle/curium/storage/manifest/${encodeURIComponent(url)}`;

	console.log(`  🔍 Querying: ${queryUrl}`);
	const response = await fetch(queryUrl);
	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Failed to query manifest from ${queryUrl}: ${response.statusText} (${response.status}) - ${errorBody}`);
	}
	return await response.json();
}