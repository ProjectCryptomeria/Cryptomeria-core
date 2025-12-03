package keeper_test

import (
	"archive/zip"
	"bytes"
	"testing"

	"github.com/stretchr/testify/require"
	"gwc/x/gateway/keeper"
)

func TestProcessZipData(t *testing.T) {
	// Create a sample zip file
	buf := new(bytes.Buffer)
	zipWriter := zip.NewWriter(buf)

	files := []struct {
		Name    string
		Content []byte
	}{
		{"index.html", []byte("<html><body>Hello</body></html>")},
		{"css/style.css", []byte("body { color: red; }")},
		{"js/app.js", bytes.Repeat([]byte("a"), 2500)}, // 2.5KB
	}

	for _, file := range files {
		f, err := zipWriter.Create(file.Name)
		require.NoError(t, err)
		_, err = f.Write(file.Content)
		require.NoError(t, err)
	}

	require.NoError(t, zipWriter.Close())

	zipData := buf.Bytes()
	chunkSize := 1000 // 1KB chunks

	// Test ProcessZipData
	processedFiles, err := keeper.ProcessZipData(zipData, chunkSize)
	require.NoError(t, err)
	require.Len(t, processedFiles, 3)

	// Verify each file
	for _, pFile := range processedFiles {
		var originalContent []byte
		for _, f := range files {
			if f.Name == pFile.Filename {
				originalContent = f.Content
				break
			}
		}
		require.NotNil(t, originalContent, "File not found in original list: %s", pFile.Filename)
		require.Equal(t, originalContent, pFile.Content)

		// Verify chunks
		expectedChunks := len(originalContent) / chunkSize
		if len(originalContent)%chunkSize != 0 {
			expectedChunks++
		}
		require.Len(t, pFile.Chunks, expectedChunks)

		// Verify reassembled chunks
		reassembled := []byte{}
		for _, chunk := range pFile.Chunks {
			reassembled = append(reassembled, chunk...)
		}
		require.Equal(t, originalContent, reassembled)
	}
}

func TestGetProjectNameFromZipFilename(t *testing.T) {
	tests := []struct {
		filename string
		expected string
	}{
		{"my-site.zip", "my-site"},
		{"project.v1.zip", "project.v1"},
		{"archive", "archive"}, // No extension
		{"folder/file.zip", "folder/file"},
	}

	for _, tt := range tests {
		t.Run(tt.filename, func(t *testing.T) {
			result := keeper.GetProjectNameFromZipFilename(tt.filename)
			require.Equal(t, tt.expected, result)
		})
	}
}
