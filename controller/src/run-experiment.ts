// controller/src/run-experiment.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { ExperimentRunner } from './core/ExperimentRunner';
import { ExperimentConfig, ExperimentResult } from './types';
import { log } from './utils/logger';
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

// ★ 修正: インポートする具象戦略クラスを変更
import {
	DistributeUploadStrategy, // ★ 修正
	IUploadStrategy,
	SequentialUploadStrategy // ★ 修正
} from './strategies/upload';
// (RoundRobinUploadStrategy と AutoDistributeUploadStrategy は削除)

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
			if (config.strategies.communication !== 'WebSocket') {
				throw new Error('TxEventConfirmationStrategy は WebSocketCommunicationStrategy が必要です。');
			}
			confirmStrategy = new TxEventConfirmationStrategy();
			break;
		default:
			throw new Error(`不明な完了確認戦略: ${config.strategies.confirmation}`);
	}

	// ★★★ 修正箇所: アップロード戦略のインスタンス化 ★★★
	let uploadStrategy: IUploadStrategy;
	switch (config.strategies.upload) {

		// 方式1: シーケンシャル（ワンバイワン）
		case 'Sequential':
			uploadStrategy = new SequentialUploadStrategy();
			break;

		// 方式2: ディストリビュート（マルチバースト）
		case 'Distribute': // ★ ご要望の「ディストリビュート戦略」
			// この戦略は Mempool 監視のため WebSocket (RPC Client) が必須
			if (config.strategies.communication !== 'WebSocket') {
				throw new Error('DistributeUploadStrategy は WebSocketCommunicationStrategy が必要です (Mempool 監視のため)。');
			}
			uploadStrategy = new DistributeUploadStrategy();
			break;
		default:
			// @ts-ignore (型チェックで 'RoundRobin' や 'AutoDistribute' がエラーになるが、実行時エラーとして捕捉)
			throw new Error(`不明なアップロード戦略: ${config.strategies.upload}。Sequential または Distribute を指定してください。`);
	}
	// ★★★ 修正箇所ここまで ★★★

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
 * (変更なし)
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

	if (args.includes('--debug')) {
		log.setDebugMode(true);
	}

	return { configPath };
}

/**
 * 実験結果をCSV形式の文字列に変換します (簡易版)
 * (変更なし)
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
 * (変更なし)
 */
async function main() {
	let runner: ExperimentRunner | undefined;

	try {
		// 1. 引数解析
		const { configPath } = parseArgs();
		log.info(`設定ファイル ${configPath} を読み込んでいます...`);

		// 2. 設定ファイルの動的インポート
		const absoluteConfigPath = path.resolve(__dirname, configPath);
		const configModule = await import(absoluteConfigPath);
		const config: ExperimentConfig = configModule.default;

		if (!config) {
			throw new Error(`設定ファイル ${configPath} が 'export default' していません。`);
		}

		// 3. 戦略のインスタンス化
		const strategies = instantiateStrategies(config);

		const urlPathCodec = new UrlPathCodec();

		// 4. ExperimentRunner の初期化と実行
		runner = new ExperimentRunner(config, strategies, urlPathCodec);
		const result = await runner.run();

		// 5. 結果の表示
		log.step('--- 実験結果サマリー ---');
		console.log(JSON.stringify(result.summary ?? { message: 'サマリーなし' }, null, 2));
		log.step('--- イテレーション詳細 ---');
		console.log(
			result.iterationResults.map(r => ({
				iter: r.iteration,
				chains: r.chainCount,
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
		// ログバッファをフラッシュ
		await log.flushErrorLogs();
		process.exit();
	}
}

// --- スクリプト実行 ---
main();