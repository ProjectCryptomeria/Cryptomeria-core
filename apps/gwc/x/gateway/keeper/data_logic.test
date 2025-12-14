package keeper_test

import (
	"bytes"
	"testing"

	"gwc/x/gateway/keeper"

	"github.com/stretchr/testify/require"
)

func TestSplitDataIntoFragments(t *testing.T) {
	tests := []struct {
		name          string
		dataSize      int
		chunkSize     int
		expectedCount int
		expectError   bool
	}{
		{
			name:          "Exact multiple",
			dataSize:      100,
			chunkSize:     10,
			expectedCount: 10,
			expectError:   false,
		},
		{
			name:          "Remainder exists",
			dataSize:      105,
			chunkSize:     10,
			expectedCount: 11,
			expectError:   false,
		},
		{
			name:          "Smaller than chunk",
			dataSize:      5,
			chunkSize:     10,
			expectedCount: 1,
			expectError:   false,
		},
		{
			name:          "Empty data",
			dataSize:      0,
			chunkSize:     10,
			expectedCount: 0,
			expectError:   false,
		},
		{
			name:          "Invalid chunk size",
			dataSize:      100,
			chunkSize:     0,
			expectedCount: 0,
			expectError:   true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// Generate dummy data
			data := make([]byte, tc.dataSize)
			for i := 0; i < tc.dataSize; i++ {
				data[i] = byte(i % 255)
			}

			chunks, err := keeper.SplitDataIntoFragments(data, tc.chunkSize)

			if tc.expectError {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.expectedCount, len(chunks))

			// Reconstruct and verify
			var reconstructed []byte
			for _, chunk := range chunks {
				if tc.dataSize > 0 {
					// Check chunk size constraint (except possibly the last one)
					if len(reconstructed)+len(chunk) < tc.dataSize {
						require.Equal(t, tc.chunkSize, len(chunk), "Middle chunks must be full size")
					}
				}
				reconstructed = append(reconstructed, chunk...)
			}

			if tc.dataSize > 0 {
				require.True(t, bytes.Equal(data, reconstructed), "Reconstructed data must match original")
			}
		})
	}
}