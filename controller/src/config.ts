import {
	getChainEndpoints,
	getChainNamesFromSecret,
	getCreatorMnemonicFromSecret
} from './k8s-client';

// --- Kubernetes Configuration ---
export const K8S_NAMESPACE = 'raidchain';
export const SECRET_NAME = 'raidchain-mnemonics';


// --- Chain Configuration ---
// この情報は、どのチェーンがどのprefixやdenomを持つかという静的な対応付けに使います。
export const chainConfig = {
	'data-0': { chainId: 'data-0', prefix: 'cosmos', denom: 'uatom' },
	'data-1': { chainId: 'data-1', prefix: 'cosmos', denom: 'uatom' },
	'meta-0': { chainId: 'meta-0', prefix: 'cosmos', denom: 'uatom' },
};


// --- Dynamic Data from Kubernetes ---
export const getRpcEndpoints = getChainEndpoints;
export const getCreatorMnemonic = getCreatorMnemonicFromSecret;
export const getChainNames = getChainNamesFromSecret;


// --- File Chunk Configuration ---
export const CHUNK_SIZE = 16 * 1024;