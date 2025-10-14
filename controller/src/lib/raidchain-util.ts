import * as fs from 'fs/promises';
import * as path from 'path';
import { uploadChunkToDataChain, uploadManifestToMetaChain } from '../blockchain';
import { queryStoredChunk, queryStoredManifest } from './blockchain-query';
import { splitFileIntoChunks } from './chunker';
import { getChainInfo, getRpcEndpoints } from './k8s-client';

// データチェーンの一意な識別子（例: "data-0", "data-1"）
export type DataChainId = string;

// ファイルのチャンクをどのデータチェーンに分散させるかの戦略
// 'round-robin': 均等に分散
// 'manual': 特定のチェーンに固定
// 'auto': 空いているチェーンに自動的に割り振る
export type DistributionStrategy = 'round-robin' | 'manual' | 'auto';

// ファイルの個々の断片（チャンク）に関する情報
export interface ChunkInfo {
	index: string; // チャンクの一意なID
	chain: DataChainId; // このチャンクが保存されているデータチェーンのID
}

// ファイル全体の構造を定義するマニフェスト
export interface Manifest {
	filepath: string; // 元のファイル名
	chunks: ChunkInfo[]; // ファイルを構成するチャンクのリスト
}

// ファイルアップロード時に指定可能なオプション
export interface UploadOptions {
	chunkSize?: number; // 各チャンクのサイズ（バイト単位）
	distributionStrategy?: DistributionStrategy; // チャンクの分散戦略
	targetChain?: DataChainId; // 'manual'戦略の時に使用するターゲットチェーン
}

// 各チェーンの状態を表すインターフェース
export interface ChainStatus {
	chainId: DataChainId; // チェーンのID
	pendingTxs: number; // 処理待ちのトランザクション数
}

// ログ出力用のヘルパーオブジェクト
export const log = {
	info: (msg: string) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
	success: (msg: string) => console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`),
	error: (msg: string) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
	step: (msg: string) => console.log(`\n\x1b[1;33m--- ${msg} ---\x1b[0m`),
};

// Raidchainとのやり取りを抽象化するクライアントクラス
export class RaidchainClient {
	private dataChains: DataChainId[] = []; // 利用可能なデータチェーンのリスト
	private metaChain: string | null = null; // メタデータチェーンのID
	private isInitialized = false; // 初期化が完了したかどうかのフラグ
	private verificationTimeoutMs = 20000; // トランザクション検証のタイムアウト（ミリ秒）
	private verificationPollIntervalMs = 1000; // トランザクション検証のポーリング間隔（ミリ秒）

	constructor() { }

	// クライアントを初期化する
	async initialize() {
		if (this.isInitialized) return; // すでに初期化済みなら何もしない

		log.info('RaidchainClientを初期化しています。チェーン情報を取得中...');
		const chainInfos = await getChainInfo();
		this.dataChains = chainInfos
			.filter(c => c.type === 'datachain')
			.map(c => c.name);

		const metaChainInfo = chainInfos.find(c => c.type === 'metachain');
		if (metaChainInfo) {
			this.metaChain = metaChainInfo.name;
		} else {
			throw new Error("メタチェーンがクラスタ内で見つかりません。");
		}

		if (this.dataChains.length === 0) {
			console.warn("警告: データチェーンが見つかりません。");
		}

		this.isInitialized = true;
		log.info(`RaidchainClientの初期化が完了しました。データチェーン: ${this.dataChains.length}個, メタチェーン: '${this.metaChain}'`);
	}

	// 1つのチャンクをアップロードし、ブロックに取り込まれるまで確認する
	private async _uploadAndVerifyChunk(targetChain: DataChainId, chunkIndex: string, chunk: Buffer): Promise<void> {
		const txResult = await uploadChunkToDataChain(targetChain, chunkIndex, chunk);
		if (txResult.code !== 0) {
			throw new Error(`チャンク ${chunkIndex} の ${targetChain} へのアップロードトランザクションが失敗しました (Code: ${txResult.code}): ${txResult.rawLog}`);
		}
		log.info(`  ... tx (${txResult.transactionHash.slice(0, 10)}...) 成功。検証中...`);

		const startTime = Date.now();
		while (Date.now() - startTime < this.verificationTimeoutMs) {
			try {
				await queryStoredChunk(targetChain, chunkIndex);
				log.success(`  ... チャンク '${chunkIndex}' がチェーン上で検証されました。`);
				return;
			} catch (error: any) {
				// 'not found' エラーの場合はリトライを続ける
				if (error.message && error.message.includes('not found')) {
					await new Promise(resolve => setTimeout(resolve, this.verificationPollIntervalMs));
				} else {
					throw error;
				}
			}
		}
		throw new Error(`チャンク '${chunkIndex}' の検証がタイムアウトしました。`);
	}

	// マニフェストファイルをアップロードし、ブロックに取り込まれるまで確認する
	private async _uploadAndVerifyManifest(urlIndex: string, manifestString: string): Promise<void> {
		if (!this.metaChain) {
			throw new Error("メタチェーンが初期化されていません。");
		}
		const txResult = await uploadManifestToMetaChain(this.metaChain, urlIndex, manifestString);
		if (txResult.code !== 0) {
			throw new Error(`マニフェスト ${urlIndex} のアップロードトランザクションが失敗しました (Code: ${txResult.code}): ${txResult.rawLog}`);
		}
		log.info(`  ... tx (${txResult.transactionHash.slice(0, 10)}...) 成功。検証中...`);

		const startTime = Date.now();
		while (Date.now() - startTime < this.verificationTimeoutMs) {
			try {
				await queryStoredManifest(this.metaChain, urlIndex);
				log.success(`  ... マニフェスト '${urlIndex}' がチェーン上で検証されました。`);
				return;
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

	/**
	 * ファイルをRaidchainネットワークにアップロードする
	 * @param filePath アップロードするファイルのパス
	 * @param siteUrl ファイルに紐付ける一意のURL
	 * @param options アップロードに関するオプション
	 * @returns 生成されたマニフェストとURLのインデックス
	 */
	public async uploadFile(filePath: string, siteUrl: string, options: UploadOptions = {}): Promise<{ manifest: Manifest, urlIndex: string }> {
		await this.initialize(); // 最初に初期化を実行
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

			// ワーカー関数: 利用可能なチャンクを取得してアップロードする
			const worker = async (chainId: DataChainId) => {
				while (chunksToUpload.length > 0) {
					const job = chunksToUpload.shift();
					if (!job) continue;

					log.info(`  -> [ワーカー: ${chainId}] チャンク '${job.index}' を処理中...`);
					await this._uploadAndVerifyChunk(chainId, job.index, job.chunk);
					uploadedChunks.push({ index: job.index, chain: chainId });
				}
			};

			const workerPromises = this.dataChains.map(chainId => worker(chainId));
			await Promise.all(workerPromises);

		} else {
			// 'manual' または 'round-robin' 戦略
			for (const [i, chunk] of chunks.entries()) {
				const chunkIndex = `${uniqueSuffix}-${i}`;
				let uploadTarget: DataChainId;

				if (distributionStrategy === 'manual') {
					if (!targetChain || !this.dataChains.includes(targetChain)) {
						throw new Error(`'manual'戦略では、有効なデータチェーンを'targetChain'で指定する必要があります。利用可能なチェーン: ${this.dataChains.join(', ')}`);
					}
					uploadTarget = targetChain;
				} else { // 'round-robin'
					if (this.dataChains.length === 0) {
						throw new Error("アップロード可能なデータチェーンがありません。");
					}
					uploadTarget = this.dataChains[i % this.dataChains.length]!;
				}

				log.info(`  -> チャンク #${i} (${(chunk.length / 1024).toFixed(2)} KB) を ${uploadTarget} へアップロード中...`);
				await this._uploadAndVerifyChunk(uploadTarget, chunkIndex, chunk);
				uploadedChunks.push({ index: chunkIndex, chain: uploadTarget });
			}
		}

		// チャンクの順番を保証するためにソート
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

		log.info(`${this.metaChain} へURL '${siteUrl}' のマニフェストをアップロードします`);
		await this._uploadAndVerifyManifest(urlIndex, manifestString);

		log.success(`'${siteUrl}' のアップロードと検証が完了しました。`);
		return { manifest, urlIndex };
	}

	/**
	 * Raidchainネットワークからファイルをダウンロードする
	 * @param siteUrl ダウンロードしたいファイルのURL
	 * @returns 復元されたファイルのBuffer
	 */
	async downloadFile(siteUrl: string): Promise<Buffer> {
		await this.initialize();
		const urlIndex = encodeURIComponent(siteUrl);
		if (!this.metaChain) {
			throw new Error("メタチェーンが初期化されていません。");
		}
		log.info(`${this.metaChain} からURL '${siteUrl}' のマニフェストを取得します`);
		const manifestResult = await queryStoredManifest(this.metaChain, urlIndex);

		if (!manifestResult.manifest || !manifestResult.manifest.manifest) {
			throw new Error(`マニフェストが見つからないか、レスポンスの形式が不正です: ${JSON.stringify(manifestResult)}`);
		}

		const manifest: Manifest = JSON.parse(manifestResult.manifest.manifest);
		log.success(`マニフェストを発見しました。${manifest.chunks.length}個のチャンクをダウンロードします。`);

		const chunkDownloadPromises = manifest.chunks.map(chunkInfo => {
			log.info(`  -> チャンク '${chunkInfo.index}' を ${chunkInfo.chain} から取得中...`);
			return queryStoredChunk(chunkInfo.chain, chunkInfo.index);
		});

		const chunkQueryResults = await Promise.all(chunkDownloadPromises);

		const chunkBuffers = chunkQueryResults.map((result, index) => {
			if (!result.stored_chunk || !result.stored_chunk.data) {
				throw new Error(`チャンク ${manifest.chunks[index]?.index} のデータ取得に失敗しました。レスポンス: ${JSON.stringify(result)}`);
			}
			return Buffer.from(result.stored_chunk.data, 'base64');
		});

		// チャンクを結合して元のファイルを復元
		return Buffer.concat(chunkBuffers);
	}

	/**
	 * 指定されたサイズのテストファイルを生成する
	 * @param filePath ファイルを保存するパス
	 * @param sizeInKb ファイルサイズ（キロバイト）
	 * @returns 生成されたファイルの内容
	 */
	async createTestFile(filePath: string, sizeInKb: number): Promise<string> {
		const buffer = Buffer.alloc(sizeInKb * 1024, 'a'); // 'a'で埋めたバッファを作成
		const content = `Test file of ${sizeInKb} KB. Unique ID: ${Date.now()}`;
		buffer.write(content);

		await fs.writeFile(filePath, buffer);
		log.info(`${sizeInKb} KB のテストファイルを ${filePath} に作成しました。`);
		return buffer.toString('utf-8');
	}

	/**
	 * 最も負荷の低い（保留中のトランザクションが最も少ない）データチェーンを見つける
	 * @returns 最も負荷の低いデータチェーンのID
	 */
	async getQuietestChain(): Promise<DataChainId> {
		await this.initialize();
		if (this.dataChains.length === 0) {
			throw new Error("最も空いているチェーンを判断するためのデータチェーンがありません。");
		}

		const statuses = await Promise.all(this.dataChains.map(id => this.getChainStatus(id)));
		const quietest = statuses.reduce((prev, curr) => (prev.pendingTxs < curr.pendingTxs ? prev : curr));
		log.info(`自動選択されたチェーン: ${quietest.chainId} (保留中のTX: ${quietest.pendingTxs})`);
		return quietest.chainId;
	}

	/**
	 * 特定のチェーンの現在の状態（保留中のトランザクション数）を取得する
	 * @param chainId 状態を取得するチェーンのID
	 * @returns チェーンの状態
	 */
	async getChainStatus(chainId: DataChainId): Promise<ChainStatus> {
		await this.initialize();
		const rpcEndpoints = await getRpcEndpoints(); // rpcEndpointsの取得を待つ
		const rpcEndpoint = rpcEndpoints[chainId];
		if (!rpcEndpoint) {
			throw new Error(`${chainId}のRPCエンドポイントが見つかりません。`);
		}

		try {
			const response = await fetch(`${rpcEndpoint}/num_unconfirmed_txs`);
			if (!response.ok) return { chainId, pendingTxs: Infinity }; // エラー時は無限大として扱う
			const data = await response.json();
			const pendingTxs = parseInt(data.result?.n_txs ?? '0', 10);
			return { chainId, pendingTxs };
		} catch (error) {
			log.error(`${chainId} のステータス取得に失敗: ${error}`);
			return { chainId, pendingTxs: Infinity }; // エラー時は無限大として扱う
		}
	}

	// バッファを指定されたサイズのチャンクに分割するプライベートメソッド
	private splitBufferIntoChunks(buffer: Buffer, chunkSize: number): Buffer[] {
		const chunks: Buffer[] = [];
		for (let i = 0; i < buffer.length; i += chunkSize) {
			chunks.push(buffer.subarray(i, i + chunkSize));
		}
		return chunks;
	}
}