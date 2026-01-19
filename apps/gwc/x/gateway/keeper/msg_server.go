package keeper

import (
	"context"
	"fmt"
	"hash/fnv"
	"net/http"
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

	// UploadIDを生成 (ProjectName + Timestamp + Nano)
	uploadID := fmt.Sprintf("%s-%d", msg.ProjectName, ctx.BlockTime().UnixNano())

	ctx.Logger().Info("MsgUpload を受信しました",
		"upload_id", uploadID,
		"creator", msg.Creator,
		"filename", msg.Filename,
		"data_size", len(msg.Data),
		"project_name", msg.ProjectName,
	)

	// --- 1. 送信先チャネルの動的取得 ---

	// (A) MDSCチャネルの取得
	mdscChannel, err := k.Keeper.MetastoreChannel.Get(ctx)
	if err != nil {
		return nil, fmt.Errorf("MDSCチャネルが見つかりません。MDSCがIBC経由で接続されているか確認してください: %w", err)
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
		return nil, fmt.Errorf("FDSCチャネルが見つかりません。少なくとも1つのFDSCがIBC経由で接続されているか確認してください")
	}

	ctx.Logger().Info("IBCチャネルを解決しました",
		"mdsc_channel", mdscChannel,
		"fdsc_channels", fdscChannels)

	// --- Zip判定と処理分岐 ---
	isZip := strings.HasSuffix(strings.ToLower(msg.Filename), ".zip")

	// ユーザー指定のフラグメントサイズを使用（無効な場合はデフォルト）
	chunkSize := int(msg.FragmentSize)
	if chunkSize <= 0 {
		chunkSize = k.ChunkSize // Keeperのデフォルト値
		if chunkSize <= 0 {
			chunkSize = 10 * 1024 // 最終フォールバック 10KB
		}
	}

	if isZip {
		return k.processZipUpload(ctx, msg, mdscChannel, fdscChannels, chunkSize, uploadID)
	}
	return k.processSingleFileUpload(ctx, msg, mdscChannel, fdscChannels, chunkSize, uploadID)
}

func (k msgServer) processZipUpload(
	ctx sdk.Context,
	msg *types.MsgUpload,
	mdscChannel string,
	fdscChannels []string,
	chunkSize int,
	uploadID string,
) (*types.MsgUploadResponse, error) {
	ctx.Logger().Info("Zipアップロードを処理中", "upload_id", uploadID)

	processedFiles, err := ProcessZipData(msg.Data, chunkSize)
	if err != nil {
		return nil, err
	}

	// プロジェクト名が指定されていればそれを使用、なければファイル名から推測
	projectName := msg.ProjectName
	if projectName == "" {
		projectName = GetProjectNameFromZipFilename(msg.Filename)
	}

	// マニフェスト用のファイルマップを初期化
	filesMap := make(map[string]*types.FileMetadata)

	// 全体を通してのチャンクカウンター（ラウンドロビン用）
	var roundRobinIndex int
	var totalFragments uint64 = 0

	// 1. 各ファイルのフラグメント送信
	for _, pFile := range processedFiles {
		// フラグメントの分散アップロード
		fragmentMappings, err := k.uploadFragments(ctx, pFile.Chunks, projectName, pFile.Path, fdscChannels, &roundRobinIndex, uploadID)
		if err != nil {
			return nil, err
		}
		totalFragments += uint64(len(fragmentMappings))

		// MIMEタイプの検出
		mimeType := "application/octet-stream"
		if len(pFile.Content) > 0 {
			mimeType = http.DetectContentType(pFile.Content)
		}

		// マップへの登録
		filesMap[pFile.Path] = &types.FileMetadata{
			MimeType:  mimeType,
			Size_:     uint64(len(pFile.Content)),
			Fragments: fragmentMappings,
		}
	}

	// 2. マニフェストパケットの作成 (送信はせずバイト列を取得)
	manifestBytes, err := k.buildManifestPacketBytes(projectName, msg.Version, filesMap)
	if err != nil {
		return nil, fmt.Errorf("failed to build manifest packet: %w", err)
	}

	// 3. アップロードセッションの開始 (Ack待機状態へ)
	if err := k.Keeper.InitUploadSession(ctx, uploadID, mdscChannel, totalFragments, manifestBytes); err != nil {
		return nil, fmt.Errorf("failed to init upload session: %w", err)
	}

	ctx.Logger().Info("アップロードセッションを開始しました",
		"upload_id", uploadID,
		"total_fragments", totalFragments)

	return &types.MsgUploadResponse{}, nil
}

func (k msgServer) processSingleFileUpload(
	ctx sdk.Context,
	msg *types.MsgUpload,
	mdscChannel string,
	fdscChannels []string,
	chunkSize int,
	uploadID string,
) (*types.MsgUploadResponse, error) {
	// プロジェクト名が指定されていない場合はファイル名を使用
	projectName := msg.ProjectName
	if projectName == "" {
		projectName = GetProjectNameFromZipFilename(msg.Filename)
	}

	// 単一ファイルの分割
	chunks, err := SplitDataIntoFragments(msg.Data, chunkSize)
	if err != nil {
		return nil, err
	}

	// フラグメントのアップロード
	var roundRobinIndex int
	fragmentMappings, err := k.uploadFragments(ctx, chunks, projectName, msg.Filename, fdscChannels, &roundRobinIndex, uploadID)
	if err != nil {
		return nil, err
	}
	totalFragments := uint64(len(fragmentMappings))

	// MIMEタイプの検出
	mimeType := http.DetectContentType(msg.Data)

	// 単一エントリーのマップを作成
	filesMap := map[string]*types.FileMetadata{
		msg.Filename: {
			MimeType:  mimeType,
			Size_:     uint64(len(msg.Data)),
			Fragments: fragmentMappings,
		},
	}

	// マニフェストパケットの作成
	manifestBytes, err := k.buildManifestPacketBytes(projectName, msg.Version, filesMap)
	if err != nil {
		return nil, err
	}

	// アップロードセッションの開始
	if err := k.Keeper.InitUploadSession(ctx, uploadID, mdscChannel, totalFragments, manifestBytes); err != nil {
		return nil, err
	}

	ctx.Logger().Info("アップロードセッションを開始しました",
		"upload_id", uploadID,
		"total_fragments", totalFragments)

	return &types.MsgUploadResponse{}, nil
}

func computeFragmentID(projectName, filename string, index int) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(projectName))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(filename))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(strconv.Itoa(index)))
	return h.Sum64()
}

// uploadFragments はチャンクのリストを受け取り、ラウンドロビンでFDSCに送信し、マッピングを返します。
// また、Ack照合用に FragmentID -> UploadID のマッピングを保存します。
func (k msgServer) uploadFragments(
	ctx sdk.Context,
	chunks [][]byte,
	projectName string,
	filename string,
	fdscChannels []string,
	roundRobinIndex *int,
	uploadID string,
) ([]*types.PacketFragmentMapping, error) {

	const TimeoutSeconds = 600
	var fragmentMappings []*types.PacketFragmentMapping

	for i, chunkData := range chunks {
		rr := *roundRobinIndex

		fragmentIDNum := computeFragmentID(projectName, filename, i)
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

		// ラウンドロビン選択: 全体カウンターを使用
		targetChannel := fdscChannels[rr%len(fdscChannels)]
		*roundRobinIndex = rr + 1

		// Packet送信
		_, err := k.Keeper.TransmitGatewayPacketData(
			ctx,
			packetData,
			"gateway",
			targetChannel,
			clienttypes.ZeroHeight(),
			timeoutTimestamp,
		)
		if err != nil {
			return nil, fmt.Errorf("フラグメントパケットの送信に失敗しました (%s, chunk %d): %w", filename, i, err)
		}

		// マッピング保存 (Ack受信時に使用)
		if err := k.Keeper.FragmentToSession.Set(ctx, fragmentIDStr, uploadID); err != nil {
			return nil, fmt.Errorf("failed to map fragment to session: %w", err)
		}

		fragmentMappings = append(fragmentMappings, &types.PacketFragmentMapping{
			FdscId:     targetChannel,
			FragmentId: fragmentIDStr,
		})

		ctx.Logger().Info("FragmentPacketを送信しました",
			"project", projectName,
			"file", filename,
			"chunk_index", i,
			"target_channel", targetChannel,
			"fragment_id", fragmentIDStr,
			"upload_id", uploadID)
	}

	return fragmentMappings, nil
}

// buildManifestPacketBytes はマップ形式のManifestPacketを構築し、マーシャルしたバイト列を返します。
func (k msgServer) buildManifestPacketBytes(
	projectName string,
	version string,
	files map[string]*types.FileMetadata,
) ([]byte, error) {
	manifestPacket := types.GatewayPacketData{
		Packet: &types.GatewayPacketData_ManifestPacket{
			ManifestPacket: &types.ManifestPacket{
				ProjectName: projectName,
				Version:     version,
				Files:       files,
			},
		},
	}
	return manifestPacket.Marshal()
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

// RegisterStorage Updates: ChannelIDをキーとして情報をマージする
func (k msgServer) RegisterStorage(goCtx context.Context, msg *types.MsgRegisterStorage) (*types.MsgRegisterStorageResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	for _, info := range msg.StorageInfos {
		if info.ChannelId == "" {
			return nil, fmt.Errorf("channel_id is required")
		}

		// 既存の情報を取得
		var targetInfo types.StorageInfo

		existingInfo, err := k.Keeper.StorageInfos.Get(ctx, info.ChannelId)
		if err != nil {
			// 新規登録
			targetInfo = *info
			ctx.Logger().Info("新しいStorageInfoを手動登録します", "channel_id", info.ChannelId)
		} else {
			// マージ
			targetInfo = existingInfo
			if info.ChainId != "" {
				targetInfo.ChainId = info.ChainId
			}
			if info.ApiEndpoint != "" {
				targetInfo.ApiEndpoint = info.ApiEndpoint
			}
			if info.ConnectionType != "" {
				targetInfo.ConnectionType = info.ConnectionType
			}
		}

		if err := k.Keeper.StorageInfos.Set(ctx, info.ChannelId, targetInfo); err != nil {
			return nil, fmt.Errorf("StorageInfoの保存に失敗しました (%s): %w", info.ChannelId, err)
		}

		ctx.Logger().Info("StorageInfoを更新しました",
			"channel_id", targetInfo.ChannelId,
			"chain_id", targetInfo.ChainId,
			"url", targetInfo.ApiEndpoint,
			"type", targetInfo.ConnectionType)
	}

	return &types.MsgRegisterStorageResponse{}, nil
}
