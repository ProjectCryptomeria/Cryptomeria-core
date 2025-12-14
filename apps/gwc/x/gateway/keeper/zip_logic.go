package keeper

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"path"
	"strings"
)

// DecompressionLimit defines the maximum total size of decompressed data allowed (e.g., 100MB)
// preventing Zip Bomb attacks.
const DecompressionLimit = 100 * 1024 * 1024

type ProcessedFile struct {
	// Original raw filename from zip
	Filename string
	// Normalized relative path (e.g. "assets/css/style.css") used for manifest key
	Path    string
	Content []byte
	Chunks  [][]byte
}

// ProcessZipData extracts files from a zip and shards them into chunks.
// It enforces a total decompression size limit.
func ProcessZipData(zipData []byte, chunkSize int) ([]ProcessedFile, error) {
	zipReader, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if err != nil {
		return nil, fmt.Errorf("failed to create zip reader: %w", err)
	}

	var processedFiles []ProcessedFile
	var totalDecompressedSize int64

	for _, file := range zipReader.File {
		if file.FileInfo().IsDir() {
			continue
		}

		// Normalize path for manifest key
		// 1. Force convert backslashes to slashes (handle Windows paths on Linux envs)
		normalizedPath := strings.ReplaceAll(file.Name, "\\", "/")

		// 2. Use path.Clean (not filepath.Clean) to resolve ., .. using forward slashes independent of OS
		cleanPath := path.Clean(normalizedPath)

		// 3. Security check: Ensure path does not go up the tree
		if path.IsAbs(cleanPath) || strings.HasPrefix(cleanPath, "../") {
			return nil, fmt.Errorf("zip contains unsafe file path: %s", file.Name)
		}

		// 4. Remove leading "./" or "/" if present to ensure relative path "assets/img.png"
		cleanPath = strings.TrimPrefix(cleanPath, "/")
		cleanPath = strings.TrimPrefix(cleanPath, "./")

		// Calculate decompressed size
		if totalDecompressedSize+file.FileInfo().Size() > DecompressionLimit {
			return nil, fmt.Errorf("decompression limit exceeded")
		}

		// Open and Read file content with limit
		rc, err := file.Open()
		if err != nil {
			return nil, fmt.Errorf("failed to open file in zip %s: %w", file.Name, err)
		}

		// LimitReader to enforce security strictly during read
		limitReader := io.LimitReader(rc, DecompressionLimit-totalDecompressedSize)
		content, err := io.ReadAll(limitReader)
		rc.Close()
		if err != nil {
			return nil, fmt.Errorf("failed to read file in zip %s (or limit exceeded): %w", file.Name, err)
		}

		currentSize := int64(len(content))
		totalDecompressedSize += currentSize
		if totalDecompressedSize > DecompressionLimit {
			return nil, fmt.Errorf("decompression limit exceeded")
		}

		// Shard content using the shared logic
		chunks, err := SplitDataIntoFragments(content, chunkSize)
		if err != nil {
			return nil, fmt.Errorf("failed to split file %s: %w", file.Name, err)
		}

		processedFiles = append(processedFiles, ProcessedFile{
			Filename: file.Name,
			Path:     cleanPath,
			Content:  content,
			Chunks:   chunks,
		})
	}

	return processedFiles, nil
}

// GetProjectNameFromZipFilename extracts project name from zip filename (e.g. "my-site.zip" -> "my-site")
func GetProjectNameFromZipFilename(filename string) string {
	// Simple string manipulation to be OS-independent for URL/Project names
	base := path.Base(strings.ReplaceAll(filename, "\\", "/"))
	ext := path.Ext(base)
	return strings.TrimSuffix(base, ext)
}
