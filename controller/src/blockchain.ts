import { HdPath, stringToPath } from "@cosmjs/crypto";
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { chainConfig, getCreatorMnemonic, getRpcEndpoints } from './config';
import { customRegistry } from './registry';

type ChainName = keyof typeof chainConfig;

async function getWallet(chainName: ChainName, prefix: string) {
	const hdPathString = "m/44'/118'/0'/0/2";
	const hdPath: HdPath = stringToPath(hdPathString);

	const creatorMnemonic = await getCreatorMnemonic(chainName);

	return await DirectSecp256k1HdWallet.fromMnemonic(creatorMnemonic, {
		prefix,
		hdPaths: [hdPath]
	});
}

async function getSigningClient(chainName: ChainName) {
	const config = chainConfig[chainName];
	const wallet = await getWallet(chainName, config.prefix);

	const endpoints = await getRpcEndpoints();
	const endpoint = endpoints[chainName];
	if (!endpoint) {
		throw new Error(`RPC endpoint for chain "${chainName}" not found.`);
	}

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

	if (!account) {
		throw new Error('Failed to get account from wallet.');
	}

	const msg = {
		// ★★★ 修正箇所 ★★★
		typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk',
		value: {
			creator: account.address,
			index: chunkIndex,
			data: Buffer.from(chunkData),
		},
	};

	const fee = {
		amount: [{ denom: chainConfig[chainName].denom, amount: '30000' }],
		gas: '3000000',
	};

	const result = await client.signAndBroadcast(account.address, [msg], fee, 'Upload chunk');
	return result;
}
export async function uploadManifestToMetaChain(
	url: string,
	manifest: string,
) {
	const chainName = 'meta-0';
	const { client, wallet } = await getSigningClient(chainName);
	const [account] = await wallet.getAccounts();

	if (!account) {
		throw new Error('Failed to get account from wallet.');
	}

	const msg = {
		// ★★★ 修正箇所 ★★★
		typeUrl: '/metachain.metastore.v1.MsgCreateStoredManifest',
		value: {
			creator: account.address,
			url: url,
			manifest: manifest,
		},
	};

	const fee = {
		amount: [{ denom: chainConfig[chainName].denom, amount: '30000' }],
		gas: '3000000',
	};

	const result = await client.signAndBroadcast(account.address, [msg], fee, 'Upload manifest');
	return result;
}