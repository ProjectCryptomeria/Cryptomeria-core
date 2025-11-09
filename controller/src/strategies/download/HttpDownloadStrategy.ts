// controller/src/strategies/download/HttpDownloadStrategy.ts
import {
	// ★ 修正: タプル型をインポート
	ChunkLocationTuple,
	Manifest,
	RunnerContext,
	StoredChunkResponse,
	StoredManifestResponse
} from '../../types';
import { DownloadResult } from '../../types/experiment';
import { log } from '../../utils/logger';
import { HttpCommunicationStrategy } from '../communication/HttpCommunicationStrategy';
import { ICommunicationStrategy } from '../communication/ICommunicationStrategy';
import { IDownloadStrategy } from './IDownloadStrategy';

// チャンクを並列でダウンロードする際の最大同時接続数
const MAX_CONCURRENT_DOWNLOADS = 10;

/**
 * HTTP/REST API を使用して Raidchain からデータをダウンロードする戦略。
 * 内部で HttpCommunicationStrategy を使用します。
 */
export class HttpDownloadStrategy implements IDownloadStrategy {

	private httpCommStrategy: HttpCommunicationStrategy;

	constructor() {
		log.debug('HttpDownloadStrategy がインスタンス化されました。(内部で HttpCommunicationStrategy を使用)');
		this.httpCommStrategy = new HttpCommunicationStrategy();
	}

	public async execute(
		context: RunnerContext,
		targetUrl: string // エンコード前の完全なURLを受け取る
	): Promise<DownloadResult> {

		const startTime = process.hrtime.bigint() / 1_000_000n;
		log.info(`[Download] 開始... URL (Raw): ${targetUrl}`);

		const { chainManager, infraService, urlPathCodec } = context;
		const commStrategy = this.httpCommStrategy;

		try {
			// --- URL 解析 ---
			const urlParts = urlPathCodec.parseTargetUrl(targetUrl);

			// 1. metachain の API エンドポイントを取得
			const metachain = chainManager.getMetachainInfo();
			const apiEndpoints = await infraService.getApiEndpoints();
			const metachainApiUrl = apiEndpoints[metachain.name];
			if (!metachainApiUrl) {
				throw new Error(`metachain (${metachain.name}) の API エンドポイントが見つかりません。`);
			}
			await commStrategy.connect(metachainApiUrl);

			// 2. metachain からマニフェストを取得
			log.debug(`[Download] metachain (${metachain.name}) からマニフェストを取得中 (BaseURL Raw: ${urlParts.baseUrlRaw})...`);
			const manifestPath = `/metachain/metastore/v1/stored_manifest/${urlParts.baseUrlEncoded}`;

			const manifestResponse: StoredManifestResponse = await commStrategy.sendRestRequest(
				`${metachainApiUrl}${manifestPath}`
			);

			if (!manifestResponse.stored_manifest || !manifestResponse.stored_manifest.manifest) {
				throw new Error(`マニフェストが見つかりません (BaseURL Raw: ${urlParts.baseUrlRaw})`);
			}

			// ★ 修正: 圧縮マニフェストをパース
			const manifest: Manifest = JSON.parse(manifestResponse.stored_manifest.manifest);
			log.debug(`[Download] マニフェスト取得成功。`);

			// ★ 修正: chainMap から逆引き辞書を作成
			const chainMapReversed: { [index: number]: string } = {};
			for (const [chainName, index] of Object.entries(manifest.chainMap)) {
				chainMapReversed[index] = chainName;
			}
			log.debug(`[Download] ChainMap 逆引き辞書を作成: ${JSON.stringify(chainMapReversed)}`);


			// 3. datachain の API エンドポイントを取得し、commStrategy に接続
			const datachainInfos = chainManager.getDatachainInfos();
			const datachainApiUrls = new Map<string, string>();
			for (const info of datachainInfos) {
				const url = apiEndpoints[info.name];
				if (!url) throw new Error(`datachain (${info.name}) の API エンドポイントが見つかりません。`);
				await commStrategy.connect(url);
				datachainApiUrls.set(info.name, url);
			}

			// 4. マニフェストからチャンク情報 (タプル) を取得
			// ★ 修正: 型を ChunkLocationTuple[] に変更
			const chunkLocationTuples = manifest.files[urlParts.filePathEncoded];
			if (!chunkLocationTuples || chunkLocationTuples.length === 0) {
				throw new Error(`マニフェスト内にファイルパス "${urlParts.filePathRaw}" のチャンク情報が見つかりません。`);
			}
			log.info(`[Download] ファイル "${urlParts.filePathRaw}" の ${chunkLocationTuples.length} 個のチャンクを並列ダウンロード (同時 ${MAX_CONCURRENT_DOWNLOADS})`);

			// 5. チャンクを並列ダウンロード
			const chunkBuffers: (Buffer | null)[] = await this.downloadChunksConcurrently(
				chunkLocationTuples, // ★ 修正: タプルリスト
				datachainApiUrls,
				chainMapReversed, // ★ 修正: 逆引き辞書
				commStrategy
			);

			// 6. データを復元
			const validBuffers = chunkBuffers.filter((b): b is Buffer => b !== null);
			if (validBuffers.length !== chunkLocationTuples.length) {
				throw new Error(`チャンクのダウンロードに失敗しました (期待: ${chunkLocationTuples.length}, 取得: ${validBuffers.length})`);
			}

			const downloadedData = Buffer.concat(validBuffers);

			const endTime = process.hrtime.bigint() / 1_000_000n;
			const durationMs = endTime - startTime;

			// --- ★ ログレベル変更 (info -> success) ---
			log.success(`[Download] 完了。所要時間: ${durationMs} ms, サイズ: ${downloadedData.length} bytes`);

			return {
				startTime,
				endTime,
				durationMs,
				downloadedData,
				downloadedDataHash: undefined, // 必要ならここでハッシュ計算
			};

		} catch (error: any) {
			log.error(`[Download] ダウンロード処理中にエラーが発生しました (URL Raw: ${targetUrl})。`, error);
			throw error; // エラーを再スロー
		} finally {
			try {
				await commStrategy.disconnect();
				log.debug('[Download] HttpCommunicationStrategy の接続を切断しました。');
			} catch (disconnectError) {
				log.warn('[Download] HttpCommunicationStrategy 切断中にエラー:', disconnectError);
			}
		}
	}

	/**
	 * チャンクインデックスのリストを受け取り、並列でダウンロードします。
	 * ★ 修正: マニフェストのタプルと逆引き辞書を受け取るように変更
	 */
	private async downloadChunksConcurrently(
		chunkLocationTuples: ChunkLocationTuple[],
		datachainApiUrls: Map<string, string>,
		chainMapReversed: { [index: number]: string }, // ★ 修正
		commStrategy: ICommunicationStrategy
	): Promise<(Buffer | null)[]> {

		// ★ 修正: 推定ロジック (datachainNames, datachainCount) を削除

		const downloadTasks = chunkLocationTuples.map((tuple) => {
			const [index, chainMapIndex] = tuple; // ★ 修正: タプルを分解

			// ★ 修正: 逆引き辞書から実績のチェーン名を取得
			const chainName = chainMapReversed[chainMapIndex];
			if (!chainName) {
				throw new Error(`マニフェストの chainMap にインデックス ${chainMapIndex} が見つかりません。`);
			}

			// ★ 修正: 実績のチェーン名から API URL を取得
			const apiUrl = datachainApiUrls.get(chainName);

			if (!apiUrl) throw new Error(`チャンク ${index} の割り当て先チェーン ${chainName} のURLが見つかりません。`);

			const encodedIndex = encodeURIComponent(index);
			const path = `${apiUrl}/datachain/datastore/v1/stored_chunk/${encodedIndex}`;

			return { index, path, chainName };
		});

		// 並列実行 (変更なし)
		const results: (Buffer | null)[] = new Array(downloadTasks.length).fill(null);
		const queue = [...downloadTasks.entries()];
		let activeDownloads = 0;

		return new Promise((resolve, reject) => {
			const runNext = () => {
				if (queue.length === 0 && activeDownloads === 0) {
					resolve(results);
					return;
				}

				while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && queue.length > 0) {
					const [originalIndex, task] = queue.shift()!;
					activeDownloads++;

					log.debug(`[Download] チャンク取得開始: ${task.index} (from ${task.chainName})`);

					commStrategy.sendRestRequest(task.path)
						.then((response: StoredChunkResponse) => {
							if (!response.stored_chunk || !response.stored_chunk.data) {
								throw new Error(`チャンク ${task.index} のレスポンス形式が無効です。`);
							}
							results[originalIndex] = Buffer.from(response.stored_chunk.data, 'base64');
							log.debug(`[Download] チャンク取得完了: ${task.index}`);
						})
						.catch(error => {
							log.warn(`[Download] チャンク ${task.index} の取得に失敗しました。`, error);
						})
						.finally(() => {
							activeDownloads--;
							runNext();
						});
				}
			};

			runNext();
		});
	}
}