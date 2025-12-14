package keeper_test

import (
	"archive/zip"
	"bytes"
	"path"
	"testing"

	"gwc/x/gateway/keeper"

	"github.com/stretchr/testify/require"
)

func createTestZip(t *testing.T, files map[string][]byte) []byte {
	buf := new(bytes.Buffer)
	w := zip.NewWriter(buf)

	for name, content := range files {
		f, err := w.Create(name)
		require.NoError(t, err)
		_, err = f.Write(content)
		require.NoError(t, err)
	}

	err := w.Close()
	require.NoError(t, err)
	return buf.Bytes()
}

func TestProcessZipData(t *testing.T) {
	chunkSize := 1024

	t.Run("Valid Zip extraction with path normalization", func(t *testing.T) {
		files := map[string][]byte{
			"index.html":           []byte("<html>index</html>"),
			"assets/css/style.css": []byte("body { color: red; }"),
			// Edge case: Windows style path or leading slash/dot
			`./images\logo.png`: []byte("png-data"),
		}

		zipData := createTestZip(t, files)

		processed, err := keeper.ProcessZipData(zipData, chunkSize)
		require.NoError(t, err)
		require.Len(t, processed, 3)

		// Create a map for easy verification
		processedMap := make(map[string]keeper.ProcessedFile)
		for _, pf := range processed {
			processedMap[pf.Path] = pf
		}

		// Verify index.html
		require.Contains(t, processedMap, "index.html")
		require.Equal(t, "<html>index</html>", string(processedMap["index.html"].Content))

		// Verify assets/css/style.css
		require.Contains(t, processedMap, "assets/css/style.css")
		require.Equal(t, "body { color: red; }", string(processedMap["assets/css/style.css"].Content))

		// Verify normalization of ./images\logo.png -> images/logo.png
		// Note: filepath.ToSlash handles backslashes
		// Note: The normalization logic should handle this.
		// If the logic in zip_logic.go is strictly implementing filepath.Clean/ToSlash,
		// `images/logo.png` should be the key.
		expectedPath := path.Join("images", "logo.png")
		require.Contains(t, processedMap, expectedPath)
		require.Equal(t, "png-data", string(processedMap[expectedPath].Content))
	})

	t.Run("Decompression limit exceeded", func(t *testing.T) {
		// Mock a huge file by repeating data
		hugeData := make([]byte, keeper.DecompressionLimit+100)
		files := map[string][]byte{
			"huge.txt": hugeData,
		}
		// Note: In a real zip bomb, the zip size is small but decompressed is large.
		// Here we just test the logic check with uncompressed store (default for simple writer often)
		// or just check if ProcessZipData sums up sizes correctly.

		// For strictly testing "limit", we can pass a smaller chunk to be compressed,
		// but standard library zip writer usually compresses.
		zipData := createTestZip(t, files)

		_, err := keeper.ProcessZipData(zipData, chunkSize)
		require.Error(t, err)
		require.Contains(t, err.Error(), "decompression limit exceeded")
	})

	t.Run("Unsafe path traversal", func(t *testing.T) {
		files := map[string][]byte{
			"../secret.txt": []byte("secret"),
		}
		zipData := createTestZip(t, files)

		_, err := keeper.ProcessZipData(zipData, chunkSize)
		require.Error(t, err)
		require.Contains(t, err.Error(), "unsafe file path")
	})
}
