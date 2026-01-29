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
    const content = await zip.generateAsync({
        type: 'blob',
        platform: 'UNIX', // パス区切り文字などをUNIXスタイルに統一
    });

    return content;
};

/**
 * FileList (input type="file" から取得) をInputFile形式に変換します。
 * ディレクトリ選択時に含まれる共通のルートディレクトリ（例: "dist/"）を自動的に削除します。
 */
export const processFileList = async (fileList: FileList): Promise<InputFile[]> => {
    const tempFiles: { rawPath: string; file: File }[] = [];

    // 1. まず全てのファイルをスキャンして正規化パスを生成
    for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];

        // webkitRelativePath があればそれを使用 (ディレクトリ選択時)、なければファイル名
        let rawPath = file.webkitRelativePath || file.name;

        // Windowsパス対策: \ を / に置換
        let normalizedPath = rawPath.replace(/\\/g, '/');

        // 先頭の ./ や / を削除
        normalizedPath = normalizedPath.replace(/^\.?\//, '');

        // 隠しファイル (.git など) やシステムファイルを除外
        if (normalizedPath.startsWith('.git') || normalizedPath.includes('/.git')) {
            continue;
        }

        tempFiles.push({ rawPath: normalizedPath, file });
    }

    if (tempFiles.length === 0) {
        return [];
    }

    // 2. 共通のルートディレクトリを検出
    // 全てのファイルが共通のディレクトリ配下にある場合、そのディレクトリ名を特定する
    let commonPrefix = '';
    const firstPath = tempFiles[0].rawPath;

    if (firstPath.includes('/')) {
        const parts = firstPath.split('/');
        // 最初のセグメント（例: "dist"）を候補とする
        const potentialRoot = parts[0] + '/';

        // 全てのファイルがこの候補で始まっているか確認
        const isCommon = tempFiles.every(f => f.rawPath.startsWith(potentialRoot));
        if (isCommon) {
            commonPrefix = potentialRoot;
        }
    }

    // 3. 共通ルートを除去して InputFile 形式の配列を構築
    const inputFiles: InputFile[] = [];

    for (const item of tempFiles) {
        // 共通ルートがあれば除去し、なければそのままのパスを使用
        const finalPath = commonPrefix
            ? item.rawPath.substring(commonPrefix.length)
            : item.rawPath;

        const arrayBuffer = await item.file.arrayBuffer();

        inputFiles.push({
            path: finalPath,
            data: new Uint8Array(arrayBuffer),
        });
    }

    return inputFiles;
};