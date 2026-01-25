package types

import (
	"fmt"
)

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
