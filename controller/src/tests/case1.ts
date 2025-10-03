import * as path from 'path';
import { RaidchainClient, log } from '../lib/raidchain-util';

const client = new RaidchainClient();
const testFilePath = path.join(__dirname, 'test-file-limit.txt');

async function main() {
	log.step('1. 【実験】単一チャンクでのアップロード上限を探します');
	const sizesToTest = [16, 32, 64, 128, 256, 512]; // KB
	let lastSuccessfulSize = 0;

	for (const size of sizesToTest) {
		log.step(`--- サイズ: ${size} KB ---`);
		await client.createTestFile(testFilePath, size);
		const siteUrl = `limit-test/${size}kb`;

		try {
			// チャンクサイズをファイルサイズより大きく設定し、強制的に単一チャンクにする
			await client.uploadFile(testFilePath, siteUrl, { chunkSize: (size + 1) * 1024 });

			// 検証
			const downloaded = await client.downloadFile(siteUrl);
			if (downloaded.length !== size * 1024) {
				throw new Error("ダウンロードしたファイルのサイズが一致しません。");
			}

			log.success(`${size} KBのアップロードと検証に成功しました。`);
			lastSuccessfulSize = size;
		} catch (error) {
			log.error(`${size} KBのアップロードに失敗しました。`);
			console.error(error);
			break; // 失敗した時点でループを抜ける
		}
	}

	log.step('【実験結果】');
	if (lastSuccessfulSize > 0) {
		log.success(`単一チャンクで成功した最大のサイズ: ${lastSuccessfulSize} KB`);
	} else {
		log.error('全てのサイズのアップロードに失敗しました。');
	}
}

main();
