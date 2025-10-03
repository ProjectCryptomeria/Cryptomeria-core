import * as fs from 'fs/promises'; // ★★★ 修正箇所1: 静的インポートに変更 ★★★
import * as path from 'path';
import { uploadChunkToDataChain, uploadManifestToMetaChain } from '../blockchain';
import { splitFileIntoChunks } from '../chunker';


// --- メインの実行関数 ---
async function main() {
	console.log('🚀 Starting file upload test...');

	// 1. テスト用のファイルを作成・分割
	const testFilePath = path.join(__dirname, 'test-file.txt');
	await fs.writeFile( // ★★★ 修正箇所2: fsから直接呼び出し ★★★
		testFilePath,
		'This is a test file for the Raidchain project. It will be split into multiple chunks and uploaded to different datachains.'
	);
	const chunks = await splitFileIntoChunks(testFilePath);

	// 2. 各チャンクをdatachainに並列でアップロード
	const uniqueSuffix = `test-${Date.now()}`;
	// ★★★ 修正箇所3: 各引数に型を明示的に指定 ★★★
	const chunkUploadPromises = chunks.map((chunk: Buffer, i: number) => {
		const chunkIndex = `${uniqueSuffix}-${i}`;
		// ラウンドロビンでdata-0とdata-1に振り分ける
		const targetChain = i % 2 === 0 ? 'data-0' : 'data-1';
		console.log(`  -> Uploading chunk ${chunkIndex} to ${targetChain}...`);
		return uploadChunkToDataChain(targetChain, chunkIndex, chunk).then(result => {
			// 成功したらインデックスを返す
			console.log(`  ✅ Chunk ${chunkIndex} uploaded. TxHash: ${result.transactionHash}`);
			return chunkIndex;
		}).catch((err: any) => {
			console.error(`  🔥 Failed to upload chunk ${chunkIndex} to ${targetChain}:`, err);
			return null; // 失敗した場合はnullを返す
		});
	});

	const uploadedChunkIndexes = (await Promise.all(chunkUploadPromises)).filter(
		(index: string | null): index is string => index !== null
	);

	if (uploadedChunkIndexes.length !== chunks.length) {
		console.error('🔥 Some chunks failed to upload. Aborting.');
		return;
	}

	// 3. マニフェストを作成
	const siteUrl = `my-test-site.com/${uniqueSuffix}`;
	const manifest = {
		filepath: 'test-file.txt',
		chunks: uploadedChunkIndexes,
	};

	// 4. マニフェストをmetachainにアップロード
	console.log(`\n📦 Uploading manifest for ${siteUrl} to meta-0...`);
	try {
		const result = await uploadManifestToMetaChain(siteUrl, JSON.stringify(manifest));
		console.log('✅ Manifest uploaded successfully!');
		console.log(`  -> Site URL: ${siteUrl}`);
		console.log(`  -> TxHash: ${result.transactionHash}`);
	} catch (err) {
		console.error('🔥 Failed to upload manifest:', err);
	}

	console.log('\n🎉 Test complete!');
}


// --- スクリプトの実行 ---
main().catch(console.error);