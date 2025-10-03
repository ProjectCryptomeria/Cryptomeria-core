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
		const originalContent = await client.createTestFile(testFilePath, size);
		const siteUrl = `limit-test/${size}kb`;

		try {
			// uploadFileが完了した時点で、データはAPIで確認可能になっている
			await client.uploadFile(testFilePath, siteUrl, { chunkSize: (size + 1) * 1024 });

			// (★★★ 修正箇所: 待機処理を削除 ★★★)

			// 検証
			log.info('アップロードしたデータを検証します...');
			const downloaded = await client.downloadFile(siteUrl);

			// ファイル内容が一致するかを検証
			if (originalContent !== downloaded.toString('utf-8')) {
				throw new Error("ダウンロードしたファイルの内容が一致しません。");
			}

			log.success(`${size} KBのアップロードと検証に成功しました。`);
			lastSuccessfulSize = size;
		} catch (error) {
			log.error(`${size} KBのアップロードまたは検証に失敗しました。`);
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

main().catch(err => {
	log.error("テストの実行中に予期せぬエラーが発生しました。");
	console.error(err);
	process.exit(1);
});