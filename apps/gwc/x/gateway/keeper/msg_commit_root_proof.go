package keeper

import (
	"context"
	"encoding/hex"
	"fmt"

	"gwc/x/gateway/types"

	errorsmod "cosmossdk.io/errors"

	sdk "github.com/cosmos/cosmos-sdk/types"
)

func (k msgServer) CommitRootProof(goCtx context.Context, msg *types.MsgCommitRootProof) (*types.MsgCommitRootProofResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	// [LOG: CSU Phase 2]
	fmt.Printf("🔵 [KEEPER] CSU Phase 2: CommitRootProof Received | SessionID: %s\n", msg.SessionId)

	sess, err := k.Keeper.MustGetSession(ctx, msg.SessionId)
	if err != nil {
		return nil, errorsmod.Wrap(types.ErrSessionNotFound, err.Error())
	}

	if sess.Owner != msg.Owner {
		fmt.Printf("❌ [KEEPER] Owner Mismatch: Sess=%s Msg=%s\n", sess.Owner, msg.Owner)
		return nil, errorsmod.Wrapf(types.ErrInvalidSigner, "owner mismatch: session.owner=%s msg.owner=%s", sess.Owner, msg.Owner)
	}

	if sess.State == types.SessionState_SESSION_STATE_CLOSED_SUCCESS || sess.State == types.SessionState_SESSION_STATE_CLOSED_FAILED {
		return nil, errorsmod.Wrap(types.ErrSessionClosed, "session is closed")
	}

	if sess.State != types.SessionState_SESSION_STATE_INIT {
		return nil, errorsmod.Wrapf(types.ErrSessionInvalidState, "invalid state for commit_root_proof: %s", sess.State.String())
	}

	if _, err := hex.DecodeString(msg.RootProofHex); err != nil {
		fmt.Printf("❌ [KEEPER] Invalid RootProof Hex\n")
		return nil, errorsmod.Wrap(types.ErrInvalidRootProof, "root_proof_hex is not valid hex")
	}

	sess.RootProofHex = msg.RootProofHex
	sess.State = types.SessionState_SESSION_STATE_ROOT_COMMITTED

	if err := k.Keeper.SetSession(ctx, sess); err != nil {
		return nil, err
	}

	// [LOG: CSU Phase 2]
	fmt.Printf("🟢 [KEEPER] CSU Phase 2: RootProof Committed | Proof: %s\n", msg.RootProofHex)

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
