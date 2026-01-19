package keeper

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"gwc/x/gateway/types"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/gorilla/mux"
)

// GatewayConfig holds the configuration for the Gateway HTTP handler
type GatewayConfig struct {
	MDSCEndpoint  string
	FDSCEndpoints map[string]string
}

// RegisterCustomHTTPRoutes registers custom HTTP routes for the Gateway Chain
func RegisterCustomHTTPRoutes(clientCtx client.Context, r *mux.Router, k Keeper, config GatewayConfig) {
	r.HandleFunc("/render", func(w http.ResponseWriter, req *http.Request) {
		handleRender(clientCtx, k, w, req, config)
	}).Methods("GET")
}

func handleRender(clientCtx client.Context, k Keeper, w http.ResponseWriter, req *http.Request, config GatewayConfig) {
	// 1. Parse Query Params
	projectName := req.URL.Query().Get("project")
	filePath := req.URL.Query().Get("path")

	if projectName == "" {
		http.Error(w, "project query param is required", http.StatusBadRequest)
		return
	}
	if filePath == "" {
		filePath = "index.html" // Default to index.html
	}

	// --- 0. Dynamic Configuration Loading (Strict) ---
	// ストアに保存されたエンドポイント情報を動的に取得してConfigを上書きする
	// ※QueryClientを経由して最新のStateから取得
	queryClient := types.NewQueryClient(clientCtx)
	res, err := queryClient.StorageEndpoints(req.Context(), &types.QueryStorageEndpointsRequest{})

	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to query storage topology: %v", err), http.StatusServiceUnavailable)
		return
	}

	// Configをローカル変数で再構築
	dynamicFDSC := make(map[string]string)
	config.MDSCEndpoint = "" // リセット

	for _, info := range res.StorageInfos {
		if info.ApiEndpoint == "" {
			continue
		}
		if info.ConnectionType == "mdsc" || info.ChainId == "mdsc" {
			config.MDSCEndpoint = info.ApiEndpoint
		} else {
			// FDSCの場合、ChannelID, ChainID 両方で引けるようにしておく
			if info.ChannelId != "" {
				dynamicFDSC[info.ChannelId] = info.ApiEndpoint
			}
			if info.ChainId != "" {
				dynamicFDSC[info.ChainId] = info.ApiEndpoint
			}
		}
	}
	config.FDSCEndpoints = dynamicFDSC

	// エンドポイント存在チェック (Fallbackなし)
	if config.MDSCEndpoint == "" {
		http.Error(w, "MDSC endpoint is not registered in chain state. Please register storage info via transaction.", http.StatusServiceUnavailable)
		return
	}
	if len(config.FDSCEndpoints) == 0 {
		http.Error(w, "No FDSC endpoints registered in chain state.", http.StatusServiceUnavailable)
		return
	}

	// 2. Resolve Manifest from MDSC
	mdscEndpoint := config.MDSCEndpoint

	// Fetch Manifest
	manifestURL := fmt.Sprintf("%s/mdsc/metastore/v1/manifest/%s", mdscEndpoint, projectName)
	httpClient := &http.Client{Timeout: 15 * time.Second}

	resp, err := httpClient.Get(manifestURL)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to connect to MDSC: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		http.Error(w, fmt.Sprintf("MDSC returned error: %s", string(body)), resp.StatusCode)
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
		http.Error(w, "File not found in manifest", http.StatusNotFound)
		return
	}

	// 3. Fetch Fragments from FDSCs
	fdscEndpoints := config.FDSCEndpoints

	// Concurrency & retry controls
	const maxParallel = 16
	const maxRetries = 2

	var wg sync.WaitGroup
	sem := make(chan struct{}, maxParallel)
	fragmentData := make([][]byte, len(fileInfo.Fragments))
	errors := make([]error, len(fileInfo.Fragments))

	for i, frag := range fileInfo.Fragments {
		wg.Add(1)
		go func(i int, fdscID, fragID string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			endpoint, ok := fdscEndpoints[fdscID]
			if !ok {
				errors[i] = fmt.Errorf("endpoint not found for fdsc_id: %s", fdscID)
				return
			}

			fragURL := fmt.Sprintf("%s/fdsc/datastore/v1/fragment/%s", endpoint, fragID)

			data, err := fetchFragmentWithRetry(req.Context(), httpClient, fragURL, maxRetries)
			if err != nil {
				errors[i] = err
				return
			}
			fragmentData[i] = data
		}(i, frag.FdscId, frag.FragmentId)
	}

	wg.Wait()

	for i, err := range errors {
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to fetch fragment %d: %v", i, err), http.StatusBadGateway)
			return
		}
	}

	// 4. Combine and Return
	w.Header().Set("Content-Type", fileInfo.MimeType)
	for _, data := range fragmentData {
		w.Write(data)
	}
}

// fetchFragmentWithRetry, fetchFragmentOnce は変更なし (省略)
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
		return nil, fmt.Errorf("fdsc returned status %d: %s", resp.StatusCode, string(body))
	}
	var fragResp struct {
		Fragment struct {
			Data string `json:"data"`
		} `json:"fragment"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&fragResp); err != nil {
		return nil, err
	}
	decoded, err := base64.StdEncoding.DecodeString(fragResp.Fragment.Data)
	if err != nil {
		return nil, err
	}
	return decoded, nil
}
