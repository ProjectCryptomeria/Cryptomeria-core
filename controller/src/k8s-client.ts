import * as k8s from '@kubernetes/client-node';
import { K8S_NAMESPACE, SECRET_NAME } from './config';

// --- Type Definitions ---
export type ChainEndpoints = { [key: string]: string };

// --- Caches ---
const mnemonicCache = new Map<string, string>();
let chainNamesCache: string[] | null = null;
let endpointsCache: ChainEndpoints | null = null;

const getK8sApi = () => {
	const kc = new k8s.KubeConfig();
	kc.loadFromDefault();
	return kc.makeApiClient(k8s.CoreV1Api);
};

/**
 * Kubernetes Secretから指定されたチェーンのcreatorニーモニックを非同期で取得・デコードする
 * @param chainName ニーモニックを取得したいチェーン名 (e.g., 'data-0')
 * @returns デコードされたニーモニック
 */
export async function getCreatorMnemonicFromSecret(chainName: string): Promise<string> {
	if (mnemonicCache.has(chainName)) {
		return mnemonicCache.get(chainName)!;
	}

	try {
		const k8sApi = getK8sApi();
		const MNEMONIC_KEY = `${chainName}.mnemonic`;

		console.log(`🤫 Fetching key "${MNEMONIC_KEY}" from secret "${SECRET_NAME}"...`);
		const secretRes = await k8sApi.readNamespacedSecret({
			name: SECRET_NAME,
			namespace: K8S_NAMESPACE
		});

		const secretData = secretRes.data;
		if (!secretData || !secretData[MNEMONIC_KEY]) {
			throw new Error(`Secret "${SECRET_NAME}" does not contain key "${MNEMONIC_KEY}".`);
		}

		const encodedMnemonic = secretData[MNEMONIC_KEY];
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
 * Kubernetes Secretのキーからチェーン名の一覧を取得する
 * @returns チェーン名の配列 (e.g., ['data-0', 'data-1', 'meta-0'])
 */
export async function getChainNamesFromSecret(): Promise<string[]> {
	if (chainNamesCache) {
		return chainNamesCache;
	}

	try {
		const k8sApi = getK8sApi();
		console.log(`🧐 Reading all keys from secret "${SECRET_NAME}" to get chain names...`);

		const secretRes = await k8sApi.readNamespacedSecret({
			name: SECRET_NAME,
			namespace: K8S_NAMESPACE
		});

		const secretData = secretRes.data;
		if (!secretData) {
			throw new Error(`Secret "${SECRET_NAME}" contains no data.`);
		}

		const chainNames = Object.keys(secretData).map(key => key.replace('.mnemonic', ''));

		console.log('✅ Found chain names:', chainNames);
		chainNamesCache = chainNames;
		return chainNames;

	} catch (err) {
		console.error('🔥 Failed to get chain names from Kubernetes secret.');
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
export function getChainEndpoints(node_port : number) {
	return async () => {
		const chainNames = await getChainNamesFromSecret();
		const endpoints: ChainEndpoints = {};

		const isLocal = process.env.EXECUTION_MODE === 'local';

		console.log(`🌐 Generating RPC endpoints in "${isLocal ? 'local-nodeport' : 'cluster'}" mode...`);

		chainNames.forEach((chainName, index) => {
			if (isLocal) {
				// ローカル開発モード: localhostのNodePortに接続
				endpoints[chainName] = `http://host.docker.internal:${node_port + index}`;
			} else {
				// クラスタ内実行モード: K8sの内部DNS名を使用
				const podName = `raidchain-${chainName}-0`;
				const serviceName = `raidchain-chain-headless`;
				endpoints[chainName] = `http://${podName}.${serviceName}.${K8S_NAMESPACE}.svc.cluster.local:26657`;
			}
		});
		console.log('✅ Endpoints generated:', endpoints);
		return endpoints;
	}
}