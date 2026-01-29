package keeper

import (
	"context"
	"fmt"

	"gwc/x/gateway/types"

	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
	clienttypes "github.com/cosmos/ibc-go/v10/modules/core/02-client/types"
)

const manifestTimeoutSeconds = 600

func (k msgServer) FinalizeAndCloseSession(goCtx context.Context, msg *types.MsgFinalizeAndCloseSession) (*types.MsgFinalizeAndCloseSessionResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	// [LOG: CSU Phase 6]
	fmt.Printf("🔵 [KEEPER] CSU Phase 6: Finalize Requested | SessionID: %s\n", msg.SessionId)

	sess, err := k.Keeper.MustGetSession(ctx, msg.SessionId)
	if err != nil {
		return nil, errorsmod.Wrap(types.ErrSessionNotFound, err.Error())
	}

	if sess.Executor != msg.Executor {
		return nil, errorsmod.Wrapf(types.ErrExecutorMismatch, "executor mismatch: session.executor=%s msg.executor=%s", sess.Executor, msg.Executor)
	}

	if err := k.Keeper.RequireSessionBoundAuthz(ctx, sess, msg.Executor, msg.SessionId, types.MsgTypeURLFinalizeAndCloseSession); err != nil {
		return nil, err
	}

	if sess.State == types.SessionState_SESSION_STATE_CLOSED_SUCCESS || sess.State == types.SessionState_SESSION_STATE_CLOSED_FAILED {
		return nil, errorsmod.Wrap(types.ErrSessionClosed, "session is closed")
	}

	if sess.RootProofHex == "" || (sess.State != types.SessionState_SESSION_STATE_ROOT_COMMITTED && sess.State != types.SessionState_SESSION_STATE_DISTRIBUTING) {
		return nil, errorsmod.Wrap(types.ErrRootProofNotCommitted, "root proof not committed or invalid state")
	}

	manifest := msg.Manifest
	if manifest.SessionId != msg.SessionId {
		return nil, errorsmod.Wrapf(types.ErrInvalidManifest, "manifest.session_id mismatch")
	}
	if manifest.Owner != sess.Owner {
		return nil, errorsmod.Wrapf(types.ErrInvalidManifest, "manifest.owner mismatch")
	}
	if manifest.RootProof != sess.RootProofHex {
		return nil, errorsmod.Wrapf(types.ErrInvalidManifest, "manifest.root_proof mismatch")
	}
	if manifest.FragmentSize != sess.FragmentSize {
		return nil, errorsmod.Wrapf(types.ErrInvalidManifest, "manifest.fragment_size mismatch")
	}

	mdscChannel, err := k.Keeper.MetastoreChannel.Get(ctx)
	if err != nil || mdscChannel == "" {
		return nil, errorsmod.Wrap(types.ErrNoMetastoreChannel, "MDSC channel not found")
	}

	packetData := types.GatewayPacketData{
		Packet: &types.GatewayPacketData_ManifestPacket{
			ManifestPacket: &manifest,
		},
	}
	timeoutTimestamp := uint64(ctx.BlockTime().UnixNano()) + uint64(manifestTimeoutSeconds*1_000_000_000)
	seq, err := k.Keeper.TransmitGatewayPacketData(ctx, packetData, "gateway", mdscChannel, clienttypes.ZeroHeight(), timeoutTimestamp)
	if err != nil {
		return nil, err
	}

	fmt.Printf("🟢 [KEEPER] CSU Phase 6: Manifest Packet Sent | Seq: %d | Channel: %s\n", seq, mdscChannel)

	if err := k.Keeper.BindManifestSeq(ctx, seq, msg.SessionId); err != nil {
		return nil, err
	}

	sess.State = types.SessionState_SESSION_STATE_FINALIZING
	if err := k.Keeper.SetSession(ctx, sess); err != nil {
		return nil, err
	}

	k.Keeper.RevokeCSUGrants(ctx, sess.Owner)

	// [LOG: CSU Phase 6]
	fmt.Printf("🟢 [KEEPER] CSU Phase 6: Authz/Feegrant Revoked & Session Closed (Pending ACK) | Owner: %s\n", sess.Owner)

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"csu_finalize_sent",
			sdk.NewAttribute("session_id", msg.SessionId),
			sdk.NewAttribute("executor", msg.Executor),
			sdk.NewAttribute("manifest_seq", fmt.Sprintf("%d", seq)),
		),
	)

	return &types.MsgFinalizeAndCloseSessionResponse{}, nil
}
