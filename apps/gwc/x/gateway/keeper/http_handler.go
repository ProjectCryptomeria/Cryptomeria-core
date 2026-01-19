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

	// --- 0. Dynamic Configuration Loading (Fix) ---
	// ストアに保存されたエンドポイント情報を動的に取得してConfigを上書きする
	queryClient := types.NewQueryClient(clientCtx)
	res, err := queryClient.StorageEndpoints(req.Context(), &types.QueryStorageEndpointsRequest{})

	// ローカルの上書き用マップを作成 (元のマップを汚染しないため)
	dynamicFDSC := make(map[string]string)
	// 初期値としてConfigの値をコピー
	for k, v := range config.FDSCEndpoints {
		dynamicFDSC[k] = v
	}

	if err == nil {
		// 修正: Endpoints -> StorageInfos
		for _, info := range res.StorageInfos {
			if info.ConnectionType == "mdsc" || info.ChainId == "mdsc" {
				config.MDSCEndpoint = info.ApiEndpoint
			} else {
				// FDSCの場合、ChannelID (Upload時の識別子) をキーとして登録
				if info.ChannelId != "" {
					dynamicFDSC[info.ChannelId] = info.ApiEndpoint
				}
				// 念のためChainIDでも登録
				if info.ChainId != "" {
					dynamicFDSC[info.ChainId] = info.ApiEndpoint
				}
			}
		}
	} else {
		fmt.Printf("Warning: Failed to query dynamic storage endpoints: %v\n", err)
	}
	// Configの参照先を新しいマップに切り替え
	config.FDSCEndpoints = dynamicFDSC

	// 2. Resolve Manifest from MDSC
	mdscEndpoint := config.MDSCEndpoint
	if mdscEndpoint == "" {
		mdscEndpoint = "http://localhost:1318" // Default fallback
	}

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
	if len(fdscEndpoints) == 0 {
		// Default fallback
		fdscEndpoints = map[string]string{
			"fdsc":   "http://localhost:1319",
			"fdsc-0": "http://localhost:1319",
			"fdsc-1": "http://localhost:1320",
		}
	}

	// Concurrency & retry controls for stability during experiments
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

// fetchFragmentWithRetry fetches a single fragment JSON from FDSC and returns the decoded bytes.
// It uses limited retries to reduce transient failure impact during experiments.
func fetchFragmentWithRetry(ctx context.Context, client *http.Client, url string, maxRetries int) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		data, err := fetchFragmentOnce(ctx, client, url)
		if err == nil {
			return data, nil
		}
		lastErr = err
		// simple backoff
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

	// FDSC QueryGetFragmentResponse JSON is: {"fragment": {"fragment_id":"...", "data":"<base64>", ...}}
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
