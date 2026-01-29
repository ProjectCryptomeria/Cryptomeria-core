package keeper

import (
	"context"

	"gwc/x/gateway/types"

	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
)

func (k msgServer) AbortAndCloseSession(goCtx context.Context, msg *types.MsgAbortAndCloseSession) (*types.MsgAbortAndCloseSessionResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	// [LOG: CSU Phase 7] 中断・クローズ要求開始
	ctx.Logger().Info("CSU Phase 7: Abort Requested",
		"session_id", msg.SessionId,
		"reason", msg.Reason,
		"executor", msg.Executor,
	)

	sess, err := k.Keeper.MustGetSession(ctx, msg.SessionId)
	if err != nil {
		return nil, errorsmod.Wrap(types.ErrSessionNotFound, err.Error())
	}

	// Executor mismatch check
	if sess.Executor != msg.Executor {
		return nil, errorsmod.Wrapf(types.ErrExecutorMismatch, "executor mismatch: session.executor=%s msg.executor=%s", sess.Executor, msg.Executor)
	}

	// Authz check
	if err := k.Keeper.RequireSessionBoundAuthz(ctx, sess, msg.Executor, msg.SessionId, types.MsgTypeURLAbortAndCloseSession); err != nil {
		return nil, err
	}

	// Check if already closed
	if sess.State == types.SessionState_SESSION_STATE_CLOSED_SUCCESS || sess.State == types.SessionState_SESSION_STATE_CLOSED_FAILED {
		return nil, errorsmod.Wrap(types.ErrSessionClosed, "session is already closed")
	}

	// Update State to CLOSED_FAILED immediately
	sess.State = types.SessionState_SESSION_STATE_CLOSED_FAILED
	sess.CloseReason = msg.Reason

	if err := k.Keeper.SetSession(ctx, sess); err != nil {
		return nil, err
	}

	// CRITICAL: Revoke Authz and Feegrant grants.
	// The session is dead, so the permissions must die with it.
	k.Keeper.RevokeCSUGrants(ctx, sess.Owner)

	// [LOG: CSU Phase 7] 権限剥奪・クローズ完了
	ctx.Logger().Info("CSU Phase 7: Authz/Feegrant Revoked", "owner", sess.Owner)
	ctx.Logger().Info("CSU Phase 7: Session Closed (Failed)", "session_id", msg.SessionId)

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"csu_session_aborted",
			sdk.NewAttribute("session_id", msg.SessionId),
			sdk.NewAttribute("reason", msg.Reason),
			sdk.NewAttribute("executor", msg.Executor),
		),
	)

	return &types.MsgAbortAndCloseSessionResponse{}, nil
}
