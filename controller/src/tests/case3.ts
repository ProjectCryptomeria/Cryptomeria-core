import * as path from 'path';
import { RaidchainClient, log } from '../lib/raidchain-util';

const client = new RaidchainClient();
const testFilePath = path.join(__dirname, 'test-file-auto.txt');
const FILE_SIZE_KB = 100; // チャンク分割が必要なサイズ

async function main() {
	log.step(`3. 【実験】${FILE_SIZE_KB}KBのファイルをチャンク化し、空いているチェーンへ自動でアップロードします`);

	const originalContent = await client.createTestFile(testFilePath, FILE_SIZE_KB);
	const siteUrl = `auto-dist-test/${Date.now()}`;

	// アップロード
	await client.uploadFile(testFilePath, siteUrl, {
		distributionStrategy: 'auto',
	});

	// 検証
	log.info(`\n検証のため、アップロードしたファイルを取得します...`);
	await new Promise(r => setTimeout(r, 10000)); // 処理待ち
	const downloaded = await client.downloadFile(siteUrl);
	const downloadedContent = downloaded.toString('utf-8');

	if (originalContent === downloadedContent) {
		log.success('🎉 検証成功！内容は完全に一致しました。');
	} else {
		log.error('🔥 検証失敗！内容が一致しません。');
	}
}

main();