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
const DecompressionLimit = 100 * 1024 * 1024

type ProcessedFile struct {
	Filename string
	Path    string
	Content []byte
	Chunks  [][]byte
}

// ProcessZipAndCalcMerkle extracts files, shards them, and calculates the deterministic SiteRoot.
func ProcessZipAndCalcMerkle(zipData []byte, chunkSize int) ([]ProcessedFile, string, map[string]string, error) {
	zipReader, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if err != nil {
		return nil, "", nil, fmt.Errorf("failed to create zip reader: %w", err)
	}

	var processedFiles []ProcessedFile
	var totalDecompressedSize int64

	for _, file := range zipReader.File {
		if file.FileInfo().IsDir() {
			continue
		}

		// Normalize path
		normalizedPath := strings.ReplaceAll(file.Name, "\\", "/")
		cleanPath := path.Clean(normalizedPath)
		if path.IsAbs(cleanPath) || strings.HasPrefix(cleanPath, "../") {
			return nil, "", nil, fmt.Errorf("zip contains unsafe file path: %s", file.Name)
		}
		cleanPath = strings.TrimPrefix(cleanPath, "/")
		cleanPath = strings.TrimPrefix(cleanPath, "./")

		if totalDecompressedSize+file.FileInfo().Size() > DecompressionLimit {
			return nil, "", nil, fmt.Errorf("decompression limit exceeded")
		}

		rc, err := file.Open()
		if err != nil {
			return nil, "", nil, fmt.Errorf("failed to open file in zip: %w", err)
		}

		limitReader := io.LimitReader(rc, DecompressionLimit-totalDecompressedSize)
		content, err := io.ReadAll(limitReader)
		rc.Close()
		if err != nil {
			return nil, "", nil, fmt.Errorf("failed to read file: %w", err)
		}

		currentSize := int64(len(content))
		totalDecompressedSize += currentSize
		if totalDecompressedSize > DecompressionLimit {
			return nil, "", nil, fmt.Errorf("decompression limit exceeded")
		}

		chunks, err := SplitDataIntoFragments(content, chunkSize)
		if err != nil {
			return nil, "", nil, fmt.Errorf("failed to split file: %w", err)
		}

		processedFiles = append(processedFiles, ProcessedFile{
			Filename: file.Name,
			Path:     cleanPath,
			Content:  content,
			Chunks:   chunks,
		})
	}

	// Calculate SiteRoot and FileRoots
	siteRoot, fileRoots, err := CalculateSiteRoot(processedFiles)
	if err != nil {
		return nil, "", nil, fmt.Errorf("failed to calculate merkle root: %w", err)
	}

	return processedFiles, siteRoot, fileRoots, nil
}

// GetProjectNameFromZipFilename extracts project name from zip filename
func GetProjectNameFromZipFilename(filename string) string {
	base := path.Base(strings.ReplaceAll(filename, "\\", "/"))
	ext := path.Ext(base)
	return strings.TrimSuffix(base, ext)
}