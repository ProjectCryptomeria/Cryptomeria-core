// controller/src/strategies/download/HttpDownloadStrategy.ts
import { RunnerContext, Manifest, StoredManifestResponse, StoredChunkResponse } from '../../types';
import { log } from '../../utils/logger';
import { IDownloadStrategy } from './IDownloadStrategy';
import { DownloadResult } from '../../types/experiment';
import { ICommunicationStrategy } from '../communication/ICommunicationStrategy';

// チャンクを並列でダウンロードする際の最大同時接続数
const MAX_CONCURRENT_DOWNLOADS = 10;

/**
 * HTTP/REST API を使用して Raidchain からデータをダウンロードする戦略。
 */
export class HttpDownloadStrategy implements IDownloadStrategy {

	constructor() {
		log.debug('HttpDownloadStrategy がインスタンス化されました。');
	}

	/**
	 * 指定されたURLに関連付けられたデータをRaidchainからダウンロードし、復元します。
	 * @param context 実行コンテキスト (通信戦略、インフラ情報へのアクセス)
	 * @param targetUrl ダウンロード対象のURL (アップロード時に指定したもの)
	 */
	public async execute(
		context: RunnerContext,
		targetUrl: string
	): Promise<DownloadResult> {

		const startTime = process.hrtime.bigint() / 1_000_000n;
		log.info(`[Download] 開始... URL: ${targetUrl}`);

		const { chainManager, infraService, communicationStrategy } = context;

		try {
			// 1. metachain の API エンドポイントを取得
			const metachain = chainManager.getMetachainInfo();
			// (InfrastructureService が返すエンドポイントはRPCかもしれないため、APIエンドポイントを取得し直す)
			const apiEndpoints = await infraService.getApiEndpoints();
			const metachainApiUrl = apiEndpoints[metachain.name];
			if (!metachainApiUrl) {
				throw new Error(`metachain (${metachain.name}) の API エンドポイントが見つかりません。`);
			}
			// 通信戦略に API エンドポイントを登録
			await communicationStrategy.connect(metachainApiUrl);

			// 2. metachain からマニフェストを取得
			log.debug(`[Download] metachain (${metachainApiUrl}) からマニフェストを取得中...`);
			// /metachain/metastore/v1/manifest/{url}
			// targetUrl が 'my-site/index.html' の場合、エンコードが必要
			const encodedUrl = encodeURIComponent(targetUrl);
			const manifestPath = `/metachain/metastore/v1/manifest/${encodedUrl}`;

			const manifestResponse: StoredManifestResponse = await communicationStrategy.sendRestRequest(
				`${metachainApiUrl}${manifestPath}` // sendRestRequest がベースURLを扱える前提
			);

			if (!manifestResponse.manifest || !manifestResponse.manifest.manifest) {
				throw new Error(`マニフェストが見つかりません (URL: ${targetUrl})`);
			}

			const manifest: Manifest = JSON.parse(manifestResponse.manifest.manifest);
			log.debug(`[Download] マニフェスト取得成功。`);

			// 3. datachain の API エンドポイントを取得
			const datachainInfos = chainManager.getDatachainInfos();
			const datachainApiUrls = new Map<string, string>();
			for (const info of datachainInfos) {
				const url = apiEndpoints[info.name];
				if (!url) throw new Error(`datachain (${info.name}) の API エンドポイントが見つかりません。`);
				await communicationStrategy.connect(url); // 通信戦略に登録
				datachainApiUrls.set(info.name, url);
			}

			// 4. マニフェスト内のすべてのファイルパスとチャンクインデックスを取得
			// (この実験プラットフォームでは、1 URL = 1 ファイル = チャンク配列 と仮定)
			const chunkIndexes = manifest[targetUrl]; // targetUrl が Manifest のキーであると仮定
			if (!chunkIndexes || chunkIndexes.length === 0) {
				throw new Error(`マニフェスト内に URL "${targetUrl}" のチャンク情報が見つかりません。`);
			}

			log.info(`[Download] ${chunkIndexes.length} 個のチャンクを並列ダウンロード (同時 ${MAX_CONCURRENT_DOWNLOADS})`);

			// 5. チャンクを並列ダウンロード
			const chunkBuffers: (Buffer | null)[] = await this.downloadChunksConcurrently(
				chunkIndexes,
				datachainApiUrls,
				communicationStrategy
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

			return {
				startTime,
				endTime,
				durationMs,
				downloadedData,
				downloadedDataHash: undefined, // ハッシュ計算は Tracker 側で行う (オプション)
			};

		} catch (error: any) {
			log.error(`[Download] ダウンロード処理中にエラーが発生しました。`, error);
			throw error;
		}
	}

	/**
	 * チャンクインデックスのリストを受け取り、並列でダウンロードします。
	 */
	private async downloadChunksConcurrently(
		chunkIndexes: string[],
		datachainApiUrls: Map<string, string>, // chainName -> apiUrl
		commStrategy: ICommunicationStrategy
	): Promise<(Buffer | null)[]> {

		// どのチャンクがどのチェーンにあるかのマッピングが必要
		// 既存のロジック (minimum-test.ts) では、インデックス名 (e.g., hash-0, hash-1) の
		// 番号と datachain の数 (e.g., 2) から、 0 % 2 -> data-0, 1 % 2 -> data-1 のように決定していた。

		const datachainNames = Array.from(datachainApiUrls.keys()).sort(); // data-0, data-1 ...
		const datachainCount = datachainNames.length;
		if (datachainCount === 0) throw new Error('ダウンロード先の datachain がありません。');

		// チャンクインデックスとダウンロードURLのマッピングを作成
		const downloadTasks = chunkIndexes.map((index) => {
			// インデックス (例: 'hash-0', 'hash-1') から番号を抽出
			const parts = index.split('-');
			const chunkNum = parseInt(parts[parts.length - 1] ?? '0', 10);

			// 割り当て先のチェーンを決定
			const chainIndex = chunkNum % datachainCount;
			const chainName = datachainNames[chainIndex];
			const apiUrl = datachainApiUrls.get(chainName!);

			if (!apiUrl) throw new Error(`チャンク ${index} の割り当て先チェーン ${chainName} のURLが見つかりません。`);

			// /datachain/datastore/v1/chunk/{index}
			const encodedIndex = encodeURIComponent(index);
			const path = `${apiUrl}/datachain/datastore/v1/chunk/${encodedIndex}`;

			return { index, path, chainName };
		});

		// 並列実行
		const results: (Buffer | null)[] = new Array(downloadTasks.length).fill(null);
		const queue = [...downloadTasks.entries()]; // [index, task]
		let activeDownloads = 0;

		return new Promise((resolve, reject) => {
			const runNext = () => {
				if (queue.length === 0 && activeDownloads === 0) {
					// すべて完了
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
							runNext(); // 次のタスクを実行
						});
				}
			};

			runNext(); // 最初のタスクを開始
		});
	}
}