package keeper

import (
	"context"
	"fmt"
	"strconv" // 追加

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

	// --- 定数定義 ---
	const (
		ChunkSize         = 1024 * 10 // 10KB
		TargetPort        = "datastore"
		TargetChannelFDSC = "channel-0" // FDSCへのチャネル
		TargetChannelMDSC = "channel-1" // MDSCへのチャネル (init-relayer.shの順序に依存)
		TimeoutSeconds    = 600
		FDSC_ID_DEFAULT   = "fdsc-0" // 今回はシングルFDSC構成と仮定
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

		// ID生成
		fragmentIDNum := uint64(ctx.BlockTime().UnixNano()) + uint64(i)
		fragmentIDStr := strconv.FormatUint(fragmentIDNum, 10)

		// パケット作成
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
			TargetChannelFDSC,
			clienttypes.ZeroHeight(),
			timeoutTimestamp,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to send fragment packet %d: %w", i, err)
		}

		// マッピング情報を記録
		fragmentMappings = append(fragmentMappings, &types.PacketFragmentMapping{
			FdscId:     FDSC_ID_DEFAULT,
			FragmentId: fragmentIDStr,
		})

		ctx.Logger().Info("Sent FragmentPacket", "chunk_index", i, "fragment_id", fragmentIDStr)
	}

	// --- マニフェスト送信 (To MDSC) ---
	ctx.Logger().Info("Sending Manifest to MDSC...")

	manifestPacket := types.GatewayPacketData{
		Packet: &types.GatewayPacketData_ManifestPacket{
			ManifestPacket: &types.ManifestPacket{
				Filename:  msg.Filename,
				FileSize:  uint64(dataLen),
				MimeType:  "application/octet-stream", // 簡易実装
				Fragments: fragmentMappings,
			},
		},
	}

	timeoutTimestamp := uint64(ctx.BlockTime().UnixNano()) + uint64(TimeoutSeconds*1_000_000_000)

	// IBCパケット送信 (To MDSC)
	_, err := k.Keeper.TransmitGatewayPacketData(
		ctx,
		manifestPacket,
		"gateway",
		TargetChannelMDSC, // MDSCへのチャネルID
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
