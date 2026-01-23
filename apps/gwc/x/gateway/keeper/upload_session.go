package keeper

import (
	"encoding/base64"
	"fmt"
	"strconv"

	sdk "github.com/cosmos/cosmos-sdk/types"
	clienttypes "github.com/cosmos/ibc-go/v10/modules/core/02-client/types"

	"gwc/x/gateway/types"
)

const (
	uploadSessionTimeoutSeconds = 600
	StateUploading = "UPLOADING"
	StatePendingSign = "PENDING_SIGN"
)

// --- Phase 1: Interactive Upload Session Management ---

func (k Keeper) CreateUploadSession(ctx sdk.Context, uploadID string) error {
	return k.UploadSessionState.Set(ctx, uploadID, StateUploading)
}

func (k Keeper) AppendUploadChunk(ctx sdk.Context, uploadID string, data []byte) error {
	state, err := k.UploadSessionState.Get(ctx, uploadID)
	if err != nil || state != StateUploading {
		return fmt.Errorf("session not in uploading state or does not exist")
	}

	// Note: For PoC, simple append. Ideally, store by index to handle out-of-order.
	// Current assumption: Client sends chunks in order.
	currentData, _ := k.UploadSessionBuffer.Get(ctx, uploadID) // Ignore error if empty
	newData := append(currentData, data...)
	
	return k.UploadSessionBuffer.Set(ctx, uploadID, newData)
}

func (k Keeper) GetUploadSessionBuffer(ctx sdk.Context, uploadID string) ([]byte, error) {
	return k.UploadSessionBuffer.Get(ctx, uploadID)
}

func (k Keeper) SetSessionPendingSign(ctx sdk.Context, uploadID string, manifestBytes []byte, siteRoot string) error {
	if err := k.UploadSessionState.Set(ctx, uploadID, StatePendingSign); err != nil {
		return err
	}
	
	// Store result for verification later
	res := uploadID + "|" + siteRoot + "|" + base64.StdEncoding.EncodeToString(manifestBytes)
	return k.UploadSessionResult.Set(ctx, uploadID, res)
}

func (k Keeper) GetSessionPendingResult(ctx sdk.Context, uploadID string) (string, []byte, error) {
	state, err := k.UploadSessionState.Get(ctx, uploadID)
	if err != nil || state != StatePendingSign {
		return "", nil, fmt.Errorf("session not in pending_sign state")
	}

	val, err := k.UploadSessionResult.Get(ctx, uploadID)
	if err != nil {
		return "", nil, err
	}

	// Simple parse "ID|ROOT|B64Manifest"
	parts := splitOnce(val, "|") // Simplified logic, use proper struct in prod
	// Implement simple split logic assuming format is correct
	// Go split:
	var siteRoot, b64Manifest string
	// Manual split for safety
	firstPipe := 0
	for i, c := range val {
		if c == '|' {
			firstPipe = i
			break
		}
	}
	if firstPipe == 0 { return "", nil, fmt.Errorf("corrupted session data") }
	
	remaining := val[firstPipe+1:]
	secondPipe := 0
	for i, c := range remaining {
		if c == '|' {
			secondPipe = i
			break
		}
	}
	if secondPipe == 0 { return "", nil, fmt.Errorf("corrupted session data") }
	
	siteRoot = remaining[:secondPipe]
	b64Manifest = remaining[secondPipe+1:]

	manifestBytes, err := base64.StdEncoding.DecodeString(b64Manifest)
	return siteRoot, manifestBytes, err
}

func splitOnce(s, sep string) []string {
	// Dummy helper, logic implemented inline above for specific format
	return nil
}

// Clean up session data
func (k Keeper) CleanupUploadSession(ctx sdk.Context, uploadID string) {
	_ = k.UploadSessionState.Remove(ctx, uploadID)
	_ = k.UploadSessionBuffer.Remove(ctx, uploadID)
	_ = k.UploadSessionResult.Remove(ctx, uploadID)
	// Config, etc.
}

// --- Phase 2: IBC Waiter Logic (Legacy compatible) ---

// InitUploadSession stores the manifest (as base64(packet_bytes)) and the remaining ACK count.
func (k Keeper) InitIBCWaitSession(ctx sdk.Context, uploadID string, mdscChannel string, pending uint64, manifestPacketBytes []byte) error {
	pendingStr := strconv.FormatUint(pending, 10)
	manifestB64 := base64.StdEncoding.EncodeToString(manifestPacketBytes)

	if err := k.UploadSessionPending.Set(ctx, uploadID, pendingStr); err != nil {
		return fmt.Errorf("failed to store upload session pending: %w", err)
	}
	if err := k.UploadSessionManifest.Set(ctx, uploadID, manifestB64); err != nil {
		return fmt.Errorf("failed to store upload session manifest: %w", err)
	}
	if err := k.UploadSessionMDSCChannel.Set(ctx, uploadID, mdscChannel); err != nil {
		return fmt.Errorf("failed to store upload session mdsc channel: %w", err)
	}
	return nil
}

// ConsumeFragmentAck decrements the remaining ACK count for the upload session.
func (k Keeper) ConsumeFragmentAck(ctx sdk.Context, uploadID string) (remaining uint64, exists bool, err error) {
	pendingStr, err := k.UploadSessionPending.Get(ctx, uploadID)
	if err != nil {
		return 0, false, nil
	}
	pending, err := strconv.ParseUint(pendingStr, 10, 64)
	if err != nil {
		return 0, true, fmt.Errorf("invalid pending count for upload session %s: %w", uploadID, err)
	}

	if pending == 0 {
		return 0, true, nil
	}
	pending--
	if err := k.UploadSessionPending.Set(ctx, uploadID, strconv.FormatUint(pending, 10)); err != nil {
		return 0, true, fmt.Errorf("failed to update upload session pending: %w", err)
	}
	return pending, true, nil
}

// FailUploadSession removes session data so the manifest will not be published.
func (k Keeper) FailUploadSession(ctx sdk.Context, uploadID string) {
	_ = k.UploadSessionPending.Remove(ctx, uploadID)
	_ = k.UploadSessionManifest.Remove(ctx, uploadID)
	_ = k.UploadSessionMDSCChannel.Remove(ctx, uploadID)
}

// PublishManifestIfReady publishes the stored manifest packet if the remaining count is 0.
func (k Keeper) PublishManifestIfReady(ctx sdk.Context, uploadID string) error {
	pendingStr, err := k.UploadSessionPending.Get(ctx, uploadID)
	if err != nil {
		return nil
	}
	pending, err := strconv.ParseUint(pendingStr, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid pending count for upload session %s: %w", uploadID, err)
	}
	if pending != 0 {
		return nil
	}

	mdscChannel, err := k.UploadSessionMDSCChannel.Get(ctx, uploadID)
	if err != nil {
		mdscChannel, _ = k.MetastoreChannel.Get(ctx)
	}

	manifestB64, err := k.UploadSessionManifest.Get(ctx, uploadID)
	if err != nil {
		return fmt.Errorf("upload session %s has no stored manifest", uploadID)
	}
	manifestBytes, err := base64.StdEncoding.DecodeString(manifestB64)
	if err != nil {
		return fmt.Errorf("failed to decode stored manifest bytes: %w", err)
	}

	var packetData types.GatewayPacketData
	if err := packetData.Unmarshal(manifestBytes); err != nil {
		return fmt.Errorf("failed to unmarshal stored manifest packet: %w", err)
	}

	timeoutTimestamp := uint64(ctx.BlockTime().UnixNano()) + uint64(uploadSessionTimeoutSeconds*1_000_000_000)
	_, err = k.TransmitGatewayPacketData(
		ctx,
		packetData,
		"gateway",
		mdscChannel,
		clienttypes.ZeroHeight(),
		timeoutTimestamp,
	)
	if err != nil {
		return fmt.Errorf("failed to transmit manifest packet: %w", err)
	}

	k.FailUploadSession(ctx, uploadID)
	return nil
}