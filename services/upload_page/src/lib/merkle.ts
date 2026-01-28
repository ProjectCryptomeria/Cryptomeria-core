import { sha256, bytesToHex, stringToBytes } from './utils';

// ファイル単位の計算結果
interface FileNode {
    path: string;
    size: number;
    rootHash: Uint8Array;
}

// 入力ファイルの定義
export interface InputFile {
    path: string;     // 正規化済みのパス (例: "index.html", "css/style.css")
    data: Uint8Array; // ファイルの中身
}

/**
 * CSUプロトコル (RootProof v1) 準拠のMerkle Tree計算機。
 * Python実装と完全に同一のハッシュ値を生成するように設計されています。
 */
export class MerkleTreeCalculator {
    /**
     * 親ノードのハッシュを計算します。
     * 仕様: sha256((hex(left) + hex(right)).encode())
     * 文字列としてHexを結合してからハッシュ化する点に注意してください。
     */
    private async calculateParentHash(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
        const leftHex = bytesToHex(left);
        const rightHex = bytesToHex(right);
        // バイナリ連結ではなく、Hex文字列の連結
        const combinedString = leftHex + rightHex;
        return sha256(stringToBytes(combinedString));
    }

    /**
     * リーフノードのリストからルートハッシュを計算します。
     * 奇数の場合は末尾を複製します。
     */
    private async computeMerkleRoot(leaves: Uint8Array[]): Promise<Uint8Array> {
        if (leaves.length === 0) {
            return new Uint8Array();
        }

        let level = [...leaves];

        while (level.length > 1) {
            if (level.length % 2 !== 0) {
                level.push(level[level.length - 1]);
            }

            const nextLevel: Uint8Array[] = [];
            for (let i = 0; i < level.length; i += 2) {
                const parent = await this.calculateParentHash(level[i], level[i + 1]);
                nextLevel.push(parent);
            }
            level = nextLevel;
        }

        return level[0];
    }

    /**
     * 断片(Fragment)リーフのハッシュ計算
     * H("FRAG:{path}:{index}:{hex(H(data))}")
     */
    private async hashFragment(path: string, index: number, data: Uint8Array): Promise<Uint8Array> {
        const dataHash = await sha256(data);
        const dataHashHex = bytesToHex(dataHash);
        const leafString = `FRAG:${path}:${index}:${dataHashHex}`;
        return sha256(stringToBytes(leafString));
    }

    /**
     * ファイル(File)リーフのハッシュ計算
     * H("FILE:{path}:{size}:{hex(fileRoot)}")
     */
    private async hashFile(path: string, size: number, fileRoot: Uint8Array): Promise<Uint8Array> {
        const fileRootHex = bytesToHex(fileRoot);
        const leafString = `FILE:${path}:${size}:${fileRootHex}`;
        return sha256(stringToBytes(leafString));
    }

    /**
     * 1つのファイルを断片化し、そのファイルのMerkle Rootを計算します。
     */
    private async processFile(file: InputFile, fragmentSize: number): Promise<FileNode> {
        const size = file.data.length;
        const fragments: Uint8Array[] = [];

        if (size === 0) {
            fragments.push(new Uint8Array());
        } else {
            for (let i = 0; i < size; i += fragmentSize) {
                fragments.push(file.data.slice(i, i + fragmentSize));
            }
        }

        // 各断片のハッシュを計算
        const fragmentLeafHashes = await Promise.all(
            fragments.map((fragData, index) => this.hashFragment(file.path, index, fragData))
        );

        const fileRoot = await this.computeMerkleRoot(fragmentLeafHashes);

        return {
            path: file.path,
            size: size,
            rootHash: fileRoot,
        };
    }

    /**
     * プロジェクト全体のRootProof (Hex文字列) を計算します。
     * @param files 入力ファイルのリスト
     * @param fragmentSize フラグメントサイズ (デフォルト1024推奨)
     */
    public async calculateRootProof(files: InputFile[], fragmentSize: number = 1024): Promise<string> {
        // 1. パスでソート (重要: Pythonの sort 順序と一致させる)
        const sortedFiles = [...files].sort((a, b) => {
            if (a.path < b.path) return -1;
            if (a.path > b.path) return 1;
            return 0;
        });

        // 2. 各ファイルのMerkle Root計算
        const fileNodes = await Promise.all(
            sortedFiles.map(file => this.processFile(file, fragmentSize))
        );

        // 3. ファイルリーフハッシュの計算
        const fileLeafHashes = await Promise.all(
            fileNodes.map(node => this.hashFile(node.path, node.size, node.rootHash))
        );

        // 4. 全体のMerkle Root計算
        const rootHash = await this.computeMerkleRoot(fileLeafHashes);

        return bytesToHex(rootHash);
    }
}