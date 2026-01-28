package server

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"gwc/x/gateway/client/executor"
	"gwc/x/gateway/keeper"
	"gwc/x/gateway/types"
	"net/http"
	"os"
	"strings"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/tus/tusd/v2/pkg/filestore"
	tusd "github.com/tus/tusd/v2/pkg/handler"
)

// NewTusHandler はTUSプロトコルのための http.Handler を作成します
func NewTusHandler(clientCtx client.Context, k keeper.Keeper, uploadDir string, basePath string) (http.Handler, error) {
	// アップロードディレクトリの作成
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create upload directory: %w", err)
	}

	store := filestore.New(uploadDir)

	composer := tusd.NewStoreComposer()
	composer.UseCore(store)
	composer.UseTerminater(store)

	config := tusd.Config{
		BasePath:              basePath,
		StoreComposer:         composer,
		NotifyCompleteUploads: true,
		NotifyUploadProgress:  true, // 進捗通知を有効化
		NotifyCreatedUploads:  true, // アップロードリソース作成時の通知を有効化
	}

	handler, err := tusd.NewHandler(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create tus handler: %w", err)
	}

	// イベントフック: アップロードのライフサイクルイベントをキャッチしてログ出力します
	go func() {
		for {
			select {
			// アップロードリソースが新しく作成された時（アップロード開始前）
			case event := <-handler.CreatedUploads:
				fmt.Printf("[TUS] 📤 アップロード作成 ID: %s (予定サイズ: %d bytes)\n", event.Upload.ID, event.Upload.Size)

			// データが転送され、サーバー側でオフセットが更新された時
			case event := <-handler.UploadProgress:
				var percentage float64
				if event.Upload.Size > 0 {
					percentage = float64(event.Upload.Offset) / float64(event.Upload.Size) * 100
				}
				// ID, 進捗率, 現在の受信バイト数/合計サイズを表示
				fmt.Printf("[TUS] 🚀 進捗中 ID: %s -> %.2f%% (%d/%d bytes)\n",
					event.Upload.ID, percentage, event.Upload.Offset, event.Upload.Size)

			// 全てのデータ受信が正常に完了した時
			case event := <-handler.CompleteUploads:
				fmt.Printf("[TUS] ✅ 受信完了 ID: %s (最終サイズ: %d bytes)\n", event.Upload.ID, event.Upload.Size)

				// Executor ロジックの実行
				err := processCompletedUpload(clientCtx, k, event.Upload)
				if err != nil {
					fmt.Printf("Error processing upload %s: %v\n", event.Upload.ID, err)
				}
			}
		}
	}()

	// 認証ミドルウェアを含んだハンドラーを返却します
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// POSTメソッド（アップロード作成）時のみトークンを検証します
		if r.Method == http.MethodPost {
			// 1. Authorization ヘッダーからトークンを取得
			authHeader := r.Header.Get("Authorization")
			token := strings.TrimPrefix(authHeader, "Bearer ")
			if token == "" {
				http.Error(w, "Missing Authorization header", http.StatusUnauthorized)
				return
			}

			// 2. Upload-Metadata ヘッダーから session_id を取得
			metadata := parseTusMetadata(r.Header.Get("Upload-Metadata"))
			sessionID := metadata["session_id"]
			if sessionID == "" {
				http.Error(w, "Missing session_id in Upload-Metadata", http.StatusBadRequest)
				return
			}

			// 3. オンチェーンの状態をクエリしてトークンハッシュを検証
			queryClient := types.NewQueryClient(clientCtx)
			res, err := queryClient.SessionUploadTokenHash(r.Context(), &types.QuerySessionUploadTokenHashRequest{
				SessionId: sessionID,
			})
			if err != nil {
				http.Error(w, fmt.Sprintf("Failed to query session: %v", err), http.StatusInternalServerError)
				return
			}

			// クライアントから送られたトークンのハッシュ値を計算
			providedTokenHash := sha256.Sum256([]byte(token))
			storedTokenHash, _ := hex.DecodeString(res.TokenHashHex)

			if len(storedTokenHash) != 32 || !compareHashes(providedTokenHash[:], storedTokenHash) {
				http.Error(w, "Invalid upload token", http.StatusUnauthorized)
				return
			}
		}

		handler.ServeHTTP(w, r)
	}), nil
}

// parseTusMetadata はTUSプロトコルのメタデータヘッダーを解析します
func parseTusMetadata(metadataHeader string) map[string]string {
	metadata := make(map[string]string)
	if metadataHeader == "" {
		return metadata
	}

	parts := strings.Split(metadataHeader, ",")
	for _, part := range parts {
		kv := strings.Split(strings.TrimSpace(part), " ")
		if len(kv) != 2 {
			continue
		}
		key := kv[0]
		valBytes, err := base64.StdEncoding.DecodeString(kv[1])
		if err != nil {
			continue
		}
		metadata[key] = string(valBytes)
	}
	return metadata
}

// compareHashes は2つのハッシュ値が一致するかを一定時間で比較します
func compareHashes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var res byte
	for i := 0; i < len(a); i++ {
		res |= a[i] ^ b[i]
	}
	return res == 0
}

// processCompletedUpload はTUSとCosmos SDK Txの橋渡しを行います
func processCompletedUpload(clientCtx client.Context, k keeper.Keeper, upload tusd.FileInfo) error {
	meta := upload.MetaData
	sessionID := meta["session_id"]
	projectName := meta["project_name"]
	version := meta["version"]

	if sessionID == "" {
		return fmt.Errorf("missing session_id in upload metadata")
	}
	if projectName == "" {
		projectName = "default-project"
	}
	if version == "" {
		version = "v1"
	}

	filePath := upload.Storage["Path"]
	if filePath == "" {
		return fmt.Errorf("unable to resolve file path for upload %s", upload.ID)
	}

	fmt.Printf("Starting execution for session %s (Project: %s, Version: %s), file %s\n", sessionID, projectName, version, filePath)

	return executor.ExecuteSessionUpload(clientCtx, sessionID, filePath, projectName, version)
}
