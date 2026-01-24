package keeper

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"gwc/x/gateway/types"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/gorilla/mux"
)

// GatewayConfig はGateway HTTPハンドラーの設定を保持します
type GatewayConfig struct {
	MDSCEndpoint  string
	FDSCEndpoints map[string]string
}

// RegisterCustomHTTPRoutes はGateway ChainのカスタムHTTPルートを登録します
func RegisterCustomHTTPRoutes(clientCtx client.Context, r *mux.Router, k Keeper, config GatewayConfig) {
	// 修正: パス変数 {project}, {version}, {path:.*} を使用した動的ルーティング
	r.HandleFunc("/render/{project}/{version}/{path:.*}", func(w http.ResponseWriter, req *http.Request) {
		handleRender(clientCtx, k, w, req, config)
	}).Methods("GET")
}

func handleRender(clientCtx client.Context, k Keeper, w http.ResponseWriter, req *http.Request, config GatewayConfig) {
	// 1. パス変数の解析
	vars := mux.Vars(req)
	projectName := vars["project"]
	version := vars["version"]
	filePath := vars["path"]

	if projectName == "" || version == "" {
		http.Error(w, "project and version are required in URL path", http.StatusBadRequest)
		return
	}
	if filePath == "" {
		filePath = "index.html" // パスが空の場合はデフォルトで index.html
	}

	// 0. ステートからの動的なストレージトポロジー取得
	queryClient := types.NewQueryClient(clientCtx)
	res, err := queryClient.StorageEndpoints(req.Context(), &types.QueryStorageEndpointsRequest{})
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to query storage topology: %v", err), http.StatusServiceUnavailable)
		return
	}

	dynamicFDSC := make(map[string]string)
	for _, info := range res.StorageInfos {
		if info.ApiEndpoint == "" {
			continue
		}
		// エンドポイントの正規化 (末尾スラッシュ削除)
		endpoint := strings.TrimSuffix(info.ApiEndpoint, "/")

		if info.ChainId == "mdsc" {
			config.MDSCEndpoint = endpoint
		} else {
			if info.ChannelId != "" {
				dynamicFDSC[info.ChannelId] = endpoint
			}
			if info.ChainId != "" {
				dynamicFDSC[info.ChainId] = endpoint
			}
		}
	}
	config.FDSCEndpoints = dynamicFDSC

	if config.MDSCEndpoint == "" {
		http.Error(w, "MDSC endpoint is not registered in chain state", http.StatusServiceUnavailable)
		return
	}

	// 2. MDSCからマニフェストを解決 (バージョン対応)
	manifestURL := fmt.Sprintf("%s/mdsc/metastore/v1/manifest/%s?version=%s",
		config.MDSCEndpoint,
		url.PathEscape(projectName),
		url.QueryEscape(version),
	)

	httpClient := &http.Client{Timeout: 15 * time.Second}
	resp, err := httpClient.Get(manifestURL)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to connect to MDSC: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		http.Error(w, fmt.Sprintf("Manifest not found for %s@%s", projectName, version), resp.StatusCode)
		return
	}

	var manifestResp struct {
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

	if err := json.NewDecoder(resp.Body).Decode(&manifestResp); err != nil {
		http.Error(w, "Failed to decode manifest", http.StatusInternalServerError)
		return
	}

	fileInfo, ok := manifestResp.Manifest.Files[filePath]
	if !ok {
		http.Error(w, fmt.Sprintf("File '%s' not found in manifest", filePath), http.StatusNotFound)
		return
	}

	// 3. FDSCから断片を並列取得
	const maxParallel = 16
	const maxRetries = 2

	var wg sync.WaitGroup
	sem := make(chan struct{}, maxParallel)
	fragmentData := make([][]byte, len(fileInfo.Fragments))
	errs := make([]error, len(fileInfo.Fragments))

	for i, frag := range fileInfo.Fragments {
		wg.Add(1)
		go func(i int, fdscID, fragID string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			endpoint, ok := config.FDSCEndpoints[fdscID]
			if !ok {
				errs[i] = fmt.Errorf("endpoint not found for fdsc_id: %s", fdscID)
				return
			}

			// パスセーフにFragmentIDを埋め込み
			fragURL := fmt.Sprintf("%s/fdsc/datastore/v1/fragment/%s", endpoint, url.PathEscape(fragID))
			data, err := fetchFragmentWithRetry(req.Context(), httpClient, fragURL, maxRetries)
			if err != nil {
				errs[i] = err
				return
			}
			fragmentData[i] = data
		}(i, frag.FdscId, frag.FragmentId)
	}

	wg.Wait()

	for _, e := range errs {
		if e != nil {
			http.Error(w, fmt.Sprintf("Failed to fetch fragments: %v", e), http.StatusBadGateway)
			return
		}
	}

	// 4. 断片を結合してレスポンスを返却
	w.Header().Set("Content-Type", fileInfo.MimeType)
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	for _, data := range fragmentData {
		w.Write(data)
	}
}

func fetchFragmentWithRetry(ctx context.Context, client *http.Client, url string, maxRetries int) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		data, err := fetchFragmentOnce(ctx, client, url)
		if err == nil {
			return data, nil
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(200*(attempt+1)) * time.Millisecond):
		}
	}
	return nil, lastErr
}

func fetchFragmentOnce(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("fdsc returned %d: %s", resp.StatusCode, string(body))
	}
	var fragResp struct {
		Fragment struct {
			Data string `json:"data"`
		} `json:"fragment"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&fragResp); err != nil {
		return nil, err
	}
	// FDSCはバイナリデータをBase64エンコードして返却するため、デコードが必要
	return base64.StdEncoding.DecodeString(fragResp.Fragment.Data)
}
