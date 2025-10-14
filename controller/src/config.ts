import { InfrastructureService } from './services/infrastructure.service';

export const K8S_NAMESPACE = 'raidchain';
export const SECRET_NAME = 'raidchain-mnemonics';
export const NODE_PORT_RPC_START = 30057;
export const NODE_PORT_API_START = 30067;
export const CHUNK_SIZE = 16 * 1024; // 16 KB

// 動的に生成されるチェーン設定を保持するための変数
let chainConfigCache: { [key: string]: { chainId: string; prefix: string; denom: string } } | null = null;

/**
 * Kubernetesクラスターからチェーン情報を取得し、設定オブジェクトを生成します。
 * 結果はキャッシュされ、2回目以降の呼び出しではキャッシュされた値を返します。
 */
export async function getChainConfig() {
	if (chainConfigCache) {
		return chainConfigCache;
	}

	// ★★★ ここから修正 ★★★
	// この関数内でInfrastructureServiceをインスタンス化し、
	// 依存を自己完結させる
	const infraService = new InfrastructureService();
	const chainInfos = await infraService.getChainInfo();
	// ★★★ ここまで修正 ★★★

	const config: { [key: string]: { chainId: string; prefix: string; denom: string } } = {};

	for (const info of chainInfos) {
		config[info.name] = {
			chainId: info.name,
			prefix: 'cosmos',
			denom: 'uatom'
		};
	}

	chainConfigCache = config;
	return config;
}