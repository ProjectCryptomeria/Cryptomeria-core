// controller/src/strategies/download/HttpDownloadStrategy.ts
import { Manifest, RunnerContext, StoredChunkResponse, StoredManifestResponse } from '../../types';
import { DownloadResult } from '../../types/experiment';
import { log } from '../../utils/logger';
// ★ 修正: HttpCommunicationStrategy をインポート
import { HttpCommunicationStrategy } from '../communication/HttpCommunicationStrategy';
import { ICommunicationStrategy } from '../communication/ICommunicationStrategy'; // downloadChunksConcurrently の型注釈に必要
import { IDownloadStrategy } from './IDownloadStrategy';

// チャンクを並列でダウンロードする際の最大同時接続数
const MAX_CONCURRENT_DOWNLOADS = 10;

/**
 * HTTP/REST API を使用して Raidchain からデータをダウンロードする戦略。
 * 内部で HttpCommunicationStrategy を使用します。
 */
export class HttpDownloadStrategy implements IDownloadStrategy {

	// ★ 修正: HttpCommunicationStrategy のインスタンスを内部で保持
	private httpCommStrategy: HttpCommunicationStrategy;

	constructor() {
		log.debug('HttpDownloadStrategy がインスタンス化されました。(内部で HttpCommunicationStrategy を使用)');
		// ★ 修正: インスタンスを生成
		this.httpCommStrategy = new HttpCommunicationStrategy();
	}

	public async execute(
		context: RunnerContext,
		targetUrl: string // ★ エンコード前の完全なURLを受け取る
	): Promise<DownloadResult> {

		const startTime = process.hrtime.bigint() / 1_000_000n;
		log.info(`[Download] 開始... URL (Raw): ${targetUrl}`);

		// ★ 修正: Context から urlPathCodec のみ取得
		const { chainManager, infraService, urlPathCodec } = context;
		// ★ 修正: 内部の httpCommStrategy を使用
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

			// ★ 修正: 内部の commStrategy を使用して接続
			await commStrategy.connect(metachainApiUrl);

			// 2. metachain からマニフェストを取得
			log.debug(`[Download] metachain (${metachain.name}) からマニフェストを取得中 (BaseURL Raw: ${urlParts.baseUrlRaw})...`);
			const manifestPath = `/metachain/metastore/v1/stored_manifest/${urlParts.baseUrlEncoded}`;

			// ★ 修正: 内部の commStrategy を使用
			const manifestResponse: StoredManifestResponse = await commStrategy.sendRestRequest(
				`${metachainApiUrl}${manifestPath}`
			);

			if (!manifestResponse.stored_manifest || !manifestResponse.stored_manifest.manifest) {
				throw new Error(`マニフェストが見つかりません (BaseURL Raw: ${urlParts.baseUrlRaw})`);
			}

			const manifest: Manifest = JSON.parse(manifestResponse.stored_manifest.manifest);
			log.debug(`[Download] マニフェスト取得成功。`);

			// 3. datachain の API エンドポイントを取得し、commStrategy に接続
			const datachainInfos = chainManager.getDatachainInfos();
			const datachainApiUrls = new Map<string, string>();
			for (const info of datachainInfos) {
				const url = apiEndpoints[info.name];
				if (!url) throw new Error(`datachain (${info.name}) の API エンドポイントが見つかりません。`);

				// ★ 修正: 内部の commStrategy を使用して接続
				await commStrategy.connect(url);
				datachainApiUrls.set(info.name, url);
			}

			// 4. マニフェストからチャンクインデックスを取得
			const chunkIndexes = manifest[urlParts.filePathEncoded];
			if (!chunkIndexes || chunkIndexes.length === 0) {
				throw new Error(`マニフェスト内にファイルパス "${urlParts.filePathRaw}" のチャンク情報が見つかりません。`);
			}
			log.info(`[Download] ファイル "${urlParts.filePathRaw}" の ${chunkIndexes.length} 個のチャンクを並列ダウンロード (同時 ${MAX_CONCURRENT_DOWNLOADS})`);

			// 5. チャンクを並列ダウンロード
			const chunkBuffers: (Buffer | null)[] = await this.downloadChunksConcurrently(
				chunkIndexes,
				datachainApiUrls,
				commStrategy // ★ 内部の commStrategy を渡す
			);

			// 6. データを復元
			const validBuffers = chunkBuffers.filter((b): b is Buffer => b !== null);
			if (validBuffers.length !== chunkIndexes.length) {
				throw new Error(`チャンクのダウンロードに失敗しました (期待: ${chunkIndexes.length}, 取得: ${validBuffers.length})`);
			}

			const downloadedData = Buffer.concat(validBuffers);

			const endTime = process.hrtime.bigint() / 1_000_000n;
			const durationMs = endTime - startTime;

			log.info(`[Download] 完了。所要時間: ${durationMs} ms, サイズ: ${downloadedData.length} bytes`);

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
			// ★ 修正: 処理終了後（成功・失敗問わず）に必ず切断
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
	 */
	private async downloadChunksConcurrently(
		chunkIndexes: string[],
		datachainApiUrls: Map<string, string>,
		commStrategy: ICommunicationStrategy // ★ 型注釈は ICommunicationStrategy のまま（sendRestRequest を使うため）
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