// controller/src/core/ExperimentRunner.ts
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { InfrastructureService } from '../infrastructure/InfrastructureService';
import {
	ExperimentConfig,
	ExperimentResult,
	IterationResult,
	RunnerContext
} from '../types';
import { log } from '../utils/logger';
import { ChainManager } from './ChainManager';
import { PerformanceTracker } from './PerformanceTracker';

// --- 戦略インターフェースのインポート (インターフェースのみ) ---
// ★ 修正: 具象クラスのインポートを削除し、インターフェースのみをインポート
// (index.ts ファイルが各ディレクトリに必要)
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

	private infraService: InfrastructureService;
	private chainManager: ChainManager;
	private tracker: PerformanceTracker;

	private context!: RunnerContext;

	constructor(
		config: ExperimentConfig,
		strategies: ExperimentStrategies
	) {
		this.config = config;
		this.strategies = strategies;

		this.infraService = new InfrastructureService();
		this.chainManager = new ChainManager();
		this.tracker = new PerformanceTracker();

		log.info('ExperimentRunner が設定と戦略モジュールで初期化されました。');
	}

	/**
	 * 実験を実行します。
	 */
	public async run(): Promise<ExperimentResult> {
		log.step(`実験開始: ${this.config.description}`);

		const iterationResults: IterationResult[] = [];

		// ★ 修正: infraService の初期化がまだなので、先にインスタンス化だけして、getChainInfoは await する
		const allDatachains = (await this.infraService.getChainInfo()).filter(c => c.type === 'datachain');

		const chainCounts = Array.isArray(this.config.chainCount)
			? this.config.chainCount
			: [this.config.chainCount ?? allDatachains.length];

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
			};

			// --- 3. イテレーション実行 ---
			for (const chainCount of chainCounts) {
				// TODO: chainCount に基づいて chainManager が使用する datachain を制限する機能
				log.info(`--- チェーン数 ${chainCount} でイテレーションを開始 ---`);

				for (let i = 0; i < this.config.iterations; i++) {
					const iteration = i + 1;
					log.step(`イテレーション ${iteration}/${this.config.iterations} (チェーン数: ${chainCount}) 開始...`);
					this.tracker.reset();

					try {
						const result = await this.runIteration(chainCount, iteration); // ★ 修正: iteration を渡す
						iterationResults.push(result);
						log.info(`イテレーション ${iteration} 完了。検証: ${result.verificationResult.verified ? '成功' : '失敗'}`);

					} catch (iterError: unknown) { // ★ 修正: iterError: unknown
						// ★ 修正 (Error 9): unknown 型のチェック
						const errorMessage = (iterError instanceof Error) ? iterError.message : String(iterError);
						log.error(`イテレーション ${iteration} がエラーで失敗しました。`, iterError);

						iterationResults.push({
							iteration: iteration,
							chainCount: chainCount,
							uploadResult: this.tracker.getUploadResult(),
							downloadResult: { startTime: 0n, endTime: 0n, durationMs: 0n, downloadedData: Buffer.alloc(0) }, // ★ 修正: bigint
							verificationResult: { verified: false, message: `イテレーション失敗: ${errorMessage}` },
						});
					}
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
			}

		} catch (globalError: unknown) { // ★ 修正: unknown
			const errorMessage = (globalError instanceof Error) ? globalError.message : String(globalError);
			log.error('実験のグローバル初期化（ChainManager 初期化など）に失敗しました。', errorMessage, globalError);
		} finally {
			// --- 4. グローバル後処理 ---
			await this.chainManager.disconnectAll();
			log.step('実験終了。');
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
	private async runIteration(chainCount: number, iteration: number): Promise<IterationResult> {

		// 1. データ準備
		const originalData = await this.prepareData();
		const dataHash = crypto.createHash('sha256').update(originalData).digest('hex');
		this.tracker.setOriginalDataHash(dataHash);
		log.info(`データ準備完了。サイズ: ${originalData.length} bytes, SHA256: ${dataHash.substring(0, 12)}...`);

		// 2. アップロード実行
		// 設定の targetUrlBase をベースに、イテレーションとタイムスタンプを追加
		const base = this.config.targetUrlBase
			? this.config.targetUrlBase.replace(/\/+$/, '') // 末尾のスラッシュを削除
			: `test.raidchain.${Date.now()}.com`; // 設定がない場合は旧ロジックを使用

		const targetUrl = `${base}/data.bin`;
		log.info(`アップロード開始... Target URL: ${targetUrl}`);

		// TODO: chainCount を UploadStrategy に渡す

		this.tracker.markUploadStart();
		const uploadResult = await this.strategies.uploadStrategy.execute(this.context, originalData, targetUrl);
		// this.tracker.markUploadEnd(); // ★ 修正: uploadStrategy が内部で tracker.markUploadEnd() を呼ぶか、ここで呼ぶか
		// (UploadResult に startTime/endTime があるため、UploadStrategy が内部で tracker を呼ぶか、
		// UploadResult の値で tracker を更新する必要がある。ここでは tracker が Result を生成すると仮定)
		// -> PerformanceTracker の実装に基づき、Strategy が Start/End を呼ぶと仮定
		log.info(`アップロード完了。所要時間: ${uploadResult.durationMs} ms, 成功Tx: ${uploadResult.successTx}/${uploadResult.totalTx}`);

		// 3. ダウンロード実行
		const manifestUrl = uploadResult.manifestUrl;
		if (!manifestUrl) {
			throw new Error('アップロード結果に manifestUrl が含まれていません。ダウンロードをスキップします。');
		}
		log.info(`ダウンロード開始... Manifest URL: ${manifestUrl}`);
		// this.tracker.markDownloadStart(); // ★ 修正: DownloadStrategy が呼ぶと仮定
		const downloadResult = await this.strategies.downloadStrategy.execute(this.context, manifestUrl);
		// this.tracker.markDownloadEnd(); // ★ 修正: DownloadStrategy が呼ぶと仮定
		log.info(`ダウンロード完了。所要時間: ${downloadResult.durationMs} ms, サイズ: ${downloadResult.downloadedData.length} bytes`);

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
		this.tracker.setVerificationResult(verificationResult); // ★ 修正: Tracker に結果をセット
		log.info(`検証完了: ${verificationResult.verified ? '✅ 成功' : '❌ 失敗'}`);

		// 5. イテレーション結果を返す
		return {
			iteration: iteration, // ★ 修正
			chainCount: chainCount,
			uploadResult: uploadResult,
			downloadResult: downloadResult,
			verificationResult: verificationResult,
		};
	}

	/**
	 * 設定に基づいてアップロード対象のデータを準備します。
	 * (変更なし)
	 */
	private async prepareData(): Promise<Buffer> {
		if (this.config.target.type === 'filePath') {
			log.debug(`ファイルからデータを読み込み中: ${this.config.target.value}`);
			return fs.readFile(this.config.target.value);
		} else {
			const targetBytes = this.config.target.value * 1024;
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

		const avgUploadMs = results.reduce((sum, r) => sum + Number(r.uploadResult.durationMs), 0) / totalIterations; // ★ 修正: bigint -> number
		const avgDownloadMs = results.reduce((sum, r) => sum + Number(r.downloadResult.durationMs), 0) / totalIterations; // ★ 修正: bigint -> number
		const verificationSuccesses = results.filter(r => r.verificationResult.verified).length;

		return {
			totalIterations: totalIterations,
			avgUploadMs: avgUploadMs.toFixed(2),
			avgDownloadMs: avgDownloadMs.toFixed(2),
			verificationSuccessRate: (verificationSuccesses / totalIterations) * 100,
		};
	}
}

/**
 * ★ 修正:
 * 戦略クラスのインスタンス化はステップ10 (run-experiment.ts) で行うため、
 * このファイルからは削除（またはコメントアウト）します。
 */
/*
export function instantiateStrategies(config: ExperimentConfig): ExperimentStrategies {
	// ... (ステップ7以降で実装されるため、ここではコメントアウト)
}
*/