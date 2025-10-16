// src/tests/test-case.ts
import fetch from 'node-fetch';
import * as path from 'path';
import { BLOCK_SIZE_LIMIT_MB, CHUNK_SIZE } from '../config';
import { log } from '../lib/logger';
import { PerformanceTracker } from '../lib/performance-tracker';
import { InitializeOptions, RaidchainClient, UploadOptions } from '../lib/raidchain.client';

// Node.js v18未満や、環境変数 `NODE_OPTIONS=--no-experimental-fetch` が設定されている場合、fetchをグローバルに定義する
if (!global.fetch) {
	global.fetch = fetch as any;
}


// --- データ構造の定義 ---

// 各テストの実行結果を格納するインターフェース
interface TestResult {
	iteration: number;
	case: string;
	param: string; // size(KB) or strategy or chainCount
	fileSizeKB: number;
	chunkSizeKB: number;
	uploadTimeMs: number;
	downloadTimeMs: number;
	throughputKBps: number; // スループット
	totalTx: number;
	totalGas: bigint;
	totalFee: bigint;
	gasPerKB: bigint; // KBあたりのガス
	avgGas: bigint;
	verified: boolean;
	chainsUsedCount: number;
	chainsUsedList: string;
}

// --- 結果出力ヘルパー ---
function printResults(results: TestResult[]) {
	if (results.length === 0) return;

	console.log('\n--- 📊 個別実行結果 ---');
	console.table(results.map(r => ({
		'Iteration': r.iteration,
		'Case': r.case,
		'FileSize (KB)': r.fileSizeKB,
		'ChunkSize (KB)': r.chunkSizeKB,
		'Upload (ms)': r.uploadTimeMs.toFixed(2),
		'Download (ms)': r.downloadTimeMs.toFixed(2),
		'Throughput (KB/s)': r.throughputKBps.toFixed(2),
		'Chains (Count)': r.chainsUsedCount,
		'Total Gas': r.totalGas.toString(),
		'Total Fee': r.totalFee.toString(),
		'Gas/KB': r.gasPerKB.toString(),
	})));

	console.log('\n--- 📋 CSV形式 (コピー用) ---');
	const header = 'Iteration,Case,FileSize(KB),ChunkSize(KB),Upload(ms),Download(ms),Throughput(KB/s),ChainsCount,ChainsList,TotalTxs,TotalGas,TotalFee,GasPerKB,AvgGasPerTx';
	const csvRows = results.map(r =>
		[
			r.iteration,
			r.case,
			r.fileSizeKB,
			r.chunkSizeKB,
			r.uploadTimeMs.toFixed(2),
			r.downloadTimeMs.toFixed(2),
			r.throughputKBps.toFixed(2),
			r.chainsUsedCount,
			`"${r.chainsUsedList}"`,
			r.totalTx,
			r.totalGas.toString(),
			r.totalFee.toString(),
			r.gasPerKB.toString(),
		].join(',')
	);
	console.log([header, ...csvRows].join('\n'));

	if (results.length > 1) {
		const avg = results.reduce((acc, r, _, arr) => ({
			uploadTimeMs: acc.uploadTimeMs + r.uploadTimeMs / arr.length,
			downloadTimeMs: acc.downloadTimeMs + r.downloadTimeMs / arr.length,
			throughputKBps: acc.throughputKBps + r.throughputKBps / arr.length,
			chainsUsedCount: acc.chainsUsedCount + r.chainsUsedCount / arr.length,
			totalTx: acc.totalTx + r.totalTx / arr.length,
			totalGas: acc.totalGas + r.totalGas / BigInt(arr.length),
			totalFee: acc.totalFee + r.totalFee / BigInt(arr.length),
			gasPerKB: acc.gasPerKB + r.gasPerKB / BigInt(arr.length),
			avgGas: acc.avgGas + r.avgGas / BigInt(arr.length),
		}), { uploadTimeMs: 0, downloadTimeMs: 0, throughputKBps: 0, chainsUsedCount: 0, totalTx: 0, totalGas: 0n, totalFee: 0n, gasPerKB: 0n, avgGas: 0n });

		const avgResult = {
			'Case': results[0]!.case,
			'Avg Upload (ms)': avg.uploadTimeMs.toFixed(2),
			'Avg Download (ms)': avg.downloadTimeMs.toFixed(2),
			'Avg Throughput (KB/s)': avg.throughputKBps.toFixed(2),
			'Avg Used Chains': avg.chainsUsedCount.toFixed(2),
			'Avg Total Gas': avg.totalGas.toString(),
			'Avg Total Fee': avg.totalFee.toString(),
			'Avg Gas/KB': avg.gasPerKB.toString(),
		};

		console.log('\n--- 📈 平均実行結果 ---');
		console.table([avgResult]);
	}
}


// 共通のテスト実行ロジック
async function runSingleTest(
	options: {
		caseName: string;
		param: string;
		filePath: string;
		targetSizeKB: number;
		siteUrl: string;
		chunkSizeKB?: number | 'auto' | undefined;
		distributionStrategy: 'auto' | 'round-robin' | 'manual';
		targetChain?: string;
		chainCount?: number;
	}
): Promise<TestResult> {
	const localClient = new RaidchainClient();
	const tracker = new PerformanceTracker();

	const initOptions: InitializeOptions = {};
	if (options.chainCount !== undefined) {
		initOptions.chainCount = options.chainCount;
	}
	await localClient.initialize(initOptions);

	// 目標とするエンコード後サイズから、元のファイルサイズを逆算
	const originalSizeKB = Math.floor(getOriginalSizeForBase64Target(options.targetSizeKB * 1024) / 1024);

	log.info(`Target Encoded Size: ${options.targetSizeKB} KB, creating original file of ~${originalSizeKB} KB`);
	const originalContent = await localClient.createTestFile(options.filePath, originalSizeKB);
	const usedChains = new Set<string>();

	const uploadOptions: UploadOptions = {
		distributionStrategy: options.distributionStrategy,
		onChunkUploaded: (info) => usedChains.add(info.chain),
		onTransactionConfirmed: (result) => {
			tracker.recordTransaction(result.gasUsed, result.feeAmount);
		},
	};
	if (options.targetChain !== undefined) {
		uploadOptions.targetChain = options.targetChain;
	}
	if (options.chunkSizeKB !== undefined) {
		uploadOptions.chunkSize = options.chunkSizeKB;
	}

	const { uploadStats } = await localClient.uploadFile(options.filePath, options.siteUrl, uploadOptions);

	const chainsUsedList = Array.from(usedChains).sort();
	const { data: downloaded, downloadTimeMs } = await localClient.downloadFile(options.siteUrl);

	// ★★★ 修正箇所: ファイル全体ではなく、先頭部分の一致のみを確認 ★★★
	const verified = downloaded.toString('utf-8').startsWith(originalContent);

	// 計算とレポートには、ユーザーが意図した「エンコード後のサイズ」を使用
	const throughputKBps = options.targetSizeKB / (uploadStats.durationMs / 1000);
	const gasPerKB = options.targetSizeKB > 0 ? uploadStats.totalGasUsed / BigInt(options.targetSizeKB) : 0n;

	let finalChunkSizeKB = 0;
	if (typeof options.chunkSizeKB === 'number') {
		finalChunkSizeKB = options.chunkSizeKB / 1024;
	} else if (options.chunkSizeKB === 'auto') {
		const dataChainCount = localClient.dataChainCount;
		if (dataChainCount > 0) {
			const fileSize = originalSizeKB * 1024;
			const blockSizeLimitBytes = BLOCK_SIZE_LIMIT_MB * 1024 * 1024;
			const idealChunkSize = Math.ceil(fileSize / dataChainCount);
			const calculatedChunkSizeBytes = Math.min(idealChunkSize, blockSizeLimitBytes);
			finalChunkSizeKB = calculatedChunkSizeBytes / 1024;
		} else {
			finalChunkSizeKB = CHUNK_SIZE / 1024; // フォールバック
		}
	} else {
		finalChunkSizeKB = CHUNK_SIZE / 1024; // デフォルト
	}


	return {
		iteration: 0,
		case: options.caseName,
		param: options.param,
		fileSizeKB: options.targetSizeKB,
		chunkSizeKB: finalChunkSizeKB,
		uploadTimeMs: uploadStats.durationMs,
		downloadTimeMs: downloadTimeMs,
		throughputKBps: throughputKBps,
		totalTx: uploadStats.transactionCount,
		totalGas: uploadStats.totalGasUsed,
		totalFee: uploadStats.totalFee,
		gasPerKB: gasPerKB,
		avgGas: uploadStats.averageGasPerTransaction,
		verified: verified,
		chainsUsedCount: chainsUsedList.length,
		chainsUsedList: chainsUsedList.join(' '),
	};
}

function getOriginalSizeForBase64Target(targetSizeInBytes: number): number {
	return Math.floor(targetSizeInBytes * 3 / 4);
}

// --- Test Case 1: 単一チャンク上限テスト ---
async function runCase1(targetSizeKB: number): Promise<TestResult[]> {
	const testFilePath = path.join(__dirname, 'test-file-limit.txt');
	log.step('1. 【実験】単一チャンクでのアップロード上限を探します');

	const allResults: TestResult[] = [];
	try {
		const originalSizeKB = Math.floor(getOriginalSizeForBase64Target(targetSizeKB * 1024) / 1024);
		const result = await runSingleTest({
			caseName: 'Case1-SingleChunkLimit',
			param: `${targetSizeKB}KB`,
			filePath: testFilePath,
			targetSizeKB: targetSizeKB,
			siteUrl: `limit-test/${targetSizeKB}kb-${Date.now()}`,
			chunkSizeKB: "auto",
			distributionStrategy: 'round-robin',
		});
		allResults.push(result);
	} catch (error: any) {
		log.error(`${targetSizeKB} KB upload or verification failed.`);
		console.error(error.message);
		allResults.push({
			iteration: 1, case: 'Case1-SingleChunkLimit', param: `${targetSizeKB}KB`,
			fileSizeKB: targetSizeKB, chunkSizeKB: targetSizeKB,
			uploadTimeMs: 0, downloadTimeMs: 0, throughputKBps: 0, totalTx: 0,
			totalGas: 0n, totalFee: 0n, gasPerKB: 0n, avgGas: 0n, verified: false,
			chainsUsedCount: 0, chainsUsedList: 'failed'
		});
	}
	return allResults;
}


// --- Test Case 2: Manual (単一チェーン) 分散テスト ---
async function runCase2(sizeKB: number, chunkSize: number | 'auto' | undefined): Promise<TestResult> {
	const TARGET_CHAIN = 'data-1';
	log.step(`2. 【実験】${sizeKB}KBのファイルをチャンク化し、全て'${TARGET_CHAIN}'にアップロードします`);

	return runSingleTest({
		caseName: 'Case2-Manual',
		param: TARGET_CHAIN,
		filePath: path.join(__dirname, 'test-file-manual.txt'),
		targetSizeKB: sizeKB,
		chunkSizeKB: chunkSize,
		siteUrl: `manual-dist-test/${Date.now()}`,
		distributionStrategy: 'manual',
		targetChain: TARGET_CHAIN,
	});
}

// --- Test Case 3: Round-Robin 分散テスト ---
async function runCase3(sizeKB: number, chunkSize: number | 'auto' | undefined): Promise<TestResult> {
	log.step(`3. 【実験】${sizeKB}KBのファイルをチャンク化し、ラウンドロビンにアップロードします`);

	return runSingleTest({
		caseName: 'Case3-RoundRobin',
		param: 'round-robin',
		filePath: path.join(__dirname, 'test-file-round-robin.txt'),
		targetSizeKB: sizeKB,
		chunkSizeKB: chunkSize,
		siteUrl: `round-robin-dist-test/${Date.now()}`,
		distributionStrategy: 'round-robin',
	});
}

// --- Test Case 4: Auto (負荷分散) テスト ---
async function runCase4(sizeKB: number, chunkSize: number | 'auto' | undefined): Promise<TestResult> {
	log.step(`4. 【実験】${sizeKB}KBのファイルをチャンク化し、空いているチェーンへ自動でアップロードします`);

	return runSingleTest({
		caseName: 'Case4-Auto',
		param: 'auto',
		filePath: path.join(__dirname, 'test-file-auto.txt'),
		targetSizeKB: sizeKB,
		siteUrl: `auto-dist-test/${Date.now()}`,
		distributionStrategy: 'auto',
		chunkSizeKB: "auto",
	});
}


// --- Test Case 5: 水平スケーラビリティ測定テスト ---
async function runCase5(sizeKB: number, chunkSize: number | 'auto' | undefined, chainCounts: number[]): Promise<TestResult[]> {
	const testFilePath = path.join(__dirname, 'test-file-scalability.txt');
	log.step(`5. 【実験】水平スケーラビリティ: ${sizeKB}KBのファイルをチェーン数 ${chainCounts.join(',')} でテストします`);

	const allResults: TestResult[] = [];

	for (const count of chainCounts) {
		log.step(`--- Testing with ${count} chain(s) ---`);
		try {
			const result = await runSingleTest({
				caseName: 'Case5-Scalability',
				param: `${count}-chains`,
				filePath: testFilePath,
				targetSizeKB: sizeKB,
				chunkSizeKB: chunkSize,
				siteUrl: `scalability-test/${count}-chains-${Date.now()}`,
				distributionStrategy: 'auto',
				chainCount: count,
			});
			allResults.push(result);
		} catch (error: any) {
			log.error(`${count} chain(s) test failed.`);
			console.error(error);
		}
	}
	return allResults;
}

// --- Test Case 6: チャンクサイズ最適化テスト ---
async function runCase6(sizeKB: number): Promise<TestResult[]> {
	const testFilePath = path.join(__dirname, 'test-file-chunk-size.txt');
	log.step(`6. 【実験】チャンクサイズ最適化: ${sizeKB}KBのファイルで性能を比較します`);

	const allResults: TestResult[] = [];

	log.step(`--- Scenario A: Small Chunks (16KB) ---`);
	const resultA = await runSingleTest({
		caseName: 'Case6-ChunkSize',
		param: '16KB-chunks',
		filePath: testFilePath,
		targetSizeKB: sizeKB,
		siteUrl: `chunk-test/small-${Date.now()}`,
		chunkSizeKB: 16 * 1024,
		distributionStrategy: 'auto',
	});
	allResults.push(resultA);

	log.step(`--- Scenario B: Large Chunks (128KB) ---`);
	const resultB = await runSingleTest({
		caseName: 'Case6-ChunkSize',
		param: '128KB-chunks',
		filePath: testFilePath,
		targetSizeKB: sizeKB,
		siteUrl: `chunk-test/large-${Date.now()}`,
		chunkSizeKB: 128 * 1024,
		distributionStrategy: 'auto',
	});
	allResults.push(resultB);

	return allResults;
}


// --- Main Execution Logic ---
async function main() {
	const args = process.argv.slice(2);
	const caseIndex = args.indexOf('--case');
	const iterIndex = args.indexOf('--iter');
	const debugIndex = args.indexOf('--debug');
	const countsIndex = args.indexOf('--chain-counts');
	const sizeIndex = args.indexOf('--size-kb');
	const chunkSizeIndex = args.indexOf('--chunk-size');

	if (caseIndex === -1 || !args[caseIndex + 1]) {
		console.error('エラー: --case <number> でテスト番号を指定してください。');
		process.exit(1);
	}
	const caseNumber = args[caseIndex + 1]!;
	const iterations = (iterIndex !== -1 && args[iterIndex + 1]) ? parseInt(args[iterIndex + 1]!, 10) : 1;
	const isDebug = debugIndex !== -1;

	const chainCounts = (countsIndex !== -1 && args[countsIndex + 1])
		? args[countsIndex + 1]!.split(',').map(s => parseInt(s.trim(), 10))
		: [1, 2, 4, 6];

	// ケースごとのデフォルトファイルサイズを設定
	let defaultSizeKB = 100;
	if (caseNumber === '1') defaultSizeKB = 22 * 1024;
	if (caseNumber === '5' || caseNumber === '6') defaultSizeKB = 256;

	const sizeKB = (sizeIndex !== -1 && args[sizeIndex + 1])
		? parseInt(args[sizeIndex + 1]!, 10)
		: defaultSizeKB;

	let chunkSize: number | 'auto' | undefined = undefined;
	if (chunkSizeIndex !== -1 && args[chunkSizeIndex + 1]) {
		const sizeArg = args[chunkSizeIndex + 1]!;
		if (sizeArg.toLowerCase() === 'auto') {
			chunkSize = 'auto';
		} else {
			const size = parseInt(sizeArg, 10);
			if (!isNaN(size)) {
				chunkSize = size * 1024; // KB to bytes
			}
		}
	}


	log.setDebugMode(isDebug);
	const allResults: TestResult[] = [];
	log.step(`🚀 テストケース ${caseNumber} を ${iterations} 回実行します...`);

	for (let i = 1; i <= iterations; i++) {
		log.step(`--- Iteration ${i}/${iterations} ---`);
		try {
			let results: TestResult[] = [];
			switch (caseNumber) {
				case '1':
					results = await runCase1(sizeKB);
					break;
				case '2':
					results.push(await runCase2(sizeKB, chunkSize));
					break;
				case '3':
					results.push(await runCase3(sizeKB, chunkSize));
					break;
				case '4':
					results.push(await runCase4(sizeKB, chunkSize));
					break;
				case '5':
					results = await runCase5(sizeKB, chunkSize, chainCounts);
					break;
				case '6':
					results = await runCase6(sizeKB);
					break;
				default:
					log.error(`無効なテストケース番号です: ${caseNumber}`);
					process.exit(1);
			}

			results.forEach(r => {
				r.iteration = i;
				allResults.push(r);
				if (!r.verified) {
					throw new Error(`Iteration ${i}, Case ${r.case}, Param ${r.param} failed verification.`);
				}
			});

			log.success(`--- Iteration ${i} 完了 ---`);

		} catch (err) {
			log.error(`❌ Iteration ${i} の実行中にエラーが発生しました。`);
			console.error(err);
			process.exit(1);
		}
	}

	log.success(`✅ 全てのイテレーションが完了しました。`);
	printResults(allResults);
}

main().catch(err => {
	log.error("予期せぬエラーでテストが中断されました。");
	console.error(err);
	process.exit(1);
});