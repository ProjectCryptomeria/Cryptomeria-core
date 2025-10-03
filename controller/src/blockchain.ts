import { DirectSecp256k1HdWallet, makeCosmoshubPath } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { chainConfig, chainEndpoints, creatorMnemonic } from './config';

type ChainName = keyof typeof chainEndpoints;

/**
 * ニーモニックから署名可能なウォレットを取得する
 * @param prefix アドレスのプレフィックス (e.g., 'cosmos')
 */
async function getWallet(prefix: string) {
	// ★★★ 修正箇所1: HDパスの生成方法を修正 ★★★
	// entrypoint-chain.shの --account 2 に対応
	const hdPath = makeCosmoshubPath(2);

	return await DirectSecp256k1HdWallet.fromMnemonic(creatorMnemonic, {
		prefix,
		hdPaths: [hdPath]
	});
}

/**
 * 署名可能なクライアントを取得する
 * @param chainName 接続先のチェーン名
 */
async function getSigningClient(chainName: ChainName) {
	const config = chainConfig[chainName];
	const wallet = await getWallet(config.prefix);
	const client = await SigningStargateClient.connectWithSigner(
		chainEndpoints[chainName],
		wallet,
	);
	return { client, wallet };
}

/**
 * データチャンクをdatachainにアップロードする
 * @param chainName 'data-0' or 'data-1'
 * @param chunkIndex チャンクの一意なインデックス
 * @param chunkData チャンクのバイナリデータ
 * @returns トランザクションハッシュ
 */
export async function uploadChunkToDataChain(
	chainName: ChainName,
	chunkIndex: string,
	chunkData: Buffer,
) {
	const { client, wallet } = await getSigningClient(chainName);
	const [account] = await wallet.getAccounts();

	// ★★★ 修正箇所2: accountの存在チェックを追加 ★★★
	if (!account) {
		throw new Error('Failed to get account from wallet.');
	}

	// x/datastore/types/tx.protoで定義されたMsgCreateStoredChunkに対応
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

/**
 * マニフェストをmetachainにアップロードする
 * @param url サイトのURL
 * @param manifest マニフェストのJSON文字列
 * @returns トランザクションハッシュ
 */
export async function uploadManifestToMetaChain(
	url: string,
	manifest: string,
) {
	const chainName = 'meta-0';
	const { client, wallet } = await getSigningClient(chainName);
	const [account] = await wallet.getAccounts();

	// ★★★ 修正箇所3: accountの存在チェックを追加 ★★★
	if (!account) {
		throw new Error('Failed to get account from wallet.');
	}

	// x/metastore/types/tx.protoで定義されたMsgCreateManifestに対応
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