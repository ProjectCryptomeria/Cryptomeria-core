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

	sess, err := k.Keeper.MustGetSession(ctx, msg.SessionId)
	if err != nil {
		return nil, errorsmod.Wrap(types.ErrSessionNotFound, err.Error())
	}

	// executor must match session.executor
	if sess.Executor != msg.Executor {
		return nil, errorsmod.Wrapf(types.ErrExecutorMismatch, "executor mismatch: session.executor=%s msg.executor=%s", sess.Executor, msg.Executor)
	}

	// Issue8: require session-bound authz grant for Finalize
	if err := k.Keeper.RequireSessionBoundAuthz(ctx, sess, msg.Executor, msg.SessionId, types.MsgTypeURLFinalizeAndCloseSession); err != nil {
		return nil, err
	}

	// closed sessions reject
	if sess.State == types.SessionState_SESSION_STATE_CLOSED_SUCCESS || sess.State == types.SessionState_SESSION_STATE_CLOSED_FAILED {
		return nil, errorsmod.Wrap(types.ErrSessionClosed, "session is closed")
	}

	// must have root proof committed
	if sess.RootProofHex == "" || (sess.State != types.SessionState_SESSION_STATE_ROOT_COMMITTED && sess.State != types.SessionState_SESSION_STATE_DISTRIBUTING) {
		return nil, errorsmod.Wrap(types.ErrRootProofNotCommitted, "root proof not committed or invalid state")
	}

	// validate manifest identity + root_proof match
	manifest := msg.Manifest
	if manifest.SessionId != msg.SessionId {
		return nil, errorsmod.Wrapf(types.ErrInvalidManifest, "manifest.session_id mismatch: %s != %s", manifest.SessionId, msg.SessionId)
	}
	if manifest.Owner != sess.Owner {
		return nil, errorsmod.Wrapf(types.ErrInvalidManifest, "manifest.owner mismatch: %s != %s", manifest.Owner, sess.Owner)
	}
	if manifest.RootProof != sess.RootProofHex {
		return nil, errorsmod.Wrapf(types.ErrInvalidManifest, "manifest.root_proof mismatch: %s != %s", manifest.RootProof, sess.RootProofHex)
	}
	if manifest.FragmentSize != sess.FragmentSize {
		return nil, errorsmod.Wrapf(types.ErrInvalidManifest, "manifest.fragment_size mismatch: %d != %d", manifest.FragmentSize, sess.FragmentSize)
	}

	// obtain MDSC channel
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

	// bind seq -> session_id for MDSC ACK correlation (Issue5)
	if err := k.Keeper.BindManifestSeq(ctx, seq, msg.SessionId); err != nil {
		return nil, err
	}

	// Issue6: Close処理同Tx統合（少なくとも state を Finalizing にし、以後の操作を拒否）
	sess.State = types.SessionState_SESSION_STATE_FINALIZING
	if err := k.Keeper.SetSession(ctx, sess); err != nil {
		return nil, err
	}

	// Issue6/7: revoke authz + feegrant on Close tx (best-effort revoke)
	k.Keeper.RevokeCSUGrants(ctx, sess.Owner)

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"csu_finalize_sent",
			sdk.NewAttribute("session_id", msg.SessionId),
			sdk.NewAttribute("executor", msg.Executor),
			sdk.NewAttribute("mdsc_channel", mdscChannel),
			sdk.NewAttribute("manifest_seq", fmt.Sprintf("%d", seq)),
		),
	)

	return &types.MsgFinalizeAndCloseSessionResponse{}, nil
}
