package cmd

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/types/tx/signing" // 追加: SignModeの定義に必要
)

// NewUtilCmd はユーティリティ関連の親コマンド "util" を生成します。
func NewUtilCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "util",
		Short: "Off-chain utility commands for integrity verification",
	}

	// サブコマンド（create-sign）の登録
	cmd.AddCommand(
		NewCreateSignCmd(),
	)

	return cmd
}

// NewCreateSignCmd は、指定したKeyringの鍵でHexデータを署名しBase64を返します。
// 旧: sign-data -> 新: create-sign
func NewCreateSignCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "create-sign [key_name] [hex_data]",
		Short: "Sign hex data with a local key and output as base64",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			// clientCtxを取得（v0.50以降は戻り値が1つ）
			clientCtx := client.GetClientContextFromCmd(cmd)

			keyName := args[0]
			dataHex := args[1]

			// Hex文字列をデコード
			bz, err := hex.DecodeString(dataHex)
			if err != nil {
				return fmt.Errorf("failed to decode hex data: %w", err)
			}

			// 戻り値は (署名バイト列, 公開鍵, エラー) の3つ
			sig, _, err := clientCtx.Keyring.Sign(keyName, bz, signing.SignMode_SIGN_MODE_DIRECT)
			if err != nil {
				return fmt.Errorf("failed to sign data: %w", err)
			}

			// 署名結果をBase64で標準出力に書き出し
			fmt.Println(base64.StdEncoding.EncodeToString(sig))
			return nil
		},
	}

	// --keyring-backend, --home 等のフラグを使えるようにする
	flags.AddKeyringFlags(cmd.Flags())
	return cmd
}
