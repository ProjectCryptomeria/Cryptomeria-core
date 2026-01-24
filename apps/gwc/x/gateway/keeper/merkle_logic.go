package keeper

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"gwc/x/gateway/types"
)

// sha256Bytes returns sha256(data).
func sha256Bytes(data []byte) []byte {
	sum := sha256.Sum256(data)
	return sum[:]
}

// mustHex32 decodes hex string into 32-byte slice, otherwise returns error.
func mustHex32(h string) ([]byte, error) {
	b, err := hex.DecodeString(h)
	if err != nil {
		return nil, fmt.Errorf("invalid hex: %w", err)
	}
	if len(b) != 32 {
		return nil, fmt.Errorf("invalid hash length: expected 32 bytes, got %d", len(b))
	}
	return b, nil
}

// HashFragmentLeaf computes the CSU fragment leaf hash.
//
// Domain-separated string scheme (deterministic):
//
//	leaf_frag = SHA256("FRAG:{path}:{index}:{hex(SHA256(fragment_bytes))}")
//
// Notes:
// - path is used as-is (must match what was used when building RootProof off-chain)
// - index is decimal
// - fragment_bytes hash is hex-encoded lowercase (std hex.EncodeToString)
func HashFragmentLeaf(path string, index uint64, fragmentBytes []byte) []byte {
	fragDigest := sha256Bytes(fragmentBytes)
	fragDigestHex := hex.EncodeToString(fragDigest)

	payload := []byte(fmt.Sprintf("FRAG:%s:%d:%s", path, index, fragDigestHex))
	return sha256Bytes(payload)
}

// HashFileLeaf computes the CSU file leaf hash.
//
// Domain-separated string scheme (deterministic):
//
//	leaf_file = SHA256("FILE:{path}:{file_size}:{hex(file_root)}")
func HashFileLeaf(path string, fileSize uint64, fileRoot []byte) []byte {
	fileRootHex := hex.EncodeToString(fileRoot)
	payload := []byte(fmt.Sprintf("FILE:%s:%d:%s", path, fileSize, fileRootHex))
	return sha256Bytes(payload)
}

// VerifyMerkleProof computes the Merkle root by walking the proof from the leaf.
//
// - If proof is nil or steps are empty, the root is the leaf itself.
// - Each step contains sibling hash and whether sibling is on the left in concatenation.
func VerifyMerkleProof(leaf []byte, proof *types.MerkleProof) ([]byte, error) {
	if proof == nil || len(proof.Steps) == 0 {
		// single-leaf tree
		if len(leaf) != 32 {
			return nil, fmt.Errorf("leaf must be 32 bytes, got %d", len(leaf))
		}
		return leaf, nil
	}

	if len(leaf) != 32 {
		return nil, fmt.Errorf("leaf must be 32 bytes, got %d", len(leaf))
	}

	current := leaf
	for i, step := range proof.Steps {
		sib, err := mustHex32(step.SiblingHex)
		if err != nil {
			return nil, fmt.Errorf("invalid sibling_hex at step %d: %w", i, err)
		}

		var concat []byte
		if step.SiblingIsLeft {
			concat = append(append([]byte{}, sib...), current...)
		} else {
			concat = append(append([]byte{}, current...), sib...)
		}
		current = sha256Bytes(concat)
	}
	return current, nil
}

// VerifyFragment verifies a DistributeItem against the session RootProof.
//
// CSU rules (layer4):
//  1. fragment_leaf := HashFragmentLeaf(path, index, fragment_bytes)
//  2. file_root := VerifyMerkleProof(fragment_leaf, fragment_proof)
//  3. file_leaf := HashFileLeaf(path, file_size, file_root)
//  4. root := VerifyMerkleProof(file_leaf, file_proof)
//  5. root must equal root_proof_hex (session RootProof)
func VerifyFragment(rootProofHex string, item *types.DistributeItem) error {
	if item == nil {
		return fmt.Errorf("item is nil")
	}
	if item.Path == "" {
		return fmt.Errorf("item.path is empty")
	}

	rootProof, err := mustHex32(rootProofHex)
	if err != nil {
		return fmt.Errorf("invalid root_proof_hex: %w", err)
	}

	fragLeaf := HashFragmentLeaf(item.Path, item.Index, item.FragmentBytes)
	fileRoot, err := VerifyMerkleProof(fragLeaf, item.FragmentProof)
	if err != nil {
		return fmt.Errorf("fragment_proof verification failed: %w", err)
	}

	fileLeaf := HashFileLeaf(item.Path, item.FileSize, fileRoot)
	root, err := VerifyMerkleProof(fileLeaf, item.FileProof)
	if err != nil {
		return fmt.Errorf("file_proof verification failed: %w", err)
	}

	if len(root) != 32 {
		return fmt.Errorf("computed root invalid length: %d", len(root))
	}
	for i := 0; i < 32; i++ {
		if root[i] != rootProof[i] {
			return fmt.Errorf("root_proof mismatch")
		}
	}
	return nil
}
