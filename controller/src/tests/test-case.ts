// src/tests/test-case.ts
import * as path from 'path';
import { CHUNK_SIZE } from '../config';
import { log } from '../lib/logger';
import { RaidchainClient } from '../lib/raidchain-util';

// --- データ構造の定義 ---

// 各テストの実行結果を格納するインターフェース
interface TestResult {
	iteration: number;
	case: string;
	param: string; // size(KB) or strategy
	fileSizeKB: number;
	chunkSizeKB: number;
	uploadTimeMs: number;
	downloadTimeMs: number;
	totalTx: number;
	totalGas: bigint;
	avgGas: bigint;
	verified: boolean;
	chainsUsedCount: number;
	chainsUsedList: string;
}

const client = new RaidchainClient();

// --- 結果出力ヘルパー ---

function printResults(results: TestResult[]) {
	if (results.length === 0) return;

	const maxListLength = 50; // テーブル表示時のチェーンリストの最大文字数

	// 1. 見やすいテーブル形式
	console.log('\n--- 📊 個別実行結果 ---');
	console.table(results.map(r => ({
		'Iteration': r.iteration,
		'Case': r.case,
		'Parameter': r.param,
		'File Size (KB)': r.fileSizeKB,
		'Chunk Size (KB)': r.chunkSizeKB,
		'Upload (ms)': r.uploadTimeMs.toFixed(2),
		'Download (ms)': r.downloadTimeMs.toFixed(2),
		'Chains (Count)': r.chainsUsedCount,
		// 'Used Chains (List)': r.chainsUsedList.length > maxListLength
		// 	? `${r.chainsUsedList.substring(0, maxListLength)}...`
		// 	: r.chainsUsedList,
		// 'Total Txs': r.totalTx,
		'Total Gas': r.totalGas.toString(),
		'Avg Gas/Tx': r.avgGas.toString(),
		'Verified': r.verified ? '✅' : '🔥',
	})));

	// 2. CSV形式
	console.log('\n--- 📋 CSV形式 (コピー用) ---');
	const header = 'Iteration,Case,Parameter,FileSize(KB),ChunkSize(KB),Upload(ms),Download(ms),ChainsCount,ChainsList,TotalTxs,TotalGas,AvgGasPerTx,Verified';
	const csvRows = results.map(r =>
		[
			r.iteration,
			r.case,
			r.param,
			r.fileSizeKB,
			r.chunkSizeKB,
			r.uploadTimeMs.toFixed(2),
			r.downloadTimeMs.toFixed(2),
			r.chainsUsedCount,
			`"${r.chainsUsedList}"`,
			// r.totalTx,
			r.totalGas.toString(),
			r.avgGas.toString(),
			r.verified,
		].join(',')
	);
	console.log([header, ...csvRows].join('\n'));

	// 3. TSV形式 (Excel用)
	// console.log('\n--- 📋 TSV形式 (Excelコピー用) ---');
	const tsvHeader = 'Iteration\tCase\tParameter\tFileSize(KB)\tChunkSize(KB)\tUpload(ms)\tDownload(ms)\tChainsCount\tChainsList\tTotalTxs\tTotalGas\tAvgGasPerTx\tVerified';
	const tsvRows = results.map(r =>
		[
			r.iteration,
			r.case,
			r.param,
			r.fileSizeKB,
			r.chunkSizeKB,
			r.uploadTimeMs.toFixed(2),
			r.downloadTimeMs.toFixed(2),
			r.chainsUsedCount,
			r.chainsUsedList, // TSVではダブルクオート不要
			// r.totalTx,
			r.totalGas.toString(),
			r.avgGas.toString(),
			r.verified,
		].join('\t')
	);
	// console.log([tsvHeader, ...tsvRows].join('\n'));

	// 4. 平均値の計算と出力
	if (results.length > 1) {
		const avg = results.reduce((acc, r, _, arr) => ({
			uploadTimeMs: acc.uploadTimeMs + r.uploadTimeMs / arr.length,
			downloadTimeMs: acc.downloadTimeMs + r.downloadTimeMs / arr.length,
			chainsUsedCount: acc.chainsUsedCount + r.chainsUsedCount / arr.length,
			totalTx: acc.totalTx + r.totalTx / arr.length,
			totalGas: acc.totalGas + r.totalGas / BigInt(arr.length),
			avgGas: acc.avgGas + r.avgGas / BigInt(arr.length),
		}), { uploadTimeMs: 0, downloadTimeMs: 0, chainsUsedCount: 0, totalTx: 0, totalGas: 0n, avgGas: 0n });

		const avgResult = {
			'Case': results[0]!.case,
			'Parameter': results[0]!.param,
			'Avg Upload (ms)': avg.uploadTimeMs.toFixed(2),
			'Avg Download (ms)': avg.downloadTimeMs.toFixed(2),
			'Avg Used Chains (Count)': avg.chainsUsedCount.toFixed(2),
			'Avg Total Txs': avg.totalTx.toFixed(2),
			'Avg Total Gas': avg.totalGas.toString(),
			'Avg Gas/Tx': avg.avgGas.toString(),
		};

		console.log('\n--- 📈 平均実行結果 ---');
		console.table([avgResult]);

		console.log('\n--- 📋 平均CSV形式 (コピー用) ---');
		const avgCsvHeader = 'Case,Parameter,AvgUpload(ms),AvgDownload(ms),AvgUsedChainsCount,AvgTotalTxs,AvgTotalGas,AvgAvgGasPerTx';
		const avgCsvRow = Object.values(avgResult).join(',');
		console.log([avgCsvHeader, avgCsvRow].join('\n'));

		console.log('\n--- 📋 平均TSV形式 (Excelコピー用) ---');
		const avgTsvHeader = 'Case\tParameter\tAvgUpload(ms)\tAvgDownload(ms)\tAvgUsedChainsCount\tAvgTotalTxs\tAvgTotalGas\tAvgAvgGasPerTx';
		const avgTsvRow = Object.values(avgResult).join('\t');
		console.log([avgTsvHeader, avgTsvRow].join('\n'));
	}
}

// --- Test Case 1: 単一チャンク上限テスト ---
async function runCase1(): Promise<TestResult[]> {
	const testFilePath = path.join(__dirname, 'test-file-limit.txt');
	log.step('1. 【実験】単一チャンクでのアップロード上限を探します');

	const sizesToTest = [16, 32, 64, 128, 256, 512]; // KB
	const allResults: TestResult[] = [];

	for (const size of sizesToTest) {
		log.step(`--- Testing Size: ${size} KB ---`);
		const originalContent = await client.createTestFile(testFilePath, size);
		const siteUrl = `limit-test/${size}kb-${Date.now()}`;
		const usedChains = new Set<string>();

		try {
			const chunkSize = (size + 1) * 1024;
			const { uploadStats } = await client.uploadFile(testFilePath, siteUrl, {
				chunkSize: chunkSize,
				onChunkUploaded: (info) => usedChains.add(info.chain),
			});
			const chainsUsedList = Array.from(usedChains).sort();
			const { data, downloadTimeMs } = await client.downloadFile(siteUrl);
			const verified = originalContent === data.toString('utf-8');
			if (!verified) throw new Error("File content mismatch");

			allResults.push({
				iteration: 1,
				case: 'Case1-SingleChunkLimit',
				param: `${size}KB`,
				fileSizeKB: size,
				chunkSizeKB: size, // 1チャンクなのでファイルサイズと同じ
				uploadTimeMs: uploadStats.durationMs,
				downloadTimeMs: downloadTimeMs,
				totalTx: uploadStats.transactionCount,
				totalGas: uploadStats.totalGasUsed,
				avgGas: uploadStats.averageGasPerTransaction,
				verified: verified,
				chainsUsedCount: chainsUsedList.length,
				chainsUsedList: chainsUsedList.join(' '),
			});
		} catch (error: any) {
			log.error(`${size} KB upload or verification failed.`);
			console.error(error);
			allResults.push({
				iteration: 1, case: 'Case1-SingleChunkLimit', param: `${size}KB`,
				fileSizeKB: size, chunkSizeKB: size,
				uploadTimeMs: 0, downloadTimeMs: 0, totalTx: 0,
				totalGas: 0n, avgGas: 0n, verified: false,
				chainsUsedCount: 0, chainsUsedList: 'failed'
			});
		}
	}
	return allResults;
}

// --- Test Case 2: Manual (単一チェーン) 分散テスト ---
async function runCase2(): Promise<TestResult> {
	const testFilePath = path.join(__dirname, 'test-file-manual.txt');
	const FILE_SIZE_KB = 100;
	const TARGET_CHAIN = 'data-1';
	log.step(`2. 【実験】${FILE_SIZE_KB}KBのファイルをチャンク化し、全て'${TARGET_CHAIN}'にアップロードします`);

	const originalContent = await client.createTestFile(testFilePath, FILE_SIZE_KB);
	const siteUrl = `manual-dist-test/${Date.now()}`;
	const usedChains = new Set<string>();

	const { uploadStats } = await client.uploadFile(testFilePath, siteUrl, {
		distributionStrategy: 'manual',
		targetChain: TARGET_CHAIN,
		onChunkUploaded: (info) => usedChains.add(info.chain),
	});
	const chainsUsedList = Array.from(usedChains).sort();
	const { data: downloaded, downloadTimeMs } = await client.downloadFile(siteUrl);
	const verified = originalContent === downloaded.toString('utf-8');

	return {
		iteration: 0, // 後で設定される
		case: 'Case2-Manual',
		param: TARGET_CHAIN,
		fileSizeKB: FILE_SIZE_KB,
		chunkSizeKB: CHUNK_SIZE / 1024,
		uploadTimeMs: uploadStats.durationMs,
		downloadTimeMs: downloadTimeMs,
		totalTx: uploadStats.transactionCount,
		totalGas: uploadStats.totalGasUsed,
		avgGas: uploadStats.averageGasPerTransaction,
		verified: verified,
		chainsUsedCount: chainsUsedList.length,
		chainsUsedList: chainsUsedList.join(' '),
	};
}

// --- Test Case 3: Round-Robin 分散テスト ---
async function runCase3(): Promise<TestResult> {
	const testFilePath = path.join(__dirname, 'test-file-round-robin.txt');
	const FILE_SIZE_KB = 100;
	log.step(`3. 【実験】${FILE_SIZE_KB}KBのファイルをチャンク化し、ラウンドロビンにアップロードします`);

	const originalContent = await client.createTestFile(testFilePath, FILE_SIZE_KB);
	const siteUrl = `round-robin-dist-test/${Date.now()}`;
	const usedChains = new Set<string>();

	const { uploadStats } = await client.uploadFile(testFilePath, siteUrl, {
		distributionStrategy: 'round-robin',
		onChunkUploaded: (info) => usedChains.add(info.chain),
	});
	const chainsUsedList = Array.from(usedChains).sort();
	const { data: downloaded, downloadTimeMs } = await client.downloadFile(siteUrl);
	const verified = originalContent === downloaded.toString('utf-8');

	return {
		iteration: 0, // 後で設定される
		case: 'Case3-RoundRobin',
		param: 'round-robin',
		fileSizeKB: FILE_SIZE_KB,
		chunkSizeKB: CHUNK_SIZE / 1024,
		uploadTimeMs: uploadStats.durationMs,
		downloadTimeMs: downloadTimeMs,
		totalTx: uploadStats.transactionCount,
		totalGas: uploadStats.totalGasUsed,
		avgGas: uploadStats.averageGasPerTransaction,
		verified: verified,
		chainsUsedCount: chainsUsedList.length,
		chainsUsedList: chainsUsedList.join(' '),
	};
}


// --- Test Case 4: Auto (負荷分散) テスト ---
async function runCase4(): Promise<TestResult> {
	const testFilePath = path.join(__dirname, 'test-file-auto.txt');
	const FILE_SIZE_KB = 100;
	log.step(`4. 【実験】${FILE_SIZE_KB}KBのファイルをチャンク化し、空いているチェーンへ自動でアップロードします`);

	const originalContent = await client.createTestFile(testFilePath, FILE_SIZE_KB);
	const siteUrl = `auto-dist-test/${Date.now()}`;
	const usedChains = new Set<string>();

	const { uploadStats } = await client.uploadFile(testFilePath, siteUrl, {
		distributionStrategy: 'auto',
		onChunkUploaded: (info) => usedChains.add(info.chain),
	});
	const chainsUsedList = Array.from(usedChains).sort();
	const { data: downloaded, downloadTimeMs } = await client.downloadFile(siteUrl);
	const verified = originalContent === downloaded.toString('utf-8');

	return {
		iteration: 0, // 後で設定される
		case: 'Case4-Auto',
		param: 'auto',
		fileSizeKB: FILE_SIZE_KB,
		chunkSizeKB: CHUNK_SIZE / 1024,
		uploadTimeMs: uploadStats.durationMs,
		downloadTimeMs: downloadTimeMs,
		totalTx: uploadStats.transactionCount,
		totalGas: uploadStats.totalGasUsed,
		avgGas: uploadStats.averageGasPerTransaction,
		verified: verified,
		chainsUsedCount: chainsUsedList.length,
		chainsUsedList: chainsUsedList.join(' '),
	};
}


// --- Main Execution Logic ---
async function main() {
	// --- Argument Parsing ---
	const args = process.argv.slice(2);
	const caseIndex = args.indexOf('--case');
	const iterIndex = args.indexOf('--iter');
	const debugIndex = args.indexOf('--debug');

	if (caseIndex === -1 || !args[caseIndex + 1]) {
		console.error('エラー: --case <number> でテスト番号を指定してください。');
		process.exit(1);
	}
	const caseNumber = args[caseIndex + 1]!;
	const iterations = (iterIndex !== -1 && args[iterIndex + 1]) ? parseInt(args[iterIndex + 1]!, 10) : 1;
	const isDebug = debugIndex !== -1;

	log.setDebugMode(isDebug);

	await client.initialize();

	const allResults: TestResult[] = [];

	log.step(`🚀 テストケース ${caseNumber} を ${iterations} 回実行します...`);

	for (let i = 1; i <= iterations; i++) {
		log.step(`--- Iteration ${i}/${iterations} ---`);
		try {
			let results: TestResult[] = [];
			switch (caseNumber) {
				case '1':
					// Case 1は内部でループするため、反復実行の対象外
					if (iterations > 1) {
						log.error("ケース1は --iter オプションをサポートしていません。");
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
				default:
					log.error(`無効なテストケース番号です: ${caseNumber}`);
					process.exit(1);
			}

			// イテレーション番号を付与し、結果を格納
			results.forEach(r => {
				r.iteration = i;
				allResults.push(r);
				if (!r.verified) {
					throw new Error(`Iteration ${i} failed verification.`);
				}
			});

			log.success(`--- Iteration ${i} 完了 ---`);

		} catch (err) {
			log.error(`❌ Iteration ${i} の実行中にエラーが発生しました。`);
			console.error(err);
			// 失敗したイテレーションがあってもテストを続ける場合は、下の行をコメントアウト
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