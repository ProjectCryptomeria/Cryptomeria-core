// controller/src/run-experiment.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { ExperimentRunner } from './core/ExperimentRunner';
import { ExperimentConfig, ExperimentResult } from './types';
import { log } from './utils/logger';

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
import {
	AutoDistributeUploadStrategy,
	IUploadStrategy,
	RoundRobinUploadStrategy,
	SequentialUploadStrategy
} from './strategies/upload';
import {
	BufferVerificationStrategy,
	IVerificationStrategy
} from './strategies/verification';

import { IGasEstimationStrategy, SimulationGasEstimationStrategy } from './strategies/gas';

interface ExperimentStrategies {
	commStrategy: ICommunicationStrategy;
	uploadStrategy: IUploadStrategy;
	confirmStrategy: IConfirmationStrategy;
	downloadStrategy: IDownloadStrategy;
	verifyStrategy: IVerificationStrategy;
	gasEstimationStrategy: IGasEstimationStrategy;
}

/**
 * 設定オブジェクト（文字列）に基づき、
 * 戦略クラスの具象インスタンスを生成します。
 * @param config ExperimentConfig
 * @returns ExperimentStrategies (インスタンス化された戦略オブジェクト)
 */
function instantiateStrategies(config: ExperimentConfig): ExperimentStrategies {
	log.info('戦略モジュールをインスタンス化しています...');

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
			// TxEvent 戦略は WebSocket が必須
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
		case 'RoundRobin':
			uploadStrategy = new RoundRobinUploadStrategy();
			break;
		case 'AutoDistribute':
			// AutoDistribute 戦略は Mempool 監視のため WebSocket (RPC Client) が推奨
			if (config.strategies.communication !== 'WebSocket') {
				log.warn('AutoDistributeUploadStrategy は WebSocketCommunicationStrategy を推奨します (Mempool 監視のため)。');
			}
			uploadStrategy = new AutoDistributeUploadStrategy();
			break;
		default:
			throw new Error(`不明なアップロード戦略: ${config.strategies.upload}`);
	}

	let downloadStrategy: IDownloadStrategy;
	switch (config.strategies.download) {
		case 'Http':
			// HttpDownloadStrategy は内部で HttpCommunicationStrategy を使う想定だが、
			// 汎用性のために ICommunicationStrategy (の sendRestRequest) を使う
			downloadStrategy = new HttpDownloadStrategy();
			break;
		default:
			throw new Error(`不明なダウンロード戦略: ${config.strategies.download}`);
	}

	let verifyStrategy: IVerificationStrategy;
	switch (config.strategies.verification) {
		case 'BufferFull':
		case 'BufferPartial': // 同じクラスでオプションで制御
			verifyStrategy = new BufferVerificationStrategy();
			break;
		default:
			throw new Error(`不明な検証戦略: ${config.strategies.verification}`);
	}

	const gasEstimationStrategy = new SimulationGasEstimationStrategy();

	log.info('すべての戦略モジュールのインスタンス化が完了しました。');
	return {
		commStrategy,
		uploadStrategy,
		confirmStrategy,
		downloadStrategy,
		verifyStrategy,
		gasEstimationStrategy
	};
}

/**
 * コマンドライン引数を解析します。
 * @returns { configPath: string }
 */
function parseArgs(): { configPath: string } {
	const args = process.argv.slice(2);
	const configIndex = args.indexOf('--config');

	if (configIndex === -1 || !args[configIndex + 1]) {
		log.error('引数エラー: --config <path/to/config.ts> が必要です。');
		log.error('例: yarn start --config experiments/configs/case1-limit-test.config.ts');
		process.exit(1);
	}

	const configPath = args[configIndex + 1] ?? "error";

	// デバッグモードのチェック (オプション)
	if (args.includes('--debug')) {
		log.setDebugMode(true);
	}

	return { configPath };
}

/**
 * 実験結果をCSV形式の文字列に変換します (簡易版)
 * @param result ExperimentResult
 * @returns CSV文字列
 */
async function formatResultsAsCSV(result: ExperimentResult): Promise<string> {
	const header = [
		'Timestamp',
		'Description',
		'Iteration',
		'ChainCount',
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
		'Chunk_Size_Bytes',
	].join(',');

	const now = new Date().toISOString();
	const config = result.config;

	const rows = result.iterationResults.map(iter => {
		const upload = iter.uploadResult;
		const dataSize = iter.downloadResult.downloadedData.length > 0
			? iter.downloadResult.downloadedData.length
			: (config.target.type === 'sizeKB' ? config.target.value * 1024 : 0);

		return [
			now,
			`"${config.description}"`,
			iter.iteration,
			iter.chainCount,
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
			upload.chunkSizeUsedBytes ?? 'N/A',
		].join(',');
	});

	return [header, ...rows].join('\n');
}

/**
 * メイン実行関数
 */
async function main() {
	let runner: ExperimentRunner | undefined;

	try {
		// 1. 引数解析
		const { configPath } = parseArgs();
		log.info(`設定ファイル ${configPath} を読み込んでいます...`);

		// 2. 設定ファイルの動的インポート
		// (注: ts-node や tsc-watch は .ts の動的インポートをサポートしている)
		const absoluteConfigPath = path.resolve(__dirname, configPath);
		const configModule = await import(absoluteConfigPath);
		const config: ExperimentConfig = configModule.default;

		if (!config) {
			throw new Error(`設定ファイル ${configPath} が 'export default' していません。`);
		}

		// 3. 戦略のインスタンス化
		const strategies = instantiateStrategies(config);

		// 4. ExperimentRunner の初期化と実行
		runner = new ExperimentRunner(config, strategies);
		const result = await runner.run();

		// 5. 結果の表示
		log.step('--- 実験結果サマリー ---');
		console.log(JSON.stringify(result.summary ?? { message: 'サマリーなし' }, null, 2));
		log.step('--- イテレーション詳細 ---');
		console.log(
			result.iterationResults.map(r => ({
				iter: r.iteration,
				chains: r.chainCount,
				uploadMs: Number(r.uploadResult.durationMs), // コンソール表示用に Number に
				downloadMs: Number(r.downloadResult.durationMs),
				successTx: r.uploadResult.successTx,
				totalGas: String(r.uploadResult.totalGasUsed), // コンソール表示用に String に
				verified: r.verificationResult.verified,
			}))
		);

		// 6. CSVファイルへの保存
		const csvData = await formatResultsAsCSV(result);
		const resultsDir = path.join(__dirname, 'experiments', 'results');

		// ★ 修正: config.description からファイル名を作成
		const safeDescription = config.description
			.replace(/\s+/g, '_')           // スペースをアンダースコアに
			.replace(/[^a-zA-Z0-9_-]/g, '') // 英数字、アンダースコア、ハイフン以外を削除
			.toLowerCase();
		const csvFileName = `${safeDescription}_${Date.now()}.csv`;
		const csvFilePath = path.join(resultsDir, csvFileName);

		await fs.mkdir(resultsDir, { recursive: true });
		await fs.writeFile(csvFilePath, csvData);
		log.info(`実験結果を ${csvFilePath} に保存しました。`);

	} catch (error: any) {
		log.error('実験の実行中に致命的なエラーが発生しました。', error);
		process.exitCode = 1; // エラーコードを設定
	} finally {
		// ログバッファをフラッシュ
		await log.flushErrorLogs();
		process.exit();
	}
}

// --- スクリプト実行 ---
main();