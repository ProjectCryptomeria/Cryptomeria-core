// controller/src/strategies/download/HttpDownloadStrategy.ts
import { Manifest, RunnerContext, StoredChunkResponse, StoredManifestResponse } from '../../types';
import { DownloadResult } from '../../types/experiment';
import { log } from '../../utils/logger';
import { HttpCommunicationStrategy } from '../communication/HttpCommunicationStrategy';
import { ICommunicationStrategy } from '../communication/ICommunicationStrategy';
import { IDownloadStrategy } from './IDownloadStrategy';

// チャンクを並列でダウンロードする際の最大同時接続数
const MAX_CONCURRENT_DOWNLOADS = 10;

/**
 * HTTP/REST API を使用して Raidchain からデータをダウンロードする戦略。
 */
export class HttpDownloadStrategy implements IDownloadStrategy {

	private httpCommStrategy: HttpCommunicationStrategy;

	constructor() {
		log.debug('HttpDownloadStrategy がインスタンス化されました。');
		this.httpCommStrategy = new HttpCommunicationStrategy();
	}

	public async execute(
		context: RunnerContext,
		targetUrl: string // フルURL (例: case1.test/1761686432543/data.bin)
	): Promise<DownloadResult> {

		const startTime = process.hrtime.bigint() / 1_000_000n;
		log.info(`[Download] 開始... URL: ${targetUrl}`);

		const { chainManager, infraService } = context;
		const commStrategy = this.httpCommStrategy;

		try {
			// --- ★ 修正箇所: targetUrl を metachainUrl と filePath に分割 ★ ---
			const lastSlashIndex = targetUrl.lastIndexOf('/');
			if (lastSlashIndex === -1 || lastSlashIndex === targetUrl.length - 1) {
				throw new Error(`[Download] targetUrl "${targetUrl}" の形式が無効です (ベースURLとファイルパスに分割できません)。`);
			}

			const metachainUrl = targetUrl.substring(0, lastSlashIndex); // 例: case1.test/1761686813561 (MsgCreateStoredManifest.url)
			const relativeFilePath = targetUrl.substring(lastSlashIndex); // 例: /data.bin
			const encodedFilePath = encodeURIComponent(relativeFilePath); // Manifestのキーはエンコードされている
			// --- ★ 修正箇所ここまで ★ ---

			// 1. metachain の API エンドポイントを取得
			const metachain = chainManager.getMetachainInfo();
			const apiEndpoints = await infraService.getApiEndpoints();
			const metachainApiUrl = apiEndpoints[metachain.name];
			if (!metachainApiUrl) {
				throw new Error(`metachain (${metachain.name}) の API エンドポイントが見つかりません。`);
			}

			await commStrategy.connect(metachainApiUrl);

			// 2. metachain からマニフェストを取得
			log.debug(`[Download] metachain (${metachainApiUrl}) からマニフェストを取得中...`);

			// ★ 修正点1: 検索キーとして metachainUrl (ベースURL部分) を使用し、URIエンコードする
			const encodedMetachainUrl = encodeURIComponent(metachainUrl);
			const manifestPath = `/metachain/metastore/v1/stored_manifest/${encodedMetachainUrl}`;

			const manifestResponse: StoredManifestResponse = await commStrategy.sendRestRequest(
				`${metachainApiUrl}${manifestPath}`
			);

			if (!manifestResponse.manifest || !manifestResponse.manifest.manifest) {
				throw new Error(`マニフェストが見つかりません (URL: ${metachainUrl})`);
			}

			const manifest: Manifest = JSON.parse(manifestResponse.manifest.manifest);
			log.debug(`[Download] マニフェスト取得成功。`);

			// 3. datachain の API エンドポイントを取得 (変更なし)
			const datachainInfos = chainManager.getDatachainInfos();
			const datachainApiUrls = new Map<string, string>();
			for (const info of datachainInfos) {
				const url = apiEndpoints[info.name];
				if (!url) throw new Error(`datachain (${info.name}) の API エンドポイントが見つかりません。`);

				await commStrategy.connect(url);
				datachainApiUrls.set(info.name, url);
			}

			// 4. マニフェスト内のすべてのファイルパスとチャンクインデックスを取得
			// ★ 修正点2: ManifestのキーはURIエンコードされたファイルパスで検索する
			const chunkIndexes = manifest[encodedFilePath];

			if (!chunkIndexes || chunkIndexes.length === 0) {
				throw new Error(`マニフェスト内にファイルパス "${relativeFilePath}" (${encodedFilePath}) のチャンク情報が見つかりません。`);
			}

			log.info(`[Download] ${chunkIndexes.length} 個のチャンクを並列ダウンロード (同時 ${MAX_CONCURRENT_DOWNLOADS})`);

			// 5. チャンクを並列ダウンロード
			const chunkBuffers: (Buffer | null)[] = await this.downloadChunksConcurrently(
				chunkIndexes,
				datachainApiUrls,
				commStrategy
			);

			// 6. データを復元 (Buffer.concat)
			const validBuffers = chunkBuffers.filter((b): b is Buffer => b !== null);
			if (validBuffers.length !== chunkIndexes.length) {
				throw new Error(`チャンクのダウンロードに失敗しました (期待: ${chunkIndexes.length}, 取得: ${validBuffers.length})`);
			}

			const downloadedData = Buffer.concat(validBuffers);

			const endTime = process.hrtime.bigint() / 1_000_000n;
			const durationMs = endTime - startTime;

			log.info(`[Download] 完了。所要時間: ${durationMs} ms, サイズ: ${downloadedData.length} bytes`);

			await commStrategy.disconnect();

			return {
				startTime,
				endTime,
				durationMs,
				downloadedData,
				downloadedDataHash: undefined,
			};

		} catch (error: any) {
			try {
				await commStrategy.disconnect();
			} catch (e) {
				log.warn('[Download] エラー発生時のHttpCommStrategy切断中にエラー:', e);
			}

			log.error(`[Download] ダウンロード処理中にエラーが発生しました。`, error);
			throw error;
		}
	}

	/**
	 * チャンクインデックスのリストを受け取り、並列でダウンロードします。
	 */
	private async downloadChunksConcurrently(
		chunkIndexes: string[],
		datachainApiUrls: Map<string, string>,
		commStrategy: ICommunicationStrategy
	): Promise<(Buffer | null)[]> {

		const datachainNames = Array.from(datachainApiUrls.keys()).sort();
		const datachainCount = datachainNames.length;
		if (datachainCount === 0) throw new Error('ダウンロード先の datachain がありません。');

		const downloadTasks = chunkIndexes.map((index) => {
			const parts = index.split('-');
			const chunkNum = parseInt(parts[parts.length - 1] ?? '0', 10);

			const chainIndex = chunkNum % datachainCount;
			const chainName = datachainNames[chainIndex];
			const apiUrl = datachainApiUrls.get(chainName!);

			if (!apiUrl) throw new Error(`チャンク ${index} の割り当て先チェーン ${chainName} のURLが見つかりません。`);

			const encodedIndex = encodeURIComponent(index);
			const path = `${apiUrl}/datachain/datastore/v1/stored_chunk/${encodedIndex}`;

			return { index, path, chainName };
		});

		// 並列実行
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
							// Base64 デコード
							results[originalIndex] = Buffer.from(response.stored_chunk.data, 'base64');
							log.debug(`[Download] チャンク取得完了: ${task.index}`);
						})
						.catch(error => {
							log.warn(`[Download] チャンク ${task.index} の取得に失敗しました。`, error);
							// results[originalIndex] は null のまま
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