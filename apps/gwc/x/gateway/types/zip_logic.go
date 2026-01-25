package types

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"path"
	"strings"
)

// DecompressionLimit は解凍後のデータの合計サイズ制限を定義します（例：100MB）
const DecompressionLimit = 100 * 1024 * 1024

// ProcessedFile は解凍・分割処理されたファイルの構造体です
type ProcessedFile struct {
	Filename string
	Path     string   // 正規化されたパス
	Content  []byte   // ファイルの全データ
	Chunks   [][]byte // 分割された断片データ
}

// ProcessZipAndSplit はZIPデータを展開し、正規化・検証を行った上で断片化します。
//
// NOTE:
// - CalculateSiteRoot は後方互換なし方針で廃止されました。
// - root_proof はクライアント側で計算し、オンチェーンでは VerifyFragment により検証されます。
func ProcessZipAndSplit(zipData []byte, chunkSize int) ([]ProcessedFile, error) {
	if chunkSize <= 0 {
		return nil, fmt.Errorf("chunk size must be greater than 0")
	}

	zipReader, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if err != nil {
		return nil, fmt.Errorf("failed to create zip reader: %w", err)
	}

	var processedFiles []ProcessedFile
	var totalDecompressedSize int64

	// ファイルパスでソートして決定論的な順序を保証するのが望ましいですが、
	// zipReader.Fileの順序に依存せず、後続のMerkle構築時にパス順でソートします。

	for _, file := range zipReader.File {
		if file.FileInfo().IsDir() {
			continue
		}

		// パスの正規化とセキュリティチェック（Zip Slip対策）
		normalizedPath := strings.ReplaceAll(file.Name, "\\", "/")
		cleanPath := path.Clean(normalizedPath)

		// 絶対パスや上位ディレクトリへの参照を禁止
		if path.IsAbs(cleanPath) || strings.HasPrefix(cleanPath, "../") {
			return nil, fmt.Errorf("zip contains unsafe file path: %s", file.Name)
		}

		// 先頭の "./" や "/" を除去して正規化
		cleanPath = strings.TrimPrefix(cleanPath, "/")
		cleanPath = strings.TrimPrefix(cleanPath, "./")

		// 解凍サイズ制限の事前チェック（圧縮ヘッダのみのチェックなので不完全だが目安）
		if totalDecompressedSize+file.FileInfo().Size() > DecompressionLimit {
			return nil, fmt.Errorf("decompression limit exceeded")
		}

		rc, err := file.Open()
		if err != nil {
			return nil, fmt.Errorf("failed to open file in zip: %w", err)
		}

		// 実際の読み込み時にサイズ制限を適用
		limitReader := io.LimitReader(rc, DecompressionLimit-totalDecompressedSize+1)
		content, err := io.ReadAll(limitReader)
		rc.Close()
		if err != nil {
			return nil, fmt.Errorf("failed to read file: %w", err)
		}

		currentSize := int64(len(content))
		totalDecompressedSize += currentSize
		if totalDecompressedSize > DecompressionLimit {
			return nil, fmt.Errorf("decompression limit exceeded")
		}

		// データを断片化
		chunks, err := SplitDataIntoFragments(content, chunkSize)
		if err != nil {
			return nil, fmt.Errorf("failed to split file: %w", err)
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

// SplitDataIntoFragments splits the provided byte slice into chunks of specific size.
// Returns an error if chunkSize is not positive.
func SplitDataIntoFragments(data []byte, chunkSize int) ([][]byte, error) {
	if chunkSize <= 0 {
		return nil, fmt.Errorf("chunk size must be positive, got %d", chunkSize)
	}

	dataLen := len(data)
	if dataLen == 0 {
		return [][]byte{}, nil
	}

	totalChunks := dataLen / chunkSize
	if dataLen%chunkSize != 0 {
		totalChunks++
	}

	chunks := make([][]byte, 0, totalChunks)

	for start := 0; start < dataLen; start += chunkSize {
		end := start + chunkSize
		if end > dataLen {
			end = dataLen
		}

		// Create a copy of the slice to ensure independence
		chunk := make([]byte, end-start)
		copy(chunk, data[start:end])
		chunks = append(chunks, chunk)
	}

	return chunks, nil
}

// GetProjectNameFromZipFilename はZIPファイル名からプロジェクト名（拡張子なし）を抽出します
func GetProjectNameFromZipFilename(filename string) string {
	base := path.Base(strings.ReplaceAll(filename, "\\", "/"))
	ext := path.Ext(base)
	return strings.TrimSuffix(base, ext)
}
