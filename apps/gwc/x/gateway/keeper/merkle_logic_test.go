package keeper

import (
	"encoding/hex"
	"testing"

	"gwc/x/gateway/types"
)

func TestVerifyMerkleProof_EmptyProofReturnsLeaf(t *testing.T) {
	leaf := sha256Bytes([]byte("leaf"))
	if len(leaf) != 32 {
		t.Fatalf("expected 32 bytes leaf, got %d", len(leaf))
	}

	root, err := VerifyMerkleProof(leaf, &types.MerkleProof{Steps: nil})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if hex.EncodeToString(root) != hex.EncodeToString(leaf) {
		t.Fatalf("expected root == leaf")
	}
}

func TestVerifyFragment_SingleFileTwoFragments_OK(t *testing.T) {
	path := "index.html"

	frag0 := []byte("hello-----0")
	frag1 := []byte("hello-----1")

	leaf0 := HashFragmentLeaf(path, 0, frag0)
	leaf1 := HashFragmentLeaf(path, 1, frag1)

	// file_root = sha256(leaf0 || leaf1)
	fileRoot := sha256Bytes(append(append([]byte{}, leaf0...), leaf1...))

	// file_leaf becomes rootProof for single-file site
	fileSize := uint64(123)
	fileLeaf := HashFileLeaf(path, fileSize, fileRoot)
	rootProofHex := hex.EncodeToString(fileLeaf)

	// fragment proof for leaf0: sibling is leaf1 on the right
	fp0 := &types.MerkleProof{
		Steps: []*types.MerkleStep{
			{
				SiblingHex:    hex.EncodeToString(leaf1),
				SiblingIsLeft: false, // sibling on right
			},
		},
	}
	// file proof for single file: empty steps (root == file_leaf)
	fileProof := &types.MerkleProof{Steps: nil}

	item0 := &types.DistributeItem{
		Path:          path,
		Index:         0,
		FragmentBytes: frag0,
		FragmentProof: fp0,
		FileSize:      fileSize,
		FileProof:     fileProof,
	}

	if err := VerifyFragment(rootProofHex, item0); err != nil {
		t.Fatalf("expected ok, got error: %v", err)
	}
}

func TestVerifyFragment_WrongFragmentBytes_Fails(t *testing.T) {
	path := "index.html"

	frag0 := []byte("hello-----0")
	frag1 := []byte("hello-----1")

	leaf0 := HashFragmentLeaf(path, 0, frag0)
	leaf1 := HashFragmentLeaf(path, 1, frag1)

	fileRoot := sha256Bytes(append(append([]byte{}, leaf0...), leaf1...))
	fileSize := uint64(123)
	fileLeaf := HashFileLeaf(path, fileSize, fileRoot)
	rootProofHex := hex.EncodeToString(fileLeaf)

	// proof that expects frag0
	fp0 := &types.MerkleProof{
		Steps: []*types.MerkleStep{
			{
				SiblingHex:    hex.EncodeToString(leaf1),
				SiblingIsLeft: false,
			},
		},
	}
	fileProof := &types.MerkleProof{Steps: nil}

	// wrong bytes -> leaf mismatch -> should fail
	item0 := &types.DistributeItem{
		Path:          path,
		Index:         0,
		FragmentBytes: []byte("WRONG BYTES"),
		FragmentProof: fp0,
		FileSize:      fileSize,
		FileProof:     fileProof,
	}

	if err := VerifyFragment(rootProofHex, item0); err == nil {
		t.Fatalf("expected error, got nil")
	}
}

func TestVerifyFragment_RootProofMismatch_Fails(t *testing.T) {
	path := "index.html"

	frag0 := []byte("hello-----0")
	frag1 := []byte("hello-----1")

	leaf0 := HashFragmentLeaf(path, 0, frag0)
	leaf1 := HashFragmentLeaf(path, 1, frag1)

	fileRoot := sha256Bytes(append(append([]byte{}, leaf0...), leaf1...))
	fileSize := uint64(123)
	fileLeaf := HashFileLeaf(path, fileSize, fileRoot)

	// rootProof should be fileLeaf, but we use a different rootProof to force mismatch
	badRootProofHex := hex.EncodeToString(sha256Bytes([]byte("bad_root")))

	fp0 := &types.MerkleProof{
		Steps: []*types.MerkleStep{
			{
				SiblingHex:    hex.EncodeToString(leaf1),
				SiblingIsLeft: false,
			},
		},
	}
	fileProof := &types.MerkleProof{Steps: nil}

	item0 := &types.DistributeItem{
		Path:          path,
		Index:         0,
		FragmentBytes: frag0,
		FragmentProof: fp0,
		FileSize:      fileSize,
		FileProof:     fileProof,
	}

	_ = fileLeaf // silence, ensure fileLeaf computed
	if err := VerifyFragment(badRootProofHex, item0); err == nil {
		t.Fatalf("expected error, got nil")
	}
}
