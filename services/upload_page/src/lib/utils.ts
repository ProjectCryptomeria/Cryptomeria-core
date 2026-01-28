// services/upload_page/src/lib/utils.ts
/**
 * 暗号学的ハッシュ関数およびエンコード関連のユーティリティ。
 * ブラウザ標準の Web Crypto API を使用します。
 */

/**
 * 文字列をUTF-8バイト列にエンコードします。
 * @param str 入力文字列
 * @returns UTF-8バイト列
 */
export const stringToBytes = (str: string): Uint8Array => {
    return new TextEncoder().encode(str);
};

/**
 * バイト列を16進数文字列に変換します。
 * Pythonの bytes.hex() に相当します。
 * @param bytes 入力バイト列
 * @returns 16進数文字列
 */
export const bytesToHex = (bytes: Uint8Array): string => {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
};

/**
 * SHA-256ハッシュを計算します。
 * @param data 入力データ
 * @returns ハッシュ値（バイト列）
 */
export const sha256 = async (data: Uint8Array): Promise<Uint8Array> => {
    // 修正: 型定義上の不一致（SharedArrayBufferの可能性など）によりエラーが出る場合があるため、
    // dataを明示的に BufferSource としてキャストして渡します。
    // ランタイムでは crypto.subtle.digest は Uint8Array を正しく受け入れます。
    const hashBuffer = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
    return new Uint8Array(hashBuffer);
};