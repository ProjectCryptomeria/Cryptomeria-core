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

// DebugTusResponseWriter は http.ResponseWriter をラップし、
// ヘッダーの強制上書きとデバッグ出力を行います。
// 【重要】Unwrapメソッドは実装しません。これによりtusdがラッパーをバイパスするのを防ぎます。
type DebugTusResponseWriter struct {
	http.ResponseWriter
	req *http.Request
}

// Flush は http.Flusher インターフェースを実装します（これはあっても安全）
func (w *DebugTusResponseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// WriteHeader でヘッダーを強制的にセットし、ログ出力します
func (w *DebugTusResponseWriter) WriteHeader(statusCode int) {
	// 1. Origin解決
	origin := w.req.Header.Get("Origin")
	if origin == "" {
		origin = "*"
	}

	h := w.ResponseWriter.Header()

	// 2. CORSヘッダーの強制上書き (AddではなくSetを使うことで重複防止)
	h.Set("Access-Control-Allow-Origin", origin)
	h.Set("Access-Control-Allow-Credentials", "true")
	h.Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE, PATCH, HEAD")
	h.Set("Access-Control-Allow-Headers", "Authorization, Origin, X-Requested-With, X-Request-ID, X-HTTP-Method-Override, Content-Type, Upload-Length, Upload-Offset, Tus-Resumable, Upload-Metadata, Cache-Control")
	// ブラウザがUpload-Offsetを読むために必須
	h.Set("Access-Control-Expose-Headers", "Location, Tus-Resumable, Upload-Offset, Upload-Length, Upload-Metadata, Tus-Version, Tus-Max-Size, Tus-Extension")
	h.Set("Access-Control-Max-Age", "86400")

	// 3. 【診断用】送信されるヘッダーをログに出力
	// ループしている HEAD メソッドや OPTIONS メソッドの時だけ表示
	if w.req.Method == http.MethodHead || w.req.Method == http.MethodOptions {
		fmt.Printf("⚡ [TUS OUT] %s %s (Status: %d)\n", w.req.Method, w.req.URL.Path, statusCode)
		fmt.Printf("   -> Upload-Offset: %s\n", h.Get("Upload-Offset"))
		fmt.Printf("   -> AC-Expose-Headers: %s\n", h.Get("Access-Control-Expose-Headers"))
		fmt.Printf("   -> AC-Allow-Origin: %s\n", h.Get("Access-Control-Allow-Origin"))
	}

	w.ResponseWriter.WriteHeader(statusCode)
}

// TusWithCorsHandler は tusd.Handler をラップします
type TusWithCorsHandler struct {
	baseHandler *tusd.Handler
}

func (h *TusWithCorsHandler) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// パス補正
	if req.URL.Path == "/upload/tus-stream" {
		req.URL.Path = "/upload/tus-stream/"
	}

	// Preflight (OPTIONS)
	if req.Method == http.MethodOptions {
		// ラッパーを通してヘッダーをセットし、即リターン
		wrapper := &DebugTusResponseWriter{ResponseWriter: w, req: req}
		wrapper.WriteHeader(http.StatusNoContent)
		return
	}

	// 通常リクエスト
	wrapper := &DebugTusResponseWriter{ResponseWriter: w, req: req}
	h.baseHandler.ServeHTTP(wrapper, req)
}

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

	h, err := tusd.NewHandler(tusd.Config{
		BasePath:                tusBasePath,
		StoreComposer:           composer,
		NotifyCreatedUploads:    true,
		NotifyUploadProgress:    true,
		NotifyCompleteUploads:   true,
		RespectForwardedHeaders: true,
	})
	if err != nil {
		return nil, err
	}

	// イベントログ
	go func() {
		for {
			select {
			case event := <-h.CreatedUploads:
				fmt.Printf("[CSU Phase 3: TUS] 📤 Upload Created | TUS_ID: %s | SessionID: %s | Size: %d\n",
					event.Upload.ID, event.Upload.MetaData["session_id"], event.Upload.Size)
			case event := <-h.UploadProgress:
				// 進捗ログ
				var p float64
				if event.Upload.Size > 0 {
					p = float64(event.Upload.Offset) / float64(event.Upload.Size) * 100
				}
				fmt.Printf("[CSU Phase 3: TUS] 🚀 %.2f%%\n", p)
			case event := <-h.CompleteUploads:
				fmt.Printf("[CSU Phase 3: TUS] ✅ Upload Completed | TUS_ID: %s\n", event.Upload.ID)
				if err := processCompletedUpload(clientCtx, k, event.Upload); err != nil {
					fmt.Printf("[CSU Phase 3: TUS] ❌ Error processing upload: %v\n", err)
				}
			}
		}
	}()

	return &TusWithCorsHandler{baseHandler: h}, nil
}

// TusMiddleware (Legacy support)
func TusMiddleware(tusMount http.Handler) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if strings.HasPrefix(req.URL.Path, "/upload/tus-stream") {
				tusMount.ServeHTTP(w, req)
				return
			}
			next.ServeHTTP(w, req)
		})
	}
}

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

	fmt.Printf("[CSU Phase 3: TUS] 🔄 Triggering Executor for SessionID: %s\n", sessionID)
	return executor.ExecuteSessionUpload(clientCtx, sessionID, filePath, projectName, version)
}
