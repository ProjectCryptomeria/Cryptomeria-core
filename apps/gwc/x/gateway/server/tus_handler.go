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

// GlobalCORSMiddleware は、APIとTUSの両方で必要となるCORSヘッダーを付与し、
// OPTIONSリクエストを適切に処理します。
func GlobalCORSMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			origin = "*"
		}

		h := w.Header()
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Access-Control-Allow-Credentials", "true")
		h.Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE, PATCH, HEAD")
		// TUS特有のヘッダーをすべて許可リストに含める
		h.Set("Access-Control-Allow-Headers", "Authorization, Origin, X-Requested-With, X-Request-ID, X-HTTP-Method-Override, Content-Type, Upload-Length, Upload-Offset, Tus-Resumable, Upload-Metadata, Cache-Control")
		// ブラウザ側で読み取り可能にするヘッダーを指定
		h.Set("Access-Control-Expose-Headers", "Location, Tus-Resumable, Upload-Offset, Upload-Length, Upload-Metadata, Tus-Version, Tus-Max-Size, Tus-Extension")
		h.Set("Access-Control-Max-Age", "86400")

		// Preflight (OPTIONS) の場合はここで完了させる
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// DebugTusResponseWriter は tusd 内部のヘッダー制御をログ出力・デバッグするために使用します
type DebugTusResponseWriter struct {
	http.ResponseWriter
	req *http.Request
}

func (w *DebugTusResponseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *DebugTusResponseWriter) WriteHeader(statusCode int) {
	// グローバルミドルウェアでセット済みだが、tusdが上書きする場合に備えて再セット
	origin := w.req.Header.Get("Origin")
	if origin == "" {
		origin = "*"
	}
	h := w.ResponseWriter.Header()
	h.Set("Access-Control-Allow-Origin", origin)

	if statusCode >= 400 {
		fmt.Printf("⚠️ [TUS ERROR] %s %s (Status: %d)\n", w.req.Method, w.req.URL.Path, statusCode)
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

	// 既にグローバルミドルウェアでOPTIONSは処理されているが、
	// 安全のため tusd にはデバッグラッパーを被せて渡す
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

	// イベントログ監視
	go func() {
		for {
			select {
			case event := <-h.CreatedUploads:
				fmt.Printf("[CSU Phase 3: TUS] 📤 Upload Created | TUS_ID: %s | SessionID: %s\n",
					event.Upload.ID, event.Upload.MetaData["session_id"])
			case event := <-h.UploadProgress:
				var p float64
				if event.Upload.Size > 0 {
					p = float64(event.Upload.Offset) / float64(event.Upload.Size) * 100
				}
				if int(p)%10 == 0 { // ログ過多防止のため10%刻み
					fmt.Printf("[CSU Phase 3: TUS] 🚀 %.2f%%\n", p)
				}
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

	filePath := upload.Storage["Path"]
	if filePath == "" {
		return fmt.Errorf("unable to resolve file path for upload %s", upload.ID)
	}

	fmt.Printf("[CSU Phase 3: TUS] 🔄 Triggering Executor for SessionID: %s\n", sessionID)
	return executor.ExecuteSessionUpload(clientCtx, sessionID, filePath, projectName, version)
}
