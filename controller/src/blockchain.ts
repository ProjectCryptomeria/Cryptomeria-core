import { HdPath, stringToPath } from "@cosmjs/crypto";
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { getChainConfig } from './config';
import { getCreatorMnemonic, getRpcEndpoints } from './lib/k8s-client';
import { customRegistry } from './registry';

type ChainName = string;

async function getWallet(chainName: ChainName) {
	const chainConfigs = await getChainConfig();
	const config = chainConfigs[chainName];
	if (!config) throw new Error(`Configuration for chain "${chainName}" not found.`);

	const hdPathString = "m/44'/118'/0'/0/2";
	const hdPath: HdPath = stringToPath(hdPathString);

	const creatorMnemonic = await getCreatorMnemonic(chainName);

	return await DirectSecp256k1HdWallet.fromMnemonic(creatorMnemonic, {
		prefix: config.prefix,
		hdPaths: [hdPath]
	});
}

async function getSigningClient(chainName: ChainName) {
	const chainConfigs = await getChainConfig();
	const config = chainConfigs[chainName];
	if (!config) throw new Error(`Configuration for chain "${chainName}" not found.`);

	const wallet = await getWallet(chainName);

	const endpoints = await getRpcEndpoints(); // This is now an async function
	const endpoint = endpoints[chainName];
	if (!endpoint) {
		throw new Error(`RPC endpoint for chain "${chainName}" not found.`);
	}
	// console.log(customRegistry);
	
	const client = await SigningStargateClient.connectWithSigner(endpoint, wallet, {
		registry: customRegistry,
	});
	return { client, wallet };
}

export async function uploadChunkToDataChain(
	chainName: ChainName,
	chunkIndex: string,
	chunkData: Buffer,
) {
	const { client, wallet } = await getSigningClient(chainName);
	const [account] = await wallet.getAccounts();
	const chainConfigs = await getChainConfig();
	const config = chainConfigs[chainName];

	if (!account) {
		throw new Error('Failed to get account from wallet.');
	}
	if (!config) {
		throw new Error(`Configuration for chain "${chainName}" not found.`);
	}

	const msg = {
		typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk',
		value: {
			creator: account.address,
			index: chunkIndex,
			data: Buffer.from(chunkData),
		},
	};

	const fee = {
		amount: [{ denom: config.denom, amount: '300000' }],
		gas: '30000000',
	};

	const result = await client.signAndBroadcast(account.address, [msg], fee, 'Upload chunk');
	return result;
}

export async function uploadManifestToMetaChain(
	chainName: ChainName, // ADDED: chainName parameter for consistency
	url: string,
	manifest: string,
) {
	const { client, wallet } = await getSigningClient(chainName);
	const [account] = await wallet.getAccounts();
	const chainConfigs = await getChainConfig();
	const config = chainConfigs[chainName];


	if (!account) {
		throw new Error('Failed to get account from wallet.');
	}
	if (!config) {
		throw new Error(`Configuration for chain "${chainName}" not found.`);
	}

	const msg = {
		typeUrl: '/metachain.metastore.v1.MsgCreateStoredManifest',
		value: {
			creator: account.address,
			url: url,
			manifest: manifest,
		},
	};

	const fee = {
		amount: [{ denom: config.denom, amount: '300000' }],
		gas: '30000000',
	};

	const result = await client.signAndBroadcast(account.address, [msg], fee, 'Upload manifest');
	return result;
}