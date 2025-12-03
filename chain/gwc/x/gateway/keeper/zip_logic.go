package keeper

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"path/filepath"
	"strings"
)

type ProcessedFile struct {
	Filename string
	Content  []byte
	Chunks   [][]byte
}

// ProcessZipData extracts files from a zip and shards them into chunks
func ProcessZipData(zipData []byte, chunkSize int) ([]ProcessedFile, error) {
	zipReader, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if err != nil {
		return nil, fmt.Errorf("failed to create zip reader: %w", err)
	}

	var processedFiles []ProcessedFile

	for _, file := range zipReader.File {
		if file.FileInfo().IsDir() {
			continue
		}

		// Read file content
		rc, err := file.Open()
		if err != nil {
			return nil, fmt.Errorf("failed to open file in zip %s: %w", file.Name, err)
		}
		content, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return nil, fmt.Errorf("failed to read file in zip %s: %w", file.Name, err)
		}

		// Shard content
		chunks := shardData(content, chunkSize)

		processedFiles = append(processedFiles, ProcessedFile{
			Filename: file.Name,
			Content:  content,
			Chunks:   chunks,
		})
	}

	return processedFiles, nil
}

func shardData(data []byte, chunkSize int) [][]byte {
	dataLen := len(data)
	totalChunks := dataLen / chunkSize
	if dataLen%chunkSize != 0 {
		totalChunks++
	}

	chunks := make([][]byte, totalChunks)
	for i := 0; i < totalChunks; i++ {
		start := i * chunkSize
		end := start + chunkSize
		if end > dataLen {
			end = dataLen
		}
		chunks[i] = data[start:end]
	}
	return chunks
}

// GetProjectNameFromZipFilename extracts project name from zip filename (e.g. "my-site.zip" -> "my-site")
func GetProjectNameFromZipFilename(filename string) string {
	return strings.TrimSuffix(filename, filepath.Ext(filename))
}
