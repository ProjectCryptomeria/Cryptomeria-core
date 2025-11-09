// controller/src/core/ExperimentRunner.ts
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { InfrastructureService } from '../infrastructure/InfrastructureService';
import {
	ExperimentConfig,
	ExperimentResult,
	IterationResult,
	RunnerContext,
	// ★ 修正: TaskOption, TaskTarget をインポート
	TaskOption,
	TaskTarget
} from '../types';
import { log } from '../utils/logger';
import { UrlPathCodec } from '../utils/UrlPathCodec';
import { ChainManager } from './ChainManager';
import { PerformanceTracker } from './PerformanceTracker';

// --- 戦略インターフェースのインポート (インターフェースのみ) ---
import { ICommunicationStrategy } from '../strategies/communication/ICommunicationStrategy';
import { IConfirmationStrategy } from '../strategies/confirmation/IConfirmationStrategy';
import { IDownloadStrategy } from '../strategies/download/IDownloadStrategy';
import { IGasEstimationStrategy } from '../strategies/gas';
import { IUploadStrategy } from '../strategies/upload/IUploadStrategy';
import { IVerificationStrategy } from '../strategies/verification/IVerificationStrategy';

// --- 戦略モジュールの型定義 ---
interface ExperimentStrategies {
	gasEstimationStrategy: IGasEstimationStrategy;
	commStrategy: ICommunicationStrategy;
	uploadStrategy: IUploadStrategy;
	confirmStrategy: IConfirmationStrategy;
	downloadStrategy: IDownloadStrategy;
	verifyStrategy: IVerificationStrategy;
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
	 */
	public async run(): Promise<ExperimentResult> {
		log.step(`実験開始: ${this.config.description}`);

		const iterationResults: IterationResult[] = [];

		// ★ 修正: config.tasks を使用
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
				// currentTask は runIteration のループ内で設定
			};

			// ★★★ 3. イテレーション実行 (ループ構造を変更) ★★★
			for (let i = 0; i < this.config.iterations; i++) {
				const iteration = i + 1;
				log.info(`--- イテレーション ${iteration}/${this.config.iterations} を開始 ---`);

				for (let j = 0; j < tasks.length; j++) {
					const task = tasks[j]!;
					// ★ 修正: タスクラベルのデフォルト表示を改善
					const taskLabel = `(Task ${j + 1}/${tasks.length}: ${task.description ?? `size=${task.target.value}KB, chunk=${task.chunkSize}, chains=${task.chainCount}`})`;

					log.step(`タスク ${taskLabel} (イテレーション ${iteration}) 開始...`);
					this.tracker.reset();

					try {
						// ★ 変更: runIteration に task を渡す
						const result = await this.runIteration(task, iteration, taskLabel);
						iterationResults.push(result);
						log.success(`タスク ${taskLabel} (イテレーション ${iteration}) 完了。検証: ${result.verificationResult.verified ? '✅ 成功' : '❌ 失敗'}`);

					} catch (iterError: unknown) {
						const errorMessage = (iterError instanceof Error) ? iterError.message : String(iterError);
						log.error(`タスク ${taskLabel} (イテレーション ${iteration}) がエラーで失敗しました。`, iterError);

						iterationResults.push({
							iteration: iteration,
							task: task, // ★ 変更: task を記録
							chainCount: task.chainCount, // ★ 変更: task から chainCount を記録
							uploadResult: this.tracker.getUploadResult(),
							downloadResult: { startTime: 0n, endTime: 0n, durationMs: 0n, downloadedData: Buffer.alloc(0) },
							verificationResult: { verified: false, message: `タスク失敗: ${errorMessage}` },
						});
					}
					await new Promise(resolve => setTimeout(resolve, 1000)); // タスク間のクールダウン
				}
			}
			// ★★★ ループ構造の変更 (ここまで) ★★★

		} catch (globalError: unknown) {
			const errorMessage = (globalError instanceof Error) ? globalError.message : String(globalError);
			log.error('実験のグローバル初期化（ChainManager 初期化など）に失敗しました。', errorMessage, globalError);
		} finally {
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
	 * ★ 変更: シグネチャを (TaskOption, number, string) に変更
	 */
	private async runIteration(task: TaskOption, iteration: number, taskLabel: string): Promise<IterationResult> {

		// ★ 追加: Context に現在のタスクを設定
		this.context.currentTask = task;

		// 1. データ準備 (★ 変更: task.target を渡す)
		const originalData = await this.prepareData(task.target);
		const dataHash = crypto.createHash('sha256').update(originalData).digest('hex');
		this.tracker.setOriginalDataHash(dataHash);
		log.info(`データ準備完了。サイズ: ${originalData.length} bytes, SHA256: ${dataHash.substring(0, 12)}...`);

		// 2. アップロード実行
		let base = this.config.targetUrlBase
			? this.config.targetUrlBase.replace(/\/+$/, '')
			: `raidchain.test`;
		base += `@${Date.now().toString()}`;
		const targetUrl = `${base}/data`;
		log.info(`アップロード開始... Target URL (Raw): ${targetUrl}`);

		// UploadStrategy に context (urlPathCodec と currentTask を含む) を渡す
		const uploadResult = await this.strategies.uploadStrategy.execute(this.context, originalData, targetUrl);

		log.success(`アップロード完了。所要時間: ${uploadResult.durationMs} ms, 成功Tx: ${uploadResult.successTx}/${uploadResult.totalTx}`);

		// 3. ダウンロード実行
		const manifestUrlRaw = uploadResult.manifestUrl;
		if (!manifestUrlRaw) {
			throw new Error('アップロード結果に manifestUrl が含まれていません。ダウンロードをスキップします。');
		}
		log.info(`ダウンロード開始... Target URL (Raw): ${manifestUrlRaw}`);
		// DownloadStrategy に context (urlPathCodec を含む) と元の URL を渡す
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
			task: task, // ★ 追加
			chainCount: task.chainCount, // ★ task から取得
			uploadResult: uploadResult,
			downloadResult: downloadResult,
			verificationResult: verificationResult,
		};
	}

	/**
	 * 設定に基づいてアップロード対象のデータを準備します。
	 * ★ 変更: シグネチャを (TaskTarget) に変更
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
			totalTasksRun: totalIterations, // totalIterations -> totalTasksRun
			avgUploadMs: avgUploadMs.toFixed(2),
			avgDownloadMs: avgDownloadMs.toFixed(2),
			verificationSuccessRate: (verificationSuccesses / totalIterations) * 100,
		};
	}
}