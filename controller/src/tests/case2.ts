import * as path from 'path';
import { RaidchainClient, log } from '../lib/raidchain-util';

const client = new RaidchainClient();
const testFilePath = path.join(__dirname, 'test-file-manual.txt');
const FILE_SIZE_KB = 100; // チャンク分割が必要なサイズ
const TARGET_CHAIN = 'data-1'; // 固定のアップロード先

async function main() {
	await client.initialize(); // ADDED: Initialize the client

	log.step(`2. 【実験】${FILE_SIZE_KB}KBのファイルをチャンク化し、全て'${TARGET_CHAIN}'にアップロードします`);

	const originalContent = await client.createTestFile(testFilePath, FILE_SIZE_KB);
	const siteUrl = `manual-dist-test/${Date.now()}`;

	// アップロード
	await client.uploadFile(testFilePath, siteUrl, {
		distributionStrategy: 'manual',
		targetChain: TARGET_CHAIN
	});

	// 検証
	log.info(`\n検証のため、アップロードしたファイルを取得します...`);
	// 10-second wait might not be necessary if uploadFile now waits for confirmation
	// await new Promise(r => setTimeout(r, 10000)); 
	const downloaded = await client.downloadFile(siteUrl);
	const downloadedContent = downloaded.toString('utf-8');

	if (originalContent === downloadedContent) {
		log.success('🎉 検証成功！内容は完全に一致しました。');
	} else {
		log.error('🔥 検証失敗！内容が一致しません。');
	}
}

main();