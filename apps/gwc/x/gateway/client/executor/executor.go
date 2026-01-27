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
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	"github.com/spf13/pflag"
)

// MaxFragmentsPerBatch は1つのTxに含める断片の最大数です。
const MaxFragmentsPerBatch = 50

// ExecuteSessionUpload はTUSでアップロードされたファイルを処理し、オンチェーン配布を行います。
func ExecuteSessionUpload(clientCtx client.Context, sessionID string, zipFilePath string) error {
	fmt.Printf("[Executor] Starting process for session %s\n", sessionID)

	queryClient := types.NewQueryClient(clientCtx)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, err := queryClient.Session(ctx, &types.QuerySessionRequest{SessionId: sessionID})
	if err != nil {
		return fmt.Errorf("failed to query session %s: %w", sessionID, err)
	}
	session := res.Session

	// セッション状態のチェック
	if session.State == types.SessionState_SESSION_STATE_CLOSED_SUCCESS || session.State == types.SessionState_SESSION_STATE_CLOSED_FAILED {
		return fmt.Errorf("session %s is already closed", sessionID)
	}

	zipBytes, err := os.ReadFile(zipFilePath)
	if err != nil {
		return abortSession(clientCtx, &session, "FAILED_READ_ZIP")
	}

	fragmentSize := int(session.FragmentSize)
	if fragmentSize <= 0 {
		fragmentSize = 1024 * 1024
	}

	// ZIPの展開と分割（フェーズ1で実装したソート済みロジックを使用）
	fmt.Printf("[Executor] Processing ZIP... fragment_size=%d\n", fragmentSize)
	files, err := types.ProcessZipAndSplit(zipBytes, fragmentSize)
	if err != nil {
		fmt.Printf("[Executor] ZIP processing failed: %v\n", err)
		return abortSession(clientCtx, &session, "INVALID_ZIP_CONTENT")
	}

	// Merkle Proof の生成
	fmt.Printf("[Executor] Building Merkle Tree...\n")
	proofData, err := types.BuildCSUProofs(files)
	if err != nil {
		return abortSession(clientCtx, &session, "PROOF_GENERATION_FAILED")
	}

	// オンチェーンの RootProof との照合
	if proofData.RootProofHex != session.RootProofHex {
		fmt.Printf("[Executor] RootProof mismatch! OnChain=%s, Computed=%s\n", session.RootProofHex, proofData.RootProofHex)
		return abortSession(clientCtx, &session, "ROOT_PROOF_MISMATCH")
	}

	executorAddr := session.Executor
	totalItems := len(proofData.Fragments)
	fmt.Printf("[Executor] Total fragments to distribute: %d\n", totalItems)

	// Txシーケンスの取得とバッチ送信の準備
	txf, err := prepareFactory(clientCtx, executorAddr)
	if err != nil {
		return err
	}

	// 各バッチの送信
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
				TargetFdscChannel: "",
			})
		}

		msg := &types.MsgDistributeBatch{
			Executor:  executorAddr,
			SessionId: sessionID,
			Items:     batchItems,
		}

		fmt.Printf("[Executor] Broadcasting Batch %d-%d...\n", i, end)
		_, err := broadcastWithRetry(clientCtx, txf, msg)
		if err != nil {
			fmt.Printf("[Executor] Failed to broadcast batch: %v\n", err)
			return abortSession(clientCtx, &session, "DISTRIBUTE_TX_FAILED")
		}

		// シーケンスを手動でインクリメントして連続送信を可能にします
		// TxResponse (res) には AccountNumber/Sequence が含まれないため、txf の値を直接更新します
		txf = txf.WithSequence(txf.Sequence() + 1)
	}

	// プロジェクト名の抽出とセッションの確定
	projectName := types.GetProjectNameFromZipFilename(filepath.Base(zipFilePath))
	finalizeMsg := &types.MsgFinalizeAndCloseSession{
		Executor:  executorAddr,
		SessionId: sessionID,
		Manifest: types.ManifestPacket{
			ProjectName:  projectName,
			Version:      "v1",
			RootProof:    proofData.RootProofHex,
			FragmentSize: session.FragmentSize,
			Owner:        session.Owner,
			SessionId:    sessionID,
		},
	}

	fmt.Printf("[Executor] Finalizing session...\n")
	_, err = broadcastWithRetry(clientCtx, txf, finalizeMsg)
	if err != nil {
		return fmt.Errorf("finalize failed: %w", err)
	}

	return nil
}

// broadcastWithRetry は Tx の署名とブロードキャストを行い、結果を返します。
// ここでは「ガスを固定値にせず、simulate で動的に見積もる」版の例を示します。
func broadcastWithRetry(clientCtx client.Context, txf tx.Factory, msg sdk.Msg) (*sdk.TxResponse, error) {
	// 1) まずはガス見積もり（simulate）
	//    CLI の --gas=auto 相当：Tx を組み立てて simulate し、必要 gas を算出する。
	estimatedGas, err := simulateGas(clientCtx, txf, msg)
	if err != nil {
		return nil, fmt.Errorf("ガス見積もり(simulate)に失敗しました: %w", err)
	}

	// 2) 見積もった gas に安全係数(GasAdjustment)を掛けて上限を設定する
	//    例：gas_used が 100000 なら 1.5 倍して 150000 を上限にする。
	adjusted := uint64(float64(estimatedGas) * txf.GasAdjustment())
	if adjusted == 0 {
		// 念のため 0 は避ける
		adjusted = 1
	}
	txf = txf.WithGas(adjusted)

	// 3) 通常通り Tx を構築→署名→ブロードキャスト
	txBuilder, err := txf.BuildUnsignedTx(msg)
	if err != nil {
		return nil, err
	}

	if err := tx.Sign(context.Background(), txf, txf.FromName(), txBuilder, true); err != nil {
		return nil, err
	}

	txBytes, err := clientCtx.TxConfig.TxEncoder()(txBuilder.GetTx())
	if err != nil {
		return nil, err
	}

	res, err := clientCtx.BroadcastTxSync(txBytes)
	if err != nil {
		return nil, err
	}

	if res.Code != 0 {
		return nil, fmt.Errorf("tx failed with code %d: %s", res.Code, res.RawLog)
	}

	return res, nil
}

// simulateGas は msg から Tx を組み立て、simulate で必要 gas を見積もって返します。
// ここは Cosmos SDK の simulate 機構を使います。
// ※ SDK の版や接続方式によって実装が多少変わるので、まずはこの形で導入して調整するのが安全です。
func simulateGas(clientCtx client.Context, txf tx.Factory, msg sdk.Msg) (uint64, error) {
	// simulate では「ダミー署名付き Tx」が必要になることが多いので、
	// いったん unsigned を作って署名関数を通します（CLI でも同様の手順）。
	txBuilder, err := txf.BuildUnsignedTx(msg)
	if err != nil {
		return 0, err
	}

	// overwrite=true にして署名を必ず上書きする（simulate 用）
	if err := tx.Sign(context.Background(), txf, txf.FromName(), txBuilder, true); err != nil {
		return 0, err
	}

	txBytes, err := clientCtx.TxConfig.TxEncoder()(txBuilder.GetTx())
	if err != nil {
		return 0, err
	}

	// Cosmos SDK の Simulate は gRPC (cosmos.tx.v1beta1.Service/Simulate) を使います。
	// clientCtx には gRPC 接続が入っている想定です。
	simRes, err := clientCtx.Simulate(txBytes)
	if err != nil {
		return 0, err
	}

	// GasUsed を返す
	return uint64(simRes.GasInfo.GasUsed), nil
}



// broadcastWithRetry はTxの署名とブロードキャストを行い、結果を返します
func broadcastWithRetry(clientCtx client.Context, txf tx.Factory, msg sdk.Msg) (*sdk.TxResponse, error) {
	txBuilder, err := txf.BuildUnsignedTx(msg)
	if err != nil {
		return nil, err
	}

	if err := tx.Sign(context.Background(), txf, txf.FromName(), txBuilder, true); err != nil {
		return nil, err
	}

	txBytes, err := clientCtx.TxConfig.TxEncoder()(txBuilder.GetTx())
	if err != nil {
		return nil, err
	}

	res, err := clientCtx.BroadcastTxSync(txBytes)
	if err != nil {
		return nil, err
	}

	if res.Code != 0 {
		return nil, fmt.Errorf("tx failed with code %d: %s", res.Code, res.RawLog)
	}

	return res, nil
}

func abortSession(clientCtx client.Context, session *types.Session, reason string) error {
	msg := &types.MsgAbortAndCloseSession{
		Executor:  session.Executor,
		SessionId: session.SessionId,
		Reason:    reason,
	}
	// Abort Tx は個別に準備して送信
	// ChainIDの補完が必要なため、修正した prepareFactory を利用
	txf, err := prepareFactory(clientCtx, session.Executor)
	if err != nil {
		return err
	}
	_, err = broadcastWithRetry(clientCtx, txf, msg)
	return err
}