import * as fs from 'fs/promises';
import * as path from 'path';
import { uploadChunkToDataChain, uploadManifestToMetaChain } from '../blockchain';
import { queryStoredChunk, queryStoredManifest } from '../blockchain-query';
import { splitFileIntoChunks } from '../chunker';
import { getRpcEndpoints } from '../config';

// --- 型定義 ---
export type DataChainId = 'data-0' | 'data-1';
export type DistributionStrategy = 'round-robin' | 'manual' | 'auto';
export interface UploadOptions {
	chunkSize?: number;
	distributionStrategy?: DistributionStrategy;
	targetChain?: DataChainId; // 'manual'の場合に必須
}
export interface Manifest {
	filepath: string;
	chunks: string[];
}
export interface ChainStatus {
	chainId: DataChainId;
	pendingTxs: number;
}

// --- 色付きログ出力用のヘルパー ---
export const log = {
	info: (msg: string) => console.log(`\x1b[36m[情報]\x1b[0m ${msg}`),
	success: (msg: string) => console.log(`\x1b[32m[成功]\x1b[0m ${msg}`),
	error: (msg: string) => console.error(`\x1b[31m[エラー]\x1b[0m ${msg}`),
	step: (msg: string) => console.log(`\n\x1b[1;33m--- ${msg} ---\x1b[0m`),
};

/**
 * Raidchainの操作をカプセル化するクライアント
 */
export class RaidchainClient {
	private dataChains: DataChainId[] = ['data-0', 'data-1'];
	private verificationTimeoutMs = 20000; // 20秒
	private verificationPollIntervalMs = 1000; // 1秒

	// (★★★ この関数を追加 ★★★)
	/**
	 * チャンクをアップロードし、APIで確認できるまで待機する
	 */
	private async _uploadAndVerifyChunk(targetChain: DataChainId, chunkIndex: string, chunk: Buffer): Promise<void> {
		// 1. トランザクションをブロードキャスト
		const txResult = await uploadChunkToDataChain(targetChain, chunkIndex, chunk);
		if (txResult.code !== 0) {
			throw new Error(`チャンク(${chunkIndex})のアップロードトランザクションが失敗しました (コード: ${txResult.code}): ${txResult.rawLog}`);
		}
		log.info(`  ... tx (${txResult.transactionHash.slice(0, 10)}...) 成功。APIでの確認を開始します...`);

		// 2. データがAPIで取得可能になるまでポーリング
		const startTime = Date.now();
		while (Date.now() - startTime < this.verificationTimeoutMs) {
			try {
				await queryStoredChunk(targetChain, chunkIndex);
				log.info(`  ... チャンク '${chunkIndex}' がAPIで確認できました。`);
				return; // 確認成功
			} catch (error: any) {
				if (error.message && error.message.includes('Not Found (404)')) {
					await new Promise(resolve => setTimeout(resolve, this.verificationPollIntervalMs));
				} else {
					throw error; // 404以外の予期せぬエラー
				}
			}
		}
		throw new Error(`チャンク '${chunkIndex}' のAPI確認がタイムアウトしました。`);
	}

	// (★★★ この関数を追加 ★★★)
	/**
	 * マニフェストをアップロードし、APIで確認できるまで待機する
	 */
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
				log.info(`  ... マニフェスト '${urlIndex}' がAPIで確認できました。`);
				return; // 確認成功
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


	/**
	 * ファイルをチャンクに分割し、指定された戦略でRaidchainにアップロードします。
	 * @param filePath アップロードするファイルのパス
	 * @param siteUrl サイトのURL
	 * @param options アップロードオプション
	 * @returns アップロードされたチャンクの情報
	 */
	async uploadFile(filePath: string, siteUrl: string, options: UploadOptions = {}): Promise<{ manifest: Manifest, urlIndex: string }> {
		const { distributionStrategy = 'round-robin', targetChain } = options;
		log.info(`'${filePath}' をアップロードします (戦略: ${distributionStrategy})`);

		const fileBuffer = await fs.readFile(filePath);
		const chunks = options.chunkSize ? this.splitBufferIntoChunks(fileBuffer, options.chunkSize) : await splitFileIntoChunks(filePath);
		const uniqueSuffix = `file-${Date.now()}`;
		const urlIndex = encodeURIComponent(siteUrl);

		const chunkUploadPromises = chunks.map(async (chunk, i) => {
			const chunkIndex = `${uniqueSuffix}-${i}`;
			let uploadTarget: DataChainId;

			switch (distributionStrategy) {
				case 'manual':
					if (!targetChain) throw new Error("手動配布戦略では'targetChain'を指定する必要があります。");
					uploadTarget = targetChain;
					break;
				case 'auto':
					uploadTarget = await this.getQuietestChain();
					break;
				case 'round-robin':
				default:
					const target = this.dataChains[i % this.dataChains.length];
					if (!target) throw new Error("アップロード先のdatachainが見つかりません。");
					uploadTarget = target;
					break;
			}

			log.info(`  -> チャンク #${i} (${(chunk.length / 1024).toFixed(2)} KB) を ${uploadTarget} へ...`);
			// (★★★ 修正箇所 ★★★) 堅牢なアップロード関数を呼び出す
			await this._uploadAndVerifyChunk(uploadTarget, chunkIndex, chunk);
			return chunkIndex;
		});

		const uploadedChunkIndexes = await Promise.all(chunkUploadPromises);

		const manifest: Manifest = {
			filepath: path.basename(filePath),
			chunks: uploadedChunkIndexes,
		};
		const manifestString = JSON.stringify(manifest);

		log.info(`マニフェストを metachain にアップロードします (URL: ${siteUrl})`);
		// (★★★ 修正箇所 ★★★) 堅牢なアップロード関数を呼び出す
		await this._uploadAndVerifyManifest(urlIndex, manifestString);

		log.success(`アップロードとAPIでの検証が完了しました: ${siteUrl}`);
		return { manifest, urlIndex };
	}

	/**
	 * 指定されたURLからファイルを取得し、内容をBufferとして返します。
	 * @param siteUrl 取得するサイトのURL
	 * @returns 復元されたファイルの内容
	 */
	async downloadFile(siteUrl: string): Promise<Buffer> {
		const urlIndex = encodeURIComponent(siteUrl);
		log.info(`Metachainからマニフェストを取得します (URL: ${siteUrl})`);
		const manifestResult = await queryStoredManifest(urlIndex);

		if (!manifestResult.stored_manifest?.manifest) {
			throw new Error(`マニフェストが見つからないか、応答の形式が不正です。`);
		}

		const manifest: Manifest = JSON.parse(manifestResult.stored_manifest.manifest);
		log.success(`マニフェスト取得完了。${manifest.chunks.length}個のチャンクをダウンロードします。`);

		const chunkDownloadPromises = manifest.chunks.map((chunkIndex, i) => {
			const targetChain = this.dataChains[i % this.dataChains.length];
			if (!targetChain) {
				throw new Error(`チャンク '${chunkIndex}' の取得先datachainが見つかりません。`);
			}
			log.info(`  -> チャンク '${chunkIndex}' を ${targetChain} から取得中...`);
			return queryStoredChunk(targetChain, chunkIndex);
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

	/**
	 * 指定されたサイズのテストファイルを生成します。
	 * @param filePath ファイルパス
	 * @param sizeInKb ファイルサイズ (KB)
	 * @returns 生成されたファイルの内容
	 */
	async createTestFile(filePath: string, sizeInKb: number): Promise<string> {
		const buffer = Buffer.alloc(sizeInKb * 1024, 'a');
		const content = `Test file of ${sizeInKb} KB. Unique ID: ${Date.now()}`;
		buffer.write(content); // バッファの先頭に識別用文字列を書き込む

		await fs.writeFile(filePath, buffer);
		log.info(`${sizeInKb} KBのテストファイルを生成しました: ${filePath}`);
		return buffer.toString('utf-8');
	}

	/**
	 * 最も保留中のトランザクションが少ないdatachainを返します。
	 * @returns 最も空いているdatachainのID
	 */
	async getQuietestChain(): Promise<DataChainId> {
		const statuses = await Promise.all(this.dataChains.map(id => this.getChainStatus(id)));
		const quietest = statuses.reduce((prev, curr) => (prev.pendingTxs < curr.pendingTxs ? prev : curr));
		log.info(`自動選択: ${quietest.chainId} が最も空いています (保留tx: ${quietest.pendingTxs})`);
		return quietest.chainId;
	}

	/**
	 * 指定されたdatachainの保留トランザクション数を取得します。
	 * @param chainId 調査するdatachainのID
	 * @returns チェーンのステータス
	 */
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
			return { chainId, pendingTxs: Infinity }; // 失敗したチェーンは選択対象から外す
		}
	}

	// Bufferを直接チャンクに分割するプライベートメソッド
	private splitBufferIntoChunks(buffer: Buffer, chunkSize: number): Buffer[] {
		const chunks: Buffer[] = [];
		for (let i = 0; i < buffer.length; i += chunkSize) {
			chunks.push(buffer.subarray(i, i + chunkSize));
		}
		return chunks;
	}
}

