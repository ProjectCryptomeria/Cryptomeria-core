import { HdPath, stringToPath } from "@cosmjs/crypto";
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { calculateFee, DeliverTxResponse, GasPrice, SigningStargateClient } from '@cosmjs/stargate';
import { getChainConfig } from '../config';
import { log } from '../lib/logger';
import { customRegistry } from '../registry';
import { InfrastructureService } from './infrastructure.service';

// --- Type Definitions for API Responses ---
export interface StoredChunk {
	index: string;
	data: string; // base64 encoded string
}
export interface StoredChunkResponse {
	stored_chunk: StoredChunk;
}
export interface StoredManifest {
	url: string;
	manifest: string; // JSON string of the Manifest interface
}
export interface StoredManifestResponse {
	stored_manifest: StoredManifest;
}


export class BlockchainService {
	private infraService: InfrastructureService;

	constructor(infraService: InfrastructureService) {
		this.infraService = infraService;
	}

	private async getWallet(chainName: string): Promise<DirectSecp256k1HdWallet> {
		const chainConfigs = await getChainConfig();
		const config = chainConfigs[chainName];
		if (!config) throw new Error(`Configuration for chain "${chainName}" not found.`);

		const hdPathString = "m/44'/118'/0'/0/2";
		const hdPath: HdPath = stringToPath(hdPathString);

		const creatorMnemonic = await this.infraService.getCreatorMnemonic(chainName);

		return await DirectSecp256k1HdWallet.fromMnemonic(creatorMnemonic, {
			prefix: config.prefix,
			hdPaths: [hdPath]
		});
	}

	private async getSigningClient(chainName: string): Promise<{ client: SigningStargateClient; wallet: DirectSecp256k1HdWallet }> {
		const chainConfigs = await getChainConfig();
		const config = chainConfigs[chainName];
		if (!config) throw new Error(`Configuration for chain "${chainName}" not found.`);

		const wallet = await this.getWallet(chainName);

		const endpoints = await this.infraService.getRpcEndpoints();
		const endpoint = endpoints[chainName];
		if (!endpoint) {
			throw new Error(`RPC endpoint for chain "${chainName}" not found.`);
		}
		const gasPrice = GasPrice.fromString(`${config.gasPrice}${config.denom}`);

		const client = await SigningStargateClient.connectWithSigner(endpoint, wallet, {
			registry: customRegistry,
			gasPrice: gasPrice,
		});
		return { client, wallet };
	}

	public async uploadChunkToDataChain(
		chainName: string,
		chunkIndex: string,
		chunkData: Buffer,
	): Promise<DeliverTxResponse> {
		const { client, wallet } = await this.getSigningClient(chainName);
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

		const gasPrice = GasPrice.fromString(`${config.gasPrice}${config.denom}`);

		// ★★★ ここから修正 ★★★
		// 巨大なデータの場合にsimulateがOOMを引き起こすため、ガス代をデータサイズから計算する
		// 基本ガス(50,000) + データ1バイトあたり10ガス + 安全マージン という想定
		const GAS_PER_BYTE = 50000;
		const BASE_GAS = 100000;
		const gasEstimated = BigInt(BASE_GAS + (chunkData.length * GAS_PER_BYTE));
		const fee = calculateFee(Number(gasEstimated), gasPrice);
		// ★★★ ここまで修正 ★★★

		return await client.signAndBroadcast(account.address, [msg], fee, 'Upload chunk');
	}

	public async uploadManifestToMetaChain(
		chainName: string,
		url: string,
		manifest: string,
	): Promise<DeliverTxResponse> {
		const { client, wallet } = await this.getSigningClient(chainName);
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

		// マニフェストは小さいので、従来通りsimulateを使用する
		const gasPrice = GasPrice.fromString(`${config.gasPrice}${config.denom}`);
		const gasEstimated = await client.simulate(account.address, [msg], 'Upload manifest');
		const fee = calculateFee(Math.round(gasEstimated * 1.5), gasPrice);

		return await client.signAndBroadcast(account.address, [msg], fee, 'Upload manifest');
	}

	private async queryChainAPI<T>(url: string): Promise<T> {
		log.info(`  🔍 Querying: ${url}`);
		const response = await fetch(url);
		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(`Failed to query from ${url}: ${response.statusText} (${response.status}) - ${errorBody}`);
		}
		return await response.json() as T;
	}

	public async queryStoredChunk(chainName: string, index: string): Promise<StoredChunkResponse> {
		const endpoints = await this.infraService.getApiEndpoints();
		const restEndpoint = endpoints[chainName];
		if (!restEndpoint) {
			throw new Error(`REST endpoint not found for chain: ${chainName}`);
		}
		const url = `${restEndpoint}/datachain/datastore/v1/stored_chunk/${index}`;
		return this.queryChainAPI<StoredChunkResponse>(url);
	}

	public async queryStoredManifest(chainName: string, url: string): Promise<StoredManifestResponse> {
		const endpoints = await this.infraService.getApiEndpoints();
		const restEndpoint = endpoints[chainName];
		if (!restEndpoint) {
			throw new Error(`REST endpoint not found for chain: ${chainName}`);
		}
		const queryUrl = `${restEndpoint}/metachain/metastore/v1/stored_manifest/${encodeURIComponent(url)}`;
		return this.queryChainAPI<StoredManifestResponse>(queryUrl);
	}
}