import JSZip from 'jszip';
import type { InputFile } from './merkle';

/**
 * ファイルリストを受け取り、単一のZIPバイナリを作成します。
 * @param files InputFile形式のファイルリスト
 * @returns ZIPファイルのバイナリ (Blob)
 */
export const createZipBlob = async (files: InputFile[]): Promise<Blob> => {
    const zip = new JSZip();

    // ファイルを追加
    files.forEach((file) => {
        zip.file(file.path, file.data);
    });

    // Blobとして生成
    // compression: 'DEFLATE' を指定して圧縮を有効化できますが、
    // CSUプロトコルでは圧縮・非圧縮どちらでも展開後のデータが正しければOKです。
    // ここでは標準的な設定で生成します。
    const content = await zip.generateAsync({
        type: 'blob',
        platform: 'UNIX', // パス区切り文字などをUNIXスタイルに統一
    });

    return content;
};

/**
 * FileList (input type="file" から取得) をInputFile形式に変換します。
 * ここでパスの正規化（バックスラッシュの置換など）を行います。
 */
export const processFileList = async (fileList: FileList): Promise<InputFile[]> => {
    const inputFiles: InputFile[] = [];

    for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];

        // webkitRelativePath があればそれを使用 (ディレクトリ選択時)、なければファイル名
        let rawPath = file.webkitRelativePath || file.name;

        // Windowsパス対策: \ を / に置換
        let normalizedPath = rawPath.replace(/\\/g, '/');

        // 先頭の ./ や / を削除
        normalizedPath = normalizedPath.replace(/^\.?\//, '');

        // 隠しファイル (.git など) やシステムファイルを除外するロジックをここに追加可能
        if (normalizedPath.startsWith('.git') || normalizedPath.includes('/.git')) {
            continue;
        }

        const arrayBuffer = await file.arrayBuffer();

        inputFiles.push({
            path: normalizedPath,
            data: new Uint8Array(arrayBuffer),
        });
    }

    return inputFiles;
};