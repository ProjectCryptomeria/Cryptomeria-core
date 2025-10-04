import * as fs from 'fs/promises';
import * as path from 'path';
import { RaidchainClient, log } from '../lib/raidchain-util';

async function main() {
	log.step('🚀 Starting file upload test...');

	const client = new RaidchainClient();
	await client.initialize(); // ADDED: Initialize the client

	// 1. テスト用のファイルを作成
	const testFilePath = path.join(__dirname, 'test-file.txt');
	await fs.writeFile(
		testFilePath,
		'This is a test file for the Raidchain project. It will be split into multiple chunks and uploaded to different datachains.'
	);
	log.info(`Test file created at: ${testFilePath}`);

	// 2. ファイルをアップロード
	const siteUrl = `my-test-site.com/${Date.now()}`;

	try {
		await client.uploadFile(testFilePath, siteUrl);
		log.success(`File uploaded successfully. Access it via: ${siteUrl}`);
	} catch (error) {
		log.error('Upload process failed.');
		console.error(error);
		process.exit(1);
	}

	log.info('\n🎉 Test complete!');
}

main().catch(console.error);