// controller/src/core/ExperimentRunner.ts
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { InfrastructureService } from '../infrastructure/InfrastructureService';
import {
	ExperimentConfig,
	ExperimentResult,
	IterationResult,
	RunnerContext,
	TaskOption,
	TaskTarget
} from '../types';
import { log } from '../utils/logger';
// ★ 修正: IProgressManager のインポートパス
import { IProgressManager } from '../utils/ProgressManager/IProgressManager';
import { UrlPathCodec } from '../utils/UrlPathCodec';
import { ChainManager } from './ChainManager';
import { PerformanceTracker } from './PerformanceTracker';

// --- 戦略インターフェースのインポート ---
import { ICommunicationStrategy } from '../strategies/communication/ICommunicationStrategy';
import { IConfirmationStrategy } from '../strategies/confirmation/IConfirmationStrategy';
import { IDownloadStrategy } from '../strategies/download/IDownloadStrategy';
import { IGasEstimationStrategy } from '../strategies/gas';
import { IUploadStrategy } from '../strategies/upload/old/IUploadStrategy';
import { IVerificationStrategy } from '../strategies/verification/IVerificationStrategy';

// --- 戦略モジュールの型定義 ---
interface ExperimentStrategies {
	gasEstimationStrategy: IGasEstimationStrategy;
	commStrategy: ICommunicationStrategy;
	uploadStrategy: IUploadStrategy;
	confirmStrategy: IConfirmationStrategy;
	downloadStrategy: IDownloadStrategy;
	verifyStrategy: IVerificationStrategy;
	progressManager: IProgressManager;
}

/**
 * 実験全体のライフサイクル（準備、実行、計測、後処理）を管理するオーケストレーター。
 */
export class ExperimentRunner {
	private config: ExperimentConfig;
	private strategies: ExperimentStrategies;
	private urlPathCodec: UrlPathCodec;

	private infraService: InfrastructureService;
	private chainManager: ChainManager;
	private tracker: PerformanceTracker;

	private context!: RunnerContext;

	constructor(
		config: ExperimentConfig,
		strategies: ExperimentStrategies,
		urlPathCodec: UrlPathCodec
	) {
		this.config = config;
		this.strategies = strategies;
		this.urlPathCodec = urlPathCodec;

		this.infraService = new InfrastructureService();
		this.chainManager = new ChainManager();
		this.tracker = new PerformanceTracker();

		log.info('ExperimentRunner が設定、戦略モジュール、UrlPathCodec で初期化されました。');
	}

	/**
	 * 実験を実行します。
	 * (★ 修正: start/stop の呼び出し位置を変更)
	 */
	public async run(): Promise<ExperimentResult> {
		// ★★★ 修正: \n を追加 ★★★
		log.step(`\n実験開始: ${this.config.description}`);

		const iterationResults: IterationResult[] = [];

		const tasks = this.config.tasks;
		if (!tasks || tasks.length === 0) {
			log.error('ExperimentConfig に "tasks" が定義されていないか、空です。');
			throw new Error('実験タスクが定義されていません。');
		}

		try {
			// --- 1. グローバル初期化 (ChainManager) ---
			await this.chainManager.init(this.infraService, this.strategies.commStrategy);

			// --- 2. 戦略コンテキストの作成 ---
			this.context = {
				config: this.config,
				infraService: this.infraService,
				chainManager: this.chainManager,
				tracker: this.tracker,
				communicationStrategy: this.strategies.commStrategy,
				confirmationStrategy: this.strategies.confirmStrategy,
				gasEstimationStrategy: this.strategies.gasEstimationStrategy,
				urlPathCodec: this.urlPathCodec,
				progressManager: this.strategies.progressManager,
			};

			// ★★★ 修正: プログレスバーを実験全体で1回だけ開始 ★★★
			this.context.progressManager.start();

			// --- 3. イテレーション実行 ---
			for (let i = 0; i < this.config.iterations; i++) {
				const iteration = i + 1;
				// ★★★ 修正: \n を追加 ★★★
				log.info(`\n--- イテレーション ${iteration}/${this.config.iterations} を開始 ---`);

				for (let j = 0; j < tasks.length; j++) {
					const task = tasks[j]!;
					const taskLabel = `(Task ${j + 1}/${tasks.length}: ${task.description ?? `size=${task.target.value}KB, chunk=${task.chunkSize}, chains=${task.chainCount}`})`;

					// ★★★ 修正: \n を追加 ★★★
					log.step(`\nタスク ${taskLabel} (イテレーション ${iteration}) 開始...`);
					this.tracker.reset();

					// ★ 削除: progressManager.start()

					try {
						const result = await this.runIteration(task, iteration, taskLabel);
						iterationResults.push(result);
						log.success(`タスク ${taskLabel} (イテレーション ${iteration}) 完了。検証: ${result.verificationResult.verified ? '✅ 成功' : '❌ 失敗'}`);
					} catch (iterError: unknown) {
						const errorMessage = (iterError instanceof Error) ? iterError.message : String(iterError);
						log.error(`タスク ${taskLabel} (イテレーション ${iteration}) がエラーで失敗しました。`, iterError);

						iterationResults.push({
							iteration: iteration,
							task: task,
							chainCount: task.chainCount,
							uploadResult: this.tracker.getUploadResult(),
							downloadResult: { startTime: 0n, endTime: 0n, durationMs: 0n, downloadedData: Buffer.alloc(0) },
							verificationResult: { verified: false, message: `タスク失敗: ${errorMessage}` },
						});
					}
					// ★ 削除: finally { progressManager.stop() }
				}
			}

		} catch (globalError: unknown) {
			const errorMessage = (globalError instanceof Error) ? globalError.message : String(globalError);
			log.error('実験のグローバル初期化（ChainManager 初期化など）に失敗しました。', errorMessage, globalError);
		} finally {
			// ★★★ 修正: プログレスバーを実験全体の最後に停止 ★★★
			this.context?.progressManager?.stop();

			// --- 4. グローバル後処理 ---
			await this.chainManager.disconnectAll();
			log.success('実験終了。');
		}

		// --- 5. 結果集計 (簡易版) ---
		const summary = this.calculateSummary(iterationResults);

		return {
			config: this.config,
			iterationResults: iterationResults,
			summary: summary,
		};
	}

	/**
	 * 1回のイテレーション（準備→アップロード→ダウンロード→検証）を実行します。
	 */
	private async runIteration(task: TaskOption, iteration: number, taskLabel: string): Promise<IterationResult> {

		this.context.currentTask = task;

		// 1. データ準備
		const originalData = await this.prepareData(task.target);
		const dataHash = crypto.createHash('sha256').update(originalData).digest('hex');
		this.tracker.setOriginalDataHash(dataHash);
		log.info(`データ準備完了。サイズ: ${originalData.length} bytes, SHA256: ${originalData.length > 100 ? dataHash.substring(0, 12) + '...' : dataHash}`);

		// 2. アップロード実行
		let base = this.config.targetUrlBase
			? this.config.targetUrlBase.replace(/\/+$/, '')
			: `raidchain.test`;
		base += `@${Date.now().toString()}`;
		const targetUrl = `${base}/data`;
		log.info(`アップロード開始... Target URL (Raw): ${targetUrl}`);

		const uploadResult = await this.strategies.uploadStrategy.execute(this.context, originalData, targetUrl);

		log.success(`アップロード完了。所要時間: ${uploadResult.durationMs} ms, 成功Tx: ${uploadResult.successTx}/${uploadResult.totalTx}`);

		// 3. ダウンロード実行
		const manifestUrlRaw = uploadResult.manifestUrl;
		if (!manifestUrlRaw) {
			throw new Error('アップロード結果に manifestUrl が含まれていません。ダウンロードをスキップします。');
		}
		log.info(`ダウンロード開始... Target URL (Raw): ${manifestUrlRaw}`);
		const downloadResult = await this.strategies.downloadStrategy.execute(this.context, manifestUrlRaw);

		log.success(`ダウンロード完了。所要時間: ${downloadResult.durationMs} ms, サイズ: ${downloadResult.downloadedData.length} bytes`);

		// 4. 検証実行
		log.info('データ検証開始...');
		const verificationOptions = this.config.strategies.verification === 'BufferPartial'
			? { compareBytes: this.config.verificationStrategyOptions?.compareBytes ?? 1024 }
			: {};

		const verificationResult = await this.strategies.verifyStrategy.execute(
			originalData,
			downloadResult.downloadedData,
			verificationOptions
		);
		this.tracker.setVerificationResult(verificationResult);
		log.success(`検証完了: ${verificationResult.verified ? '✅ 成功' : '❌ 失敗'}`);

		// 5. イテレーション結果を返す
		return {
			iteration: iteration,
			task: task,
			chainCount: task.chainCount,
			uploadResult: uploadResult,
			downloadResult: downloadResult,
			verificationResult: verificationResult,
		};
	}

	/**
	 * 設定に基づいてアップロード対象のデータを準備します。
	 */
	private async prepareData(target: TaskTarget): Promise<Buffer> {
		if (target.type === 'filePath') {
			log.debug(`ファイルからデータを読み込み中: ${target.value}`);
			return fs.readFile(target.value);
		} else {
			const targetBytes = target.value * 1024;
			log.debug(`ダミーデータを生成中: ${targetBytes} bytes`);
			return crypto.randomBytes(targetBytes);
		}
	}

	/**
	 * 複数イテレーションの結果を集計します (簡易実装)。
	 */
	private calculateSummary(results: IterationResult[]): any {
		const totalIterations = results.length;
		if (totalIterations === 0) return { message: "データなし" };

		const avgUploadMs = results.reduce((sum, r) => sum + Number(r.uploadResult.durationMs), 0) / totalIterations;
		const avgDownloadMs = results.reduce((sum, r) => sum + Number(r.downloadResult.durationMs), 0) / totalIterations;
		const verificationSuccesses = results.filter(r => r.verificationResult.verified).length;

		return {
			totalTasksRun: totalIterations,
			avgUploadMs: avgUploadMs.toFixed(2),
			avgDownloadMs: avgDownloadMs.toFixed(2),
			verificationSuccessRate: (verificationSuccesses / totalIterations) * 100,
		};
	}
}