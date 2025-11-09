// controller/src/run-experiment.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { ExperimentRunner } from './core/ExperimentRunner';
// ★ 修正: IProgressManager のインポートパス
import { IProgressManager } from './utils/ProgressManager/IProgressManager';
// ★ 修正: ProgressManager のインポートパス
import { ExperimentConfig, ExperimentResult } from './types';
import { log, LogLevel } from './utils/logger';
import { ProgressManager } from './utils/ProgressManager/ProgressManager';
import { UrlPathCodec } from './utils/UrlPathCodec';

// --- すべての具象戦略クラスをインポート ---
import {
	HttpCommunicationStrategy,
	ICommunicationStrategy,
	WebSocketCommunicationStrategy
} from './strategies/communication';
import {
	IConfirmationStrategy,
	PollingConfirmationStrategy,
	TxEventConfirmationStrategy
} from './strategies/confirmation';
import {
	HttpDownloadStrategy,
	IDownloadStrategy
} from './strategies/download';
import { IGasEstimationStrategy, SimulationGasEstimationStrategy } from './strategies/gas';
import {
	DistributeUploadStrategy,
	IUploadStrategy,
	SequentialUploadStrategy
} from './strategies/upload';
import {
	BufferVerificationStrategy,
	IVerificationStrategy
} from './strategies/verification';

// ★ 修正: progressManager を追加
interface ExperimentStrategies {
	commStrategy: ICommunicationStrategy;
	uploadStrategy: IUploadStrategy;
	confirmStrategy: IConfirmationStrategy;
	downloadStrategy: IDownloadStrategy;
	verifyStrategy: IVerificationStrategy;
	gasEstimationStrategy: IGasEstimationStrategy;
	progressManager: IProgressManager;
}

/**
 * 設定オブジェクト（文字列）に基づき、
 * 戦略クラスの具象インスタンスを生成します。
 * (★ 修正: progressManager を返すように変更)
 */
function instantiateStrategies(config: ExperimentConfig): ExperimentStrategies {
	log.info('戦略モジュールをインスタンス化しています...'); // (ファイルログ用)

	let commStrategy: ICommunicationStrategy;
	switch (config.strategies.communication) {
		case 'Http':
			commStrategy = new HttpCommunicationStrategy();
			break;
		case 'WebSocket':
			commStrategy = new WebSocketCommunicationStrategy();
			break;
		default:
			throw new Error(`不明な通信戦略: ${config.strategies.communication}`);
	}

	let confirmStrategy: IConfirmationStrategy;
	switch (config.strategies.confirmation) {
		case 'Polling':
			confirmStrategy = new PollingConfirmationStrategy();
			break;
		case 'TxEvent':
			if (config.strategies.communication !== 'WebSocket') {
				throw new Error('TxEventConfirmationStrategy は WebSocketCommunicationStrategy が必要です。');
			}
			confirmStrategy = new TxEventConfirmationStrategy();
			break;
		default:
			throw new Error(`不明な完了確認戦略: ${config.strategies.confirmation}`);
	}

	let uploadStrategy: IUploadStrategy;
	switch (config.strategies.upload) {
		case 'Sequential':
			uploadStrategy = new SequentialUploadStrategy();
			break;
		case 'Distribute':
			if (config.strategies.communication !== 'WebSocket') {
				throw new Error('DistributeUploadStrategy は WebSocketCommunicationStrategy が必要です (Mempool 監視のため)。');
			}
			uploadStrategy = new DistributeUploadStrategy();
			break;
		default:
			// @ts-ignore
			throw new Error(`不明なアップロード戦略: ${config.strategies.upload}。Sequential または Distribute を指定してください。`);
	}

	let downloadStrategy: IDownloadStrategy;
	switch (config.strategies.download) {
		case 'Http':
			downloadStrategy = new HttpDownloadStrategy();
			break;
		default:
			throw new Error(`不明なダウンロード戦略: ${config.strategies.download}`);
	}

	let verifyStrategy: IVerificationStrategy;
	switch (config.strategies.verification) {
		case 'BufferFull':
		case 'BufferPartial':
			verifyStrategy = new BufferVerificationStrategy();
			break;
		default:
			throw new Error(`不明な検証戦略: ${config.strategies.verification}`);
	}

	const gasEstimationStrategy = new SimulationGasEstimationStrategy();

	// ★ 追加: ProgressManager をインスタンス化
	const progressManager = new ProgressManager();

	log.info('すべての戦略モジュールのインスタンス化が完了しました。'); // (ファイルログ用)
	return {
		commStrategy,
		uploadStrategy,
		confirmStrategy,
		downloadStrategy,
		verifyStrategy,
		gasEstimationStrategy,
		progressManager // ★ 返す
	};
}

/**
 * コマンドライン引数を解析します。
 */
function parseArgs(): { configPath: string, logLevel: string | undefined } {
	const args = process.argv.slice(2);

	const configIndex = args.indexOf('--config');
	if (configIndex === -1 || !args[configIndex + 1]) {
		// ★ 修正: log.error は stderr に出力される
		log.error('引数エラー: --config <path/to/config.ts> が必要です。');
		log.error('例: yarn ts-node src/run-experiment.ts --config experiments/configs/case1-Sequential-Polling.config.ts');
		process.exit(1);
	}
	const configPath = args[configIndex + 1]!;

	const logLevelIndex = args.indexOf('--logLevel');
	const logLevel = (logLevelIndex !== -1 && args[logLevelIndex + 1])
		? args[logLevelIndex + 1]
		: undefined;

	return { configPath, logLevel };
}


/**
 * 実験結果をCSV形式の文字列に変換します
 */
async function formatResultsAsCSV(result: ExperimentResult): Promise<string> {
	const header = [
		'Timestamp',
		'ExperimentDescription',
		'Iteration',
		'TaskDescription',
		'TaskChainCount',
		'TaskTargetKB',
		'TaskChunkSizeBytes',
		'TaskTargetChain',
		'TaskPipelineDepth',
		'Upload_ms',
		'Download_ms',
		'Total_Tx',
		'Success_Tx',
		'Failed_Tx',
		'Total_Gas',
		'Avg_Gas_Per_Tx',
		'Data_Size_Bytes',
		'Verification_Success',
		'Strategy_Comm',
		'Strategy_Upload',
		'Strategy_Confirm',
	].join(',');

	const now = new Date().toISOString();
	const config = result.config;

	const rows = result.iterationResults.map(iter => {
		const upload = iter.uploadResult;
		const task = iter.task;

		const dataSize = iter.downloadResult.downloadedData.length > 0
			? iter.downloadResult.downloadedData.length
			: (task.target.type === 'sizeKB' ? task.target.value * 1024 : 0);

		return [
			now,
			`"${config.description}"`,
			iter.iteration,
			`"${task.description ?? 'N/A'}"`,
			task.chainCount,
			task.target.type === 'sizeKB' ? task.target.value : 'N/A (File)',
			task.chunkSize,
			task.targetChain ?? 'N/A',
			task.pipelineDepth ?? 'N/A',
			upload.durationMs,
			iter.downloadResult.durationMs,
			upload.totalTx,
			upload.successTx,
			upload.failedTx,
			upload.totalGasUsed,
			upload.avgGasPerTx,
			dataSize,
			iter.verificationResult.verified,
			config.strategies.communication,
			config.strategies.upload,
			config.strategies.confirmation,
		].join(',');
	});

	return [header, ...rows].join('\n');
}

/**
 * メイン実行関数
 */
async function main() {
	let runner: ExperimentRunner | undefined;
	// ★ 追加: strategies を try ブロックの外で宣言 (finally で使うため)
	let strategies: ExperimentStrategies | undefined;

	try {
		// 1. 引数解析
		const { configPath, logLevel } = parseArgs();

		// ★ 修正: これ以降、log.info/debug はファイルにのみ書き込まれる
		if (logLevel) {
			log.setLogLevel(logLevel as LogLevel);
		}

		log.info(`設定ファイル ${configPath} を読み込んでいます...`);

		// 2. 設定ファイルの動的インポート
		const absoluteConfigPath = path.resolve(__dirname, configPath);
		const configModule = await import(absoluteConfigPath);
		const config: ExperimentConfig = configModule.default;

		if (!config) {
			throw new Error(`設定ファイル ${configPath} が 'export default' していません。`);
		}

		// 3. 戦略のインスタンス化
		strategies = instantiateStrategies(config); // ★ strategies に代入
		const urlPathCodec = new UrlPathCodec();

		// 4. ExperimentRunner の初期化と実行
		runner = new ExperimentRunner(config, strategies, urlPathCodec);
		const result = await runner.run();

		// 5. 結果の表示 (★ 修正: console.error で stderr に出力)
		log.step('--- 実験結果サマリー ---'); // (これは 'success' レベルなので stderr に出る)
		console.error(JSON.stringify(result.summary ?? { message: 'サマリーなし' }, null, 2));
		log.step('--- イテレーション詳細 (タスク別) ---');
		console.error(
			result.iterationResults.map(r => ({
				iter: r.iteration,
				task: r.task.description ?? `size=${r.task.target.value}KB, chunk=${r.task.chunkSize}, chains=${r.task.chainCount}, target=${r.task.targetChain ?? 'N/A'}`,
				uploadMs: Number(r.uploadResult.durationMs),
				downloadMs: Number(r.downloadResult.durationMs),
				successTx: r.uploadResult.successTx,
				totalGas: String(r.uploadResult.totalGasUsed),
				verified: r.verificationResult.verified,
			}))
		);

		// 6. CSVファイルへの保存
		const csvData = await formatResultsAsCSV(result);
		const resultsDir = path.join(__dirname, 'experiments', 'results');

		const safeDescription = config.description
			.replace(/\s+/g, '_')
			.replace(/[^a-zA-Z0-9_-]/g, '')
			.toLowerCase();
		const csvFileName = `${safeDescription}_${Date.now()}.csv`;
		const csvFilePath = path.join(resultsDir, csvFileName);

		await fs.mkdir(resultsDir, { recursive: true });
		await fs.writeFile(csvFilePath, csvData);
		log.info(`実験結果を ${csvFilePath} に保存しました。`);

	} catch (error: any) {
		log.error('実験の実行中に致命的なエラーが発生しました。', error);
		process.exitCode = 1;
	} finally {
		// ★ 追加: エラー発生時でもプログレスバーが起動していれば停止する
		if (strategies && strategies.progressManager) {
			strategies.progressManager.stop();
		}
		// ログバッファをフラッシュ
		await log.flushErrorLogs();
		process.exit();
	}
}

// --- スクリプト実行 ---
main();