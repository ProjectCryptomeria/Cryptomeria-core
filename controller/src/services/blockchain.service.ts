// src/services/blockchain.service.ts
import { HdPath, stringToPath } from "@cosmjs/crypto";
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { calculateFee, DeliverTxResponse, GasPrice, SigningStargateClient } from '@cosmjs/stargate';
import fetch from 'node-fetch';
import { getChainConfig } from '../config';
import { log } from '../lib/logger';
import { withRetry } from '../lib/retry';
import { customRegistry } from '../registry';
import { ChainEndpoints, InfrastructureService } from './infrastructure.service';

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
	private rpcEndpointsCache: ChainEndpoints | null = null;
	private apiEndpointsCache: ChainEndpoints | null = null;
	private chunkGasEstimatedCache: number | null = null;
	private manifestGasEstimatedCache: number | null = null;

	constructor(infraService: InfrastructureService) {
		this.infraService = infraService;
	}

	public setEndpoints(rpcEndpoints: ChainEndpoints, apiEndpoints: ChainEndpoints) {
		this.rpcEndpointsCache = rpcEndpoints;
		this.apiEndpointsCache = apiEndpoints;
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

		if (!this.rpcEndpointsCache) throw new Error("RPC Endpoints must be set before getting signing client.");
		const endpoint = this.rpcEndpointsCache[chainName];
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
		const uploadFn = async () => {
			const { client, wallet } = await this.getSigningClient(chainName);
			const [account] = await wallet.getAccounts();
			const chainConfigs = await getChainConfig();
			const config = chainConfigs[chainName];

			if (!account) throw new Error('Failed to get account from wallet.');
			if (!config) throw new Error(`Configuration for chain "${chainName}" not found.`);

			const msg = {
				typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk',
				value: { creator: account.address, index: chunkIndex, data: chunkData },
			};

			const gasPrice = GasPrice.fromString(`${config.gasPrice}${config.denom}`);
			if (!this.chunkGasEstimatedCache) {
				const gasEstimated = await client.simulate(account.address, [msg], 'Upload chunk');
				this.chunkGasEstimatedCache = gasEstimated;
			}
			const fee = calculateFee(Math.round(this.chunkGasEstimatedCache * 1.5), gasPrice);
			return await client.signAndBroadcast(account.address, [msg], fee, 'Upload chunk');
		};

		return withRetry(uploadFn, { retries: 5, minTimeout: 1000, factor: 2, jitter: true });
	}

	public async uploadManifestToMetaChain(
		chainName: string,
		url: string,
		manifest: string,
	): Promise<DeliverTxResponse> {
		const uploadFn = async () => {
			const { client, wallet } = await this.getSigningClient(chainName);
			const [account] = await wallet.getAccounts();
			const chainConfigs = await getChainConfig();
			const config = chainConfigs[chainName];

			if (!account) throw new Error('Failed to get account from wallet.');
			if (!config) throw new Error(`Configuration for chain "${chainName}" not found.`);

			const msg = {
				typeUrl: '/metachain.metastore.v1.MsgCreateStoredManifest',
				value: { creator: account.address, url: url, manifest: manifest },
			};
			const gasPrice = GasPrice.fromString(`${config.gasPrice}${config.denom}`);
			if (!this.manifestGasEstimatedCache) {
				const gasEstimated = await client.simulate(account.address, [msg], 'Upload chunk');
				this.manifestGasEstimatedCache = gasEstimated;
			}
			const fee = calculateFee(Math.round(this.manifestGasEstimatedCache * 1.5), gasPrice);

			return await client.signAndBroadcast(account.address, [msg], fee, 'Upload manifest');
		};

		return withRetry(uploadFn, { retries: 5, minTimeout: 1000, factor: 2, jitter: true });
	}

	private async queryChainAPI<T>(url: string): Promise<T> {
		const queryFn = async () => {
			log.info(`  🔍 Querying: ${url}`);
			const response = await fetch(url);
			if (!response.ok) {
				const errorBody = await response.text();
				throw new Error(`Failed to query from ${url}: ${response.statusText} (${response.status}) - ${errorBody}`);
			}
			return await response.json() as T;
		};

		return withRetry(queryFn, { retries: 10, minTimeout: 500, factor: 1.5, jitter: true });
	}

	public async queryStoredChunk(chainName: string, index: string): Promise<StoredChunkResponse> {
		if (!this.apiEndpointsCache) throw new Error("API Endpoints must be set before querying chunk.");
		const restEndpoint = this.apiEndpointsCache[chainName];
		if (!restEndpoint) throw new Error(`REST endpoint not found for chain: ${chainName}`);

		const url = `${restEndpoint}/datachain/datastore/v1/stored_chunk/${index}`;
		return this.queryChainAPI<StoredChunkResponse>(url);
	}

	public async queryStoredManifest(chainName: string, url: string): Promise<StoredManifestResponse> {
		if (!this.apiEndpointsCache) throw new Error("API Endpoints must be set before querying manifest.");
		const restEndpoint = this.apiEndpointsCache[chainName];
		if (!restEndpoint) throw new Error(`REST endpoint not found for chain: ${chainName}`);

		const queryUrl = `${restEndpoint}/metachain/metastore/v1/stored_manifest/${encodeURIComponent(url)}`;
		return this.queryChainAPI<StoredManifestResponse>(queryUrl);
	}
}