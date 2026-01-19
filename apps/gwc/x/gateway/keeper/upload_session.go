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
	// uploadSessionTimeoutSeconds is used when sending the manifest packet after all fragments are ACKed.
	uploadSessionTimeoutSeconds = 600
)

// InitUploadSession stores the manifest (as base64(packet_bytes)) and the remaining ACK count.
// The session is keyed by uploadID, which is computed deterministically from the upload input.
func (k Keeper) InitUploadSession(ctx sdk.Context, uploadID string, mdscChannel string, pending uint64, manifestPacketBytes []byte) error {
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
// It returns the remaining count after decrement. If the session does not exist, it returns (0, false, nil).
func (k Keeper) ConsumeFragmentAck(ctx sdk.Context, uploadID string) (remaining uint64, exists bool, err error) {
	pendingStr, err := k.UploadSessionPending.Get(ctx, uploadID)
	if err != nil {
		// session missing
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
// It is safe to call multiple times; on success it cleans up the session data.
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
		// fallback to current configured channel if missing
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

	// cleanup after successful send
	k.FailUploadSession(ctx, uploadID)
	return nil
}
