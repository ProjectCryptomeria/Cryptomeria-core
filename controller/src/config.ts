import { InfrastructureService } from './services/infrastructure.service';

export const K8S_NAMESPACE = 'raidchain';
export const SECRET_NAME = 'raidchain-mnemonics';
export const NODE_PORT_RPC_START = 30057;
export const NODE_PORT_API_START = 30067;
export const CHUNK_SIZE = 16 * 1024; // 16 KB

interface ChainConfig {
	chainId: string;
	prefix: string;
	denom: string;
	gasPrice: string; // ★★★ amountとgasを削除し、これに変更 ★★★
}

// 動的に生成されるチェーン設定を保持するための変数
let chainConfigCache: { [key: string]: ChainConfig } | null = null;

/**
 * Kubernetesクラスターからチェーン情報を取得し、設定オブジェクトを生成します。
 * 結果はキャッシュされ、2回目以降の呼び出しではキャッシュされた値を返します。
 */
export async function getChainConfig() {
	if (chainConfigCache) {
		return chainConfigCache;
	}

	const infraService = new InfrastructureService();
	const chainInfos = await infraService.getChainInfo();

	const config: { [key: string]: ChainConfig } = {};

	for (const info of chainInfos) {
		config[info.name] = {
			chainId: info.name,
			prefix: 'cosmos',
			denom: 'uatom',
			gasPrice: '0.001', // ★★★ amountとgasを削除し、これに変更 ★★★
		};
	}

	chainConfigCache = config;
	return config;
}