package keeper

import (
	"context"
	"fmt"

	"gwc/x/gateway/types"

	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
)

func (k msgServer) AbortAndCloseSession(goCtx context.Context, msg *types.MsgAbortAndCloseSession) (*types.MsgAbortAndCloseSessionResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	// [LOG: CSU Phase 7]
	fmt.Printf("🔵 [KEEPER] CSU Phase 7: Abort Requested | SessionID: %s | Reason: %s\n", msg.SessionId, msg.Reason)

	sess, err := k.Keeper.MustGetSession(ctx, msg.SessionId)
	if err != nil {
		return nil, errorsmod.Wrap(types.ErrSessionNotFound, err.Error())
	}

	if sess.Executor != msg.Executor {
		return nil, errorsmod.Wrapf(types.ErrExecutorMismatch, "executor mismatch: session.executor=%s msg.executor=%s", sess.Executor, msg.Executor)
	}

	if err := k.Keeper.RequireSessionBoundAuthz(ctx, sess, msg.Executor, msg.SessionId, types.MsgTypeURLAbortAndCloseSession); err != nil {
		return nil, err
	}

	if sess.State == types.SessionState_SESSION_STATE_CLOSED_SUCCESS || sess.State == types.SessionState_SESSION_STATE_CLOSED_FAILED {
		return nil, errorsmod.Wrap(types.ErrSessionClosed, "session is already closed")
	}

	sess.State = types.SessionState_SESSION_STATE_CLOSED_FAILED
	sess.CloseReason = msg.Reason

	if err := k.Keeper.SetSession(ctx, sess); err != nil {
		return nil, err
	}

	k.Keeper.RevokeCSUGrants(ctx, sess.Owner)

	// [LOG: CSU Phase 7]
	fmt.Printf("🔴 [KEEPER] CSU Phase 7: Session Aborted & Revoked | Owner: %s\n", sess.Owner)

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
