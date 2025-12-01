package cli

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/spf13/cobra"

	"gwc/x/gateway/types"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
)

const FlagOutput = "output"

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
		Short: "Download file resolving endpoints from GWC",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			filename := args[0]
			outputDir, _ := cmd.Flags().GetString(FlagOutput)

			clientCtx, err := client.GetClientQueryContext(cmd)
			if err != nil {
				return err
			}

			// --- 1. エンドポイント情報の取得 (Service Discovery) ---
			fmt.Println("🔍 Resolving storage nodes from GWC...")
			queryClient := types.NewQueryClient(clientCtx)

			// 全エンドポイントを取得
			res, err := queryClient.StorageEndpoints(context.Background(), &types.QueryStorageEndpointsRequest{})
			if err != nil {
				return fmt.Errorf("failed to query storage endpoints: %w", err)
			}

			// マップ化 (ChainID -> URL)
			endpointMap := make(map[string]string)
			for _, ep := range res.Endpoints {
				endpointMap[ep.ChainId] = ep.ApiEndpoint
			}

			// MDSCのURL特定
			mdscURL, ok := endpointMap["mdsc"]
			if !ok {
				return fmt.Errorf("MDSC endpoint not found in registry. Please register it via 'tx register-storage'")
			}
			fmt.Printf("   -> Found MDSC at %s\n", mdscURL)
			// FDSC-0のURLをデフォルトで取得（FDSC_IDはmanifestから取得するため、ここでは不要だが、ルーティングテストのために必要）
			// FDSCのURLは動的に取得されるため、fdscURLの定義は不要

			// --- 2. マニフェスト取得 ---
			manifestUrl := fmt.Sprintf("%s/mdsc/metastore/v1/manifest/%s", mdscURL, filename)
			fmt.Printf("🔍 Fetching manifest from %s...\n", manifestUrl)

			// ... (HTTP GETとデコード処理は省略) ...
			resp, err := http.Get(manifestUrl)
			if err != nil {
				return fmt.Errorf("failed to fetch manifest: %w", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != 200 {
				bodyBytes, _ := io.ReadAll(resp.Body)
				return fmt.Errorf("manifest not found (status: %d, body: %s)", resp.StatusCode, string(bodyBytes))
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

			// --- 3. FDSCから断片を並列ダウンロード ---
			chunks := make([][]byte, totalFragments)
			var wg sync.WaitGroup
			errChan := make(chan error, totalFragments)

			for i, frag := range fileInfo.Fragments {
				wg.Add(1)
				go func(idx int, fragID, fdscID string) {
					defer wg.Done()

					// FDSCのURL解決
					fdscURL, ok := endpointMap[fdscID]
					if !ok {
						errChan <- fmt.Errorf("endpoint for %s not found in registry", fdscID)
						return
					}

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
				}(i, frag.FragmentId, frag.FdscId)
			}
			// ... (wait/error check/combine/save処理は省略) ...
			wg.Wait()
			close(errChan)

			if len(errChan) > 0 {
				return <-errChan
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

	// 修正: 不要なフラグを削除。Outputフラグのみ残す
	cmd.Flags().String(FlagOutput, ".", "Output directory")
	flags.AddQueryFlagsToCmd(cmd)

	return cmd
}
