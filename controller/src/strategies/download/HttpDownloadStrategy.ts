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

	// ★ 修正: インスタンスを内部で持つのではなく、Context経由で受け取る想定
	// private httpCommStrategy: HttpCommunicationStrategy;

	constructor() {
		log.debug('HttpDownloadStrategy がインスタンス化されました。');
		// ★ 修正: インスタンス生成を削除
		// this.httpCommStrategy = new HttpCommunicationStrategy();
	}

	public async execute(
		context: RunnerContext,
		targetUrl: string // ★ エンコード前の完全なURLを受け取る
	): Promise<DownloadResult> {

		const startTime = process.hrtime.bigint() / 1_000_000n;
		// ★ 修正: ログにRaw URL を使用
		log.info(`[Download] 開始... URL (Raw): ${targetUrl}`);

		// ★ 修正: UrlPathCodec と CommunicationStrategy をコンテキストから取得
		const { chainManager, infraService, communicationStrategy, urlPathCodec } = context;

		// ★ 修正: この戦略はHTTP通信のみサポート（型ガード/チェック）
		if (!(communicationStrategy instanceof HttpCommunicationStrategy)) {
			// WebSocket でも sendRestRequest をフォールバック実装している場合があるが、
			// 本来の設計としては HTTP 戦略を使うべき
			log.warn('[Download] HttpDownloadStrategy は HttpCommunicationStrategy の使用を推奨します。');
			// throw new Error('HttpDownloadStrategy requires HttpCommunicationStrategy.');
		}
		// ★ 修正: Context の CommunicationStrategy を使用する
		const commStrategy = communicationStrategy;

		try {
			// --- ★ 修正箇所: targetUrl を UrlParts に解析 ★ ---
			const urlParts = urlPathCodec.parseTargetUrl(targetUrl);
			// ----------------------------------------------------

			// 1. metachain の API エンドポイントを取得
			const metachain = chainManager.getMetachainInfo();
			const apiEndpoints = await infraService.getApiEndpoints();
			const metachainApiUrl = apiEndpoints[metachain.name];
			if (!metachainApiUrl) {
				throw new Error(`metachain (${metachain.name}) の API エンドポイントが見つかりません。`);
			}

			// ★ 修正: 通信戦略への接続は Runner で行われる想定のため connect 呼び出しを削除
			// await commStrategy.connect(metachainApiUrl);

			// 2. metachain からマニフェストを取得
			// ★ 修正: ログに Raw 値を使用
			log.debug(`[Download] metachain (${metachain.name}) からマニフェストを取得中 (BaseURL Raw: ${urlParts.baseUrlRaw})...`);

			// ★ 修正: クエリにはエンコード済みのベースURLを使用
			const manifestPath = `/metachain/metastore/v1/stored_manifest/${urlParts.baseUrlEncoded}`;

			// ★ 修正: sendRestRequest には完全なAPIエンドポイント + パス を渡す
			const manifestResponse: StoredManifestResponse = await commStrategy.sendRestRequest(
				`${metachainApiUrl}${manifestPath}`
			);

			if (!manifestResponse.manifest || !manifestResponse.manifest.manifest) {
				// ★ 修正: エラーログに Raw 値を使用
				throw new Error(`マニフェストが見つかりません (BaseURL Raw: ${urlParts.baseUrlRaw})`);
			}

			const manifest: Manifest = JSON.parse(manifestResponse.manifest.manifest);
			log.debug(`[Download] マニフェスト取得成功。`);

			// 3. datachain の API エンドポイントを取得
			const datachainInfos = chainManager.getDatachainInfos();
			const datachainApiUrls = new Map<string, string>();
			for (const info of datachainInfos) {
				const url = apiEndpoints[info.name];
				if (!url) throw new Error(`datachain (${info.name}) の API エンドポイントが見つかりません。`);

				// ★ 修正: connect 呼び出しを削除
				// await commStrategy.connect(url);
				datachainApiUrls.set(info.name, url);
			}

			// 4. マニフェスト内のファイルパスに対応するチャンクインデックスを取得
			// ★ 修正: マニフェストのキーにはエンコード済みのファイルパスを使用
			const chunkIndexes = manifest[urlParts.filePathEncoded];

			if (!chunkIndexes || chunkIndexes.length === 0) {
				// ★ 修正: エラーログに Raw 値を使用
				throw new Error(`マニフェスト内にファイルパス "${urlParts.filePathRaw}" のチャンク情報が見つかりません。`);
			}
			// ★ 修正: ログに Raw 値を使用
			log.info(`[Download] ファイル "${urlParts.filePathRaw}" の ${chunkIndexes.length} 個のチャンクを並列ダウンロード (同時 ${MAX_CONCURRENT_DOWNLOADS})`);

			// 5. チャンクを並列ダウンロード
			const chunkBuffers: (Buffer | null)[] = await this.downloadChunksConcurrently(
				chunkIndexes,
				datachainApiUrls,
				commStrategy // ★ Context の CommunicationStrategy を渡す
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

			// ★ 修正: disconnect 呼び出しは Runner で行うため削除
			// await commStrategy.disconnect();

			return {
				startTime,
				endTime,
				durationMs,
				downloadedData,
				downloadedDataHash: undefined,
			};

		} catch (error: any) {
			// ★ 修正: disconnect 呼び出し削除
			/*
			try {
				await commStrategy.disconnect();
			} catch (e) {
				log.warn('[Download] エラー発生時のHttpCommStrategy切断中にエラー:', e);
			}
			*/

			log.error(`[Download] ダウンロード処理中にエラーが発生しました (URL Raw: ${targetUrl})。`, error);
			throw error;
		}
	}

	/**
	 * チャンクインデックスのリストを受け取り、並列でダウンロードします。
	 */
	private async downloadChunksConcurrently(
		chunkIndexes: string[],
		datachainApiUrls: Map<string, string>,
		commStrategy: ICommunicationStrategy // ★ 引数で受け取る
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

			// ★ 修正: chunk index も念のためエンコードする
			const encodedIndex = encodeURIComponent(index);
			// ★ 修正: sendRestRequest に渡すのは完全なURL
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

					// ★ 修正: 引数で受け取った commStrategy を使用
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