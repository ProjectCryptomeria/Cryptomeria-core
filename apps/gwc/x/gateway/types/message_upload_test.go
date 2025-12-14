package types_test

import (
	"testing"

	"gwc/testutil/sample"
	"gwc/x/gateway/types"

	"github.com/stretchr/testify/require"
)

func TestMsgUpload_ValidateBasic(t *testing.T) {
	// Use sample package to generate a valid address with correct checksum
	validAddress := sample.AccAddress()

	tests := []struct {
		name        string
		msg         types.MsgUpload
		expectError bool
		errString   string
	}{
		{
			name: "Success: Valid Input",
			msg: types.MsgUpload{
				Creator:      validAddress,
				Filename:     "index.html",
				Data:         []byte("content"),
				ProjectName:  "my-project-1",
				Version:      "v1.0.0",
				FragmentSize: 1024,
			},
			expectError: false,
		},
		{
			name: "Success: Minimal Valid Input (Optional fields empty/zero)",
			msg: types.MsgUpload{
				Creator:      validAddress,
				Filename:     "index.html",
				Data:         []byte("content"),
				ProjectName:  "myproject",
				Version:      "", // Optional
				FragmentSize: 0,  // Optional (Use default)
			},
			expectError: false,
		},
		{
			name: "Error: Invalid Address",
			msg: types.MsgUpload{
				Creator:     "invalid_address",
				Filename:    "test.txt",
				Data:        []byte("data"),
				ProjectName: "proj",
			},
			expectError: true,
			errString:   "invalid creator address",
		},
		{
			name: "Error: Empty Filename",
			msg: types.MsgUpload{
				Creator:     validAddress,
				Filename:    "",
				Data:        []byte("data"),
				ProjectName: "proj",
			},
			expectError: true,
			errString:   "filename cannot be empty",
		},
		{
			name: "Error: Empty Data",
			msg: types.MsgUpload{
				Creator:     validAddress,
				Filename:    "test.txt",
				Data:        []byte{},
				ProjectName: "proj",
			},
			expectError: true,
			errString:   "data cannot be empty",
		},
		{
			name: "Error: Invalid Project Name (Empty)",
			msg: types.MsgUpload{
				Creator:     validAddress,
				Filename:    "test.txt",
				Data:        []byte("data"),
				ProjectName: "",
			},
			expectError: true,
			errString:   "project_name cannot be empty",
		},
		{
			name: "Error: Invalid Project Name (Special Chars)",
			msg: types.MsgUpload{
				Creator:     validAddress,
				Filename:    "test.txt",
				Data:        []byte("data"),
				ProjectName: "My Project!", // Space and ! not allowed
			},
			expectError: true,
			errString:   "project_name contains invalid characters",
		},
		{
			name: "Error: Fragment Size Too Small",
			msg: types.MsgUpload{
				Creator:      validAddress,
				Filename:     "test.txt",
				Data:         []byte("data"),
				ProjectName:  "proj",
				FragmentSize: 100, // < 1024
			},
			expectError: true,
			errString:   "fragment_size too small",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.msg.ValidateBasic()
			if tc.expectError {
				require.Error(t, err)
				if tc.errString != "" {
					require.Contains(t, err.Error(), tc.errString)
				}
			} else {
				require.NoError(t, err)
			}
		})
	}
}
