package server

import (
	"fmt"
	"net/http"
	"os"
	"strings"

	"gwc/x/gateway/keeper"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/tus/tusd/v2/pkg/filestore"
	tusdhandler "github.com/tus/tusd/v2/pkg/handler"
)

// NewTusHandler はTUSアップロード用ハンドラを初期化して返します。
// 既存の呼び出し側シグネチャを維持します。
func NewTusHandler(clientCtx client.Context, k keeper.Keeper, uploadDir, tusBasePath string) (http.Handler, error) {
	// 現時点では clientCtx / k をここで使わなくても、将来のフック等に使えるのでシグネチャを維持
	_ = clientCtx
	_ = k

	if uploadDir == "" {
		uploadDir = "./tmp/uploads"
	}
	if tusBasePath == "" {
		tusBasePath = "/upload/tus-stream/"
	}

	// BasePath は tusd の Location 生成などに使われるため、末尾スラッシュを揃える
	if !strings.HasPrefix(tusBasePath, "/") {
		tusBasePath = "/" + tusBasePath
	}
	if !strings.HasSuffix(tusBasePath, "/") {
		tusBasePath = tusBasePath + "/"
	}

	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		return nil, err
	}

	// filestore を composer に登録
	store := filestore.New(uploadDir)
	composer := tusdhandler.NewStoreComposer()
	store.UseIn(composer)

	// NOTE:
	// - NewUnroutedHandler は *handler.UnroutedHandler を返し、http.Handler を満たさない構成があり得る
	// - ここでは確実に http.Handler を返す NewHandler を使う
	h, err := tusdhandler.NewHandler(tusdhandler.Config{
		BasePath:              tusBasePath,
		StoreComposer:         composer,
		NotifyCompleteUploads: true,
	})
	if err != nil {
		return nil, err
	}

	return h, nil
}

// TusMiddleware は /upload/tus-stream 配下のリクエストを優先処理し、tusMount に委譲します。
// app.go から tus の侵食（CORS/OPTIONS/デバッグ/末尾スラッシュ補正）を排除するための集約先です。
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

				// Preflight
				if req.Method == http.MethodOptions {
					w.WriteHeader(http.StatusNoContent)
					return
				}

				// 末尾スラッシュ補正（既存挙動踏襲）
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
