package keeper

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gwc/x/gateway/types"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/tx"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/spf13/pflag"
)

// ExecuteSessionUpload は、TUS経由でファイルがアップロードされた後のロジックを処理します。
// これは「ローカル管理者エグゼキューター（実行者）」として機能します。
func ExecuteSessionUpload(clientCtx client.Context, sessionID string, zipFilePath string) error {
	// 1. チェーンからセッション情報を照会してパラメータ（フラグメントサイズ、所有者など）を取得します。
	// クエリクライアントを使用します。
	queryClient := types.NewQueryClient(clientCtx)
	res, err := queryClient.Session(context.Background(), &types.QuerySessionRequest{SessionId: sessionID})
	if err != nil {
		return fmt.Errorf("セッション %s の照会に失敗しました: %w", sessionID, err)
	}
	session := res.Session

	if session.State != types.SessionState_SESSION_STATE_ROOT_COMMITTED && session.State != types.SessionState_SESSION_STATE_INIT {
		// ルートがまだコミットされていない場合、検証できません。ただし厳密には、アップロード前にクライアントによってRootProofがコミットされているべきです。
		// そのまま続行しますが、RootProofが見つからない場合、検証に失敗する可能性があります。
	}

	// 2. ファイルの解凍と処理
	// 展開用の一時ディレクトリを作成します
	extractDir := filepath.Join(filepath.Dir(zipFilePath), "extract_"+sessionID)
	if err := os.MkdirAll(extractDir, 0755); err != nil {
		return err
	}
	defer os.RemoveAll(extractDir) // クリーンアップ

	// TODO: 安全な解凍（Zip Slip対策）を実装する
	// MVP（Minimum Viable Product）のため、ヘルパー関数が存在するか、ここに実装されていると仮定します。
	// 簡潔にするため、解凍の実装詳細は省略し、フローに焦点を当てます。
	// ファイルリストがあるものと仮定します。

	// コンパイル用にファイルリストをモック化（実際の解凍ロジックに置き換えてください）
	// files := Unzip(zipFilePath, extractDir)

	// 3. フラグメント化とマークル証明の計算
	// これは integrity-test.sh (Python) のロジックを Go で再現したものです。
	// `MsgDistributeBatch` のアイテムを生成する必要があります。

	// 4. MsgDistributeBatch の構築
	// 「ローカル管理者」として振る舞う必要があります。
	// clientCtx はローカル管理者の鍵を持っている必要があります。

	// ローカル管理者キーの取得
	// ノードはキーリング内で利用可能な local-admin キーで実行されていると仮定します。
	// そうでない場合、このエグゼキューターは失敗します。

	// デモンストレーションのために、ブロードキャストのロジックを示すダミーメッセージを作成します。
	// 実際の実装では、すべてのフラグメントをループ処理する必要があります。

	msgs := []sdk.Msg{}

	// チャンク化ロジック（簡易版）
	fragmentSize := session.FragmentSize
	if fragmentSize == 0 {
		fragmentSize = 1024 * 1024 // デフォルト 1MB
	}

	// 例: バッチメッセージを1つ作成
	// batchMsg := &types.MsgDistributeBatch{
	// 	Executor:  session.Executor,
	// 	SessionId: sessionID,
	// 	Items:     []types.DistributeItem{ ... },
	// }
	// msgs = append(msgs, batchMsg)

	// 5. MsgFinalizeAndCloseSession の構築
	// これは、すべてのバッチが送信された後（または同じフロー内）に送信されます。
	// finalizeMsg := &types.MsgFinalizeAndCloseSession{
	// 	Executor:  session.Executor,
	// 	SessionId: sessionID,
	// 	Manifest:  types.ManifestPacket{ ... },
	// }
	// msgs = append(msgs, finalizeMsg)

	// 6. トランザクションのブロードキャスト
	// メッセージをバッチ処理するか、順次送信する必要があります。
	// ブロードキャストには `tx` パッケージを使用します。

	return BroadcastMessages(clientCtx, session.Executor, msgs)
}

// BroadcastMessages は、local-adminキーを使用してメッセージに署名し、ブロードキャストします。
func BroadcastMessages(clientCtx client.Context, executorAddr string, msgs []sdk.Msg) error {
	if len(msgs) == 0 {
		return nil
	}

	// 1. 実行者のアドレスに対応するキー名を探します
	// 名前を知らずに行うのは困難です。キーを反復処理するか、名前を "local-admin" と仮定する必要があります。
	keyName := "local-admin"

	// 2. ファクトリーの準備
	txf := tx.NewFactoryCLI(clientCtx, &pflag.FlagSet{})
	txf = txf.WithChainID(clientCtx.ChainID).
		WithGas(200000). // 見積もり、または高めに設定
		WithGasAdjustment(1.5).
		WithKeybase(clientCtx.Keyring).
		WithFrom(executorAddr).
		WithSignMode(tx.SignModeOptions.SignMode)

	// 3. 構築と署名
	// 注: Feegrantを使用する場合、FeeGranterを設定する必要があります。
	// セッション所有者は実行者に手数料を付与（Grant）します。
	// FeeGranterを設定するには所有者が誰かを知る必要があります。
	// TxFactoryには WithFeeGranter() があります。
	// 解析すれば最初のMsgから所有者を取得できますし、引数で渡すこともできます。

	// 簡単にするため、実行者が支払うか、Feegrantがグローバル/CLIデフォルトで設定されていると仮定します。
	// CSUに厳密に従う場合は、`txf.WithFeeGranter(ownerAddr)` が必要です。

	txBuilder, err := txf.BuildUnsignedTx(msgs...)
	if err != nil {
		return err
	}

	if err := tx.Sign(txf, keyName, txBuilder, true); err != nil {
		return err
	}

	txBytes, err := clientCtx.TxConfig.TxEncoder()(txBuilder.GetTx())
	if err != nil {
		return err
	}

	// 4. ブロードキャスト
	res, err := clientCtx.BroadcastTx(txBytes)
	if err != nil {
		return err
	}

	if res.Code != 0 {
		return fmt.Errorf("tx送信に失敗しました: code=%d, log=%s", res.Code, res.RawLog)
	}

	fmt.Printf("Txブロードキャスト成功: %s\n", res.TxHash)
	return nil
}