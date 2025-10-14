// src/lib/raidchain.client.ts
import { DeliverTxResponse } from '@cosmjs/stargate';
import * as fs from 'fs/promises';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { BlockchainService } from '../services/blockchain.service';
import { ChainInfo, InfrastructureService } from '../services/infrastructure.service';
import { splitFileIntoChunks } from './chunker';
import { log } from './logger';
import { PerformanceReport, PerformanceTracker } from './performance-tracker';

// --- Type Definitions (No Change) ---
export type DataChainId = string;
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
	onChunkUploaded?: (info: { chunkIndex: string; chain: DataChainId }) => void;
}
export interface InitializeOptions {
	chainCount?: number;
}
export interface UploadResult {
	manifest: Manifest;
	urlIndex: string;
	uploadStats: PerformanceReport;
}
export interface DownloadResult {
	data: Buffer;
	downloadTimeMs: number;
}
export interface ChainStatus {
	chainId: DataChainId;
	pendingTxs: number;
}


export class RaidchainClient {
	private dataChains: ChainInfo[] = [];
	private metaChain: ChainInfo | null = null;
	private isInitialized = false;
	private verificationTimeoutMs = 20000;
	private verificationPollIntervalMs = 1000;

	// --- Services ---
	private infraService: InfrastructureService;
	private blockchainService: BlockchainService;

	constructor() {
		this.infraService = new InfrastructureService();
		this.blockchainService = new BlockchainService(this.infraService);
	}

	async initialize(options: InitializeOptions = {}) {
		if (this.isInitialized) return;

		log.info('RaidchainClientを初期化しています。チェーン情報を取得中...');
		const chainInfos = await this.infraService.getChainInfo();

		let allDataChains = chainInfos.filter(c => c.type === 'datachain');

		if (options.chainCount && options.chainCount > 0) {
			if (options.chainCount > allDataChains.length) {
				log.error(`要求されたチェーン数 (${options.chainCount}) が利用可能なデータチェーン数 (${allDataChains.length}) を超えています。`);
				throw new Error("Cannot initialize with more chains than available.");
			}
			this.dataChains = allDataChains.slice(0, options.chainCount);
			log.info(`指定された 'chainCount'=${options.chainCount} に基づいて、${this.dataChains.length}個のデータチェーンを利用します。`);
		} else {
			this.dataChains = allDataChains;
		}

		this.metaChain = chainInfos.find(c => c.type === 'metachain') ?? null;
		if (!this.metaChain) {
			throw new Error("メタチェーンがクラスタ内で見つかりません。");
		}
		if (this.dataChains.length === 0) {
			console.warn("警告: データチェーンが見つかりません。");
		}

		this.isInitialized = true;
		log.info(`RaidchainClientの初期化が完了しました。データチェーン: ${this.dataChains.length}個, メタチェーン: '${this.metaChain.name}'`);
	}

	private async _uploadAndVerifyChunk(targetChain: DataChainId, chunkIndex: string, chunk: Buffer, options: UploadOptions): Promise<DeliverTxResponse> {
		const txResult = await this.blockchainService.uploadChunkToDataChain(targetChain, chunkIndex, chunk);
		if (txResult.code !== 0) {
			throw new Error(`チャンク ${chunkIndex} の ${targetChain} へのアップロードトランザクションが失敗しました (Code: ${txResult.code}): ${txResult.rawLog}`);
		}
		log.info(`  ... tx (${txResult.transactionHash.slice(0, 10)}...) 成功。検証中...`);

		const startTime = Date.now();
		while (Date.now() - startTime < this.verificationTimeoutMs) {
			try {
				await this.blockchainService.queryStoredChunk(targetChain, chunkIndex);
				log.info(`  ... チャンク '${chunkIndex}' がチェーン上で検証されました。`);
				options.onChunkUploaded?.({ chunkIndex: chunkIndex, chain: targetChain });
				return txResult;
			} catch (error: any) {
				if (error.message && error.message.includes('not found')) {
					await new Promise(resolve => setTimeout(resolve, this.verificationPollIntervalMs));
				} else {
					throw error;
				}
			}
		}
		throw new Error(`チャンク '${chunkIndex}' の検証がタイムアウトしました。`);
	}

	private async _uploadAndVerifyManifest(urlIndex: string, manifestString: string): Promise<DeliverTxResponse> {
		if (!this.metaChain) throw new Error("メタチェーンが初期化されていません。");

		const txResult = await this.blockchainService.uploadManifestToMetaChain(this.metaChain.name, urlIndex, manifestString);
		if (txResult.code !== 0) {
			throw new Error(`マニフェスト ${urlIndex} のアップロードトランザクションが失敗しました (Code: ${txResult.code}): ${txResult.rawLog}`);
		}
		log.info(`  ... tx (${txResult.transactionHash.slice(0, 10)}...) 成功。検証中...`);

		const startTime = Date.now();
		while (Date.now() - startTime < this.verificationTimeoutMs) {
			try {
				await this.blockchainService.queryStoredManifest(this.metaChain.name, urlIndex);
				log.info(`  ... マニフェスト '${urlIndex}' がチェーン上で検証されました。`);
				return txResult;
			} catch (error: any) {
				if (error.message && error.message.includes('not found')) {
					await new Promise(resolve => setTimeout(resolve, this.verificationPollIntervalMs));
				} else {
					throw error;
				}
			}
		}
		throw new Error(`マニフェスト '${urlIndex}' の検証がタイムアウトしました。`);
	}

	public async uploadFile(filePath: string, siteUrl: string, options: UploadOptions = {}): Promise<UploadResult> {
		await this.initialize();
		const tracker = new PerformanceTracker();
		tracker.start();

		const { distributionStrategy = 'round-robin', targetChain } = options;
		log.info(`'${filePath}' をアップロードします。方式: ${distributionStrategy}`);

		const fileBuffer = await fs.readFile(filePath);
		const chunks = options.chunkSize ? this.splitBufferIntoChunks(fileBuffer, options.chunkSize) : await splitFileIntoChunks(filePath);
		const uniqueSuffix = `file-${Date.now()}`;
		const urlIndex = encodeURIComponent(siteUrl);
		const uploadedChunks: ChunkInfo[] = [];

		if (distributionStrategy === 'auto') {
			log.info(`${this.dataChains.length}個の並列ワーカーでアップロードを開始します...`);
			const chunksToUpload = chunks.map((chunk, i) => ({
				chunk,
				index: `${uniqueSuffix}-${i}`
			}));
			const worker = async (chain: ChainInfo) => {
				while (chunksToUpload.length > 0) {
					const job = chunksToUpload.shift();
					if (!job) continue;
					log.info(`  -> [ワーカー: ${chain.name}] チャンク '${job.index}' を処理中...`);
					const txResult = await this._uploadAndVerifyChunk(chain.name, job.index, job.chunk, options);
					tracker.recordTransaction(BigInt(txResult.gasUsed));
					uploadedChunks.push({ index: job.index, chain: chain.name });
				}
			};
			const workerPromises = this.dataChains.map(chain => worker(chain));
			await Promise.all(workerPromises);
		} else {
			for (const [i, chunk] of chunks.entries()) {
				const chunkIndex = `${uniqueSuffix}-${i}`;
				let uploadTarget: ChainInfo;
				if (distributionStrategy === 'manual') {
					const foundChain = this.dataChains.find(c => c.name === targetChain);
					if (!foundChain) throw new Error(`'manual'戦略では、有効なデータチェーンを'targetChain'で指定する必要があります。利用可能なチェーン: ${this.dataChains.map(c => c.name).join(', ')}`);
					uploadTarget = foundChain;
				} else {
					if (this.dataChains.length === 0) throw new Error("アップロード可能なデータチェーンがありません。");
					uploadTarget = this.dataChains[i % this.dataChains.length]!;
				}
				log.info(`  -> チャンク #${i} (${(chunk.length / 1024).toFixed(2)} KB) を ${uploadTarget.name} へアップロード中...`);
				const txResult = await this._uploadAndVerifyChunk(uploadTarget.name, chunkIndex, chunk, options);
				tracker.recordTransaction(BigInt(txResult.gasUsed));
				uploadedChunks.push({ index: chunkIndex, chain: uploadTarget.name });
			}
		}

		uploadedChunks.sort((a, b) => parseInt(a.index.split('-').pop() ?? '0') - parseInt(b.index.split('-').pop() ?? '0'));
		const manifest: Manifest = {
			filepath: path.basename(filePath),
			chunks: uploadedChunks,
		};
		const manifestString = JSON.stringify(manifest);

		if (!this.metaChain) throw new Error("メタチェーンが初期化されていません。");
		log.info(`${this.metaChain.name} へURL '${siteUrl}' のマニフェストをアップロードします`);
		const manifestTxResult = await this._uploadAndVerifyManifest(urlIndex, manifestString);
		tracker.recordTransaction(BigInt(manifestTxResult.gasUsed));

		tracker.stop();
		log.success(`'${siteUrl}' のアップロードと検証が完了しました。`);
		return { manifest, urlIndex, uploadStats: tracker.getReport() };
	}

	public async downloadFile(siteUrl: string): Promise<DownloadResult> {
		await this.initialize();
		const startTime = performance.now();
		const urlIndex = encodeURIComponent(siteUrl);
		if (!this.metaChain) throw new Error("メタチェーンが初期化されていません。");

		log.info(`${this.metaChain.name} からURL '${siteUrl}' のマニフェストを取得します`);
		const manifestResult = await this.blockchainService.queryStoredManifest(this.metaChain.name, urlIndex);
		if (!manifestResult.stored_manifest || !manifestResult.stored_manifest.manifest) {
			throw new Error(`マニフェストが見つからないか、レスポンスの形式が不正です: ${JSON.stringify(manifestResult)}`);
		}

		const manifest: Manifest = JSON.parse(manifestResult.stored_manifest.manifest);
		log.info(`マニフェストを発見しました。${manifest.chunks.length}個のチャンクをダウンロードします。`);

		const chunkDownloadPromises = manifest.chunks.map(chunkInfo => {
			log.info(`  -> チャンク '${chunkInfo.index}' を ${chunkInfo.chain} から取得中...`);
			return this.blockchainService.queryStoredChunk(chunkInfo.chain, chunkInfo.index);
		});

		const chunkQueryResults = await Promise.all(chunkDownloadPromises);
		const chunkBuffers = chunkQueryResults.map((result, index) => {
			if (!result.stored_chunk || !result.stored_chunk.data) {
				throw new Error(`チャンク ${manifest.chunks[index]?.index} のデータ取得に失敗しました。レスポンス: ${JSON.stringify(result)}`);
			}
			return Buffer.from(result.stored_chunk.data, 'base64');
		});

		const data = Buffer.concat(chunkBuffers);
		const endTime = performance.now();
		const downloadTimeMs = endTime - startTime;
		log.info(`ファイルの復元が完了しました。(${downloadTimeMs.toFixed(2)} ms)`);
		return { data, downloadTimeMs };
	}

	public async createTestFile(filePath: string, sizeInKb: number): Promise<string> {
		const buffer = Buffer.alloc(sizeInKb * 1024, 'a');
		const content = `Test file of ${sizeInKb} KB. Unique ID: ${Date.now()}`;
		buffer.write(content);
		await fs.writeFile(filePath, buffer);
		log.info(`${sizeInKb} KB のテストファイルを ${filePath} に作成しました。`);
		return buffer.toString('utf-8');
	}

	public async getQuietestChain(): Promise<DataChainId> {
		await this.initialize();
		if (this.dataChains.length === 0) throw new Error("最も空いているチェーンを判断するためのデータチェーンがありません。");
		const statuses = await Promise.all(this.dataChains.map(c => this.getChainStatus(c.name)));
		const quietest = statuses.reduce((prev, curr) => (prev.pendingTxs < curr.pendingTxs ? prev : curr));
		log.info(`自動選択されたチェーン: ${quietest.chainId} (保留中のTX: ${quietest.pendingTxs})`);
		return quietest.chainId;
	}

	public async getChainStatus(chainId: DataChainId): Promise<ChainStatus> {
		await this.initialize();
		const rpcEndpoints = await this.infraService.getRpcEndpoints();
		const rpcEndpoint = rpcEndpoints[chainId];
		if (!rpcEndpoint) throw new Error(`${chainId}のRPCエンドポイントが見つかりません。`);

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