import * as fs from 'fs/promises';
import * as path from 'path';
import { uploadChunkToDataChain, uploadManifestToMetaChain } from '../blockchain';
import { queryStoredChunk, queryStoredManifest } from '../blockchain-query';
import { splitFileIntoChunks } from '../chunker';

// --- 色付きログ出力用のヘルパー ---
const log = {
	info: (msg: string) => console.log(`\x1b[36m[情報]\x1b[0m ${msg}`),
	success: (msg: string) => console.log(`\x1b[32m[成功]\x1b[0m ${msg}`),
	error: (msg: string) => console.error(`\x1b[31m[エラー]\x1b[0m ${msg}`),
	step: (msg: string) => console.log(`\n\x1b[1;33m--- ${msg} ---\x1b[0m`),
};

async function main() {
	// =========================================================================
	// 1. アップロードフェーズ: まず、テスト対象となるデータをアップロードする
	// =========================================================================
	log.step('1. 【アップロード】テストデータの準備とアップロード');
	const originalContent = `これはRaidchainのデータ取得テストです。この文章が読めていれば、複数チェーンからのデータ復元に成功しています。ユニークID: ${Date.now()}`;
	const testFilePath = path.join(__dirname, 'retrieval-test-file.txt');
	await fs.writeFile(testFilePath, originalContent);
	const chunks = await splitFileIntoChunks(testFilePath);

	const uniqueSuffix = `retrieve-test-${Date.now()}`;
	const siteUrl = `my-retrieval-site.com/${uniqueSuffix}`;
	const urlIndex = encodeURIComponent(siteUrl);

	log.info(`サイト (${siteUrl}) のために、${chunks.length}個のチャンクをアップロードします。`);

	const chunkUploadPromises = chunks.map(async (chunk, i) => {
		const chunkIndex = `${uniqueSuffix}-${i}`;
		const targetChain = (i % 2 === 0 ? 'data-0' : 'data-1') as 'data-0' | 'data-1';
		await uploadChunkToDataChain(targetChain, chunkIndex, chunk);
		return chunkIndex;
	});
	const uploadedChunkIndexes = await Promise.all(chunkUploadPromises);

	const manifest = {
		filepath: 'retrieval-test-file.txt',
		chunks: uploadedChunkIndexes,
	};
	await uploadManifestToMetaChain(urlIndex, JSON.stringify(manifest));
	log.success('テストデータのアップロードが完了しました。');

	log.info('\n⏳ トランザクションが処理されるまで10秒待機します...');
	await new Promise(resolve => setTimeout(resolve, 10000));

	// =========================================================================
	// 2. 取得フェーズ: アップロードしたデータを実際に取得・復元する
	// =========================================================================
	log.step('2. 【データ取得】チェーンからデータを取得し、復元します');
	let retrievedFileContent: string | null = null;

	try {
		// --- 2a. Metachainからマニフェストを取得 ---
		log.info(`Metachainにマニフェストを問い合わせます (URL: ${siteUrl})`);
		const manifestQueryResult = await queryStoredManifest(urlIndex);

		if (!manifestQueryResult.stored_manifest || !manifestQueryResult.stored_manifest.manifest) {
			throw new Error(`不正なマニフェスト応答です: ${JSON.stringify(manifestQueryResult)}`);
		}

		const retrievedManifestString = manifestQueryResult.stored_manifest.manifest;
		const retrievedManifest = JSON.parse(retrievedManifestString);
		const chunkIndexesToFetch: string[] = retrievedManifest.chunks;
		log.success(`マニフェストを発見しました！ ${chunkIndexesToFetch.length}個のチャンクが含まれています。`);

		// --- 2b. Datachainから各データチャンクを取得 ---
		const chunkBuffers: Buffer[] = [];
		for (const [i, chunkIndex] of chunkIndexesToFetch.entries()) {
			const targetChain = (i % 2 === 0 ? 'data-0' : 'data-1') as 'data-0' | 'data-1';
			log.info(`  -> チャンク '${chunkIndex}' を ${targetChain} から取得中...`);

			const chunkQueryResult = await queryStoredChunk(targetChain, chunkIndex);
			if (!chunkQueryResult.stored_chunk || !chunkQueryResult.stored_chunk.data) {
				throw new Error(`不正なチャンク応答です (${chunkIndex}): ${JSON.stringify(chunkQueryResult)}`);
			}

			const chunkDataB64 = chunkQueryResult.stored_chunk.data;
			chunkBuffers.push(Buffer.from(chunkDataB64, 'base64'));
		}

		// --- 2c. チャンクを結合して元のデータを復元 ---
		const reconstructedBuffer = Buffer.concat(chunkBuffers);
		retrievedFileContent = reconstructedBuffer.toString('utf-8');
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