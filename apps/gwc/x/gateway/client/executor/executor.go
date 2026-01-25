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
	"github.com/cosmos/cosmos-sdk/types/tx/signing" // SignMode 定数のために追加
	"github.com/spf13/pflag"
)

// MaxFragmentsPerBatch は1つのTxに含める断片の最大数です。
// ガスリミット超過を防ぐために設定します。
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

	if session.State != types.SessionState_SESSION_STATE_ROOT_COMMITTED && session.State != types.SessionState_SESSION_STATE_INIT {
		if session.RootProofHex == "" {
			return fmt.Errorf("root proof not committed for session %s", sessionID)
		}
	}

	zipBytes, err := os.ReadFile(zipFilePath)
	if err != nil {
		return abortSession(clientCtx, &session, "FAILED_READ_ZIP") // ポインタを渡すように修正
	}

	fragmentSize := int(session.FragmentSize)
	if fragmentSize <= 0 {
		fragmentSize = 1024 * 1024
	}

	fmt.Printf("[Executor] Processing ZIP... fragment_size=%d\n", fragmentSize)
	files, err := types.ProcessZipAndSplit(zipBytes, fragmentSize)
	if err != nil {
		fmt.Printf("[Executor] ZIP processing failed: %v\n", err)
		return abortSession(clientCtx, &session, "INVALID_ZIP_CONTENT")
	}

	fmt.Printf("[Executor] Building Merkle Tree...\n")
	proofData, err := types.BuildCSUProofs(files)
	if err != nil {
		return abortSession(clientCtx, &session, "PROOF_GENERATION_FAILED")
	}

	if proofData.RootProofHex != session.RootProofHex {
		fmt.Printf("[Executor] RootProof mismatch! OnChain=%s, Computed=%s\n", session.RootProofHex, proofData.RootProofHex)
		return abortSession(clientCtx, &session, "ROOT_PROOF_MISMATCH")
	}

	executorAddr := session.Executor

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
				TargetFdscChannel: "",
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
			return abortSession(clientCtx, &session, "DISTRIBUTE_TX_FAILED")
		}

		time.Sleep(2 * time.Second)
	}

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
	if err := BroadcastMessages(clientCtx, executorAddr, []sdk.Msg{finalizeMsg}); err != nil {
		return fmt.Errorf("finalize failed: %w", err)
	}

	return nil
}

func abortSession(clientCtx client.Context, session *types.Session, reason string) error {
	msg := &types.MsgAbortAndCloseSession{
		Executor:  session.Executor,
		SessionId: session.SessionId,
		Reason:    reason,
	}
	return BroadcastMessages(clientCtx, session.Executor, []sdk.Msg{msg})
}

func BroadcastMessages(clientCtx client.Context, executorAddr string, msgs []sdk.Msg) error {
	if len(msgs) == 0 {
		return nil
	}

	keyName := "local-admin"

	// 修正：SDK v0.50 では戻り値が (Factory, error) の2値
	txf, err := tx.NewFactoryCLI(clientCtx, &pflag.FlagSet{})
	if err != nil {
		return fmt.Errorf("failed to create tx factory: %w", err)
	}

	// 修正：WithFrom ではなく WithFromName を使用
	// 修正：tx.SignModeOptions ではなく signing.SignMode_SIGN_MODE_DIRECT を使用
	txf = txf.WithChainID(clientCtx.ChainID).
		WithGas(2000000).
		WithGasAdjustment(1.5).
		WithKeybase(clientCtx.Keyring).
		WithFromName(executorAddr).
		WithSignMode(signing.SignMode_SIGN_MODE_DIRECT)

	txBuilder, err := txf.BuildUnsignedTx(msgs...)
	if err != nil {
		return fmt.Errorf("failed to build tx: %w", err)
	}

	// 修正：引数に context.Context (context.Background() 等) が必要
	if err := tx.Sign(context.Background(), txf, keyName, txBuilder, true); err != nil {
		return fmt.Errorf("failed to sign tx: %w", err)
	}

	txBytes, err := clientCtx.TxConfig.TxEncoder()(txBuilder.GetTx())
	if err != nil {
		return fmt.Errorf("failed to encode tx: %w", err)
	}

	// 修正：BroadcastTxCommit は削除されたため、BroadcastTxSync を使用
	res, err := clientCtx.BroadcastTxSync(txBytes)
	if err != nil {
		return fmt.Errorf("failed to broadcast tx: %w", err)
	}

	if res.Code != 0 {
		return fmt.Errorf("tx failed: code=%d, log=%s", res.Code, res.RawLog)
	}

	return nil
}
