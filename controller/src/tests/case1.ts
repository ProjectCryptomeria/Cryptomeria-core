// src/tests/case1.ts
import * as path from 'path';
import { PerformanceReport } from '../lib/performance-tracker';
import { RaidchainClient, log } from '../lib/raidchain-util';

const testFilePath = path.join(__dirname, 'test-file-limit.txt');

function printSummary(results: Array<{ size: number; uploadStats: PerformanceReport; downloadTimeMs: number }>) {
	console.log('\n\n--- 🧪 Test Summary ---');
	console.table(results.map(r => ({
		'File Size (KB)': r.size,
		'Upload Time (ms)': r.uploadStats.durationMs.toFixed(2),
		'Total Gas Used': r.uploadStats.totalGasUsed,
		'Avg. Gas / Tx': r.uploadStats.averageGasPerTransaction,
		'Download Time (ms)': r.downloadTimeMs.toFixed(2),
	})));
}

async function main() {
	const client = new RaidchainClient();
	await client.initialize();

	log.step('1. 【実験】単一チャンクでのアップロード上限を探します');
	const sizesToTest = [16, 32, 64, 128, 256, 512]; // KB
	const results: Array<{ size: number; uploadStats: PerformanceReport; downloadTimeMs: number }> = [];

	for (const size of sizesToTest) {
		log.step(`--- Testing Size: ${size} KB ---`);
		const originalContent = await client.createTestFile(testFilePath, size);
		const siteUrl = `limit-test/${size}kb-${Date.now()}`;

		try {
			// uploadFileが完了した時点で、データはAPIで確認可能になっている
			// chunkSizeをファイルサイズより大きくすることで、1チャンクでアップロードさせる
			const { uploadStats } = await client.uploadFile(testFilePath, siteUrl, { chunkSize: (size + 1) * 1024 });

			// 検証
			log.info('Verifying uploaded data...');
			const { data, downloadTimeMs } = await client.downloadFile(siteUrl);

			// ファイル内容が一致するかを検証
			if (originalContent !== data.toString('utf-8')) {
				throw new Error("Downloaded file content does not match the original.");
			}

			log.success(`${size} KB upload and verification successful.`);
			results.push({ size, uploadStats, downloadTimeMs });

		} catch (error: any) {
			log.error(`${size} KB upload or verification failed.`);
			console.error(error.message);
			printSummary(results); // Print summary even if it fails
			process.exit(1);
		}
	}

	log.step('✅ All tests completed successfully!');
	printSummary(results);
}

main().catch(err => {
	log.error("An unexpected error occurred during the test run.");
	console.error(err);
	process.exit(1);
});