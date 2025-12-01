package cli

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/spf13/cobra"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	// "gwc/x/gateway/types" // typesが未使用なら削除、必要なら残す
)

// ダウンロード用のフラグ
const (
	FlagMdscNode = "mdsc-node"
	FlagFdscNode = "fdsc-node" // 簡易的に1つ、またはカンマ区切り
	FlagOutput   = "output"
)

// 外部チェーンのレスポンス用構造体 (簡易定義)
type ManifestResponse struct {
	Manifest struct {
		Files map[string]struct {
			MimeType  string `json:"mime_type"`
			Fragments []struct {
				FdscId     string `json:"fdsc_id"`
				FragmentId string `json:"fragment_id"`
			} `json:"fragments"`
		} `json:"files"`
	} `json:"manifest"`
}

type FragmentResponse struct {
	Fragment struct {
		Data string `json:"data"` // Base64
	} `json:"fragment"`
}

func CmdDownload() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "download [filename]",
		Short: "Download and restore a file via GWC Gateway logic",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			filename := args[0]

			// 修正: clientCtx を _ に変更（未使用エラー回避）
			_, err := client.GetClientQueryContext(cmd)
			if err != nil {
				return err
			}

			// 1. 設定の取得
			mdscURL, _ := cmd.Flags().GetString(FlagMdscNode)
			fdscURL, _ := cmd.Flags().GetString(FlagFdscNode)
			outputDir, _ := cmd.Flags().GetString(FlagOutput)

			if mdscURL == "" || fdscURL == "" {
				return fmt.Errorf("mdsc-node and fdsc-node flags are required")
			}

			fmt.Printf("⬇️  Starting download for '%s'...\n", filename)

			// 2. MDSCからマニフェストを取得 (HTTP Query)
			// URL: /mdsc/metastore/v1/manifest/{project_name}
			// ここでは ProjectName = Filename と仮定
			manifestUrl := fmt.Sprintf("%s/mdsc/metastore/v1/manifest/%s", mdscURL, filename)
			fmt.Printf("🔍 Fetching manifest from %s...\n", manifestUrl)

			resp, err := http.Get(manifestUrl)
			if err != nil {
				return fmt.Errorf("failed to fetch manifest: %w", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != 200 {
				return fmt.Errorf("manifest not found (status: %d)", resp.StatusCode)
			}

			var mResp ManifestResponse
			if err := json.NewDecoder(resp.Body).Decode(&mResp); err != nil {
				return fmt.Errorf("failed to decode manifest: %w", err)
			}

			fileInfo, ok := mResp.Manifest.Files[filename]
			if !ok {
				return fmt.Errorf("file info not found in manifest")
			}

			totalFragments := len(fileInfo.Fragments)
			fmt.Printf("📦 Found %d fragments. Downloading...\n", totalFragments)

			// 3. FDSCから断片を並列ダウンロード
			// 簡易化: すべて指定された fdscURL から取得する (本来はIDでルーティング)
			chunks := make([][]byte, totalFragments)
			var wg sync.WaitGroup
			errChan := make(chan error, totalFragments)

			for i, frag := range fileInfo.Fragments {
				wg.Add(1)
				go func(idx int, fragID string) {
					defer wg.Done()

					// URL: /fdsc/datastore/v1/fragment/{fragment_id}
					fragUrl := fmt.Sprintf("%s/fdsc/datastore/v1/fragment/%s", fdscURL, fragID)

					fResp, err := http.Get(fragUrl)
					if err != nil {
						errChan <- fmt.Errorf("failed to fetch fragment %s: %w", fragID, err)
						return
					}
					defer fResp.Body.Close()

					var fr FragmentResponse
					if err := json.NewDecoder(fResp.Body).Decode(&fr); err != nil {
						errChan <- fmt.Errorf("failed to decode fragment %s: %w", fragID, err)
						return
					}

					data, err := base64.StdEncoding.DecodeString(fr.Fragment.Data)
					if err != nil {
						errChan <- fmt.Errorf("failed to base64 decode fragment %s: %w", fragID, err)
						return
					}

					chunks[idx] = data
					fmt.Printf("   ✅ Fetched fragment %d/%d\n", idx+1, totalFragments)
				}(i, frag.FragmentId)
			}

			wg.Wait()
			close(errChan)

			// エラーチェック
			if len(errChan) > 0 {
				return <-errChan // 最初のエラーを返す
			}

			// 4. 結合と保存
			outputPath := filename
			if outputDir != "" {
				outputPath = filepath.Join(outputDir, filename)
			}

			outFile, err := os.Create(outputPath)
			if err != nil {
				return fmt.Errorf("failed to create output file: %w", err)
			}
			defer outFile.Close()

			for _, chunk := range chunks {
				if _, err := outFile.Write(chunk); err != nil {
					return err
				}
			}

			fmt.Printf("🎉 Successfully restored to '%s'\n", outputPath)
			return nil
		},
	}

	cmd.Flags().String(FlagMdscNode, "", "URL of MDSC API node (e.g. http://localhost:30068)")
	cmd.Flags().String(FlagFdscNode, "", "URL of FDSC API node (e.g. http://localhost:30067)")
	cmd.Flags().String(FlagOutput, ".", "Output directory")
	flags.AddQueryFlagsToCmd(cmd)

	return cmd
}
