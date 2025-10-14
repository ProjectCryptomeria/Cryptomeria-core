import * as k8s from '@kubernetes/client-node';
import { V1Pod } from '@kubernetes/client-node';
import { K8S_NAMESPACE, SECRET_NAME } from '../config';
import { log } from '../lib/logger';

// --- Type Definitions ---
export type ChainType = 'datachain' | 'metachain';

export interface ChainInfo {
	name: string;
	type: ChainType;
}

export type ChainEndpoints = { [key: string]: string };


export class InfrastructureService {
	private k8sApi: k8s.CoreV1Api;
	private mnemonicCache = new Map<string, string>();
	private chainInfoCache: ChainInfo[] | null = null;
	private apiEndpointsCache: ChainEndpoints | null = null;
	private rpcEndpointsCache: ChainEndpoints | null = null;

	constructor() {
		const kc = new k8s.KubeConfig();
		kc.loadFromDefault();
		this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
	}

	public async getChainInfo(): Promise<ChainInfo[]> {
		if (this.chainInfoCache) {
			return this.chainInfoCache;
		}

		try {
			log.info(`Discovering chains in namespace "${K8S_NAMESPACE}"...`);
			const res = await this.k8sApi.listNamespacedPod({
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
			}).filter((item): item is ChainInfo => item !== null)
				.sort((a, b) => a.name.localeCompare(b.name));

			log.info(`Discovered chains: ${JSON.stringify(info, null, 2)}`);
			this.chainInfoCache = info;
			return info;
		} catch (err) {
			log.error('Failed to discover chains from Kubernetes API.');
			if (err instanceof Error) {
				log.error(`   Error: ${err.message}`);
			} else {
				log.error(`   Unknown error: ${err}`);
			}
			process.exit(1);
		}
	}

	public async getCreatorMnemonic(chainName: string): Promise<string> {
		if (this.mnemonicCache.has(chainName)) {
			return this.mnemonicCache.get(chainName)!;
		}

		try {
			const MNEMONIC_KEY = `${chainName}.mnemonic`;

			log.info(`Fetching key "${MNEMONIC_KEY}" from secret "${SECRET_NAME}"...`);
			const res = await this.k8sApi.readNamespacedSecret({
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

			log.info(`Successfully fetched and decoded mnemonic for "${chainName}".`);
			this.mnemonicCache.set(chainName, decodedMnemonic);
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

	public async getRpcEndpoints(): Promise<ChainEndpoints> {
		if (this.rpcEndpointsCache) {
			return this.rpcEndpointsCache;
		}

		const chainInfos = await this.getChainInfo();
		const endpoints: ChainEndpoints = {};
		const isLocal = process.env.NODE_ENV !== 'production';

		log.info(`Generating RPC endpoints in "${isLocal ? 'local-nodeport' : 'cluster'}" mode...`);

		if (isLocal) {
			const res = await this.k8sApi.listNamespacedService({
				namespace: K8S_NAMESPACE,
				labelSelector: "app.kubernetes.io/category=chain"
			});
			const services = res.items;
			for (const chain of chainInfos) {
				const serviceName = `raidchain-${chain.name}-headless`;
				const service = services.find(s => s.metadata?.name === serviceName);
				if (!service || !service.spec?.ports) throw new Error(`Service "${serviceName}" not found.`);

				const portInfo = service.spec.ports.find(p => p.name === 'rpc');
				if (!portInfo || !portInfo.nodePort) throw new Error(`RPC NodePort not found for service "${serviceName}".`);

				endpoints[chain.name] = `http://localhost:${portInfo.nodePort}`;
			}
		} else {
			for (const chain of chainInfos) {
				const serviceName = `raidchain-chain-headless`;
				endpoints[chain.name] = `http://raidchain-${chain.name}-0.${serviceName}.${K8S_NAMESPACE}.svc.cluster.local:26657`;
			}
		}

		log.info(`RPC Endpoints generated: ${JSON.stringify(endpoints, null, 2)}`);
		this.rpcEndpointsCache = endpoints;
		return endpoints;
	}

	public async getApiEndpoints(): Promise<ChainEndpoints> {
		if (this.apiEndpointsCache) {
			return this.apiEndpointsCache;
		}

		const chainInfos = await this.getChainInfo();
		const endpoints: ChainEndpoints = {};
		const isLocal = process.env.NODE_ENV !== 'production';

		log.info(`Generating API endpoints in "${isLocal ? 'local-nodeport' : 'cluster'}" mode...`);

		if (isLocal) {
			const res = await this.k8sApi.listNamespacedService({
				namespace: K8S_NAMESPACE,
				labelSelector: "app.kubernetes.io/category=chain"
			});
			const services = res.items;

			for (const chain of chainInfos) {
				const serviceName = `raidchain-${chain.name}-headless`;
				const service = services.find(s => s.metadata?.name === serviceName);
				if (!service || !service.spec?.ports) throw new Error(`Service "${serviceName}" not found.`);

				const portInfo = service.spec.ports.find(p => p.name === 'api');
				if (!portInfo || !portInfo.nodePort) throw new Error(`API NodePort not found for service "${serviceName}".`);

				endpoints[chain.name] = `http://localhost:${portInfo.nodePort}`;
			}
		} else {
			for (const chain of chainInfos) {
				const serviceName = `raidchain-chain-headless`;
				endpoints[chain.name] = `http://raidchain-${chain.name}-0.${serviceName}.${K8S_NAMESPACE}.svc.cluster.local:1317`;
			}
		}

		log.info(`API Endpoints generated: ${JSON.stringify(endpoints, null, 2)}`);
		this.apiEndpointsCache = endpoints;
		return endpoints;
	}
}