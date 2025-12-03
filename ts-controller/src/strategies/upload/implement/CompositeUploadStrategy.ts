// controller/src/strategies/upload/implement/CompositeUploadStrategy.ts
import { RunnerContext, UploadResult } from '../../../types';
import { log } from '../../../utils/logger';
import { IProgressBar } from '../../../utils/ProgressManager/IProgressManager';
import { BaseCoreLogic, ChunkLocation, UploadJob } from '../base/BaseCoreLogic';
import { IChunkAllocator } from '../interfaces/IChunkAllocator';
import { IUploadStrategy } from '../interfaces/IUploadStrategy';
import { IUploadTransmitter } from '../interfaces/IUploadTransmitter';
import { AvailableAllocator } from './allocator/AvailableAllocator';

/**
 * Composite パターンによるアップロード戦略の最終実装。
 * IChunkAllocator (割当) と IUploadTransmitter (実行) を
 * DI (依存性注入) によって受け取り、アップロードプロセス全体を統括する。
 */
export class CompositeUploadStrategy implements IUploadStrategy {
	private coreLogic: BaseCoreLogic;
	private allocator: IChunkAllocator;
	private transmitter: IUploadTransmitter;

	constructor(
		allocator: IChunkAllocator,
		transmitter: IUploadTransmitter
	) {
		this.allocator = allocator;
		this.transmitter = transmitter;
		this.coreLogic = new BaseCoreLogic();
		log.debug(`CompositeUploadStrategy がインスタンス化されました (Allocator: ${allocator.constructor.name}, Transmitter: ${transmitter.constructor.name})`);
	}

	/**
	 * 【Template Method】アップロード処理の共通フローを実行します。
	 */
	public async execute(
		context: RunnerContext,
		data: Buffer,
		targetUrl: string
	): Promise<UploadResult> {
		const { tracker, progressManager } = context;
		tracker.markUploadStart();
		log.info(`[CompositeUpload] 開始... URL (Raw): ${targetUrl}, データサイズ: ${data.length} bytes`);

		// 1. URL解析 (共通)
		const urlParts = context.urlPathCodec.parseTargetUrl(targetUrl);

		// 2. チャンク化 (共通)
		const { chunks: allChunks, chunkSizeUsed } = this.coreLogic.createChunks(data, context);
		tracker.setChunkSizeUsed(chunkSizeUsed);
		log.info(`[CompositeUpload] データは ${allChunks.length} 個のチャンクに分割されました。`);

		if (allChunks.length === 0) {
			log.warn(`[CompositeUpload] チャンクが0個です。マニフェストのみ登録します。`);
		}

		// 3. ガス見積もり (共通)
		let estimatedGasLimit = '0';
		if (allChunks.length > 0) {
			estimatedGasLimit = await this.coreLogic.estimateGas(context, allChunks[0]!);
		}

		// 4. 【戦略固有】チャンクのアップロード処理 (Allocator + Transmitter)
		let allSuccessfulLocations: ChunkLocation[] = [];
		let processingFailed = false;

		// 4a. チャンクが0件の場合
		if (allChunks.length === 0) {
			// (何もしない)

			// 4b. チャンクが1件以上ある場合
		} else {
			try {
				// 4b-1. Allocator で実行計画 (Job) を作成
				// (AvailableAllocator の場合、この内部でバーが初期化される)
				const uploadJobs = await this.allocator.allocateChunks(context, allChunks);

				if (uploadJobs.length === 0 && allChunks.length > 0) {
					throw new Error('Allocator が 0 件のジョブを返しました (チャンク > 0)。');
				}

				// 4b-2. プログレスバーの準備 (Allocator が準備しない場合)
				const bars = this.prepareProgressBars(context, uploadJobs);

				// 4b-3. Transmitter で Job を並列実行
				const processingPromises = uploadJobs.map(job => {

					// ★★★ 修正箇所 (ここから) ★★★
					// Allocator の種類に応じて、正しいバーの取得元を参照する
					let targetBar: IProgressBar | undefined;
					if (this.allocator instanceof AvailableAllocator) {
						// AvailableAllocator は public chainBars プロパティでバーを管理
						targetBar = this.allocator.chainBars.get(job.chainName);
					} else {
						// 他の Allocator (StaticMulti など) は prepareProgressBars で生成
						targetBar = bars.get(job.chainName);
					}

					if (!targetBar) {
						// 致命的なエラー
						log.error(`[CompositeUpload] Job (${job.chainName}) に対応するプログレスバーの取得に失敗しました。`);
						// エラーをスローして Promise.all を失敗させる
						throw new Error(`[CompositeUpload] プログレスバーの取得に失敗しました: ${job.chainName}`);
					}
					// ★★★ 修正箇所 (ここまで) ★★★

					return this.transmitter.transmitBatch(
						context,
						job.batch,
						job.chainName,
						estimatedGasLimit,
						targetBar // ★ 修正: 確実に IProgressBar を渡す
					);
				});

				const results = await Promise.all(processingPromises);

				// 4b-4. 結果を集約
				for (const batchLocations of results) {
					if (batchLocations === null) {
						processingFailed = true; // 1つでも失敗したら全体が失敗
					} else {
						allSuccessfulLocations.push(...batchLocations);
					}
				}

			} catch (allocatorOrTransmitterError) {
				log.error(`[CompositeUpload] アップロード処理 (Allocate/Transmit) 中にエラーが発生しました。`, allocatorOrTransmitterError);
				processingFailed = true;
			}
		}

		// 4c. AvailableAllocator のバーの後処理
		if (this.allocator instanceof AvailableAllocator) {
			this.allocator.cleanupBars(processingFailed, this.getActualChunksAssigned(allSuccessfulLocations));
		}

		// 5. マニフェスト登録 (共通)
		if (processingFailed) {
			log.error(`[CompositeUpload] チャンクのアップロードに失敗しました。マニフェスト登録をスキップします。`);
		} else {
			log.success(`[CompositeUpload] 全チャンクのアップロード完了`);
			log.info(`[CompositeUpload] マニフェストを登録中...`);
			try {
				// (allSuccessfulLocations は 0件 (チャンクなし) or 成功した全件 のいずれか)
				const sortedLocations = allSuccessfulLocations.sort((a, b) => {
					const numA = parseInt(a.index.split('-').pop() ?? '0', 10);
					const numB = parseInt(b.index.split('-').pop() ?? '0', 10);
					return numA - numB;
				});

				await this.coreLogic.registerManifest(context, urlParts, sortedLocations);
				log.success(`[CompositeUpload] マニフェスト登録成功 (BaseURL: ${urlParts.baseUrlRaw})`);
			} catch (error) {
				log.error(`[CompositeUpload] マニフェストの登録に失敗しました。`, error);
			}
		}

		// 6. 最終結果 (共通)
		tracker.markUploadEnd();
		const result = tracker.getUploadResult();
		log.success(`[CompositeUpload] 完了。所要時間: ${result.durationMs} ms`);
		return result;
	}


	/**
	 * AvailableAllocator 以外のアロケータ用に、ジョブリストからプログレスバーを準備する
	 */
	private prepareProgressBars(context: RunnerContext, jobs: UploadJob[]): Map<string, IProgressBar> {
		if (this.allocator instanceof AvailableAllocator) {
			// AvailableAllocator は allocateChunks 内部でバーを作成・管理する
			return new Map<string, IProgressBar>();
		}

		const { progressManager } = context;
		const bars = new Map<string, IProgressBar>();

		// 1. チェーンごとの総チャンク数を計算
		const totals = new Map<string, number>();
		for (const job of jobs) {
			const current = totals.get(job.chainName) ?? 0;
			totals.set(job.chainName, current + job.batch.chunks.length);
		}

		// 2. バーを作成
		for (const [chainName, total] of totals.entries()) {
			const bar = progressManager.addBar(chainName.padEnd(8), total, 0, { status: 'Waiting...' });
			bars.set(chainName, bar);
		}
		return bars;
	}

	/**
	 * (AvailableAllocator の cleanupBars 用) 成功した場所リストから実績チャンク数を集計
	 */
	private getActualChunksAssigned(locations: ChunkLocation[]): Map<string, number> {
		const map = new Map<string, number>();
		for (const loc of locations) {
			map.set(loc.chainName, (map.get(loc.chainName) ?? 0) + 1);
		}
		return map;
	}
}