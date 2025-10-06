import * as k8s from '@kubernetes/client-node';
import { V1Pod } from '@kubernetes/client-node';
import { K8S_NAMESPACE, NODE_PORT_API_START, NODE_PORT_RPC_START, SECRET_NAME } from '../config';

// ADDED: Type definitions for clarity and safety
export type ChainType = 'datachain' | 'metachain';

export interface ChainInfo {
	name: string;
	type: ChainType;
}

export type ChainEndpoints = { [key: string]: string };

// --- Caches ---
const mnemonicCache = new Map<string, string>();
let chainInfoCache: ChainInfo[] | null = null;
let apiEndpointsCache: ChainEndpoints | null = null;
let rpcEndpointsCache: ChainEndpoints | null = null;

const getK8sApi = () => {
	const kc = new k8s.KubeConfig();
	kc.loadFromDefault();
	return kc.makeApiClient(k8s.CoreV1Api);
};

/**
 * Kubernetes APIから実行中のPod情報を取得し、チェーンの構成情報を動的に生成する
 * 結果はキャッシュされ、2回目以降の呼び出しではキャッシュされた値を返す
 * @returns {Promise<ChainInfo[]>} チェーン情報の配列
 */
export async function getChainInfo(): Promise<ChainInfo[]> {
	if (chainInfoCache) {
		return chainInfoCache;
	}

	try {
		console.log(`🧐 Discovering chains in namespace "${K8S_NAMESPACE}"...`);
		const k8sApi = getK8sApi();
		// CHANGED: Correctly use labelSelector for filtering pods
		const res = await k8sApi.listNamespacedPod({
			namespace: K8S_NAMESPACE,
			labelSelector: 'app.kubernetes.io/component in (datachain, metachain)'
		});

		const pods = res.items; 
		if (pods.length === 0) {
			throw new Error('No chain pods found in the cluster. Is the application deployed?');
		}

		const info: ChainInfo[] = pods.map((pod: V1Pod) => {
			const name = pod.metadata?.labels?.['app.kubernetes.io/instance'];
			const type = pod.metadata?.labels?.['app.kubernetes.io/component'] as ChainType;
			if (!name) {
				console.warn(`Pod ${pod.metadata?.name} is missing the 'app.kubernetes.io/instance' label. Skipping.`);
				return null;
			}
			return { name, type };
		}).filter((item): item is ChainInfo => item !== null) // Type guard to filter out nulls
			.sort((a, b) => a.name.localeCompare(b.name)); // Sort for consistent ordering

		console.log('✅ Discovered chains:', info);
		chainInfoCache = info;
		return info;
	} catch (err) {
		console.error('🔥 Failed to discover chains from Kubernetes API.');
		if (err instanceof Error) {
			console.error('   Error:', err.message);
		} else {
			console.error('   Unknown error:', err);
		}
		process.exit(1);
	}
}

/**
 * Kubernetes Secretのキーからチェーン名の一覧を取得する (DEPRECATED: use getChainInfo)
 * @returns チェーン名の配列 (e.g., ['data-0', 'data-1', 'meta-0'])
 */
export async function getChainNamesFromSecret(): Promise<string[]> {
	const chainInfo = await getChainInfo();
	return chainInfo.map(c => c.name);
}

/**
 * Kubernetes Secretから指定されたチェーンのcreatorニーモニックを非同期で取得・デコードする
 * @param chainName ニーモニックを取得したいチェーン名 (e.g., 'data-0')
 * @returns デコードされたニーモニック
 */
export async function getCreatorMnemonic(chainName: string): Promise<string> {
	if (mnemonicCache.has(chainName)) {
		return mnemonicCache.get(chainName)!;
	}

	try {
		const k8sApi = getK8sApi();
		const MNEMONIC_KEY = `${chainName}.mnemonic`;

		console.log(`🤫 Fetching key "${MNEMONIC_KEY}" from secret "${SECRET_NAME}"...`);
		// CHANGED: Correct method signature for readNamespacedSecret
		const res = await k8sApi.readNamespacedSecret({
			name: SECRET_NAME,
			namespace: K8S_NAMESPACE
		});
		const secret = res;

		if (!secret.data || !secret.data[MNEMONIC_KEY]) {
			throw new Error(`Secret "${SECRET_NAME}" does not contain key "${MNEMONIC_KEY}".`);
		}

		const encodedMnemonic = secret.data[MNEMONIC_KEY];
		const decodedMnemonic = Buffer.from(encodedMnemonic, 'base64').toString('utf-8');

		if (!decodedMnemonic) {
			throw new Error(`Failed to decode mnemonic for key "${MNEMONIC_KEY}".`);
		}

		console.log(`✅ Successfully fetched and decoded mnemonic for "${chainName}".`);
		mnemonicCache.set(chainName, decodedMnemonic);
		return decodedMnemonic;

	} catch (err) {
		console.error(`🔥 Failed to get mnemonic for "${chainName}" from Kubernetes secret.`);
		if (err instanceof Error) {
			console.error('   Error:', err.message);
		} else {
			console.error('   Unknown error:', err);
		}
		process.exit(1);
	}
}

/**
 * 実行環境に応じて、各チェーンのRPCエンドポイントを動的に生成する
 * @returns チェーン名とRPCエンドポイントURLのマップ
 */
export async function getRpcEndpoints(): Promise<ChainEndpoints> {
	if (rpcEndpointsCache) {
		return rpcEndpointsCache;
	}

	const chainInfos = await getChainInfo();
	const endpoints: ChainEndpoints = {};
	const isLocal = process.env.NODE_ENV !== 'production';

	console.log(`🌐 Generating RPC endpoints in "${isLocal ? 'local-nodeport' : 'cluster'}" mode...`);

	chainInfos.forEach((chain, index) => {
		const chainName = chain.name;
		if (isLocal) {
			// ローカル開発モード: localhostのNodePortに接続
			endpoints[chainName] = `http://localhost:${NODE_PORT_RPC_START + index}`;
		} else {
			// クラスタ内実行モード: K8sの内部DNS名を使用
			const serviceName = `raidchain-chain-headless`;
			endpoints[chainName] = `http://raidchain-${chainName}-0.${serviceName}.${K8S_NAMESPACE}.svc.cluster.local:26657`;
		}
	});

	console.log('✅ RPC Endpoints generated:', endpoints);
	rpcEndpointsCache = endpoints;
	return endpoints;
}

/**
 * 実行環境に応じて、各チェーンのAPIエンドポイントを動的に生成する
 * @returns チェーン名とAPIエンドポイントURLのマップ
 */
export async function getApiEndpoints(): Promise<ChainEndpoints> {
	if (apiEndpointsCache) {
		return apiEndpointsCache;
	}

	const chainInfos = await getChainInfo();
	const endpoints: ChainEndpoints = {};
	const isLocal = process.env.NODE_ENV !== 'production';

	console.log(`🌐 Generating API endpoints in "${isLocal ? 'local-nodeport' : 'cluster'}" mode...`);

	chainInfos.forEach((chain, index) => {
		const chainName = chain.name;
		if (isLocal) {
			// ローカル開発モード: localhostのNodePortに接続
			endpoints[chainName] = `http://localhost:${NODE_PORT_API_START + index}`;
		} else {
			// クラスタ内実行モード: K8sの内部DNS名を使用
			const serviceName = `raidchain-chain-headless`;
			endpoints[chainName] = `http://raidchain-${chainName}-0.${serviceName}.${K8S_NAMESPACE}.svc.cluster.local:1317`;
		}
	});

	console.log('✅ API Endpoints generated:', endpoints);
	apiEndpointsCache = endpoints;
	return endpoints;
}