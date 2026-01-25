package keeper

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"gwc/x/gateway/types"

	"cosmossdk.io/collections"
	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
)

func (k msgServer) InitSession(goCtx context.Context, msg *types.MsgInitSession) (*types.MsgInitSessionResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	// Load params (fallback to defaults if not set or zero-filled)
	params, err := k.Keeper.Params.Get(ctx)
	if err != nil {
		if collections.ErrNotFound != nil && err == collections.ErrNotFound {
			params = types.DefaultParams()
		} else {
			params = types.DefaultParams()
		}
	}
	if params.MaxFragmentBytes == 0 || params.MaxFragmentsPerSession == 0 || params.DefaultDeadlineSeconds == 0 {
		params = types.DefaultParams()
	}

	// Enforce local-admin configured (Issue8)
	if params.LocalAdmin == "" {
		return nil, errorsmod.Wrap(types.ErrLocalAdminNotConfigured, "params.local_admin must be set for CSU")
	}

	// Enforce executor fixed to local-admin (Issue8)
	// (Allow client to send executor field, but it must match local-admin.)
	if msg.Executor != "" && msg.Executor != params.LocalAdmin {
		return nil, errorsmod.Wrapf(types.ErrLocalAdminMismatch, "executor must be local-admin: got=%s want=%s", msg.Executor, params.LocalAdmin)
	}
	executor := params.LocalAdmin

	// Enforce fragment_size limit at session creation time (Issue11)
	if params.MaxFragmentBytes > 0 && msg.FragmentSize > params.MaxFragmentBytes {
		return nil, errorsmod.Wrapf(
			types.ErrLimitExceeded,
			"fragment_size exceeds max_fragment_bytes: fragment_size=%d max=%d",
			msg.FragmentSize,
			params.MaxFragmentBytes,
		)
	}

	// session_id: deterministic, unique enough (owner + blocktime nanos)
	sessionID := fmt.Sprintf("%s-%d", msg.Owner, ctx.BlockTime().UnixNano())

	// deadline resolution (Issue11)
	var deadlineUnix int64
	if msg.DeadlineUnix == 0 {
		deadlineUnix = ctx.BlockTime().Add(time.Duration(params.DefaultDeadlineSeconds) * time.Second).Unix()
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
		Executor:         executor,
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
			sdk.NewAttribute("executor", executor),
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
