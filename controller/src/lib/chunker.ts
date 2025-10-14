import * as fs from 'fs/promises';
import { CHUNK_SIZE } from '../config';
import { log } from './logger';
/**
 * ファイルを指定されたサイズのチャンクに分割する
 * @param filePath 分割するファイルのパス
 * @returns チャンクデータのBuffer配列
 */
export async function splitFileIntoChunks(filePath: string): Promise<Buffer[]> {
	const fileBuffer = await fs.readFile(filePath);
	const chunks: Buffer[] = [];

	for (let i = 0; i < fileBuffer.length; i += CHUNK_SIZE) {
		const chunk = fileBuffer.subarray(i, i + CHUNK_SIZE);
		chunks.push(chunk);
	}

	log.info(`File "${filePath}" was split into ${chunks.length} chunks.`);
	return chunks;
}