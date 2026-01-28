package executor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"time"

	"gwc/x/gateway/types"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/tx"
	"github.com/cosmos/cosmos-sdk/crypto/keyring"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	"github.com/spf13/pflag"
)

const MaxFragmentsPerBatch = 50

// ExecuteSessionUpload はZIPファイルの解凍、断片化、各ストレージへの配布、およびマニフェストの登録を一括して実行します。
func ExecuteSessionUpload(clientCtx client.Context, sessionID string, zipFilePath string, projectName string, version string) error {
	fmt.Printf("[Executor] Starting process for session %s\n", sessionID)

	queryClient := types.NewQueryClient(clientCtx)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// 1. オンチェーンからセッション情報を取得
	res, err := queryClient.Session(ctx, &types.QuerySessionRequest{SessionId: sessionID})
	if err != nil {
		return fmt.Errorf("failed to query session %s: %w", sessionID, err)
	}
	session := res.Session

	// セッションが既に閉じている場合はエラー
	if session.State == types.SessionState_SESSION_STATE_CLOSED_SUCCESS || session.State == types.SessionState_SESSION_STATE_CLOSED_FAILED {
		return fmt.Errorf("session %s is already closed", sessionID)
	}

	// 2. 有効な FDSC ID (ChainId) と ChannelId を動的に取得
	// ストレージトポロジーをクエリし、connection_type が "datastore" のものを探します
	fmt.Printf("[Executor] Resolving storage endpoints...\n")
	resStorage, err := queryClient.StorageEndpoints(ctx, &types.QueryStorageEndpointsRequest{})
	if err != nil {
		return fmt.Errorf("failed to query storage endpoints: %w", err)
	}

	var targetFdscID string
	var targetChannelID string

	for _, info := range resStorage.StorageInfos {
		// 修正: インフラ側の登録名 "datastore" に合わせる
		if info.ConnectionType == "datastore" {
			targetFdscID = info.ChainId
			targetChannelID = info.ChannelId
			fmt.Printf("[Executor] Found active FDSC: %s (Endpoint: %s, Channel: %s)\n", targetFdscID, info.ApiEndpoint, targetChannelID)
			break
		}
	}

	if targetFdscID == "" {
		return fmt.Errorf("no active FDSC storage found in registry (connection_type='datastore'). Please ensure storage is registered via 'gwcd tx gateway register-storage'")
	}
	if targetChannelID == "" {
		return fmt.Errorf("active FDSC found (%s) but channel_id is missing. Please re-register storage correctly.", targetFdscID)
	}

	// 3. ZIPファイルの読み込み
	zipBytes, err := os.ReadFile(zipFilePath)
	if err != nil {
		return abortSession(clientCtx, &session, "FAILED_READ_ZIP")
	}

	fragmentSize := int(session.FragmentSize)
	if fragmentSize <= 0 {
		fragmentSize = 1024 * 1024
	}

	// ZIPの解凍と断片化
	fmt.Printf("[Executor] Processing ZIP... fragment_size=%d\n", fragmentSize)
	files, err := types.ProcessZipAndSplit(zipBytes, fragmentSize)
	if err != nil {
		return abortSession(clientCtx, &session, "INVALID_ZIP_CONTENT")
	}

	// 4. CSU Proof (Merkle Tree) の構築
	fmt.Printf("[Executor] Building Merkle Tree...\n")
	proofData, err := types.BuildCSUProofs(files)
	if err != nil {
		return abortSession(clientCtx, &session, "PROOF_GENERATION_FAILED")
	}

	// ルートハッシュの検証
	if proofData.RootProofHex != session.RootProofHex {
		fmt.Printf("[Executor] RootProof mismatch! OnChain=%s, Computed=%s\n", session.RootProofHex, proofData.RootProofHex)
		return abortSession(clientCtx, &session, "ROOT_PROOF_MISMATCH")
	}

	executorAddr := session.Executor
	totalItems := len(proofData.Fragments)
	fmt.Printf("[Executor] Total fragments to distribute: %d\n", totalItems)

	// トランザクションファクトリの準備
	ownerAddr, _ := sdk.AccAddressFromBech32(session.Owner)
	txf, err := prepareFactory(clientCtx, executorAddr)
	if err != nil {
		return err
	}
	txf = txf.WithFeeGranter(ownerAddr)

	// 5. 断片データの配布 (バッチ処理)
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
				// 修正: 特定したチャネルIDを明示的に指定
				TargetFdscChannel: targetChannelID,
			})
		}

		msg := &types.MsgDistributeBatch{
			Executor:  executorAddr,
			SessionId: sessionID,
			Items:     batchItems,
		}

		fmt.Printf("[Executor] Broadcasting Batch %d-%d to channel %s...\n", i, end, targetChannelID)
		txRes, err := broadcastAndConfirm(clientCtx, txf, msg)
		if err != nil {
			fmt.Printf("[Executor] Failed to confirm batch Tx: %v\n", err)
			return abortSession(clientCtx, &session, "DISTRIBUTE_TX_FAILED")
		}
		fmt.Printf("[Executor] Batch confirmed successfully. TxHash: %s\n", txRes.TxHash)

		// 次のシーケンス番号へ更新
		txf = txf.WithSequence(txf.Sequence() + 1)
	}

	// 6. マニフェストファイル情報の構築
	// Map Entry の互換性問題回避のためスライス構造を使用
	var manifestFiles []types.ManifestFileEntry

	// 断片情報をパスごとに整理
	fragmentsByPath := make(map[string][]*types.PacketFragmentMapping)
	for _, frag := range proofData.Fragments {
		// 修正: FDSCの MakeFragmentID と同じロジックでIDを生成
		// FDSC側: hex(sha256("FDSC_FRAG_ID:{session_id}:{path}:{index}"))
		calculatedID := calculateFragmentID(sessionID, frag.Path, frag.Index)

		mapping := &types.PacketFragmentMapping{
			FdscId:     targetFdscID, 
			FragmentId: calculatedID, // 単純なpath-indexではなく、ハッシュ化されたIDを使用
		}
		fragmentsByPath[frag.Path] = append(fragmentsByPath[frag.Path], mapping)
	}

	for _, file := range files {
		mimeType := mime.TypeByExtension(filepath.Ext(file.Filename))
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}

		// ファイルごとの Merkle Root を計算
		fileRoot := calculateFileRoot(file.Path, file.Chunks)

		manifestFiles = append(manifestFiles, types.ManifestFileEntry{
			Path: file.Path,
			Metadata: types.FileMetadata{
				MimeType:  mimeType,
				FileSize:  uint64(len(file.Content)),
				Fragments: fragmentsByPath[file.Path],
				FileRoot:  fileRoot,
			},
		})
	}

	// 7. セッションの終了とマニフェストの確定
	finalizeMsg := &types.MsgFinalizeAndCloseSession{
		Executor:  executorAddr,
		SessionId: sessionID,
		Manifest: types.ManifestPacket{
			ProjectName:  projectName,
			Version:      version,
			RootProof:    proofData.RootProofHex,
			FragmentSize: session.FragmentSize,
			Owner:        session.Owner,
			SessionId:    sessionID,
			Files:        manifestFiles,
		},
	}
	fmt.Printf("[Executor] Manifest for project %s (version %s)\n", projectName, version)

	fmt.Printf("[Executor] Finalizing session...\n")
	_, err = broadcastAndConfirm(clientCtx, txf, finalizeMsg)
	if err != nil {
		fmt.Printf("[Executor] Finalize Tx failed: %v\n", err)
		return err
	}
	fmt.Printf("[Executor] Session %s finalized successfully.\n", sessionID)

	return nil
}

// calculateFragmentID generates the same deterministic ID as FDSC
func calculateFragmentID(sessionID, path string, index uint64) string {
	// FDSCの types.MakeFragmentID と完全一致させる必要があります
	payload := []byte(fmt.Sprintf("FDSC_FRAG_ID:%s:%s:%d", sessionID, path, index))
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// calculateFileRoot は types.BuildCSUProofs と同じロジックでFileRootを計算します
func calculateFileRoot(path string, chunks [][]byte) string {
	if len(chunks) == 0 {
		return ""
	}
	var leaves []string
	for i, chunk := range chunks {
		// FRAG:{path}:{index}:{hex(SHA256(bytes))}
		chunkHash := sha256.Sum256(chunk)
		chunkHashHex := hex.EncodeToString(chunkHash[:])

		rawLeaf := fmt.Sprintf("FRAG:%s:%d:%s", path, i, chunkHashHex)
		leafHash := sha256.Sum256([]byte(rawLeaf))
		leafHex := hex.EncodeToString(leafHash[:])

		leaves = append(leaves, leafHex)
	}
	// typesパッケージのMerkleTree実装を利用
	return types.NewMerkleTree(leaves).Root()
}

func prepareFactory(clientCtx client.Context, fromAddr string) (tx.Factory, error) {
	fromAcc, err := sdk.AccAddressFromBech32(fromAddr)
	if err != nil {
		return tx.Factory{}, err
	}

	// 'test' キーリング・バックエンドへのフォールバック
	krRec, err := clientCtx.Keyring.KeyByAddress(fromAcc)
	if err != nil {
		homeDir := clientCtx.HomeDir
		if homeDir == "" {
			homeDir = os.ExpandEnv("$HOME/.gwc")
		}
		kb, errK := keyring.New(sdk.KeyringServiceName(), keyring.BackendTest, homeDir, nil, clientCtx.Codec)
		if errK == nil {
			if rec, errRec := kb.KeyByAddress(fromAcc); errRec == nil {
				krRec = rec
				err = nil
				clientCtx.Keyring = kb
			}
		}
	}
	if err != nil {
		return tx.Factory{}, fmt.Errorf("key resolution failed: %w", err)
	}

	txf, err := tx.NewFactoryCLI(clientCtx, &pflag.FlagSet{})
	if err != nil {
		return tx.Factory{}, err
	}

	num, seq, err := clientCtx.AccountRetriever.GetAccountNumberSequence(clientCtx, fromAcc)
	if err != nil {
		return tx.Factory{}, err
	}

	return txf.
		WithChainID(clientCtx.ChainID).
		WithGas(4000000).
		WithGasAdjustment(1.5).
		WithKeybase(clientCtx.Keyring).
		WithFromName(krRec.Name).
		WithSignMode(signing.SignMode_SIGN_MODE_DIRECT).
		WithAccountNumber(num).
		WithSequence(seq), nil
}

func broadcastAndConfirm(clientCtx client.Context, txf tx.Factory, msg sdk.Msg) (*sdk.TxResponse, error) {
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
		return res, fmt.Errorf("tx sync failed (code %d): %s", res.Code, res.RawLog)
	}

	// ブロックに含まれるのを待機（最大60秒）
	txHash, _ := hex.DecodeString(res.TxHash)
	for i := 0; i < 20; i++ {
		time.Sleep(3 * time.Second)
		txRes, err := clientCtx.Client.Tx(context.Background(), txHash, false)
		if err == nil {
			if txRes.TxResult.Code != 0 {
				return &sdk.TxResponse{TxHash: res.TxHash, Code: txRes.TxResult.Code, RawLog: txRes.TxResult.Log},
					fmt.Errorf("tx execution failed (code %d): %s", txRes.TxResult.Code, txRes.TxResult.Log)
			}
			return &sdk.TxResponse{TxHash: res.TxHash, Code: 0}, nil
		}
	}

	return res, fmt.Errorf("tx confirmation timeout: %s", res.TxHash)
}

func abortSession(clientCtx client.Context, session *types.Session, reason string) error {
	msg := &types.MsgAbortAndCloseSession{
		Executor:  session.Executor,
		SessionId: session.SessionId,
		Reason:    reason,
	}
	txf, err := prepareFactory(clientCtx, session.Executor)
	if err != nil {
		return err
	}
	_, err = broadcastAndConfirm(clientCtx, txf, msg)
	return err
}