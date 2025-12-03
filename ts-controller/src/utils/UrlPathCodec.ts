// controller/src/utils/UrlPathCodec.ts
import { UrlParts } from '../types'; // 型定義をインポート
import { log } from './logger';

/**
 * URLとファイルパスのエンコード・デコード、分割・結合を行うユーティリティクラス。
 */
export class UrlPathCodec {
	constructor() {
		log.debug('UrlPathCodec がインスタンス化されました。');
	}

	/**
	 * ユーザー指定の targetUrl を解析し、エンコード前後の各部分を返す。
	 * @param targetUrl 例: 'my-site/path/data.bin' or 'case1.test/1761686432543/data.bin'
	 * @returns UrlParts オブジェクト
	 */
	parseTargetUrl(targetUrl: string): UrlParts {
		// targetUrl が空や null でないことを確認
		if (!targetUrl) {
			throw new Error('targetUrl が空または無効です。');
		}

		// 最後のスラッシュを探す
		const lastSlashIndex = targetUrl.lastIndexOf('/');

		// スラッシュが見つからない、または末尾がスラッシュの場合はエラー
		if (lastSlashIndex === -1 || lastSlashIndex === targetUrl.length - 1) {
			throw new Error(`Invalid targetUrl format: "${targetUrl}". URL must contain a file path after the last slash.`);
		}

		// ベースURL部分とファイルパス部分に分割
		const baseUrlRaw = targetUrl.substring(0, lastSlashIndex);
		// ファイルパス部分は必ずスラッシュから始まるようにする
		const filePathRaw = targetUrl.substring(lastSlashIndex);

		// ★ エンコード処理を一元化 ★
		// encodeURIComponent は '/' もエンコードするため、そのまま使用
		const baseUrlEncoded = Buffer.from(baseUrlRaw).toString('base64url');
		// ファイルパスも同様にエンコード
		const filePathEncoded = Buffer.from(filePathRaw).toString('base64url');

		log.debug(`URL Parsed: Original='${targetUrl}', BaseRaw='${baseUrlRaw}', FileRaw='${filePathRaw}', BaseEncoded='${baseUrlEncoded}', FileEncoded='${filePathEncoded}'`);

		return {
			original: targetUrl,
			baseUrlRaw: baseUrlRaw,
			baseUrlEncoded: baseUrlEncoded,
			filePathRaw: filePathRaw,
			filePathEncoded: filePathEncoded,
		};
	}

	/**
	 * エンコード済みのファイルパスをデコードする。
	 * @param encodedFilePath 例: '%2Fdata.bin'
	 * @returns 例: '/data.bin'
	 */
	decodeFilePath(encodedFilePath: string): string {
		try {
			return decodeURIComponent(encodedFilePath);
		} catch (e) {
			log.warn(`Failed to decode file path: "${encodedFilePath}"`, e);
			return encodedFilePath; // デコード失敗時は元の文字列を返す
		}
	}

	/**
	 * エンコード済みのベースURLをデコードする。
	 * @param encodedBaseUrl 例: 'my-site%2Fpath'
	 * @returns 例: 'my-site/path'
	 */
	decodeBaseUrl(encodedBaseUrl: string): string {
		try {
			return Buffer.from(encodedBaseUrl, 'base64url').toString('utf-8');
		} catch (e) {
			log.warn(`Failed to decode base URL: "${encodedBaseUrl}"`, e);
			return encodedBaseUrl; // デコード失敗時は元の文字列を返す
		}
	}

	/**
	 * ベースURLとファイルパス（エンコード前）から完全なURLを再構築する。
	 * @param baseUrlRaw ベースURL (例: 'my-site/path')
	 * @param filePathRaw ファイルパス (例: '/data.bin')
	 * @returns 完全なURL (例: 'my-site/path/data.bin')
	 */
	buildUrl(baseUrlRaw: string, filePathRaw: string): string {
		// filePathRaw が '/' で始まっていることを確認（念のため）
		const sanitizedFilePath = filePathRaw.startsWith('/') ? filePathRaw : '/' + filePathRaw;
		// baseUrlRaw の末尾のスラッシュを削除（念のため）
		const sanitizedBaseUrl = baseUrlRaw.replace(/\/+$/, '');
		return `${sanitizedBaseUrl}${sanitizedFilePath}`;
	}
}