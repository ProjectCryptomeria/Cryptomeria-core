import * as fs from 'fs/promises';
import * as path from 'path';
import { queryStoredChunk, queryStoredManifest } from '../blockchain-query';
import { getChainInfo } from '../k8s-client';
import { ChunkInfo, log, RaidchainClient } from '../lib/raidchain-util';

async function main() {
	log.step('🚀 Starting End-to-End Upload and Verification Test...');
	const client = new RaidchainClient();
	await client.initialize(); // ADDED: Initialize the client

	// --- 1. Test Data Preparation ---
	log.step('1. Preparing Test Data');
	const testFilePath = path.join(__dirname, 'test-file.txt');
	const originalContent = `This is a test file for the Raidchain project. It will be split into multiple chunks and uploaded to different datachains. Unique ID: ${Date.now()}`;
	await fs.writeFile(testFilePath, originalContent);
	log.info(`Test file created at: ${testFilePath}`);
	const chunks = await require('../chunker').splitFileIntoChunks(testFilePath);
	log.success(`File split into ${chunks.length} chunk(s).`);

	// --- 2. Upload Data to Chains ---
	log.step('2. Uploading Data to Chains');
	const siteUrl = `my-e2e-test.com/${Date.now()}`;
	const { manifest, urlIndex } = await client.uploadFile(testFilePath, siteUrl, {
		distributionStrategy: 'auto',
	});

	log.info('\n⏳ Waiting 10 seconds for transactions to be processed and indexed...');
	await new Promise(resolve => setTimeout(resolve, 10000));

	// --- 3. Verify Data on Chains ---
	log.step('3. Verifying Data on Chains');
	let allTestsPassed = true;

	// Verify each data chunk
	for (let i = 0; i < manifest.chunks.length; i++) {
		const chunkInfo = manifest.chunks[i] as ChunkInfo;
		log.info(`  -> Verifying chunk ${chunkInfo.index} on ${chunkInfo.chain}...`);
		try {
			const queryResult = await queryStoredChunk(chunkInfo.chain, chunkInfo.index);

			if (!queryResult.stored_chunk || !queryResult.stored_chunk.data) {
				log.error(`  🔥 Invalid response structure for chunk ${chunkInfo.index}: ${JSON.stringify(queryResult)}`);
				allTestsPassed = false;
				continue;
			}
			const storedDataB64 = queryResult.stored_chunk.data;
			const storedData = Buffer.from(storedDataB64, 'base64');

			if (Buffer.compare(chunks[i], storedData) !== 0) {
				log.error(`  🔥 Data mismatch for chunk ${chunkInfo.index}!`);
				allTestsPassed = false;
			} else {
				log.success(`  ✅ Chunk ${chunkInfo.index} data is correct.`);
			}
		} catch (err: any) {
			log.error(`  🔥 Failed to query or verify chunk ${chunkInfo.index}: ${err.message}`);
			allTestsPassed = false;
		}
	}

	// Verify manifest
	const chainInfos = await getChainInfo();
	const metaChainInfo = chainInfos.find(c => c.type === 'metachain');
	if (!metaChainInfo) {
		log.error("🔥 Cannot find metachain to verify manifest.");
		allTestsPassed = false;
	} else {
		log.info(`\n  -> Verifying manifest for ${siteUrl} on ${metaChainInfo.name}...`);
		try {
			const queryResult = await queryStoredManifest(metaChainInfo.name, urlIndex);

			if (!queryResult.manifest || !queryResult.manifest.manifest) {
				log.error(`  🔥 Invalid response structure for manifest ${siteUrl}: ${JSON.stringify(queryResult)}`);
				allTestsPassed = false;
			} else {
				const storedManifestString = queryResult.manifest.manifest;
				const storedManifest = JSON.parse(storedManifestString);

				// Re-create the expected manifest for a deep comparison
				const expectedManifest = {
					filepath: path.basename(testFilePath),
					chunks: manifest.chunks
				};

				if (JSON.stringify(storedManifest) !== JSON.stringify(expectedManifest)) {
					log.error(`  🔥 Manifest mismatch for URL ${siteUrl}!`);
					log.error(`     Expected: ${JSON.stringify(expectedManifest)}`);
					log.error(`     Received: ${storedManifestString}`);
					allTestsPassed = false;
				} else {
					log.success(`  ✅ Manifest for ${siteUrl} is correct.`);
				}
			}
		} catch (err: any) {
			log.error(`  🔥 Failed to query or verify manifest for ${siteUrl}: ${err.message}`);
			allTestsPassed = false;
		}
	}


	// --- 4. Test Conclusion ---
	log.step('4. Test Conclusion');
	if (allTestsPassed) {
		log.success('🎉🎉🎉 All tests passed! Data was successfully uploaded and verified. 🎉🎉🎉');
	} else {
		log.error('🔥🔥🔥 One or more tests failed. Please review the logs.');
		process.exit(1);
	}
}

main().catch(err => {
	log.error('An unexpected error occurred during the test run:');
	console.error(err);
	process.exit(1);
});