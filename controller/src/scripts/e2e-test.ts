import * as fs from 'fs/promises';
import * as path from 'path';
import { uploadChunkToDataChain, uploadManifestToMetaChain } from '../blockchain';
import { queryManifest, queryStoredChunk } from '../blockchain-query';
import { splitFileIntoChunks } from '../chunker';

// --- 色付きログ出力用のヘルパー ---
const log = {
	info: (msg: string) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
	success: (msg: string) => console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`),
	error: (msg: string) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
	step: (msg: string) => console.log(`\n\x1b[1;33m--- ${msg} ---\x1b[0m`),
};

// --- メインのテスト関数 ---
async function main() {
	log.step('🚀 Starting End-to-End Upload and Verification Test...');

	// --- 1. テストデータの準備 ---
	log.step('1. Preparing Test Data');
	const testFilePath = path.join(__dirname, 'test-file.txt');
	const originalContent = `This is a test file for the Raidchain project. It will be split into multiple chunks and uploaded to different datachains. Unique ID: ${Date.now()}`;
	await fs.writeFile(testFilePath, originalContent);
	log.info(`Test file created at: ${testFilePath}`);
	const chunks = await splitFileIntoChunks(testFilePath);
	log.success(`File split into ${chunks.length} chunk(s).`);

	// --- 2. チェーンへのアップロード ---
	log.step('2. Uploading Data to Chains');
	const uniqueSuffix = `e2e-test-${Date.now()}`;
	const chunkUploadPromises = chunks.map(async (chunk: Buffer, i: number) => {
		const chunkIndex = `${uniqueSuffix}-${i}`;
		const targetChain = (i % 2 === 0 ? 'data-0' : 'data-1') as 'data-0' | 'data-1';
		log.info(`  -> Uploading chunk ${chunkIndex} to ${targetChain}...`);
		const result = await uploadChunkToDataChain(targetChain, chunkIndex, chunk);
		log.info(`  ✅ Chunk ${chunkIndex} uploaded. TxHash: ${result.transactionHash}`);
		return { chunkIndex, targetChain, originalData: chunk };
	});

	const uploadedChunks = await Promise.all(chunkUploadPromises);

	const siteUrl = `my-e2e-test.com/${uniqueSuffix}`;
	const manifest = {
		filepath: 'test-file.txt',
		chunks: uploadedChunks.map(c => c.chunkIndex),
	};
	const manifestString = JSON.stringify(manifest);

	log.info(`\n📦 Uploading manifest for ${siteUrl} to meta-0...`);
	const manifestResult = await uploadManifestToMetaChain(siteUrl, manifestString);
	log.success(`Manifest uploaded successfully! TxHash: ${manifestResult.transactionHash}`);

	log.info('\n⏳ Waiting 10 seconds for transactions to be processed and indexed...');
	await new Promise(resolve => setTimeout(resolve, 10000));

	// --- 3. チェーンからのデータ検証 ---
	log.step('3. Verifying Data on Chains');
	let allTestsPassed = true;

	// 各データチャンクを検証
	for (const uploaded of uploadedChunks) {
		log.info(`  -> Verifying chunk ${uploaded.chunkIndex} on ${uploaded.targetChain}...`);
		try {
			const queryResult = await queryStoredChunk(uploaded.targetChain, uploaded.chunkIndex);
			console.log(queryResult.stored_chunk.data);
			
			const storedDataB64 = queryResult.stored_chunk.data;
			const storedData = Buffer.from(storedDataB64, 'base64');

			if (Buffer.compare(uploaded.originalData, storedData) !== 0) {
				log.error(`  🔥 Data mismatch for chunk ${uploaded.chunkIndex}!`);
				allTestsPassed = false;
			} else {
				log.success(`  ✅ Chunk ${uploaded.chunkIndex} data is correct.`);
			}
		} catch (err) {
			log.error(`  🔥 Failed to query or verify chunk ${uploaded.chunkIndex}: ${err}`);
			allTestsPassed = false;
		}
	}

	// マニフェストを検証
	log.info(`\n  -> Verifying manifest for ${siteUrl} on meta-0...`);
	try {
		const queryResult = await queryManifest(siteUrl);
		console.log(queryResult);
		
		const storedManifestString = queryResult.manifest.manifest;
		if (storedManifestString !== manifestString) {
			log.error(`  🔥 Manifest mismatch for URL ${siteUrl}!`);
			log.error(`     Expected: ${manifestString}`);
			log.error(`     Received: ${storedManifestString}`);
			allTestsPassed = false;
		} else {
			log.success(`  ✅ Manifest for ${siteUrl} is correct.`);
		}
	} catch (err) {
		log.error(`  🔥 Failed to query or verify manifest for ${siteUrl}: ${err}`);
		allTestsPassed = false;
	}


	// --- 4. テスト結果の判定 ---
	log.step('4. Test Conclusion');
	if (allTestsPassed) {
		log.success('🎉🎉🎉 All tests passed! Data was successfully uploaded and verified. 🎉🎉🎉');
	} else {
		log.error('🔥🔥🔥 One or more tests failed. Please review the logs. 🔥🔥🔥');
		process.exit(1); // エラーがあった場合は終了コード1で終了
	}
}

main().catch(err => {
	log.error('An unexpected error occurred during the test run:');
	console.error(err);
	process.exit(1);
});