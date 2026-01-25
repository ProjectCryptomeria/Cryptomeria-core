package executor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gwc/x/gateway/types"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/tx"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/spf13/pflag"
)

// MaxFragmentsPerBatch は1つのTxに含める断片の最大数です。
// ガスリミット超過を防ぐために設定します。
const MaxFragmentsPerBatch = 50

// ExecuteSessionUpload はTUSでアップロードされたファイルを処理し、オンチェーン配布を行います。
// GWCノードがlocal-admin（Executor）として機能するためのメインロジックです。
func ExecuteSessionUpload(clientCtx client.Context, sessionID string, zipFilePath string) error {
	fmt.Printf("[Executor] Starting process for session %s\n", sessionID)

	// 1. セッション情報の取得（Query）
	// 注意: clientCtx.QueryClient を使用したいが、CLIコンテキスト外からの呼び出しの可能性があるため、
	// アプリケーション内であれば Keeper を直接参照する方が良い場合もある。
	// ここでは汎用的に QueryClient を使用する。
	queryClient := types.NewQueryClient(clientCtx)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, err := queryClient.Session(ctx, &types.QuerySessionRequest{SessionId: sessionID})
	if err != nil {
		return fmt.Errorf("failed to query session %s: %w", sessionID, err)
	}
	session := res.Session

	// 状態チェック
	if session.State != types.SessionState_SESSION_STATE_ROOT_COMMITTED && session.State != types.SessionState_SESSION_STATE_INIT {
		// すでに進行中や完了済みの場合は再実行を避けるべきだが、リトライの可能性も考慮。
		// ここでは厳密に RootProof がコミット済みであることを要求する。
		// (クライアントが先に CommitRootProof を投げているはず)
		if session.RootProofHex == "" {
			return fmt.Errorf("root proof not committed for session %s", sessionID)
		}
		// Warning: 状態がすでにDISTRIBUTING等の場合、重複送信になる可能性があるが、冪等性はMsgServer側で担保する。
	}

	// 2. ZIPファイルの読み込みと解凍
	zipBytes, err := os.ReadFile(zipFilePath)
	if err != nil {
		return abortSession(clientCtx, session, "FAILED_READ_ZIP")
	}

	// 解凍と断片化 (zip_logic.go)
	fragmentSize := int(session.FragmentSize)
	if fragmentSize <= 0 {
		fragmentSize = 1024 * 1024 // デフォルト 1MB
	}
	
	fmt.Printf("[Executor] Processing ZIP... fragment_size=%d\n", fragmentSize)
	files, err := ProcessZipAndSplit(zipBytes, fragmentSize)
	if err != nil {
		fmt.Printf("[Executor] ZIP processing failed: %v\n", err)
		return abortSession(clientCtx, session, "INVALID_ZIP_CONTENT")
	}

	// 3. Merkle Proof 生成 (merkle_gen.go)
	fmt.Printf("[Executor] Building Merkle Tree...\n")
	proofData, err := BuildCSUProofs(files)
	if err != nil {
		return abortSession(clientCtx, session, "PROOF_GENERATION_FAILED")
	}

	// 4. RootProof 整合性チェック
	// クライアントがコミットしたRootProofと、アップロードされた実体から計算したRootProofが一致するか？
	if proofData.RootProofHex != session.RootProofHex {
		fmt.Printf("[Executor] RootProof mismatch! OnChain=%s, Computed=%s\n", session.RootProofHex, proofData.RootProofHex)
		return abortSession(clientCtx, session, "ROOT_PROOF_MISMATCH")
	}

	// 5. MsgDistributeBatch の送信ループ
	// local-admin としてTxを作成
	executorAddr := session.Executor // local-admin address
	
	totalItems := len(proofData.Fragments)
	fmt.Printf("[Executor] Total fragments to distribute: %d\n", totalItems)

	for i := 0; i < totalItems; i += MaxFragmentsPerBatch {
		end := i + MaxFragmentsPerBatch
		if end > totalItems {
			end = totalItems
		}
		
		batchItems := make([]types.DistributeItem, 0, end-i)
		for _, frag := range proofData.Fragments[i:end] {
			batchItems = append(batchItems, types.DistributeItem{
				Path:              frag.Path,
				Index:             frag.Index,
				FragmentBytes:     frag.FragmentBytes,
				FragmentProof:     frag.FragmentProof,
				FileSize:          frag.FileSize,
				FileProof:         frag.FileProof,
				TargetFdscChannel: "", // 必要であればラウンドロビンや指定を入れる
			})
		}

		msg := &types.MsgDistributeBatch{
			Executor:  executorAddr,
			SessionId: sessionID,
			Items:     batchItems,
		}

		fmt.Printf("[Executor] Broadcasting Batch %d-%d...\n", i, end)
		if err := BroadcastMessages(clientCtx, executorAddr, []sdk.Msg{msg}); err != nil {
			fmt.Printf("[Executor] Failed to broadcast batch: %v\n", err)
			// リトライロジックが必要だが、ここでは簡易的にAbort
			return abortSession(clientCtx, session, "DISTRIBUTE_TX_FAILED")
		}
		
		// Tx順序保証やNonce競合回避のため、少し待つ（本来はTx完了を待つべき）
		time.Sleep(2 * time.Second)
	}

	// 6. 完了通知 (FinalizeAndClose)
	// マニフェスト情報の構築
	// 仕様では ManifestPacket 構造体を送る
	// プロジェクト名はZIPファイル名などから推測、あるいは別途metadataが必要。
	// ここでは簡易的にZIPファイル名を使用。
	projectName := GetProjectNameFromZipFilename(filepath.Base(zipFilePath))
	
	finalizeMsg := &types.MsgFinalizeAndCloseSession{
		Executor:  executorAddr,
		SessionId: sessionID,
		Manifest: &types.ManifestPacket{
			ProjectName:  projectName,
			Version:      "v1", // デフォルト
			RootProof:    proofData.RootProofHex,
			FragmentSize: session.FragmentSize,
			Owner:        session.Owner,
			SessionId:    sessionID,
		},
	}

	fmt.Printf("[Executor] Finalizing session...\n")
	if err := BroadcastMessages(clientCtx, executorAddr, []sdk.Msg{finalizeMsg}); err != nil {
		fmt.Printf("[Executor] Failed to finalize: %v\n", err)
		// Finalize失敗時はリトライすべき（Abortしない）
		return fmt.Errorf("finalize failed: %w", err)
	}

	fmt.Printf("[Executor] Session %s completed successfully.\n", sessionID)
	
	// アップロードファイルのクリーンアップ
	// os.Remove(zipFilePath) // 必要に応じて有効化
	
	return nil
}

// abortSession は異常終了時に MsgAbortAndCloseSession を送信します
func abortSession(clientCtx client.Context, session *types.Session, reason string) error {
	msg := &types.MsgAbortAndCloseSession{
		Executor:  session.Executor,
		SessionId: session.SessionId,
		Reason:    reason,
	}
	fmt.Printf("[Executor] Aborting session: %s\n", reason)
	return BroadcastMessages(clientCtx, session.Executor, []sdk.Msg{msg})
}

// BroadcastMessages は指定されたMsgをTxとして署名・送信します。
// local-admin キーがKeyringに存在することを前提とします。
func BroadcastMessages(clientCtx client.Context, executorAddr string, msgs []sdk.Msg) error {
	if len(msgs) == 0 {
		return nil
	}

	// KeyringからexecutorAddrに対応するKey名を探す、または固定名 "local-admin" を使用
	// ここでは設定または環境変数から取得するのが理想だが、CSU仕様に基づき "local-admin" と仮定
	keyName := "local-admin"

	// TxFactoryの構築
	txf := tx.NewFactoryCLI(clientCtx, &pflag.FlagSet{})
	txf = txf.WithChainID(clientCtx.ChainID).
		WithGas(2000000). // Proofを含むためガスは多めに設定
		WithGasAdjustment(1.5).
		WithKeybase(clientCtx.Keyring).
		WithFrom(executorAddr).
		WithSignMode(tx.SignModeOptions.SignMode)

	// Feegrant: local-adminが実行するが、feeはOwnerが払う設定になっている場合、
	// txf.WithFeeGranter(ownerAddr) をセットする必要がある。
	// msgs[0] から sessionID を辿って owner を知る必要があるが、
	// ここでは簡略化のため local-admin が fee を払う（またはFeegrant自動解決に任せる）。
	// CSU仕様厳密準拠なら、呼び出し元でOwnerアドレスを渡してここでセットすべき。

	// Tx構築
	txBuilder, err := txf.BuildUnsignedTx(msgs...)
	if err != nil {
		return fmt.Errorf("failed to build tx: %w", err)
	}

	if err := tx.Sign(txf, keyName, txBuilder, true); err != nil {
		return fmt.Errorf("failed to sign tx: %w", err)
	}

	txBytes, err := clientCtx.TxConfig.TxEncoder()(txBuilder.GetTx())
	if err != nil {
		return fmt.Errorf("failed to encode tx: %w", err)
	}

	// ブロードキャスト（ブロック待ち `BroadcastTxCommit` 推奨だが、スループットのため `Sync`）
	// Executorは順序制御したいので Commit の方が安全かもしれない。
	res, err := clientCtx.BroadcastTxCommit(txBytes)
	if err != nil {
		return fmt.Errorf("failed to broadcast tx: %w", err)
	}

	if res.Code != 0 {
		return fmt.Errorf("tx failed on chain: code=%d, log=%s", res.Code, res.RawLog)
	}

	return nil
}