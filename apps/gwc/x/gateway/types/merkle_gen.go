package types

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
)

type CSUFragmentProofData struct {
	Path          string
	Index         uint64
	FragmentBytes []byte
	FragmentProof *MerkleProof // types. を削除
	FileSize      uint64
	FileProof     *MerkleProof // types. を削除
}

// CSUSessionProofData はセッション全体の証明データです。
type CSUSessionProofData struct {
	RootProofHex string
	Fragments    []CSUFragmentProofData
}

// BuildCSUProofs は解凍されたファイル群からCSU仕様のRootProofと全断片のProofを生成します。
//
// RootProof v1 仕様:
// 1. Fragment leaf: SHA256("FRAG:{path}:{index}:{hex(SHA256(bytes))}")
// 2. File root: MerkleRoot(fragment_leaves)
// 3. File leaf: SHA256("FILE:{path}:{file_size}:{file_root}")
// 4. RootProof: MerkleRoot(file_leaves)
func BuildCSUProofs(files []ProcessedFile) (*CSUSessionProofData, error) {
	// 決定論的順序のため、パス昇順でソート
	sort.Slice(files, func(i, j int) bool {
		return files[i].Path < files[j].Path
	})

	var fileLeaves []string
	// ファイルごとの情報を一時保存するマップ
	// path -> { fileRoot, fragments[] }
	type fileInfo struct {
		fileRoot  string
		fileSize  uint64
		fragments []struct {
			index uint64
			bytes []byte
			leaf  string
		}
		fragTree *MerkleTree
	}
	fileInfos := make(map[string]*fileInfo)

	// Step 1: 各ファイルのFragment Treeを構築
	for _, f := range files {
		if len(f.Chunks) == 0 {
			// 空ファイルの場合の扱いは仕様によるが、ここではスキップまたは特定のハッシュとする。
			// 今回はスキップせず、空のMerkleRootを許容する実装とします。
			// ただし、ProcessZipAndSplitで空チャンクを除外している場合は注意。
			continue
		}

		var fragLeaves []string
		info := &fileInfo{
			fileSize: uint64(len(f.Content)),
		}

		for i, chunk := range f.Chunks {
			index := uint64(i)
			// Leaf計算: SHA256("FRAG:{path}:{index}:{hex(SHA256(fragment_bytes))}")
			chunkHash := sha256.Sum256(chunk)
			chunkHashHex := hex.EncodeToString(chunkHash[:])

			rawLeaf := fmt.Sprintf("FRAG:%s:%d:%s", f.Path, index, chunkHashHex)
			leafHash := sha256.Sum256([]byte(rawLeaf))
			leafHex := hex.EncodeToString(leafHash[:])

			fragLeaves = append(fragLeaves, leafHex)
			info.fragments = append(info.fragments, struct {
				index uint64
				bytes []byte
				leaf  string
			}{index, chunk, leafHex})
		}

		// Fragment Tree構築
		fragTree := NewMerkleTree(fragLeaves)
		info.fragTree = fragTree
		info.fileRoot = fragTree.Root()
		fileInfos[f.Path] = info

		// Step 2: File Leafを計算
		// Leaf計算: SHA256("FILE:{path}:{file_size}:{file_root}")
		rawFileLeaf := fmt.Sprintf("FILE:%s:%d:%s", f.Path, info.fileSize, info.fileRoot)
		fileLeafHash := sha256.Sum256([]byte(rawFileLeaf))
		fileLeafHex := hex.EncodeToString(fileLeafHash[:])

		fileLeaves = append(fileLeaves, fileLeafHex)
	}

	// Step 3: Root Treeを構築
	rootTree := NewMerkleTree(fileLeaves)
	rootProofHex := rootTree.Root()

	// Step 4: 全断片のProofデータを生成
	result := &CSUSessionProofData{
		RootProofHex: rootProofHex,
		Fragments:    make([]CSUFragmentProofData, 0),
	}

	// 構築したツリーからProofを取り出す
	// fileLeavesの順序は files のループ順（ソート済み）と一致しているため、インデックスで対応可能
	for fileIdx, f := range files {
		info, ok := fileInfos[f.Path]
		if !ok {
			continue
		}

		// このファイルの FileProof (Root Treeに対する証明)
		fileProof, err := rootTree.GenerateProof(fileIdx)
		if err != nil {
			return nil, fmt.Errorf("failed to generate file proof for %s: %w", f.Path, err)
		}

		for fragIdx, frag := range info.fragments {
			// この断片の FragmentProof (Fragment Treeに対する証明)
			fragProof, err := info.fragTree.GenerateProof(fragIdx)
			if err != nil {
				return nil, fmt.Errorf("failed to generate fragment proof for %s[%d]: %w", f.Path, frag.index, err)
			}

			result.Fragments = append(result.Fragments, CSUFragmentProofData{
				Path:          f.Path,
				Index:         frag.index,
				FragmentBytes: frag.bytes,
				FragmentProof: fragProof,
				FileSize:      info.fileSize,
				FileProof:     fileProof,
			})
		}
	}

	return result, nil
}

// --- Merkle Tree Implementation ---

type MerkleTree struct {
	Leaves []string
	Layers [][]string
}

// NewMerkleTree は葉（Hex文字列リスト）からMerkle Treeを構築します。
func NewMerkleTree(leaves []string) *MerkleTree {
	if len(leaves) == 0 {
		return &MerkleTree{Leaves: []string{}, Layers: [][]string{}}
	}

	layers := [][]string{leaves}
	current := leaves

	for len(current) > 1 {
		var next []string
		for i := 0; i < len(current); i += 2 {
			left := current[i]
			var right string
			if i+1 < len(current) {
				right = current[i+1]
			} else {
				// 奇数の場合は末尾複製
				right = left
			}
			parent := hashPair(left, right)
			next = append(next, parent)
		}
		layers = append(layers, next)
		current = next
	}

	return &MerkleTree{
		Leaves: leaves,
		Layers: layers,
	}
}

// Root はルートハッシュを返します
func (m *MerkleTree) Root() string {
	if len(m.Layers) == 0 {
		return ""
	}
	// 最後のレイヤーの最初の要素がルート
	return m.Layers[len(m.Layers)-1][0]
}

// GenerateProof は指定されたインデックスの葉に対するMerkle Proofを生成します
func (m *MerkleTree) GenerateProof(index int) (*MerkleProof, error) {
	if index < 0 || index >= len(m.Leaves) {
		return nil, fmt.Errorf("index out of range")
	}

	proof := &MerkleProof{
		Steps: []*MerkleStep{},
	}

	currentIndex := index
	// ルートレイヤー（最後のレイヤー）を除く各レイヤーについて処理
	for i := 0; i < len(m.Layers)-1; i++ {
		layer := m.Layers[i]
		isRight := currentIndex%2 == 1
		siblingIndex := 0

		var siblingHex string
		var siblingIsLeft bool

		if isRight {
			// 自分が右なら兄弟は左 (index-1)
			siblingIndex = currentIndex - 1
			siblingHex = layer[siblingIndex]
			siblingIsLeft = true
		} else {
			// 自分が左なら兄弟は右 (index+1)
			// ただし末尾でペアがいない場合は自分自身の複製が兄弟となる
			if currentIndex+1 < len(layer) {
				siblingIndex = currentIndex + 1
				siblingHex = layer[siblingIndex]
			} else {
				siblingHex = layer[currentIndex]
			}
			siblingIsLeft = false
		}

		proof.Steps = append(proof.Steps, &MerkleStep{
			SiblingHex:    siblingHex,
			SiblingIsLeft: siblingIsLeft,
		})

		currentIndex /= 2
	}

	return proof, nil
}

// hashPair は2つのHex文字列を連結してSHA256ハッシュを取ります
func hashPair(leftHex, rightHex string) string {
	// 単純な文字列連結してからハッシュ (仕様書: hex(SHA256(left_hex + right_hex)))
	data := []byte(leftHex + rightHex)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}
