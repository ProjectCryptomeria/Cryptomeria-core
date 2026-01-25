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

// prepareFactory は送信者の情報を元に Tx Factory を初期化します
func prepareFactory(clientCtx client.Context, fromAddr string) (tx.Factory, error) {
	txf, err := tx.NewFactoryCLI(clientCtx, &pflag.FlagSet{})
	if err != nil {
		return txf, err
	}

	txf = txf.WithChainID(clientCtx.ChainID).
		WithGas(2000000).
		WithGasAdjustment(1.5).
		WithKeybase(clientCtx.Keyring).
		WithFromName(fromAddr).
		WithSignMode(signing.SignMode_SIGN_MODE_DIRECT)

	// 最新のシーケンス番号を取得してセットします
	num, seq, err := clientCtx.AccountRetriever.GetAccountNumberSequence(clientCtx, sdk.MustAccAddressFromBech32(fromAddr))
	if err != nil {
		return txf, err
	}
	return txf.WithAccountNumber(num).WithSequence(seq), nil
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
	txf, err := prepareFactory(clientCtx, session.Executor)
	if err != nil {
		return err
	}
	_, err = broadcastWithRetry(clientCtx, txf, msg)
	return err
}
