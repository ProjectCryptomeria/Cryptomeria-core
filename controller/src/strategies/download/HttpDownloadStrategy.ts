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

	// ★ 追加: ダウンロード専用のHTTP通信戦略インスタンスを保持
	private httpCommStrategy: HttpCommunicationStrategy;

	constructor() {
		log.debug('HttpDownloadStrategy がインスタンス化されました。');
		// ★ 修正: インスタンス化時に専用のHTTP通信戦略を生成
		this.httpCommStrategy = new HttpCommunicationStrategy();
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

		// ★ 修正: communicationStrategy を使わず、内部の httpCommStrategy を使用
		const { chainManager, infraService } = context;
		const commStrategy = this.httpCommStrategy; // 内部のHTTP戦略を使用

		try {
			// 1. metachain の API エンドポイントを取得
			const metachain = chainManager.getMetachainInfo();
			// (InfrastructureService が返すエンドポイントはRPCかもしれないため、APIエンドポイントを取得し直す)
			const apiEndpoints = await infraService.getApiEndpoints();
			const metachainApiUrl = apiEndpoints[metachain.name];
			if (!metachainApiUrl) {
				throw new Error(`metachain (${metachain.name}) の API エンドポイントが見つかりません。`);
			}

			// ★ 修正: 内部のHTTP戦略にAPIエンドポイントを登録/接続（接続処理はHttpCommunicationStrategy内では軽量）
			await commStrategy.connect(metachainApiUrl);

			// 2. metachain からマニフェストを取得
			log.debug(`[Download] metachain (${metachainApiUrl}) からマニフェストを取得中...`);
			// /metachain/metastore/v1/manifest/{url}
			// targetUrl が 'my-site/index.html' の場合、エンコードが必要
			const encodedUrl = encodeURIComponent(targetUrl);
			// ★ 修正: REST API のパスを 'get_stored_manifest' から 'stored_manifest' に修正
			const manifestPath = `/metachain/metastore/v1/stored_manifest/${encodedUrl}`;

			// sendRestRequest にフルURLを渡す (HttpCommunicationStrategy が fetch を使う)
			const manifestResponse: StoredManifestResponse = await commStrategy.sendRestRequest(
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

				// ★ 修正: 内部のHTTP戦略に datachain の API エンドポイントを登録
				await commStrategy.connect(url);
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
				commStrategy // 内部のHTTP戦略を渡す
			);

			// 6. データを復元 (Buffer.concat)
			const validBuffers = chunkBuffers.filter((b): b is Buffer => b !== null);
			if (validBuffers.length !== chunkIndexes.length) {
				// ★ 修正点3: パリティ断片による復元ロジックは PoC 外なので、今回は単純にエラーとする
				throw new Error(`チャンクのダウンロードに失敗しました (期待: ${chunkIndexes.length}, 取得: ${validBuffers.length})`);
			}

			const downloadedData = Buffer.concat(validBuffers);

			const endTime = process.hrtime.bigint() / 1_000_000n;
			const durationMs = endTime - startTime;

			log.info(`[Download] 完了。所要時間: ${durationMs} ms, サイズ: ${downloadedData.length} bytes`);

			// ★ 修正: ダウンロードが成功した場合も、内部の通信戦略を切断
			await commStrategy.disconnect();

			return {
				startTime,
				endTime,
				durationMs,
				downloadedData,
				downloadedDataHash: undefined, // ハッシュ計算は Tracker 側で行う (オプション)
			};

		} catch (error: any) {
			// ★ 修正: エラーが発生した場合も、内部の通信戦略を切断
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
		datachainApiUrls: Map<string, string>, // chainName -> apiUrl
		commStrategy: ICommunicationStrategy // ★ 修正: 内部のHTTP戦略を受け取る
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
			// ★ 修正: REST API のパスを 'get_stored_chunk' から 'stored_chunk' に修正
			const path = `${apiUrl}/datachain/datastore/v1/stored_chunk/${encodedIndex}`;

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

					// ★ 修正: 渡された commStrategy（HttpCommunicationStrategy）の sendRestRequest を使用
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