import {
	getChainEndpoints,
	getChainNamesFromSecret,
	getCreatorMnemonicFromSecret
} from './k8s-client';

// --- Kubernetes Configuration ---
export const K8S_NAMESPACE = 'raidchain';
export const SECRET_NAME = 'raidchain-mnemonics';
// ★★★ NodePortの開始ポート番号をvalues.yamlと合わせる ★★★
export const NODE_PORT_START = 30057;


// --- Chain Configuration ---
export const chainConfig = {
	'data-0': { chainId: 'data-0', prefix: 'cosmos', denom: 'uatom' },
	'data-1': { chainId: 'data-1', prefix: 'cosmos', denom: 'uatom' },
	'meta-0': { chainId: 'meta-0', prefix: 'cosmos', denom: 'uatom' },
};



export const getRpcEndpoints = getChainEndpoints(NODE_PORT_START);
export const getCreatorMnemonic = getCreatorMnemonicFromSecret;
export const getChainNames = getChainNamesFromSecret;


// --- File Chunk Configuration ---
export const CHUNK_SIZE = 16 * 1024;