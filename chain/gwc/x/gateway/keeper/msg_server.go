package keeper

import (
	"context"
	"fmt"

	"gwc/x/gateway/types"

	sdk "github.com/cosmos/cosmos-sdk/types"
	clienttypes "github.com/cosmos/ibc-go/v10/modules/core/02-client/types"
)

type msgServer struct {
	Keeper
}

// NewMsgServerImpl returns an implementation of the MsgServer interface
// for the provided Keeper.
func NewMsgServerImpl(keeper Keeper) types.MsgServer {
	return &msgServer{Keeper: keeper}
}

var _ types.MsgServer = msgServer{}

// Upload handles the file upload request
func (k msgServer) Upload(goCtx context.Context, msg *types.MsgUpload) (*types.MsgUploadResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	ctx.Logger().Info("Received MsgUpload",
		"creator", msg.Creator,
		"filename", msg.Filename,
		"data_size", len(msg.Data),
	)

	// 定数 (PoC用)
	const (
		ChunkSize      = 1024 * 10 // 10KB
		TargetPort     = "datastore"
		TargetChannel  = "channel-0"
		TimeoutSeconds = 600
	)

	// データの分割 (Sharding)
	dataLen := len(msg.Data)
	totalChunks := dataLen / ChunkSize
	if dataLen%ChunkSize != 0 {
		totalChunks++
	}

	ctx.Logger().Info("Sharding data", "total_chunks", totalChunks)

	// パケット送信ループ
	for i := 0; i < totalChunks; i++ {
		start := i * ChunkSize
		end := start + ChunkSize
		if end > dataLen {
			end = dataLen
		}
		chunkData := msg.Data[start:end]

		// ID生成
		fragmentID := uint64(ctx.BlockTime().UnixNano()) + uint64(i)

		packetData := types.GatewayPacketData{
			Packet: &types.GatewayPacketData_FragmentPacket{
				FragmentPacket: &types.FragmentPacket{
					Id:   fragmentID,
					Data: chunkData,
				},
			},
		}

		timeoutTimestamp := uint64(ctx.BlockTime().UnixNano()) + uint64(TimeoutSeconds*1_000_000_000)

		// IBCパケット送信
		// 修正: types.PortKeyではなく文字列 "gateway" を渡す
		_, err := k.Keeper.TransmitGatewayPacketData(
			ctx,
			packetData,
			"gateway",
			TargetChannel,
			clienttypes.ZeroHeight(),
			timeoutTimestamp,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to send packet %d: %w", i, err)
		}

		ctx.Logger().Info("Sent FragmentPacket", "chunk_index", i, "fragment_id", fragmentID)
	}

	return &types.MsgUploadResponse{}, nil
}

// TransmitGatewayPacketData sends the packet over IBC
func (k Keeper) TransmitGatewayPacketData(
	ctx sdk.Context,
	packetData types.GatewayPacketData,
	sourcePort,
	sourceChannel string,
	timeoutHeight clienttypes.Height,
	timeoutTimestamp uint64,
) (uint64, error) {

	// 修正: GetBytes() -> Marshal()
	packetBytes, err := packetData.Marshal()
	if err != nil {
		return 0, fmt.Errorf("failed to marshal packet data: %w", err)
	}

	// 修正: SendPacketの引数から capability を削除 (v10仕様に合わせる)
	sequence, err := k.ibcKeeperFn().ChannelKeeper.SendPacket(
		ctx,
		sourcePort,
		sourceChannel,
		timeoutHeight,
		timeoutTimestamp,
		packetBytes,
	)
	if err != nil {
		return 0, err
	}

	return sequence, nil
}
