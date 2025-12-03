package keeper

import (
	"context"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

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

	// (B) FDSCチャネルの取得 (全リスト取得)
	var fdscChannels []string
	iter, err := k.Keeper.DatastoreChannels.Iterate(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer iter.Close()

	for ; iter.Valid(); iter.Next() {
		channelID, err := iter.Key()
		if err != nil {
			return nil, err
		}
		fdscChannels = append(fdscChannels, channelID)
	}

	if len(fdscChannels) == 0 {
		return nil, fmt.Errorf("no FDSC channels found. make sure at least one FDSC is connected via IBC")
	}

	ctx.Logger().Info("Resolved IBC Channels",
		"mdsc_channel", mdscChannel,
		"fdsc_channels", fdscChannels)

	// --- Zip判定と処理分岐 ---
	isZip := strings.HasSuffix(strings.ToLower(msg.Filename), ".zip")

	// Use configurable ChunkSize
	chunkSize := k.ChunkSize
	if chunkSize <= 0 {
		chunkSize = 10 * 1024 // Default 10KB
	}

	if isZip {
		return k.processZipUpload(ctx, msg, mdscChannel, fdscChannels, chunkSize)
	} else {
		return k.processSingleFileUpload(ctx, msg, mdscChannel, fdscChannels, chunkSize)
	}
}

func (k msgServer) processZipUpload(ctx sdk.Context, msg *types.MsgUpload, mdscChannel string, fdscChannels []string, chunkSize int) (*types.MsgUploadResponse, error) {
	ctx.Logger().Info("Processing Zip Upload")

	const (
		TimeoutSeconds  = 600
		FDSC_ID_DEFAULT = "fdsc" // 簡易ID
	)

	processedFiles, err := ProcessZipData(msg.Data, chunkSize)
	if err != nil {
		return nil, err
	}

	projectName := GetProjectNameFromZipFilename(msg.Filename)

	for _, pFile := range processedFiles {
		// ファイルごとの処理 (Distribution)
		var fragmentMappings []*types.PacketFragmentMapping

		for i, chunkData := range pFile.Chunks {
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

			// Round-Robin Selection
			targetChannel := fdscChannels[i%len(fdscChannels)]

			_, err := k.Keeper.TransmitGatewayPacketData(
				ctx,
				packetData,
				"gateway",
				targetChannel,
				clienttypes.ZeroHeight(),
				timeoutTimestamp,
			)
			if err != nil {
				return nil, fmt.Errorf("failed to send fragment packet %d for %s: %w", i, pFile.Filename, err)
			}

			fragmentMappings = append(fragmentMappings, &types.PacketFragmentMapping{
				FdscId:     targetChannel,
				FragmentId: fragmentIDStr,
			})

			ctx.Logger().Info("Sent FragmentPacket", "file", pFile.Filename, "chunk_index", i, "fragment_id", fragmentIDStr)
		}

		// ManifestPacket送信 (ファイルごと)
		fullPath := filepath.Join(projectName, pFile.Filename)

		err = k.sendManifestPacket(ctx, mdscChannel, fullPath, uint64(len(pFile.Content)), "application/octet-stream", fragmentMappings)
		if err != nil {
			return nil, fmt.Errorf("failed to send manifest packet for %s: %w", pFile.Filename, err)
		}
	}

	return &types.MsgUploadResponse{}, nil
}

func (k msgServer) processSingleFileUpload(ctx sdk.Context, msg *types.MsgUpload, mdscChannel string, fdscChannels []string, chunkSize int) (*types.MsgUploadResponse, error) {
	fragmentMappings, err := k.distributeFile(ctx, msg.Data, fdscChannels, chunkSize)
	if err != nil {
		return nil, err
	}

	err = k.sendManifestPacket(ctx, mdscChannel, msg.Filename, uint64(len(msg.Data)), "application/octet-stream", fragmentMappings)
	if err != nil {
		return nil, err
	}

	return &types.MsgUploadResponse{}, nil
}

func (k msgServer) distributeFile(ctx sdk.Context, data []byte, fdscChannels []string, chunkSize int) ([]*types.PacketFragmentMapping, error) {
	const (
		TimeoutSeconds  = 600
		FDSC_ID_DEFAULT = "fdsc" // 簡易ID
	)

	dataLen := len(data)
	totalChunks := dataLen / chunkSize
	if dataLen%chunkSize != 0 {
		totalChunks++
	}

	var fragmentMappings []*types.PacketFragmentMapping

	for i := 0; i < totalChunks; i++ {
		start := i * chunkSize
		end := start + chunkSize
		if end > dataLen {
			end = dataLen
		}
		chunkData := data[start:end]

		fragmentIDNum := uint64(ctx.BlockTime().UnixNano()) + uint64(i) // 簡易ユニークID生成
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

		// Round-Robin Selection
		targetChannel := fdscChannels[i%len(fdscChannels)]

		_, err := k.Keeper.TransmitGatewayPacketData(
			ctx,
			packetData,
			"gateway",
			targetChannel,
			clienttypes.ZeroHeight(),
			timeoutTimestamp,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to send fragment packet %d: %w", i, err)
		}

		fragmentMappings = append(fragmentMappings, &types.PacketFragmentMapping{
			FdscId:     targetChannel, // チャネルIDをFDSC IDとして使用
			FragmentId: fragmentIDStr,
		})
	}

	return fragmentMappings, nil
}

func (k msgServer) sendManifestPacket(ctx sdk.Context, mdscChannel string, filename string, size uint64, mimeType string, fragments []*types.PacketFragmentMapping) error {
	const TimeoutSeconds = 600

	manifestPacket := types.GatewayPacketData{
		Packet: &types.GatewayPacketData_ManifestPacket{
			ManifestPacket: &types.ManifestPacket{
				Filename:  filename,
				FileSize:  size,
				MimeType:  mimeType,
				Fragments: fragments,
			},
		},
	}

	timeoutTimestamp := uint64(ctx.BlockTime().UnixNano()) + uint64(TimeoutSeconds*1_000_000_000)

	_, err := k.Keeper.TransmitGatewayPacketData(
		ctx,
		manifestPacket,
		"gateway",
		mdscChannel,
		clienttypes.ZeroHeight(),
		timeoutTimestamp,
	)
	return err
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
