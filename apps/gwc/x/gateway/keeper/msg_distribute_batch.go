package keeper

import (
	"context"
	"fmt"
	"sort"

	"gwc/x/gateway/types"

	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
	clienttypes "github.com/cosmos/ibc-go/v10/modules/core/02-client/types"
)

const fragmentTimeoutSeconds = 600

func (k msgServer) DistributeBatch(goCtx context.Context, msg *types.MsgDistributeBatch) (*types.MsgDistributeBatchResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	// [LOG: CSU Phase 5]
	fmt.Printf("🔵 [KEEPER] CSU Phase 5: DistributeBatch Started | SessionID: %s | Items: %d\n", msg.SessionId, len(msg.Items))

	params := k.Keeper.getParamsOrDefault(ctx)

	sess, err := k.Keeper.MustGetSession(ctx, msg.SessionId)
	if err != nil {
		return nil, errorsmod.Wrap(types.ErrSessionNotFound, err.Error())
	}

	if sess.Executor != msg.Executor {
		return nil, errorsmod.Wrapf(types.ErrExecutorMismatch, "executor mismatch")
	}

	if err := k.Keeper.RequireSessionBoundAuthz(ctx, sess, msg.Executor, msg.SessionId, types.MsgTypeURLDistributeBatch); err != nil {
		fmt.Printf("❌ [KEEPER] Authz Failed\n")
		return nil, err
	}

	if sess.State == types.SessionState_SESSION_STATE_CLOSED_SUCCESS || sess.State == types.SessionState_SESSION_STATE_CLOSED_FAILED {
		return nil, errorsmod.Wrap(types.ErrSessionClosed, "session is closed")
	}

	if params.MaxFragmentsPerSession > 0 {
		after := sess.DistributedCount + uint64(len(msg.Items))
		if after > params.MaxFragmentsPerSession {
			return nil, errorsmod.Wrap(types.ErrLimitExceeded, "max_fragments_per_session exceeded")
		}
	}

	var fdscChannels []string
	iter, _ := k.Keeper.DatastoreChannels.Iterate(ctx, nil)
	defer iter.Close()
	for ; iter.Valid(); iter.Next() {
		ch, _ := iter.Key()
		fdscChannels = append(fdscChannels, ch)
	}
	if len(fdscChannels) == 0 {
		return nil, errorsmod.Wrap(types.ErrNoDatastoreChannels, "no FDSC channels")
	}

	// 決定論的な順序にするためチャンネル名をソート
	sort.Strings(fdscChannels)

	// 指定された数に制限
	if sess.NumFdscChains > 0 && uint32(len(fdscChannels)) > sess.NumFdscChains {
		fdscChannels = fdscChannels[:sess.NumFdscChains]
	}

	fdscSet := make(map[string]struct{})
	for _, ch := range fdscChannels {
		fdscSet[ch] = struct{}{}
	}

	roundRobin := 0
	for i := range msg.Items {
		item := &msg.Items[i]
		fragKey := MakeFragKey(msg.SessionId, item.Path, item.Index)

		if params.MaxFragmentBytes > 0 && uint64(len(item.FragmentBytes)) > params.MaxFragmentBytes {
			return nil, errorsmod.Wrap(types.ErrLimitExceeded, "fragment too large")
		}

		already, _ := k.Keeper.SessionFragmentSeen.Has(ctx, fragKey)
		if already {
			return nil, errorsmod.Wrap(types.ErrDuplicateFragment, "duplicate fragment")
		}

		if err := VerifyFragment(sess.RootProofHex, item); err != nil {
			fmt.Printf("❌ [KEEPER] Merkle Verify Failed | Path: %s | Index: %d | Err: %v\n", item.Path, item.Index, err)
			return nil, errorsmod.Wrap(types.ErrInvalidProof, err.Error())
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

		targetChannel := ""
		if item.TargetFdscChannel != "" {
			if _, ok := fdscSet[item.TargetFdscChannel]; !ok {
				// 制限外のチャンネルが明示指定された場合はエラー
				return nil, errorsmod.Wrap(types.ErrUnknownDatastoreChannel, "target channel is not allowed for this session")
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

		_ = k.Keeper.BindFragmentSeq(ctx, seq, msg.SessionId, item.Path, item.Index)
		_ = k.Keeper.SessionFragmentSeen.Set(ctx, fragKey)
		sess.DistributedCount++
	}

	if sess.State == types.SessionState_SESSION_STATE_ROOT_COMMITTED {
		sess.State = types.SessionState_SESSION_STATE_DISTRIBUTING
	}

	_ = k.Keeper.SetSession(ctx, sess)

	// [LOG: CSU Phase 5]
	fmt.Printf("🟢 [KEEPER] CSU Phase 5: Batch Distributed | Count: %d | State: %s\n", len(msg.Items), sess.State.String())

	return &types.MsgDistributeBatchResponse{}, nil
}
