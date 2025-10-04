import * as fs from 'fs/promises';
import * as path from 'path';
import { uploadChunkToDataChain, uploadManifestToMetaChain } from '../blockchain';
import { queryStoredChunk, queryStoredManifest } from '../blockchain-query';
import { splitFileIntoChunks } from '../chunker';
import { getChainInfo, getRpcEndpoints } from '../k8s-client';

export type DataChainId = string; // CHANGED: More flexible
export type DistributionStrategy = 'round-robin' | 'manual' | 'auto';

export interface ChunkInfo {
	index: string;
	chain: DataChainId;
}
export interface Manifest {
	filepath: string;
	chunks: ChunkInfo[];
}

export interface UploadOptions {
	chunkSize?: number;
	distributionStrategy?: DistributionStrategy;
	targetChain?: DataChainId;
}

export interface ChainStatus {
	chainId: DataChainId;
	pendingTxs: number;
}

export const log = {
	info: (msg: string) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
	success: (msg: string) => console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`),
	error: (msg: string) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
	step: (msg: string) => console.log(`\n\x1b[1;33m--- ${msg} ---\x1b[0m`),
};

export class RaidchainClient {
	private dataChains: DataChainId[] = [];
	private metaChain: string | null = null;
	private isInitialized = false;
	private verificationTimeoutMs = 20000;
	private verificationPollIntervalMs = 1000;

	constructor() { }

	// ADDED: Initialization method
	async initialize() {
		if (this.isInitialized) return;

		log.info('Initializing RaidchainClient by fetching chain information...');
		const chainInfos = await getChainInfo();
		this.dataChains = chainInfos
			.filter(c => c.type === 'datachain')
			.map(c => c.name);

		const metaChainInfo = chainInfos.find(c => c.type === 'metachain');
		if (metaChainInfo) {
			this.metaChain = metaChainInfo.name;
		} else {
			throw new Error("Metachain not found in the cluster.");
		}

		if (this.dataChains.length === 0) {
			console.warn("Warning: No data chains found.");
		}

		this.isInitialized = true;
		log.info(`RaidchainClient initialized with ${this.dataChains.length} data chain(s) and meta chain '${this.metaChain}'.`);
	}

	private async _uploadAndVerifyChunk(targetChain: DataChainId, chunkIndex: string, chunk: Buffer): Promise<void> {
		const txResult = await uploadChunkToDataChain(targetChain, chunkIndex, chunk);
		if (txResult.code !== 0) {
			throw new Error(`Chunk upload transaction failed for ${chunkIndex} on ${targetChain} (Code: ${txResult.code}): ${txResult.rawLog}`);
		}
		log.info(`  ... tx (${txResult.transactionHash.slice(0, 10)}...) successful. Verifying...`);

		const startTime = Date.now();
		while (Date.now() - startTime < this.verificationTimeoutMs) {
			try {
				await queryStoredChunk(targetChain, chunkIndex);
				log.success(`  ... Chunk '${chunkIndex}' verified on chain.`);
				return;
			} catch (error: any) {
				if (error.message && error.message.includes('not found')) { // Adapted for potential error messages
					await new Promise(resolve => setTimeout(resolve, this.verificationPollIntervalMs));
				} else {
					throw error;
				}
			}
		}
		throw new Error(`Verification timed out for chunk '${chunkIndex}'.`);
	}

	private async _uploadAndVerifyManifest(urlIndex: string, manifestString: string): Promise<void> {
		if (!this.metaChain) {
			throw new Error("Metachain is not initialized.");
		}
		const txResult = await uploadManifestToMetaChain(this.metaChain, urlIndex, manifestString);
		if (txResult.code !== 0) {
			throw new Error(`Manifest upload transaction failed for ${urlIndex} (Code: ${txResult.code}): ${txResult.rawLog}`);
		}
		log.info(`  ... tx (${txResult.transactionHash.slice(0, 10)}...) successful. Verifying...`);

		const startTime = Date.now();
		while (Date.now() - startTime < this.verificationTimeoutMs) {
			try {
				await queryStoredManifest(this.metaChain, urlIndex);
				log.success(`  ... Manifest '${urlIndex}' verified on chain.`);
				return;
			} catch (error: any) {
				if (error.message && error.message.includes('not found')) { // Adapted for potential error messages
					await new Promise(resolve => setTimeout(resolve, this.verificationPollIntervalMs));
				} else {
					throw error;
				}
			}
		}
		throw new Error(`Manifest '${urlIndex}' verification timed out.`);
	}

	public async uploadFile(filePath: string, siteUrl: string, options: UploadOptions = {}): Promise<{ manifest: Manifest, urlIndex: string }> {
		await this.initialize(); // ADDED
		const { distributionStrategy = 'round-robin', targetChain } = options;
		log.info(`Uploading '${filePath}' with strategy: ${distributionStrategy}`);

		const fileBuffer = await fs.readFile(filePath);
		const chunks = options.chunkSize ? this.splitBufferIntoChunks(fileBuffer, options.chunkSize) : await splitFileIntoChunks(filePath);
		const uniqueSuffix = `file-${Date.now()}`;
		const urlIndex = encodeURIComponent(siteUrl);

		const uploadedChunks: ChunkInfo[] = [];

		if (distributionStrategy === 'auto') {
			log.info(`Starting upload with ${this.dataChains.length} parallel workers...`);
			const chunksToUpload = chunks.map((chunk, i) => ({
				chunk,
				index: `${uniqueSuffix}-${i}`
			}));

			const worker = async (chainId: DataChainId) => {
				while (chunksToUpload.length > 0) {
					const job = chunksToUpload.shift();
					if (!job) continue;

					log.info(`  -> [Worker: ${chainId}] processing chunk '${job.index}'...`);
					await this._uploadAndVerifyChunk(chainId, job.index, job.chunk);
					uploadedChunks.push({ index: job.index, chain: chainId });
				}
			};

			const workerPromises = this.dataChains.map(chainId => worker(chainId));
			await Promise.all(workerPromises);

		} else {
			for (const [i, chunk] of chunks.entries()) {
				const chunkIndex = `${uniqueSuffix}-${i}`;
				let uploadTarget: DataChainId;

				if (distributionStrategy === 'manual') {
					if (!targetChain || !this.dataChains.includes(targetChain)) {
						throw new Error(`'targetChain' must be a valid and available data chain for the 'manual' strategy. Available: ${this.dataChains.join(', ')}`);
					}
					uploadTarget = targetChain;
				} else { // 'round-robin'
					if (this.dataChains.length === 0) {
						throw new Error("No data chains available for upload.");
					}
					uploadTarget = this.dataChains[i % this.dataChains.length]!;
				}

				log.info(`  -> Uploading chunk #${i} (${(chunk.length / 1024).toFixed(2)} KB) to ${uploadTarget}...`);
				await this._uploadAndVerifyChunk(uploadTarget, chunkIndex, chunk);
				uploadedChunks.push({ index: chunkIndex, chain: uploadTarget });
			}
		}

		uploadedChunks.sort((a, b) => {
			const indexA = parseInt(a.index.split('-').pop() ?? '0');
			const indexB = parseInt(b.index.split('-').pop() ?? '0');
			return indexA - indexB;
		});

		const manifest: Manifest = {
			filepath: path.basename(filePath),
			chunks: uploadedChunks,
		};
		const manifestString = JSON.stringify(manifest);

		log.info(`Uploading manifest to ${this.metaChain} for URL: ${siteUrl}`);
		await this._uploadAndVerifyManifest(urlIndex, manifestString);

		log.success(`Upload and verification complete for: ${siteUrl}`);
		return { manifest, urlIndex };
	}

	async downloadFile(siteUrl: string): Promise<Buffer> {
		await this.initialize();
		const urlIndex = encodeURIComponent(siteUrl);
		if (!this.metaChain) {
			throw new Error("Metachain is not initialized.");
		}
		log.info(`Fetching manifest from ${this.metaChain} for URL: ${siteUrl}`);
		const manifestResult = await queryStoredManifest(this.metaChain, urlIndex);

		if (!manifestResult.manifest || !manifestResult.manifest.manifest) {
			throw new Error(`Manifest not found or response format is invalid: ${JSON.stringify(manifestResult)}`);
		}

		const manifest: Manifest = JSON.parse(manifestResult.manifest.manifest);
		log.success(`Manifest found. Downloading ${manifest.chunks.length} chunks.`);

		const chunkDownloadPromises = manifest.chunks.map(chunkInfo => {
			log.info(`  -> Fetching chunk '${chunkInfo.index}' from ${chunkInfo.chain}...`);
			return queryStoredChunk(chunkInfo.chain, chunkInfo.index);
		});

		const chunkQueryResults = await Promise.all(chunkDownloadPromises);

		const chunkBuffers = chunkQueryResults.map((result, index) => {
			if (!result.stored_chunk || !result.stored_chunk.data) {
				throw new Error(`Failed to get data for chunk ${manifest.chunks[index]?.index}. Response: ${JSON.stringify(result)}`);
			}
			return Buffer.from(result.stored_chunk.data, 'base64');
		});

		return Buffer.concat(chunkBuffers);
	}

	async createTestFile(filePath: string, sizeInKb: number): Promise<string> {
		const buffer = Buffer.alloc(sizeInKb * 1024, 'a');
		const content = `Test file of ${sizeInKb} KB. Unique ID: ${Date.now()}`;
		buffer.write(content);

		await fs.writeFile(filePath, buffer);
		log.info(`Created a ${sizeInKb} KB test file at: ${filePath}`);
		return buffer.toString('utf-8');
	}

	async getQuietestChain(): Promise<DataChainId> {
		await this.initialize();
		if (this.dataChains.length === 0) {
			throw new Error("No data chains available to determine the quietest.");
		}

		const statuses = await Promise.all(this.dataChains.map(id => this.getChainStatus(id)));
		const quietest = statuses.reduce((prev, curr) => (prev.pendingTxs < curr.pendingTxs ? prev : curr));
		log.info(`Auto-selected chain: ${quietest.chainId} is the quietest with ${quietest.pendingTxs} pending transactions.`);
		return quietest.chainId;
	}

	async getChainStatus(chainId: DataChainId): Promise<ChainStatus> {
		await this.initialize();
		const rpcEndpoints = await getRpcEndpoints(); // CHANGED: Await the promise
		const rpcEndpoint = rpcEndpoints[chainId];
		if (!rpcEndpoint) {
			throw new Error(`${chainId}のRPCエンドポイントが見つかりません。`);
		}

		try {
			const response = await fetch(`${rpcEndpoint}/num_unconfirmed_txs`);
			if (!response.ok) return { chainId, pendingTxs: Infinity };
			const data = await response.json();
			const pendingTxs = parseInt(data.result?.n_txs ?? '0', 10);
			return { chainId, pendingTxs };
		} catch (error) {
			log.error(`${chainId} のステータス取得に失敗: ${error}`);
			return { chainId, pendingTxs: Infinity };
		}
	}

	private splitBufferIntoChunks(buffer: Buffer, chunkSize: number): Buffer[] {
		const chunks: Buffer[] = [];
		for (let i = 0; i < buffer.length; i += chunkSize) {
			chunks.push(buffer.subarray(i, i + chunkSize));
		}
		return chunks;
	}
}