package keeper

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"gwc/x/gateway/types"

	sdk "github.com/cosmos/cosmos-sdk/types"
)

const defaultDeadlineSeconds int64 = 24 * 60 * 60 // TODO: move to params in Issue11

func (k msgServer) InitSession(goCtx context.Context, msg *types.MsgInitSession) (*types.MsgInitSessionResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	// session_id: deterministic, unique enough (owner + blocktime nanos)
	sessionID := fmt.Sprintf("%s-%d", msg.Owner, ctx.BlockTime().UnixNano())

	// deadline resolution
	var deadlineUnix int64
	if msg.DeadlineUnix == 0 {
		deadlineUnix = ctx.BlockTime().Add(time.Duration(defaultDeadlineSeconds) * time.Second).Unix()
	} else {
		deadlineUnix = msg.DeadlineUnix
	}

	// upload token: deterministic token derived from session_id (no consensus randomness)
	// token_plain = hex(sha256("upload_token:"+sessionID))
	sum := sha256.Sum256([]byte("upload_token:" + sessionID))
	tokenPlain := hex.EncodeToString(sum[:])

	// store token hash (never store plaintext token)
	tokenHash := sha256.Sum256([]byte(tokenPlain))
	if err := k.Keeper.SetUploadTokenHash(ctx, sessionID, tokenHash[:]); err != nil {
		return nil, err
	}

	// create session
	sess := types.Session{
		SessionId:        sessionID,
		Owner:            msg.Owner,
		Executor:         msg.Executor,
		RootProofHex:     "",
		FragmentSize:     msg.FragmentSize,
		DeadlineUnix:     deadlineUnix,
		State:            types.SessionState_SESSION_STATE_INIT,
		CloseReason:      "",
		DistributedCount: 0,
		AckSuccessCount:  0,
		AckErrorCount:    0,
	}
	if err := k.Keeper.SetSession(ctx, sess); err != nil {
		return nil, err
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"csu_init_session",
			sdk.NewAttribute("session_id", sessionID),
			sdk.NewAttribute("owner", msg.Owner),
			sdk.NewAttribute("executor", msg.Executor),
			sdk.NewAttribute("fragment_size", fmt.Sprintf("%d", msg.FragmentSize)),
			sdk.NewAttribute("deadline_unix", fmt.Sprintf("%d", deadlineUnix)),
		),
	)

	return &types.MsgInitSessionResponse{
		SessionId:            sessionID,
		SessionUploadToken:   tokenPlain,
		ResolvedDeadlineUnix: deadlineUnix,
	}, nil
}
