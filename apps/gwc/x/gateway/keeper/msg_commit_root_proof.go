package keeper

import (
	"context"
	"encoding/hex"

	"gwc/x/gateway/types"

	errorsmod "cosmossdk.io/errors"

	sdk "github.com/cosmos/cosmos-sdk/types"
)

func (k msgServer) CommitRootProof(goCtx context.Context, msg *types.MsgCommitRootProof) (*types.MsgCommitRootProofResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	// [LOG: CSU Phase 2] RootProofコミット要求受信
	ctx.Logger().Info("CSU Phase 2: CommitRootProof Received", "session_id", msg.SessionId, "owner", msg.Owner)

	sess, err := k.Keeper.MustGetSession(ctx, msg.SessionId)
	if err != nil {
		return nil, errorsmod.Wrap(types.ErrSessionNotFound, err.Error())
	}

	// owner must match
	if sess.Owner != msg.Owner {
		ctx.Logger().Error("CSU Phase 2: Owner Mismatch", "session_owner", sess.Owner, "msg_owner", msg.Owner)
		return nil, errorsmod.Wrapf(types.ErrInvalidSigner, "owner mismatch: session.owner=%s msg.owner=%s", sess.Owner, msg.Owner)
	}

	// cannot modify closed sessions
	if sess.State == types.SessionState_SESSION_STATE_CLOSED_SUCCESS || sess.State == types.SessionState_SESSION_STATE_CLOSED_FAILED {
		return nil, errorsmod.Wrap(types.ErrSessionClosed, "session is closed")
	}

	// only INIT allowed
	if sess.State != types.SessionState_SESSION_STATE_INIT {
		return nil, errorsmod.Wrapf(types.ErrSessionInvalidState, "invalid state for commit_root_proof: %s", sess.State.String())
	}

	// validate hex root proof
	if _, err := hex.DecodeString(msg.RootProofHex); err != nil {
		ctx.Logger().Error("CSU Phase 2: Invalid Hex", "root_proof", msg.RootProofHex)
		return nil, errorsmod.Wrap(types.ErrInvalidRootProof, "root_proof_hex is not valid hex")
	}

	sess.RootProofHex = msg.RootProofHex
	sess.State = types.SessionState_SESSION_STATE_ROOT_COMMITTED

	if err := k.Keeper.SetSession(ctx, sess); err != nil {
		return nil, err
	}

	// [LOG: CSU Phase 2] RootProofコミット完了・状態遷移
	ctx.Logger().Info("CSU Phase 2: RootProof Committed",
		"session_id", msg.SessionId,
		"root_proof", msg.RootProofHex,
		"state", "ROOT_COMMITTED",
	)

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"csu_commit_root_proof",
			sdk.NewAttribute("session_id", msg.SessionId),
			sdk.NewAttribute("owner", msg.Owner),
			sdk.NewAttribute("root_proof", msg.RootProofHex),
		),
	)

	return &types.MsgCommitRootProofResponse{}, nil
}
