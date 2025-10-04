import * as fs from 'fs/promises';
import * as path from 'path';
import { RaidchainClient, log } from '../lib/raidchain-util';

async function main() {
	const client = new RaidchainClient();

	// =========================================================================
	// 1. アップロードフェーズ: まず、テスト対象となるデータをアップロードする
	// =========================================================================
	log.step('1. 【アップロード】テストデータの準備とアップロード');
	const originalContent = `これはRaidchainのデータ取得テストです。この文章が読めていれば、複数チェーンからのデータ復元に成功しています。ユニークID: ${Date.now()}`;
	const testFilePath = path.join(__dirname, 'retrieval-test-file.txt');
	await fs.writeFile(testFilePath, originalContent);

	const siteUrl = `my-retrieval-site.com/${Date.now()}`;
	log.info(`Uploading test file to ${siteUrl}`);

	await client.uploadFile(testFilePath, siteUrl, {
		distributionStrategy: 'round-robin',
	});

	log.success('テストデータのアップロードが完了しました。');

	log.info('\n⏳ Waiting 10 seconds for the network to process the transactions...');
	await new Promise(resolve => setTimeout(resolve, 10000));

	// =========================================================================
	// 2. 取得フェーズ: アップロードしたデータを実際に取得・復元する
	// =========================================================================
	log.step('2. 【データ取得】チェーンからデータを取得し、復元します');
	let retrievedFileContent: string | null = null;
	try {
		const downloadedBuffer = await client.downloadFile(siteUrl);
		retrievedFileContent = downloadedBuffer.toString('utf-8');
		log.success('全てのチャンクを取得し、ファイルの復元が完了しました！');
	} catch (err) {
		log.error('データ取得処理中にエラーが発生しました:');
		console.error(err);
		process.exit(1);
	}

	// =========================================================================
	// 3. 検証＆表示フェーズ: 結果の検証と表示
	// =========================================================================
	log.step('3. 【検証＆表示】最終結果');

	console.log('\n--- [ 元のファイル内容 ] ---');
	console.log(originalContent);
	console.log('\n--- [ 復元されたファイル内容 ] ---');
	console.log(retrievedFileContent);
	console.log('---------------------------------');

	if (originalContent === retrievedFileContent) {
		log.success('\n🎉🎉🎉 検証成功！復元された内容は元の内容と完全に一致します。🎉🎉🎉');
	} else {
		log.error('\n🔥🔥🔥 検証失敗！内容が一致しませんでした。🔥🔥🔥');
		process.exit(1);
	}
}

main().catch(err => {
	log.error('予期せぬトップレベルエラーが発生しました:');
	console.error(err);
	process.exit(1);
});