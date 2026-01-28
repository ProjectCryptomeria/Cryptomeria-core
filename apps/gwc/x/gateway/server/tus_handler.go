package server

import (
	"fmt"
	"net/http"
	"os"
	"strings"

	"gwc/x/gateway/client/executor"
	"gwc/x/gateway/keeper"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/tus/tusd/v2/pkg/filestore"
	tusd "github.com/tus/tusd/v2/pkg/handler"
)

func NewTusHandler(clientCtx client.Context, k keeper.Keeper, uploadDir, tusBasePath string) (http.Handler, error) {
	if uploadDir == "" {
		uploadDir = "./tmp/uploads"
	}
	if tusBasePath == "" {
		tusBasePath = "/upload/tus-stream/"
	}
	if !strings.HasPrefix(tusBasePath, "/") {
		tusBasePath = "/" + tusBasePath
	}
	if !strings.HasSuffix(tusBasePath, "/") {
		tusBasePath = tusBasePath + "/"
	}

	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		return nil, err
	}

	store := filestore.New(uploadDir)
	composer := tusd.NewStoreComposer()
	store.UseIn(composer)

	// 旧版同等：イベント通知を全部ON
	h, err := tusd.NewHandler(tusd.Config{
		BasePath:              tusBasePath,
		StoreComposer:         composer,
		NotifyCreatedUploads:  true,
		NotifyUploadProgress:  true,
		NotifyCompleteUploads: true,
	})
	if err != nil {
		return nil, err
	}

	// ✅ 旧バージョンのイベント購読を復活
	go func() {
		for {
			select {
			// アップロードリソースが新しく作成された時（アップロード開始前）
			case event := <-h.CreatedUploads:
				fmt.Printf("[TUS] 📤 アップロード作成 ID: %s (予定サイズ: %d bytes)\n", event.Upload.ID, event.Upload.Size)

			// データが転送され、サーバー側でオフセットが更新された時
			case event := <-h.UploadProgress:
				var percentage float64
				if event.Upload.Size > 0 {
					percentage = float64(event.Upload.Offset) / float64(event.Upload.Size) * 100
				}
				// ID, 進捗率, 現在の受信バイト数/合計サイズを表示
				fmt.Printf("[TUS] 🚀 進捗中 ID: %s -> %.2f%% (%d/%d bytes)\n",
					event.Upload.ID, percentage, event.Upload.Offset, event.Upload.Size)

			// 全てのデータ受信が正常に完了した時
			case event := <-h.CompleteUploads:
				fmt.Printf("[TUS] ✅ 受信完了 ID: %s (最終サイズ: %d bytes)\n", event.Upload.ID, event.Upload.Size)

				// Executor ロジックの実行（旧版踏襲）
				if err := processCompletedUpload(clientCtx, k, event.Upload); err != nil {
					fmt.Printf("Error processing upload %s: %v\n", event.Upload.ID, err)
				}
			}
		}
	}()

	return h, nil
}

func TusMiddleware(tusMount http.Handler) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if strings.HasPrefix(req.URL.Path, "/upload/tus-stream") {

				// 詳細デバッグログ
				fmt.Printf("\n🎯 [TUS DEBUG] Method: %s | Path: %s\n", req.Method, req.URL.Path)

				// ブラウザおよびスクリプト向けのCORSヘッダー強制付与
				w.Header().Set("Access-Control-Allow-Origin", "*")
				w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE, PATCH, HEAD")
				w.Header().Set("Access-Control-Allow-Headers", "*")
				w.Header().Set("Access-Control-Expose-Headers", "Location, Tus-Resumable, Upload-Offset, Upload-Length")

				if req.Method == http.MethodOptions {
					w.WriteHeader(http.StatusNoContent)
					return
				}

				// 末尾スラッシュ補正は残してもOK
				if req.URL.Path == "/upload/tus-stream" {
					req.URL.Path = "/upload/tus-stream/"
				}

				tusMount.ServeHTTP(w, req)
				return
			}

			next.ServeHTTP(w, req)
		})
	}
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

	// ✅ あなたの現行 HookEvent JSON で Storage.Path が来ているため、ここを現行型に合わせる
	filePath := upload.Storage["Path"]
	if filePath == "" {
		return fmt.Errorf("unable to resolve file path for upload %s", upload.ID)
	}

	fmt.Printf("Starting execution for session %s (Project: %s, Version: %s), file %s\n",
		sessionID, projectName, version, filePath)

	_ = k // 旧実装では使っていないがシグネチャ維持のため残す
	return executor.ExecuteSessionUpload(clientCtx, sessionID, filePath, projectName, version)
}
