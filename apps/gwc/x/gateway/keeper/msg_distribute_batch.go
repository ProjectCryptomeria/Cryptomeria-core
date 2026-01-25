package keeper

import (
	"context"
	"fmt"

	"gwc/x/gateway/types"

	"cosmossdk.io/collections"
	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
	clienttypes "github.com/cosmos/ibc-go/v10/modules/core/02-client/types"
)

const fragmentTimeoutSeconds = 600

func (k msgServer) DistributeBatch(goCtx context.Context, msg *types.MsgDistributeBatch) (*types.MsgDistributeBatchResponse, error) {
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

	sess, err := k.Keeper.MustGetSession(ctx, msg.SessionId)
	if err != nil {
		return nil, errorsmod.Wrap(types.ErrSessionNotFound, err.Error())
	}

	// executor must match session.executor
	if sess.Executor != msg.Executor {
		return nil, errorsmod.Wrapf(types.ErrExecutorMismatch, "executor mismatch: session.executor=%s msg.executor=%s", sess.Executor, msg.Executor)
	}

	// Issue8: require session-bound authz grant for DistributeBatch
	if err := k.Keeper.RequireSessionBoundAuthz(ctx, sess, msg.Executor, msg.SessionId, types.MsgTypeURLDistributeBatch); err != nil {
		return nil, err
	}

	// closed sessions reject
	if sess.State == types.SessionState_SESSION_STATE_CLOSED_SUCCESS || sess.State == types.SessionState_SESSION_STATE_CLOSED_FAILED {
		return nil, errorsmod.Wrap(types.ErrSessionClosed, "session is closed")
	}

	// root proof must be committed
	if sess.State != types.SessionState_SESSION_STATE_ROOT_COMMITTED && sess.State != types.SessionState_SESSION_STATE_DISTRIBUTING {
		return nil, errorsmod.Wrapf(types.ErrSessionInvalidState, "invalid state for distribute_batch: %s", sess.State.String())
	}
	if sess.RootProofHex == "" {
		return nil, errorsmod.Wrap(types.ErrRootProofNotCommitted, "root proof not committed")
	}

	// limits: max_fragments_per_session (Issue11)
	if params.MaxFragmentsPerSession > 0 {
		after := sess.DistributedCount + uint64(len(msg.Items))
		if after > params.MaxFragmentsPerSession {
			return nil, errorsmod.Wrapf(
				types.ErrLimitExceeded,
				"max_fragments_per_session exceeded: current=%d incoming=%d max=%d",
				sess.DistributedCount,
				len(msg.Items),
				params.MaxFragmentsPerSession,
			)
		}
	}

	// gather FDSC channels
	var fdscChannels []string
	iter, err := k.Keeper.DatastoreChannels.Iterate(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer iter.Close()

	for ; iter.Valid(); iter.Next() {
		ch, _ := iter.Key()
		fdscChannels = append(fdscChannels, ch)
	}
	if len(fdscChannels) == 0 {
		return nil, errorsmod.Wrap(types.ErrNoDatastoreChannels, "no FDSC channels registered")
	}

	// quick membership check map (Issue1 target_fdsc_channel optional)
	fdscSet := make(map[string]struct{}, len(fdscChannels))
	for _, ch := range fdscChannels {
		fdscSet[ch] = struct{}{}
	}

	// local duplicate detection within the same batch
	localSeen := make(map[string]struct{}, len(msg.Items))

	roundRobin := 0
	for i := range msg.Items {
		item := &msg.Items[i]
		fragKey := MakeFragKey(msg.SessionId, item.Path, item.Index)

		// limits: max_fragment_bytes (Issue11)
		if params.MaxFragmentBytes > 0 && uint64(len(item.FragmentBytes)) > params.MaxFragmentBytes {
			return nil, errorsmod.Wrapf(
				types.ErrLimitExceeded,
				"fragment_bytes exceeds max_fragment_bytes: len=%d max=%d (path=%s index=%d)",
				len(item.FragmentBytes),
				params.MaxFragmentBytes,
				item.Path,
				item.Index,
			)
		}

		// local duplicates in batch
		if _, ok := localSeen[fragKey]; ok {
			return nil, errorsmod.Wrapf(types.ErrDuplicateFragment, "duplicate fragment in batch: %s", fragKey)
		}
		localSeen[fragKey] = struct{}{}

		// global duplicates in state
		already, err := k.Keeper.SessionFragmentSeen.Has(ctx, fragKey)
		if err != nil {
			return nil, err
		}
		if already {
			return nil, errorsmod.Wrapf(types.ErrDuplicateFragment, "duplicate fragment: %s", fragKey)
		}

		// layer4: verify_fragment MUST pass
		if err := VerifyFragment(sess.RootProofHex, item); err != nil {
			return nil, errorsmod.Wrapf(types.ErrInvalidProof, "verify_fragment failed: %v", err)
		}

		packetData := types.GatewayPacketData{
			Packet: &types.GatewayPacketData_FragmentPacket{
				FragmentPacket: &types.FragmentPacket{
					SessionId: msg.SessionId,
					RootProof: sess.RootProofHex,
					Path:      item.Path,
					Index:     item.Index,
					Data:      item.FragmentBytes,
				},
			},
		}

		timeoutTimestamp := uint64(ctx.BlockTime().UnixNano()) + uint64(fragmentTimeoutSeconds*1_000_000_000)

		// routing (Issue1):
		// - if item.target_fdsc_channel is specified, use it (must be registered)
		// - otherwise, round-robin across registered datastore channels
		targetChannel := ""
		if item.TargetFdscChannel != "" {
			if _, ok := fdscSet[item.TargetFdscChannel]; !ok {
				return nil, errorsmod.Wrapf(types.ErrUnknownDatastoreChannel, "unknown target_fdsc_channel: %s", item.TargetFdscChannel)
			}
			targetChannel = item.TargetFdscChannel
		} else {
			targetChannel = fdscChannels[roundRobin%len(fdscChannels)]
			roundRobin++
		}

		seq, err := k.Keeper.TransmitGatewayPacketData(ctx, packetData, "gateway", targetChannel, clienttypes.ZeroHeight(), timeoutTimestamp)
		if err != nil {
			return nil, err
		}

		// bind seq -> frag_key for ACK correlation (Issue5)
		if err := k.Keeper.BindFragmentSeq(ctx, seq, msg.SessionId, item.Path, item.Index); err != nil {
			return nil, err
		}

		// mark seen to prevent duplicates
		if err := k.Keeper.SessionFragmentSeen.Set(ctx, fragKey); err != nil {
			return nil, err
		}

		sess.DistributedCount++
	}

	// move to DISTRIBUTING if first time
	if sess.State == types.SessionState_SESSION_STATE_ROOT_COMMITTED {
		sess.State = types.SessionState_SESSION_STATE_DISTRIBUTING
	}

	if err := k.Keeper.SetSession(ctx, sess); err != nil {
		return nil, err
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"csu_distribute_batch",
			sdk.NewAttribute("session_id", msg.SessionId),
			sdk.NewAttribute("executor", msg.Executor),
			sdk.NewAttribute("items", fmt.Sprintf("%d", len(msg.Items))),
			sdk.NewAttribute("distributed_total", fmt.Sprintf("%d", sess.DistributedCount)),
		),
	)

	return &types.MsgDistributeBatchResponse{}, nil
}
