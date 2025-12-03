package keeper

import (
	"context"
	"fmt"
	"strconv"

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

	// --- 1. 送信先チャネルの動的取得 ---

	// (A) MDSCチャネルの取得
	mdscChannel, err := k.Keeper.MetastoreChannel.Get(ctx)
	if err != nil {
		return nil, fmt.Errorf("MDSC channel not found. make sure MDSC is connected via IBC: %w", err)
	}

	// (B) FDSCチャネルの取得
	iter, err := k.Keeper.DatastoreChannels.Iterate(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer iter.Close()

	if !iter.Valid() {
		return nil, fmt.Errorf("no FDSC channels found. make sure at least one FDSC is connected via IBC")
	}

	fdscChannel, err := iter.Key()
	if err != nil {
		return nil, err
	}

	ctx.Logger().Info("Resolved IBC Channels",
		"mdsc_channel", mdscChannel,
		"fdsc_channel", fdscChannel)

	// --- 定数定義 ---
	const (
		ChunkSize       = 1024 * 10 // 10KB
		TimeoutSeconds  = 600
		FDSC_ID_DEFAULT = "fdsc-0"
	)

	// --- データの分割 (Sharding) ---
	dataLen := len(msg.Data)
	totalChunks := dataLen / ChunkSize
	if dataLen%ChunkSize != 0 {
		totalChunks++
	}

	ctx.Logger().Info("Sharding data", "total_chunks", totalChunks)

	// マニフェスト用情報の保存リスト
	var fragmentMappings []*types.PacketFragmentMapping

	// --- パケット送信ループ (FDSCへ) ---
	for i := 0; i < totalChunks; i++ {
		start := i * ChunkSize
		end := start + ChunkSize
		if end > dataLen {
			end = dataLen
		}
		chunkData := msg.Data[start:end]

		fragmentIDNum := uint64(ctx.BlockTime().UnixNano()) + uint64(i)
		fragmentIDStr := strconv.FormatUint(fragmentIDNum, 10)

		packetData := types.GatewayPacketData{
			Packet: &types.GatewayPacketData_FragmentPacket{
				FragmentPacket: &types.FragmentPacket{
					Id:   fragmentIDNum,
					Data: chunkData,
				},
			},
		}

		timeoutTimestamp := uint64(ctx.BlockTime().UnixNano()) + uint64(TimeoutSeconds*1_000_000_000)

		// IBCパケット送信 (To FDSC)
		_, err := k.Keeper.TransmitGatewayPacketData(
			ctx,
			packetData,
			"gateway",
			fdscChannel,
			clienttypes.ZeroHeight(),
			timeoutTimestamp,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to send fragment packet %d: %w", i, err)
		}

		fragmentMappings = append(fragmentMappings, &types.PacketFragmentMapping{
			FdscId:     FDSC_ID_DEFAULT,
			FragmentId: fragmentIDStr,
		})

		ctx.Logger().Info("Sent FragmentPacket", "chunk_index", i, "fragment_id", fragmentIDStr)
	}

	// --- マニフェスト送信 (To MDSC) ---
	manifestPacket := types.GatewayPacketData{
		Packet: &types.GatewayPacketData_ManifestPacket{
			ManifestPacket: &types.ManifestPacket{
				Filename:  msg.Filename,
				FileSize:  uint64(dataLen),
				MimeType:  "application/octet-stream",
				Fragments: fragmentMappings,
			},
		},
	}

	timeoutTimestamp := uint64(ctx.BlockTime().UnixNano()) + uint64(TimeoutSeconds*1_000_000_000)

	// IBCパケット送信 (To MDSC)
	_, err = k.Keeper.TransmitGatewayPacketData(
		ctx,
		manifestPacket,
		"gateway",
		mdscChannel,
		clienttypes.ZeroHeight(),
		timeoutTimestamp,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to send manifest packet: %w", err)
	}

	ctx.Logger().Info("Sent ManifestPacket", "filename", msg.Filename, "fragments_count", len(fragmentMappings))

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

	packetBytes, err := packetData.Marshal()
	if err != nil {
		return 0, fmt.Errorf("failed to marshal packet data: %w", err)
	}

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

// 追加: RegisterStorage
func (k msgServer) RegisterStorage(goCtx context.Context, msg *types.MsgRegisterStorage) (*types.MsgRegisterStorageResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	for _, ep := range msg.Endpoints {
		if err := k.Keeper.StorageEndpoints.Set(ctx, ep.ChainId, ep.ApiEndpoint); err != nil {
			return nil, fmt.Errorf("failed to save endpoint for %s: %w", ep.ChainId, err)
		}
		ctx.Logger().Info("Registered Storage Endpoint", "chain_id", ep.ChainId, "url", ep.ApiEndpoint)
	}

	return &types.MsgRegisterStorageResponse{}, nil
}
