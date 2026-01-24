package keeper

import (
	"context"
	"fmt"

	"gwc/x/gateway/types"

	sdk "github.com/cosmos/cosmos-sdk/types"
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

func (k msgServer) RegisterStorage(goCtx context.Context, msg *types.MsgRegisterStorage) (*types.MsgRegisterStorageResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	for _, info := range msg.StorageInfos {
		if info.ChannelId == "" {
			return nil, fmt.Errorf("channel_id required")
		}
		if err := k.Keeper.StorageInfos.Set(ctx, info.ChannelId, *info); err != nil {
			return nil, err
		}
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
