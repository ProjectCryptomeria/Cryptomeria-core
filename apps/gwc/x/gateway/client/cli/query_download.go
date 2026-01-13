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

const (
	FlagOutput  = "save-dir"
	FlagProject = "project"
)

// ManifestResponse はMDSCから返却されるマニフェストデータの構造体です
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

// FragmentResponse はFDSCから返却されるフラグメントデータの構造体です
type FragmentResponse struct {
	Fragment struct {
		Data string `json:"data"` // Base64 encoded data
	} `json:"fragment"`
}

// CmdDownload はGWCを経由してファイルをダウンロード・復元するCLIコマンドを定義します
func CmdDownload() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "download [filename]",
		Short: "Download file resolving endpoints from GWC",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			filename := args[0]
			outputDir, _ := cmd.Flags().GetString(FlagOutput)

			// ▼▼▼ 修正: プロジェクト名の取得と必須化 ▼▼▼
			// Webホスティングの仕様上、ファイルは必ず特定のプロジェクトに属するため、
			// プロジェクト名の指定を必須とします。
			projectName, _ := cmd.Flags().GetString(FlagProject)
			if projectName == "" {
				return fmt.Errorf("project name is required. please use --project flag")
			}
			// ▲▲▲ 修正ここまで ▲▲▲

			clientCtx, err := client.GetClientQueryContext(cmd)
			if err != nil {
				return err
			}

			// --- 1. エンドポイント情報の取得 ---
			fmt.Println("🔍 Resolving storage nodes from GWC...")
			queryClient := types.NewQueryClient(clientCtx)

			// GWCからストレージエンドポイント（MDSC/FDSCのURL）一覧を取得
			res, err := queryClient.StorageEndpoints(context.Background(), &types.QueryStorageEndpointsRequest{})
			if err != nil {
				return fmt.Errorf("failed to query storage endpoints: %w", err)
			}

			// エンドポイントをマップ化（ChainIDとChannelIDの両方で引けるようにする）
			endpointMap := make(map[string]string)
			for _, info := range res.StorageInfos {
				if info.ChainId != "" {
					endpointMap[info.ChainId] = info.ApiEndpoint
				}
				endpointMap[info.ChannelId] = info.ApiEndpoint
			}

			// MDSCのエンドポイントを特定
			var mdscURL string
			for _, info := range res.StorageInfos {
				if info.ConnectionType == "mdsc" {
					mdscURL = info.ApiEndpoint
					break
				}
			}
			if mdscURL == "" {
				// connection_typeで見つからない場合のフォールバック
				if url, ok := endpointMap["mdsc"]; ok {
					mdscURL = url
				}
			}
			if mdscURL == "" {
				return fmt.Errorf("MDSC endpoint not found")
			}
			fmt.Printf("   -> Found MDSC at %s\n", mdscURL)

			// --- 2. マニフェスト取得 ---
			// ▼▼▼ 修正: URL生成ロジックの変更 ▼▼▼
			// REST APIのパスパラメータには「プロジェクト名」のみを使用します。
			// スラッシュを含むファイルパスはURLパスに含めるとルーティングエラーになるためです。
			manifestUrl := fmt.Sprintf("%s/mdsc/metastore/v1/manifest/%s", mdscURL, projectName)
			// ▲▲▲ 修正ここまで ▲▲▲
			fmt.Printf("🔍 Fetching manifest from %s...\n", manifestUrl)

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

			// ▼▼▼ 修正: クライアントサイドでのファイル検索 ▼▼▼
			// 取得したプロジェクト全体のManifestから、指定されたファイル名に該当するエントリを探します。
			fileInfo, ok := mResp.Manifest.Files[filename]
			if !ok {
				return fmt.Errorf("file '%s' not found in project '%s'", filename, projectName)
			}
			// ▲▲▲ 修正ここまで ▲▲▲

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

					// FDSCのエンドポイント解決
					fdscURL, ok := endpointMap[fdscID]
					if !ok {
						errChan <- fmt.Errorf("endpoint for %s not found in registry", fdscID)
						return
					}

					fragUrl := fmt.Sprintf("%s/fdsc/datastore/v1/fragment/%s", fdscURL, fragID)

					// Fragmentデータの取得
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

					// Base64デコード
					data, err := base64.StdEncoding.DecodeString(fr.Fragment.Data)
					if err != nil {
						errChan <- fmt.Errorf("failed to base64 decode fragment %s: %w", fragID, err)
						return
					}

					chunks[idx] = data
					fmt.Printf("   ✅ Fetched fragment %d/%d\n", idx+1, totalFragments)
				}(i, frag.FragmentId, frag.FdscId)
			}

			wg.Wait()
			close(errChan)

			if len(errChan) > 0 {
				return <-errChan
			}

			// --- 4. 結合と保存 ---
			outputPath := filename
			// ディレクトリ構造がある場合（例: images/logo.png）、ローカルのディレクトリを作成する
			if dir := filepath.Dir(outputPath); dir != "." {
				if outputDir != "" {
					dir = filepath.Join(outputDir, dir)
				}
				if err := os.MkdirAll(dir, 0755); err != nil {
					return fmt.Errorf("failed to create directory %s: %w", dir, err)
				}
			}

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

	cmd.Flags().String(FlagOutput, ".", "Directory to save the downloaded file")
	cmd.Flags().String(FlagProject, "", "Project name containing the file (required)")
	flags.AddQueryFlagsToCmd(cmd)

	return cmd
}