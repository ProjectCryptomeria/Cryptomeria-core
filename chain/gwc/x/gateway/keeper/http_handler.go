package keeper

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"

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

	// 2. Resolve Manifest from MDSC
	// For PoC, we assume MDSC is running on localhost:1318 or use a registered endpoint if available.
	// We try to find an endpoint for "mdsc".
	// ctx := sdk.Context{}.WithContext(req.Context()) // Note: This is a hollow context, might need a proper one if accessing store.
	// However, accessing Keeper.StorageEndpoints requires a valid SDK Context with StoreKey.
	// In a standard HTTP handler, we don't have a block context.
	// We can use the clientCtx to query, but Keeper methods need sdk.Context.
	// If we use the Keeper directly, we need a context with the store.
	// Since we are inside the App, we might be able to get a context, but usually queries are done via ABCI Query.
	// BUT, here we are inside the node process.
	// Actually, `k.StorageEndpoints.Get` reads from the KVStore.
	// We can't easily get a store-bound context here without `clientCtx.QueryABCI`.
	// So we should use `clientCtx` to query the state of GWC itself to find endpoints?
	// OR, since this is a "Web Server Mode" running ON the node, maybe we can access the store?
	// Accessing store requires `app.CommitMultiStore().CacheMultiStore()...` or similar.
	// It's safer to use `clientCtx` to query the local node's state via ABCI.

	// SIMPLIFICATION FOR POC:
	// Use configuration passed from AppOptions
	
	mdscEndpoint := config.MDSCEndpoint
	if mdscEndpoint == "" {
		mdscEndpoint = "http://localhost:1318" // Default fallback
	}
	
	// Fetch Manifest
	manifestURL := fmt.Sprintf("%s/mdsc/metastore/v1/manifest/%s", mdscEndpoint, projectName)
	resp, err := http.Get(manifestURL)
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
	// Use configuration
	fdscEndpoints := config.FDSCEndpoints
	if len(fdscEndpoints) == 0 {
		// Default fallback
		fdscEndpoints = map[string]string{
			"fdsc":   "http://localhost:1319",
			"fdsc-0": "http://localhost:1319",
			"fdsc-1": "http://localhost:1320",
		}
	}

	var wg sync.WaitGroup
	fragmentData := make([][]byte, len(fileInfo.Fragments))
	errors := make([]error, len(fileInfo.Fragments))

	for i, frag := range fileInfo.Fragments {
		wg.Add(1)
		go func(i int, fdscID, fragID string) {
			defer wg.Done()
			endpoint, ok := fdscEndpoints[fdscID]
			if !ok {
				// Fallback or error
				endpoint = "http://localhost:1319"
			}

			fragURL := fmt.Sprintf("%s/fdsc/datastore/v1/fragment/%s", endpoint, fragID)
			resp, err := http.Get(fragURL)
			if err != nil {
				errors[i] = err
				return
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusOK {
				errors[i] = fmt.Errorf("status %d", resp.StatusCode)
				return
			}

			var fragResp struct {
				Fragment struct {
					Value string `json:"value"` // Base64 encoded
				} `json:"fragment"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&fragResp); err != nil {
				errors[i] = err
				return
			}

			decoded, err := base64.StdEncoding.DecodeString(fragResp.Fragment.Value)
			if err != nil {
				errors[i] = err
				return
			}
			fragmentData[i] = decoded
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
