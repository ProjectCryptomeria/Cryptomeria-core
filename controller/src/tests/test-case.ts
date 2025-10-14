// src/tests/test-case.ts
import * as path from 'path';
import { CHUNK_SIZE } from '../config';
import { log } from '../lib/logger';
import { InitializeOptions, RaidchainClient, UploadOptions } from '../lib/raidchain.client'; // ★★★ 修正箇所 ★★★

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
		'Parameter': r.param,
		'File Size (KB)': r.fileSizeKB,
		'Chunk Size (KB)': r.chunkSizeKB,
		'Upload (ms)': r.uploadTimeMs.toFixed(2),
		'Download (ms)': r.downloadTimeMs.toFixed(2),
		'Throughput (KB/s)': r.throughputKBps.toFixed(2),
		'Chains (Count)': r.chainsUsedCount,
		'Total Gas': r.totalGas.toString(),
		'Gas/KB': r.gasPerKB.toString(),
		'Verified': r.verified ? '✅' : '🔥',
	})));

	console.log('\n--- 📋 CSV形式 (コピー用) ---');
	const header = 'Iteration,Case,Parameter,FileSize(KB),ChunkSize(KB),Upload(ms),Download(ms),Throughput(KB/s),ChainsCount,ChainsList,TotalTxs,TotalGas,GasPerKB,AvgGasPerTx,Verified';
	const csvRows = results.map(r =>
		[
			r.iteration, r.case, r.param,
			r.fileSizeKB, r.chunkSizeKB,
			r.uploadTimeMs.toFixed(2), r.downloadTimeMs.toFixed(2),
			r.throughputKBps.toFixed(2),
			r.chainsUsedCount, `"${r.chainsUsedList}"`, r.totalTx,
			r.totalGas.toString(),
			r.gasPerKB.toString(),
			r.avgGas.toString(), r.verified,
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
			gasPerKB: acc.gasPerKB + r.gasPerKB / BigInt(arr.length),
			avgGas: acc.avgGas + r.avgGas / BigInt(arr.length),
		}), { uploadTimeMs: 0, downloadTimeMs: 0, throughputKBps: 0, chainsUsedCount: 0, totalTx: 0, totalGas: 0n, gasPerKB: 0n, avgGas: 0n });

		const avgResult = {
			'Case': results[0]!.case,
			'Parameter': results[0]!.param,
			'Avg Upload (ms)': avg.uploadTimeMs.toFixed(2),
			'Avg Download (ms)': avg.downloadTimeMs.toFixed(2),
			'Avg Throughput (KB/s)': avg.throughputKBps.toFixed(2),
			'Avg Used Chains': avg.chainsUsedCount.toFixed(2),
			'Avg Total Gas': avg.totalGas.toString(),
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
		fileSizeKB: number;
		siteUrl: string;
		chunkSize?: number;
		distributionStrategy: 'auto' | 'round-robin' | 'manual';
		targetChain?: string;
		chainCount?: number;
	}
): Promise<TestResult> {
	const localClient = new RaidchainClient();

	const initOptions: InitializeOptions = {};
	if (options.chainCount !== undefined) {
		initOptions.chainCount = options.chainCount;
	}
	await localClient.initialize(initOptions);


	const originalContent = await localClient.createTestFile(options.filePath, options.fileSizeKB);
	const usedChains = new Set<string>();

	const uploadOptions: UploadOptions = {
		distributionStrategy: options.distributionStrategy,
		onChunkUploaded: (info) => usedChains.add(info.chain),
	};
	if (options.targetChain !== undefined) {
		uploadOptions.targetChain = options.targetChain;
	}
	if (options.chunkSize !== undefined) {
		uploadOptions.chunkSize = options.chunkSize;
	}

	const { uploadStats } = await localClient.uploadFile(options.filePath, options.siteUrl, uploadOptions);

	const chainsUsedList = Array.from(usedChains).sort();
	const { data: downloaded, downloadTimeMs } = await localClient.downloadFile(options.siteUrl);
	const verified = originalContent === downloaded.toString('utf-8');

	const throughputKBps = options.fileSizeKB / (uploadStats.durationMs / 1000);
	const gasPerKB = options.fileSizeKB > 0 ? uploadStats.totalGasUsed / BigInt(options.fileSizeKB) : 0n;

	return {
		iteration: 0, // 後で設定
		case: options.caseName,
		param: options.param,
		fileSizeKB: options.fileSizeKB,
		chunkSizeKB: (options.chunkSize ?? CHUNK_SIZE) / 1024,
		uploadTimeMs: uploadStats.durationMs,
		downloadTimeMs: downloadTimeMs,
		throughputKBps: throughputKBps,
		totalTx: uploadStats.transactionCount,
		totalGas: uploadStats.totalGasUsed,
		gasPerKB: gasPerKB,
		avgGas: uploadStats.averageGasPerTransaction,
		verified: verified,
		chainsUsedCount: chainsUsedList.length,
		chainsUsedList: chainsUsedList.join(' '),
	};
}


// --- Test Case 1: 単一チャンク上限テスト ---
async function runCase1(): Promise<TestResult[]> {
	const testFilePath = path.join(__dirname, 'test-file-limit.txt');
	log.step('1. 【実験】単一チャンクでのアップロード上限を探します');

	const sizesToTest = [16, 32, 64, 128, 256, 512]; // KB
	const allResults: TestResult[] = [];
	const client = new RaidchainClient();
	await client.initialize();

	for (const size of sizesToTest) {
		log.step(`--- Testing Size: ${size} KB ---`);
		const originalContent = await client.createTestFile(testFilePath, size);
		const siteUrl = `limit-test/${size}kb-${Date.now()}`;
		const usedChains = new Set<string>();

		try {
			// ファイル全体を1つのチャンクとして扱うため、ファイルサイズより大きい値を設定
			const chunkSize = (size + 1) * 1024;
			const { uploadStats } = await client.uploadFile(testFilePath, siteUrl, {
				chunkSize: chunkSize,
				distributionStrategy: 'auto', // 1チャンクなのでどれでも同じ
				onChunkUploaded: (info) => usedChains.add(info.chain),
			});

			const chainsUsedList = Array.from(usedChains).sort();
			const { data, downloadTimeMs } = await client.downloadFile(siteUrl);
			const verified = originalContent === data.toString('utf-8');
			if (!verified) throw new Error("File content mismatch");

			const throughputKBps = size / (uploadStats.durationMs / 1000);
			const gasPerKB = size > 0 ? uploadStats.totalGasUsed / BigInt(size) : 0n;

			allResults.push({
				iteration: 1,
				case: 'Case1-SingleChunkLimit',
				param: `${size}KB`,
				fileSizeKB: size,
				chunkSizeKB: size,
				uploadTimeMs: uploadStats.durationMs,
				downloadTimeMs,
				throughputKBps,
				totalTx: uploadStats.transactionCount,
				totalGas: uploadStats.totalGasUsed,
				gasPerKB,
				avgGas: uploadStats.averageGasPerTransaction,
				verified,
				chainsUsedCount: chainsUsedList.length,
				chainsUsedList: chainsUsedList.join(' '),
			});
		} catch (error: any) {
			log.error(`${size} KB upload or verification failed.`);
			console.error(error.message);
			allResults.push({
				iteration: 1, case: 'Case1-SingleChunkLimit', param: `${size}KB`,
				fileSizeKB: size, chunkSizeKB: size,
				uploadTimeMs: 0, downloadTimeMs: 0, throughputKBps: 0, totalTx: 0,
				totalGas: 0n, gasPerKB: 0n, avgGas: 0n, verified: false,
				chainsUsedCount: 0, chainsUsedList: 'failed'
			});
		}
	}
	return allResults;
}


// --- Test Case 2: Manual (単一チェーン) 分散テスト ---
async function runCase2(): Promise<TestResult> {
	const FILE_SIZE_KB = 100;
	const TARGET_CHAIN = 'data-1';
	log.step(`2. 【実験】${FILE_SIZE_KB}KBのファイルをチャンク化し、全て'${TARGET_CHAIN}'にアップロードします`);

	return runSingleTest({
		caseName: 'Case2-Manual',
		param: TARGET_CHAIN,
		filePath: path.join(__dirname, 'test-file-manual.txt'),
		fileSizeKB: FILE_SIZE_KB,
		siteUrl: `manual-dist-test/${Date.now()}`,
		distributionStrategy: 'manual',
		targetChain: TARGET_CHAIN,
	});
}

// --- Test Case 3: Round-Robin 分散テスト ---
async function runCase3(): Promise<TestResult> {
	const FILE_SIZE_KB = 100;
	log.step(`3. 【実験】${FILE_SIZE_KB}KBのファイルをチャンク化し、ラウンドロビンにアップロードします`);

	return runSingleTest({
		caseName: 'Case3-RoundRobin',
		param: 'round-robin',
		filePath: path.join(__dirname, 'test-file-round-robin.txt'),
		fileSizeKB: FILE_SIZE_KB,
		siteUrl: `round-robin-dist-test/${Date.now()}`,
		distributionStrategy: 'round-robin',
	});
}

// --- Test Case 4: Auto (負荷分散) テスト ---
async function runCase4(): Promise<TestResult> {
	const FILE_SIZE_KB = 100;
	log.step(`4. 【実験】${FILE_SIZE_KB}KBのファイルをチャンク化し、空いているチェーンへ自動でアップロードします`);

	return runSingleTest({
		caseName: 'Case4-Auto',
		param: 'auto',
		filePath: path.join(__dirname, 'test-file-auto.txt'),
		fileSizeKB: FILE_SIZE_KB,
		siteUrl: `auto-dist-test/${Date.now()}`,
		distributionStrategy: 'auto',
	});
}


// --- Test Case 5: 水平スケーラビリティ測定テスト ---
async function runCase5(chainCounts: number[]): Promise<TestResult[]> {
	const testFilePath = path.join(__dirname, 'test-file-scalability.txt');
	const FILE_SIZE_KB = 256;
	log.step(`5. 【実験】水平スケーラビリティ: ${FILE_SIZE_KB}KBのファイルをチェーン数 ${chainCounts.join(',')} でテストします`);

	const allResults: TestResult[] = [];

	for (const count of chainCounts) {
		log.step(`--- Testing with ${count} chain(s) ---`);
		try {
			const result = await runSingleTest({
				caseName: 'Case5-Scalability',
				param: `${count}-chains`,
				filePath: testFilePath,
				fileSizeKB: FILE_SIZE_KB,
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
async function runCase6(): Promise<TestResult[]> {
	const testFilePath = path.join(__dirname, 'test-file-chunk-size.txt');
	const FILE_SIZE_KB = 256;
	log.step(`6. 【実験】チャンクサイズ最適化: ${FILE_SIZE_KB}KBのファイルで性能を比較します`);

	const allResults: TestResult[] = [];

	// シナリオA: 小さいチャンク、多数のトランザクション
	log.step(`--- Scenario A: Small Chunks (16KB) ---`);
	const resultA = await runSingleTest({
		caseName: 'Case6-ChunkSize',
		param: '16KB-chunks',
		filePath: testFilePath,
		fileSizeKB: FILE_SIZE_KB,
		siteUrl: `chunk-test/small-${Date.now()}`,
		chunkSize: 16 * 1024,
		distributionStrategy: 'auto',
	});
	allResults.push(resultA);

	// シナリオB: 大きいチャンク、少数のトランザクション
	log.step(`--- Scenario B: Large Chunks (128KB) ---`);
	const resultB = await runSingleTest({
		caseName: 'Case6-ChunkSize',
		param: '128KB-chunks',
		filePath: testFilePath,
		fileSizeKB: FILE_SIZE_KB,
		siteUrl: `chunk-test/large-${Date.now()}`,
		chunkSize: 128 * 1024,
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

	log.setDebugMode(isDebug);
	const allResults: TestResult[] = [];
	log.step(`🚀 テストケース ${caseNumber} を ${iterations} 回実行します...`);

	for (let i = 1; i <= iterations; i++) {
		log.step(`--- Iteration ${i}/${iterations} ---`);
		try {
			let results: TestResult[] = [];
			switch (caseNumber) {
				case '1':
					if (iterations > 1) {
						log.error("ケース1は内部で複数シナリオを実行するため、--iter オプションをサポートしていません。");
						process.exit(1);
					}
					results = await runCase1();
					break;
				case '2':
					results.push(await runCase2());
					break;
				case '3':
					results.push(await runCase3());
					break;
				case '4':
					results.push(await runCase4());
					break;
				case '5':
					if (iterations > 1) {
						log.error("ケース5は反復実行（--iter）ではなく、--chain-countsで複数シナリオを実行します。");
						process.exit(1);
					}
					results = await runCase5(chainCounts);
					break;
				case '6':
					if (iterations > 1) {
						log.error("ケース6は内部で複数シナリオを実行するため、--iter オプションをサポートしていません。");
						process.exit(1);
					}
					results = await runCase6();
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