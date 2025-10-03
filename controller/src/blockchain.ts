import { DirectSecp256k1HdWallet, makeCosmoshubPath } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { chainConfig, getCreatorMnemonic, getRpcEndpoints } from './config';

type ChainName = keyof typeof chainConfig;

async function getWallet(chainName: ChainName, prefix: string) {
	const hdPath = makeCosmoshubPath(2);
	const creatorMnemonic = await getCreatorMnemonic(chainName);

	return await DirectSecp256k1HdWallet.fromMnemonic(creatorMnemonic, {
		prefix,
		hdPaths: [hdPath]
	});
}

async function getSigningClient(chainName: ChainName) {
	const config = chainConfig[chainName];
	const wallet = await getWallet(chainName, config.prefix);

	// ★★★ 修正箇所: エンドポイントを非同期で取得 ★★★
	const endpoints = await getRpcEndpoints();
	const endpoint = endpoints[chainName];
	if (!endpoint) {
		throw new Error(`RPC endpoint for chain "${chainName}" not found.`);
	}

	const client = await SigningStargateClient.connectWithSigner(endpoint, wallet);
	return { client, wallet };
}

// uploadChunkToDataChain と uploadManifestToMetaChain は変更なし
// (省略)
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
		typeUrl: '/raidchain.datastore.MsgCreateStoredChunk',
		value: {
			creator: account.address,
			index: chunkIndex,
			data: chunkData,
		},
	};

	const fee = {
		amount: [{ denom: chainConfig[chainName].denom, amount: '2000' }],
		gas: '200000',
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
		typeUrl: '/raidchain.metastore.MsgCreateManifest',
		value: {
			creator: account.address,
			url: url,
			manifest: manifest,
		},
	};

	const fee = {
		amount: [{ denom: chainConfig[chainName].denom, amount: '2000' }],
		gas: '200000',
	};

	const result = await client.signAndBroadcast(account.address, [msg], fee, 'Upload manifest');
	return result;
}