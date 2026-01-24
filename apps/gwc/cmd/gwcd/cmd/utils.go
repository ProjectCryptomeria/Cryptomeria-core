package cmd

import (
	"archive/zip"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"strconv"

	"github.com/spf13/cobra"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/types/tx/signing" // 追加: SignModeの定義に必要

	"gwc/x/gateway/keeper" // マークルツリー計算ロジックを直接利用
)

// NewUtilCmd はユーティリティ関連の親コマンド "util" を生成します。
func NewUtilCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "util",
		Short: "Off-chain utility commands for integrity verification",
	}

	// サブコマンド（create-sign, verify-data）の登録
	cmd.AddCommand(
		NewCreateSignCmd(),
		NewVerifyDataCmd(),
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

			// SiteRootなどのHex文字列をデコード
			bz, err := hex.DecodeString(dataHex)
			if err != nil {
				return fmt.Errorf("failed to decode hex data: %w", err)
			}

			// ✅ 修正箇所: 第3引数に signing.SignMode_SIGN_MODE_DIRECT を追加
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

// NewVerifyDataCmd は、Zipファイルからオンチェーンと同じロジックでSiteRootを計算します。
// 旧: compute-root -> 新: verify-data
func NewVerifyDataCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "verify-data [zip_path] [chunk_size]",
		Short: "Compute SiteRoot from a zip file using on-chain logic",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			zipPath := args[0]
			chunkSize, err := strconv.Atoi(args[1])
			if err != nil {
				return fmt.Errorf("invalid chunk size: %w", err)
			}

			// 1. ローカルのZipファイルを読み込む
			r, err := zip.OpenReader(zipPath)
			if err != nil {
				return fmt.Errorf("failed to open zip: %w", err)
			}
			defer r.Close()

			var processedFiles []keeper.ProcessedFile

			// 2. Zip内の各ファイルをチャンク分割し、ProcessedFile構造体に格納
			for _, f := range r.File {
				if f.FileInfo().IsDir() {
					continue
				}

				rc, err := f.Open()
				if err != nil {
					return err
				}
				content, err := io.ReadAll(rc)
				rc.Close()
				if err != nil {
					return err
				}

				var chunks [][]byte
				for i := 0; i < len(content); i += chunkSize {
					end := i + chunkSize
					if end > len(content) {
						end = len(content)
					}
					chunks = append(chunks, content[i:end])
				}

				processedFiles = append(processedFiles, keeper.ProcessedFile{
					Path:    f.Name,
					Content: content,
					Chunks:  chunks,
				})
			}

			// 3. ゲートウェイモジュールのマークルツリー計算ロジック（merkle_logic.go）を直接実行
			siteRoot, _, err := keeper.CalculateSiteRoot(processedFiles)
			if err != nil {
				return fmt.Errorf("failed to calculate site root: %w", err)
			}

			// 計算されたSiteRoot(Hex)を出力
			fmt.Println(siteRoot)
			return nil
		},
	}
}
