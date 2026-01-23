package keeper

import (
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"

	sdk "github.com/cosmos/cosmos-sdk/types"
	clienttypes "github.com/cosmos/ibc-go/v10/modules/core/02-client/types"

	"gwc/x/gateway/types"
)

const (
	uploadSessionTimeoutSeconds = 600
	StateUploading              = "UPLOADING"
	StatePendingSign            = "PENDING_SIGN"
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

	currentData, _ := k.UploadSessionBuffer.Get(ctx, uploadID)
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

	// Store result: ID|ROOT|B64Manifest
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

	// Parse "ID|ROOT|B64Manifest"
	parts := strings.Split(val, "|")
	if len(parts) != 3 {
		return "", nil, fmt.Errorf("corrupted session data format")
	}

	siteRoot := parts[1]
	b64Manifest := parts[2]

	manifestBytes, err := base64.StdEncoding.DecodeString(b64Manifest)
	return siteRoot, manifestBytes, err
}

// Clean up session data
func (k Keeper) CleanupUploadSession(ctx sdk.Context, uploadID string) {
	_ = k.UploadSessionState.Remove(ctx, uploadID)
	_ = k.UploadSessionBuffer.Remove(ctx, uploadID)
	_ = k.UploadSessionResult.Remove(ctx, uploadID)
}

// --- Phase 2: IBC Waiter Logic (Legacy compatible) ---

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

func (k Keeper) FailUploadSession(ctx sdk.Context, uploadID string) {
	_ = k.UploadSessionPending.Remove(ctx, uploadID)
	_ = k.UploadSessionManifest.Remove(ctx, uploadID)
	_ = k.UploadSessionMDSCChannel.Remove(ctx, uploadID)
}

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
