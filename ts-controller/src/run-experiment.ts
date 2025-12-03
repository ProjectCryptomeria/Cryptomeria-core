// controller/src/run-experiment.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { ExperimentRunner } from './core/ExperimentRunner';
import { ExperimentConfig, ExperimentResult, LogLevel } from './types'; // LogLevel も types/index.ts からインポート (要修正)
// ★ 修正: LogLevel を types からインポート (logger からは削除)
// import { log, LogLevel } from './utils/logger';
import { log } from './utils/logger';
import { IProgressManager } from './utils/ProgressManager/IProgressManager';
import { ProgressManager, SilentProgressManager } from './utils/ProgressManager/ProgressManager';
import { UrlPathCodec } from './utils/UrlPathCodec';

// --- (通信、完了確認、ダウンロード、検証、ガスのインポートは変更なし) ---
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
	BufferVerificationStrategy,
	IVerificationStrategy
} from './strategies/verification';

// ★★★ 修正箇所: アップロード戦略のインポート ★★★
import {
	CompositeUploadStrategy,
	IUploadStrategy
} from './strategies/upload';

// (新しい Allocator と Transmitter のインポート)
import {
	AvailableAllocator,
	RandomAllocator,
	RoundRobinAllocator,
	StaticMultiAllocator
} from './strategies/upload/implement/allocator';
import {
	MultiBurstTransmitter,
	OneByOneTransmitter
} from './strategies/upload/implement/transmitter';
import { IChunkAllocator } from './strategies/upload/interfaces/IChunkAllocator';
import { IUploadTransmitter } from './strategies/upload/interfaces/IUploadTransmitter';
// ★★★ 修正箇所 ここまで ★★★


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
 * ★ 修正: instantiateStrategies をリファクタリング後の戦略に対応
 */
function instantiateStrategies(config: ExperimentConfig, logLevel: LogLevel, noProgress: boolean): ExperimentStrategies {
	log.info('戦略モジュールをインスタンス化しています...');

	// --- 1. 通信戦略 (変更なし) ---
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

	// --- 2. 完了確認戦略 (変更なし) ---
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

	// --- 3. ダウンロード、検証、ガス (変更なし) ---
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

	// --- 4. プログレスバー (変更なし) ---
	const useSilentProgress = noProgress;
	const progressManager = useSilentProgress
		? new SilentProgressManager()
		: new ProgressManager();

	if (useSilentProgress) {
		log.info('[ProgressManager] --no-progress フラグが指定されたため、プログレスバーを無効化します (Silent Mode)。');
	}

	// ★★★ 5. アップロード戦略 (Composite パターン) ★★★

	// 5a. 送信方式 (Transmitter) を決定
	let transmitter: IUploadTransmitter;
	switch (config.strategies.uploadTransmitter) {
		case 'OneByOne':
			transmitter = new OneByOneTransmitter();
			break;
		case 'MultiBurst':
			transmitter = new MultiBurstTransmitter();
			break;
		default:
			throw new Error(`不明な UploadTransmitter 戦略: ${config.strategies.uploadTransmitter}`);
	}

	// 5b. 割当方式 (Allocator) を決定
	let allocator: IChunkAllocator;
	switch (config.strategies.uploadAllocator) {
		case 'StaticMulti':
			allocator = new StaticMultiAllocator();
			break;
		case 'RoundRobin':
			allocator = new RoundRobinAllocator();
			break;
		case 'Available':
			if (config.strategies.communication !== 'WebSocket') {
				throw new Error('AvailableAllocator は WebSocketCommunicationStrategy が必要です (Mempool 監視のため)。');
			}
			allocator = new AvailableAllocator();
			break;
		case 'Random':
			allocator = new RandomAllocator();
			break;
		default:
			throw new Error(`不明な UploadAllocator 戦略: ${config.strategies.uploadAllocator}`);
	}

	// 5c. 2つを合成
	const uploadStrategy = new CompositeUploadStrategy(allocator, transmitter);

	log.info('すべての戦略モジュールのインスタンス化が完了しました。');
	return {
		commStrategy,
		uploadStrategy,
		confirmStrategy,
		downloadStrategy,
		verifyStrategy,
		gasEstimationStrategy,
		progressManager
	};
}

/**
 * コマンドライン引数を解析します。
 * (変更なし)
 */
function parseArgs(): { configPath: string, logLevel: string | undefined, noProgress: boolean } {
	const args = process.argv.slice(2);

	const configIndex = args.indexOf('--config');
	if (configIndex === -1 || !args[configIndex + 1]) {
		log.error('引数エラー: --config <path/to/config.ts> が必要です。');
		log.error('例: yarn ts-node src/run-experiment.ts --config experiments/configs/case1-Sequential-Polling.config.ts');
		process.exit(1);
	}
	const configPath = args[configIndex + 1]!;

	const logLevelIndex = args.indexOf('--logLevel');
	const logLevel = (logLevelIndex !== -1 && args[logLevelIndex + 1])
		? args[logLevelIndex + 1]
		: undefined;

	const noProgress = args.includes('--no-progress');

	return { configPath, logLevel, noProgress };
}


/**
 * 実験結果をCSV形式の文字列に変換します
 * (★ 修正: config.strategies.upload を .uploadAllocator/.uploadTransmitter に変更)
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
		// ★ 修正
		'Strategy_Upload_Allocator',
		'Strategy_Upload_Transmitter',
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
			// ★ 修正
			config.strategies.uploadAllocator,
			config.strategies.uploadTransmitter,
			config.strategies.confirmation,
		].join(',');
	});

	return [header, ...rows].join('\n');
}

/**
 * メイン実行関数
 * (★ 修正: LogLevel を string からキャスト)
 */
async function main() {
	let runner: ExperimentRunner | undefined;
	let strategies: ExperimentStrategies | undefined;

	try {
		// 1. 引数解析
		const { configPath, logLevel: logLevelArg, noProgress } = parseArgs();
		// ★ 修正
		const logLevel: LogLevel = (logLevelArg as LogLevel) ?? 'info';

		if (logLevelArg) {
			log.setLogLevel(logLevel);
		}

		log.info(`設定ファイル ${configPath} を読み込んでいます...`);

		// 2. 設定ファイルの動的インポート
		const absoluteConfigPath = path.resolve(__dirname, configPath);
		const configModule = await import(absoluteConfigPath);
		const config: ExperimentConfig = configModule.default;

		if (!config) {
			throw new Error(`設定ファイル ${configPath} が 'export default' していません。`);
		}

		// 3. 戦略のインスタンス化 (★ 修正済み)
		strategies = instantiateStrategies(config, logLevel, noProgress);
		const urlPathCodec = new UrlPathCodec();

		// 4. ExperimentRunner の初期化と実行
		runner = new ExperimentRunner(config, strategies, urlPathCodec);
		const result = await runner.run();

		// 5. 結果の表示 (変更なし)
		log.step('--- 実験結果サマリー ---');
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

		// 6. CSVファイルへの保存 (変更なし)
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
		// 7. 終了処理 (変更なし)
		if (strategies && strategies.progressManager) {
			strategies.progressManager.stop();
		}
		await log.flushErrorLogs();
		process.exit();
	}
}

// --- スクリプト実行 ---
main();