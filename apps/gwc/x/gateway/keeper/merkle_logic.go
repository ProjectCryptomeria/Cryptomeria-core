package keeper

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
)

// CalculateSiteRoot computes the Merkle Root of the entire site (project).
// It constructs the tree from bottom up: Fragments -> File -> Site.
// Returns the siteRoot (hex string) and a map of FileRoot for each file.
func CalculateSiteRoot(files []ProcessedFile) (string, map[string]string, error) {
	if len(files) == 0 {
		return "", nil, fmt.Errorf("no files to process")
	}

	// 1. Sort files by Path to ensure deterministic SiteRoot
	sort.Slice(files, func(i, j int) bool {
		return files[i].Path < files[j].Path
	})

	fileRoots := make(map[string]string)
	var fileLeafHashes []string

	for _, file := range files {
		// Calculate FileRoot from fragments
		fRoot, err := calculateFileRoot(file.Path, file.Chunks)
		if err != nil {
			return "", nil, err
		}
		fileRoots[file.Path] = fRoot

		// Create Leaf for Site Tree: H("FILE" + path + size + fileRoot)
		leafHash := hashFileEntry(file.Path, uint64(len(file.Content)), fRoot)
		fileLeafHashes = append(fileLeafHashes, leafHash)
	}

	// Calculate SiteRoot from File Leafs
	siteRoot := calculateMerkleRoot(fileLeafHashes)
	return siteRoot, fileRoots, nil
}

// calculateFileRoot computes Merkle Root for a single file from its chunks
func calculateFileRoot(filePath string, chunks [][]byte) (string, error) {
	if len(chunks) == 0 {
		// Empty file
		return hashFragmentEntry(filePath, 0, []byte{}), nil
	}

	var leafHashes []string
	for i, chunk := range chunks {
		// Create Leaf for File Tree: H("FRAG" + path + index + dataHash)
		leaf := hashFragmentEntry(filePath, i, chunk)
		leafHashes = append(leafHashes, leaf)
	}

	return calculateMerkleRoot(leafHashes), nil
}

// calculateMerkleRoot computes the root of a list of hashes (standard binary Merkle Tree)
func calculateMerkleRoot(hashes []string) string {
	if len(hashes) == 0 {
		return ""
	}
	if len(hashes) == 1 {
		return hashes[0]
	}

	// If odd number of nodes, duplicate the last one
	if len(hashes)%2 != 0 {
		hashes = append(hashes, hashes[len(hashes)-1])
	}

	var nextLevel []string
	for i := 0; i < len(hashes); i += 2 {
		combined := hashes[i] + hashes[i+1]
		hash := sha256.Sum256([]byte(combined))
		nextLevel = append(nextLevel, hex.EncodeToString(hash[:]))
	}

	return calculateMerkleRoot(nextLevel)
}

// hashFragmentEntry: SHA256("FRAG" || filePath || index || SHA256(data))
func hashFragmentEntry(path string, index int, data []byte) string {
	dataHash := sha256.Sum256(data)
	dataHashStr := hex.EncodeToString(dataHash[:])
	
	raw := fmt.Sprintf("FRAG:%s:%d:%s", path, index, dataHashStr)
	hash := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(hash[:])
}

// hashFileEntry: SHA256("FILE" || filePath || size || fileRoot)
func hashFileEntry(path string, size uint64, fileRoot string) string {
	raw := fmt.Sprintf("FILE:%s:%d:%s", path, size, fileRoot)
	hash := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(hash[:])
}