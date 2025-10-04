import * as fs from 'fs/promises';
import * as path from 'path';
import { uploadChunkToDataChain, uploadManifestToMetaChain } from '../blockchain';
import { queryStoredChunk, queryStoredManifest } from '../blockchain-query';
import { splitFileIntoChunks } from '../chunker';
import { getRpcEndpoints } from '../config';

// --- 型定義 ---
export type DataChainId = 'data-0' | 'data-1';
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

// --- 色付きログ出力用のヘルパー ---
export const log = {
	info: (msg: string) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
	success: (msg: string) => console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`),
	error: (msg: string) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
	step: (msg: string) => console.log(`\n\x1b[1;33m--- ${msg} ---\x1b[0m`),
};

/**
 * Raidchainの操作をカプセル化するクライアント
 */
export class RaidchainClient {
	private dataChains: DataChainId[] = ['data-0', 'data-1'];
	private verificationTimeoutMs = 20000; // 20秒
	private verificationPollIntervalMs = 1000; // 1秒

	private async _uploadAndVerifyChunk(targetChain: DataChainId, chunkIndex: string, chunk: Buffer): Promise<void> {
		const txResult = await uploadChunkToDataChain(targetChain, chunkIndex, chunk);
		if (txResult.code !== 0) {
			throw new Error(`チャンク(${chunkIndex})のアップロードトランザクションが失敗しました (コード: ${txResult.code}): ${txResult.rawLog}`);
		}
		log.info(`  ... tx (${txResult.transactionHash.slice(0, 10)}...) 成功。APIでの確認を開始します...`);

		const startTime = Date.now();
		while (Date.now() - startTime < this.verificationTimeoutMs) {
			try {
				await queryStoredChunk(targetChain, chunkIndex);
				log.success(`  ... チャンク '${chunkIndex}' がAPIで確認できました。`);
				return;
			} catch (error: any) {
				if (error.message && error.message.includes('Not Found (404)')) {
					await new Promise(resolve => setTimeout(resolve, this.verificationPollIntervalMs));
				} else {
					throw error;
				}
			}
		}
		throw new Error(`チャンク '${chunkIndex}' のAPI確認がタイムアウトしました。`);
	}

	private async _uploadAndVerifyManifest(urlIndex: string, manifestString: string): Promise<void> {
		const txResult = await uploadManifestToMetaChain(urlIndex, manifestString);
		if (txResult.code !== 0) {
			throw new Error(`マニフェスト(${urlIndex})のアップロードトランザクションが失敗しました (コード: ${txResult.code}): ${txResult.rawLog}`);
		}
		log.info(`  ... tx (${txResult.transactionHash.slice(0, 10)}...) 成功。APIでの確認を開始します...`);

		const startTime = Date.now();
		while (Date.now() - startTime < this.verificationTimeoutMs) {
			try {
				await queryStoredManifest(urlIndex);
				log.success(`  ... マニフェスト '${urlIndex}' がAPIで確認できました。`);
				return;
			} catch (error: any) {
				if (error.message && error.message.includes('Not Found (404)')) {
					await new Promise(resolve => setTimeout(resolve, this.verificationPollIntervalMs));
				} else {
					throw error;
				}
			}
		}
		throw new Error(`マニフェスト '${urlIndex}' のAPI確認がタイムアウトしました。`);
	}

	async uploadFile(filePath: string, siteUrl: string, options: UploadOptions = {}): Promise<{ manifest: Manifest, urlIndex: string }> {
		const { distributionStrategy = 'round-robin', targetChain } = options;
		log.info(`'${filePath}' をアップロードします (戦略: ${distributionStrategy})`);

		const fileBuffer = await fs.readFile(filePath);
		const chunks = options.chunkSize ? this.splitBufferIntoChunks(fileBuffer, options.chunkSize) : await splitFileIntoChunks(filePath);
		const uniqueSuffix = `file-${Date.now()}`;
		const urlIndex = encodeURIComponent(siteUrl);

		// (★★★ ここからが新しいロジック ★★★)
		const uploadedChunks: ChunkInfo[] = [];

		if (distributionStrategy === 'auto') {
			log.info(`${this.dataChains.length}個の並列ワーカーでアップロードを開始します...`);
			// アップロードすべきチャンクのキューを作成
			const chunksToUpload = chunks.map((chunk, i) => ({
				chunk,
				index: `${uniqueSuffix}-${i}`
			}));

			// 各datachainをワーカーとして稼働させる
			const worker = async (chainId: DataChainId) => {
				// キューに仕事がある限り、仕事を取り出して処理する
				while (chunksToUpload.length > 0) {
					const job = chunksToUpload.shift();
					if (!job) continue;

					log.info(`  -> [ワーカー: ${chainId}] がチャンク '${job.index}' の処理を開始...`);
					await this._uploadAndVerifyChunk(chainId, job.index, job.chunk);
					uploadedChunks.push({ index: job.index, chain: chainId });
				}
			};

			// 全てのワーカーを同時に起動
			const workerPromises = this.dataChains.map(chainId => worker(chainId));
			// 全てのワーカーが仕事を終えるのを待つ
			await Promise.all(workerPromises);

		} else {
			// 'manual' と 'round-robin' はこれまで通りの直列処理
			for (const [i, chunk] of chunks.entries()) {
				const chunkIndex = `${uniqueSuffix}-${i}`;
				let uploadTarget: DataChainId;

				switch (distributionStrategy) {
					case 'manual':
						if (!targetChain) throw new Error("手動配布戦略では'targetChain'を指定する必要があります。");
						uploadTarget = targetChain;
						break;
					case 'round-robin':
					default:
						const target = this.dataChains[i % this.dataChains.length];
						if (!target) throw new Error("アップロード先のdatachainが見つかりません。");
						uploadTarget = target;
						break;
				}

				log.info(`  -> チャンク #${i} (${(chunk.length / 1024).toFixed(2)} KB) を ${uploadTarget} へ...`);
				await this._uploadAndVerifyChunk(uploadTarget, chunkIndex, chunk);
				uploadedChunks.push({ index: chunkIndex, chain: uploadTarget });
			}
		}

		// 並列処理で順序がばらばらになる可能性があるため、インデックスでソートしてマニフェストの順序を保証する
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

		log.info(`マニフェストを metachain にアップロードします (URL: ${siteUrl})`);
		await this._uploadAndVerifyManifest(urlIndex, manifestString);

		log.success(`アップロードとAPIでの検証が完了しました: ${siteUrl}`);
		return { manifest, urlIndex };
	}

	async downloadFile(siteUrl: string): Promise<Buffer> {
		const urlIndex = encodeURIComponent(siteUrl);
		log.info(`Metachainからマニフェストを取得します (URL: ${siteUrl})`);
		const manifestResult = await queryStoredManifest(urlIndex);

		if (!manifestResult.stored_manifest?.manifest) {
			throw new Error(`マニフェストが見つからないか、応答の形式が不正です。`);
		}

		const manifest: Manifest = JSON.parse(manifestResult.stored_manifest.manifest);
		log.success(`マニフェスト取得完了。${manifest.chunks.length}個のチャンクをダウンロードします。`);

		const chunkDownloadPromises = manifest.chunks.map(chunkInfo => {
			log.info(`  -> チャンク '${chunkInfo.index}' を ${chunkInfo.chain} から取得中...`);
			return queryStoredChunk(chunkInfo.chain, chunkInfo.index);
		});

		const chunkQueryResults = await Promise.all(chunkDownloadPromises);

		const chunkBuffers = chunkQueryResults.map(result => {
			if (!result.stored_chunk?.data) {
				throw new Error(`チャンクデータの取得に失敗しました。応答: ${JSON.stringify(result)}`);
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
		log.info(`${sizeInKb} KBのテストファイルを生成しました: ${filePath}`);
		return buffer.toString('utf-8');
	}

	async getQuietestChain(): Promise<DataChainId> {
		const statuses = await Promise.all(this.dataChains.map(id => this.getChainStatus(id)));
		const quietest = statuses.reduce((prev, curr) => (prev.pendingTxs < curr.pendingTxs ? prev : curr));
		log.info(`自動選択: ${quietest.chainId} が最も空いています (保留tx: ${quietest.pendingTxs})`);
		return quietest.chainId;
	}

	async getChainStatus(chainId: DataChainId): Promise<ChainStatus> {
		const rpcEndpoints = await getRpcEndpoints();
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