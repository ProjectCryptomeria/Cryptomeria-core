package keeper

import (
	"context"
	"fmt"

	"gwc/x/gateway/types"

	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	clienttypes "github.com/cosmos/ibc-go/v10/modules/core/02-client/types"
	ibckeeper "github.com/cosmos/ibc-go/v10/modules/core/keeper"
)

type msgServer struct {
	Keeper
}

func NewMsgServerImpl(keeper Keeper) types.MsgServer {
	return &msgServer{Keeper: keeper}
}

var _ types.MsgServer = msgServer{}

// RegisterStorage は管理者がストレージエンドポイント（API URL）をオンチェーンに登録・更新するために使用します。
func (k msgServer) RegisterStorage(goCtx context.Context, msg *types.MsgRegisterStorage) (*types.MsgRegisterStorageResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	// 1. ガバナンス権限（authority）の検証
	if msg.Authority != sdk.AccAddress(k.Keeper.authority).String() {
		return nil, errorsmod.Wrapf(sdkerrors.ErrUnauthorized, "invalid authority; expected %s, got %s", sdk.AccAddress(k.Keeper.authority).String(), msg.Authority)
	}

	// 2. ストレージ情報の更新
	for _, info := range msg.StorageInfos {
		if info.ChannelId == "" {
			return nil, errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "channel_id is required")
		}

		// 既存の情報を取得（IBCで登録済みの ChainId 等を保持するため）
		existing, err := k.Keeper.StorageInfos.Get(ctx, info.ChannelId)
		if err == nil {
			// ApiEndpoint 等、提供されたフィールドのみを上書き更新します
			if info.ApiEndpoint != "" {
				existing.ApiEndpoint = info.ApiEndpoint
			}
			if info.ChainId != "" {
				existing.ChainId = info.ChainId
			}
			if info.ConnectionType != "" {
				existing.ConnectionType = info.ConnectionType
			}
			info = &existing
		}

		if err := k.Keeper.StorageInfos.Set(ctx, info.ChannelId, *info); err != nil {
			return nil, err
		}

		ctx.Logger().Info("Storage endpoint registered", "channel_id", info.ChannelId, "endpoint", info.ApiEndpoint)
	}

	return &types.MsgRegisterStorageResponse{}, nil
}

// TransmitGatewayPacketData sends packet data over IBC and returns the packet sequence.
func (k Keeper) TransmitGatewayPacketData(
	ctx sdk.Context,
	packetData types.GatewayPacketData,
	sourcePort,
	sourceChannel string,
	timeoutHeight clienttypes.Height,
	timeoutTimestamp uint64,
) (uint64, error) {
	packetBytes, err := packetData.Marshal()
	if err != nil {
		return 0, err
	}

	ibcK := k.ibcKeeperFn()
	if ibcK == nil {
		return 0, fmt.Errorf("ibc keeper is nil")
	}
	return sendPacket(ibcK, ctx, sourcePort, sourceChannel, timeoutHeight, timeoutTimestamp, packetBytes)
}

// sendPacket is a tiny wrapper for ease of testing/mocking later.
func sendPacket(
	ibcK *ibckeeper.Keeper,
	ctx sdk.Context,
	sourcePort,
	sourceChannel string,
	timeoutHeight clienttypes.Height,
	timeoutTimestamp uint64,
	data []byte,
) (uint64, error) {
	return ibcK.ChannelKeeper.SendPacket(ctx, sourcePort, sourceChannel, timeoutHeight, timeoutTimestamp, data)
}
