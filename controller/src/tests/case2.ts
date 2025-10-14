// src/tests/case2.ts
import * as path from 'path';
import { RaidchainClient, log } from '../lib/raidchain-util';

const client = new RaidchainClient();
const testFilePath = path.join(__dirname, 'test-file-manual.txt');
const FILE_SIZE_KB = 100; // チャンク分割が必要なサイズ
const TARGET_CHAIN = 'data-1'; // 固定のアップロード先

async function main() {
	await client.initialize();

	log.step(`2. 【実験】${FILE_SIZE_KB}KBのファイルをチャンク化し、全て'${TARGET_CHAIN}'にアップロードします`);

	const originalContent = await client.createTestFile(testFilePath, FILE_SIZE_KB);
	const siteUrl = `manual-dist-test/${Date.now()}`;

	// アップロード
	const { uploadStats } = await client.uploadFile(testFilePath, siteUrl, {
		distributionStrategy: 'manual',
		targetChain: TARGET_CHAIN
	});

	// 検証
	log.info(`\nVerifying uploaded file...`);
	const { data: downloaded, downloadTimeMs } = await client.downloadFile(siteUrl);
	const downloadedContent = downloaded.toString('utf-8');

	log.step('📊 Test Results');
	console.log(`- Upload Time: ${uploadStats.durationMs.toFixed(2)} ms`);
	console.log(`- Total Transactions: ${uploadStats.transactionCount}`);
	console.log(`- Total Gas Used: ${uploadStats.totalGasUsed}`);
	console.log(`- Average Gas per Tx: ${uploadStats.averageGasPerTransaction}`);
	console.log(`- Download Time: ${downloadTimeMs.toFixed(2)} ms`);

	if (originalContent === downloadedContent) {
		log.success('\n🎉 Verification successful! Content matches perfectly.');
	} else {
		log.error('\n🔥 Verification failed! Content does not match.');
		process.exit(1);
	}
}

main().catch(err => {
	log.error("Test execution failed.");
	console.error(err);
	process.exit(1);
});