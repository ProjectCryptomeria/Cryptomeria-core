package keeper

import (
	"context"

	"gwc/x/gateway/types"

	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
)

func (k msgServer) AbortAndCloseSession(goCtx context.Context, msg *types.MsgAbortAndCloseSession) (*types.MsgAbortAndCloseSessionResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	sess, err := k.Keeper.MustGetSession(ctx, msg.SessionId)
	if err != nil {
		return nil, errorsmod.Wrap(types.ErrSessionNotFound, err.Error())
	}

	// executor must match session.executor
	if sess.Executor != msg.Executor {
		return nil, errorsmod.Wrapf(types.ErrExecutorMismatch, "executor mismatch: session.executor=%s msg.executor=%s", sess.Executor, msg.Executor)
	}

	// Issue8: require session-bound authz grant for Abort
	if err := k.Keeper.RequireSessionBoundAuthz(ctx, sess, msg.Executor, msg.SessionId, types.MsgTypeURLAbortAndCloseSession); err != nil {
		return nil, err
	}

	// already closed -> reject
	if sess.State == types.SessionState_SESSION_STATE_CLOSED_SUCCESS || sess.State == types.SessionState_SESSION_STATE_CLOSED_FAILED {
		return nil, errorsmod.Wrap(types.ErrSessionClosed, "session is closed")
	}

	// Issue6: close immediately (failure)
	sess.State = types.SessionState_SESSION_STATE_CLOSED_FAILED
	sess.CloseReason = msg.Reason

	if err := k.Keeper.SetSession(ctx, sess); err != nil {
		return nil, err
	}

	// Issue6/7: revoke authz + feegrant on Close tx (best-effort revoke)
	k.Keeper.RevokeCSUGrants(ctx, sess.Owner)

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"csu_abort_close",
			sdk.NewAttribute("session_id", msg.SessionId),
			sdk.NewAttribute("executor", msg.Executor),
			sdk.NewAttribute("reason", msg.Reason),
		),
	)

	return &types.MsgAbortAndCloseSessionResponse{}, nil
}
