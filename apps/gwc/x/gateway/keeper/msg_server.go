package keeper

import (
	"context"
	"encoding/hex" // 追加: 署名検証用
	"fmt"
	"hash/fnv"
	"net/http"
	"strconv"

	"gwc/x/gateway/types"

	sdk "github.com/cosmos/cosmos-sdk/types"
	clienttypes "github.com/cosmos/ibc-go/v10/modules/core/02-client/types"
)

type msgServer struct {
	Keeper
}

func NewMsgServerImpl(keeper Keeper) types.MsgServer {
	return &msgServer{Keeper: keeper}
}

var _ types.MsgServer = msgServer{}

// 1. InitUpload: セッションの開始
func (k msgServer) InitUpload(goCtx context.Context, msg *types.MsgInitUpload) (*types.MsgInitUploadResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	uploadID := fmt.Sprintf("%s-%d", msg.Creator, ctx.BlockTime().UnixNano())

	if err := k.Keeper.CreateUploadSession(ctx, uploadID); err != nil {
		return nil, err
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"init_upload",
			sdk.NewAttribute("upload_id", uploadID),
			sdk.NewAttribute("creator", msg.Creator),
		),
	)

	ctx.Logger().Info("Upload session initialized", "id", uploadID)
	return &types.MsgInitUploadResponse{UploadId: uploadID}, nil
}

// 2. PostChunk: データの蓄積
func (k msgServer) PostChunk(goCtx context.Context, msg *types.MsgPostChunk) (*types.MsgPostChunkResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	if err := k.Keeper.AppendUploadChunk(ctx, msg.UploadId, msg.Data); err != nil {
		return nil, err
	}

	return &types.MsgPostChunkResponse{}, nil
}

// 3. CompleteUpload: 展開、計算、SiteRoot生成 (確定待機)
func (k msgServer) CompleteUpload(goCtx context.Context, msg *types.MsgCompleteUpload) (*types.MsgCompleteUploadResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	zipData, err := k.Keeper.GetUploadSessionBuffer(ctx, msg.UploadId)
	if err != nil || len(zipData) == 0 {
		return nil, fmt.Errorf("no data found for session %s", msg.UploadId)
	}

	chunkSize := int(msg.FragmentSize)
	if chunkSize <= 0 {
		chunkSize = 10 * 1024
	}

	processedFiles, siteRoot, fileRoots, err := ProcessZipAndCalcMerkle(zipData, chunkSize)
	if err != nil {
		return nil, fmt.Errorf("processing failed: %w", err)
	}

	projectName := msg.Filename
	filesMap := make(map[string]*types.FileMetadata)
	for _, pFile := range processedFiles {
		mimeType := http.DetectContentType(pFile.Content)
		filesMap[pFile.Path] = &types.FileMetadata{
			MimeType:  mimeType,
			Size_:     uint64(len(pFile.Content)),
			FileRoot:  fileRoots[pFile.Path],
			Fragments: []*types.PacketFragmentMapping{},
		}
	}

	manifestPacket := types.ManifestPacket{
		ProjectName:  projectName,
		Version:      msg.Version,
		SiteRoot:     siteRoot,
		Files:        filesMap,
		FragmentSize: uint64(chunkSize),
	}

	gp := types.GatewayPacketData{
		Packet: &types.GatewayPacketData_ManifestPacket{ManifestPacket: &manifestPacket},
	}
	manifestBytes, err := gp.Marshal()
	if err != nil {
		return nil, err
	}

	if err := k.Keeper.SetSessionPendingSign(ctx, msg.UploadId, manifestBytes, siteRoot); err != nil {
		return nil, err
	}

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			"complete_upload",
			sdk.NewAttribute("upload_id", msg.UploadId),
			sdk.NewAttribute("site_root", siteRoot),
		),
	)

	ctx.Logger().Info("Upload processed, waiting for sign", "id", msg.UploadId, "site_root", siteRoot)
	return &types.MsgCompleteUploadResponse{SiteRoot: siteRoot}, nil
}

// 4. SignUpload: 署名検証、IBC配信 (確定)
func (k msgServer) SignUpload(goCtx context.Context, msg *types.MsgSignUpload) (*types.MsgSignUploadResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	// セッション情報の取得
	storedRoot, manifestBytes, err := k.Keeper.GetSessionPendingResult(ctx, msg.UploadId)
	if err != nil {
		return nil, err
	}

	// 1. SiteRootの一致確認
	if storedRoot != msg.SiteRoot {
		return nil, fmt.Errorf("site_root mismatch: stored=%s, signed=%s", storedRoot, msg.SiteRoot)
	}

	// 2. CSUプロトコル: クライアントの公開鍵による数学的署名検証
	addr, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return nil, err
	}
	acc := k.accountKeeper.GetAccount(ctx, addr)
	if acc == nil {
		return nil, fmt.Errorf("account not found: %s", msg.Creator)
	}
	pubKey := acc.GetPubKey()
	if pubKey == nil {
		return nil, fmt.Errorf("public key not found for account: %s", msg.Creator)
	}

	siteRootBytes, err := hex.DecodeString(msg.SiteRoot)
	if err != nil {
		return nil, fmt.Errorf("invalid site_root hex: %v", err)
	}

	if !pubKey.VerifySignature(siteRootBytes, msg.Signature) {
		return nil, fmt.Errorf("CSU Signature Verification Failed: invalid signature")
	}

	// 3. 配送準備
	var gp types.GatewayPacketData
	if err := gp.Unmarshal(manifestBytes); err != nil {
		return nil, err
	}
	manifest := gp.GetManifestPacket()
	if manifest == nil {
		return nil, fmt.Errorf("invalid manifest data")
	}

	manifest.ClientSignature = msg.Signature
	manifest.Creator = msg.Creator

	zipData, err := k.Keeper.GetUploadSessionBuffer(ctx, msg.UploadId)
	if err != nil {
		return nil, err
	}

	processedFiles, _, _, err := ProcessZipAndCalcMerkle(zipData, int(manifest.FragmentSize))
	if err != nil {
		return nil, err
	}

	mdscChannel, err := k.Keeper.MetastoreChannel.Get(ctx)
	if err != nil {
		return nil, fmt.Errorf("MDSC channel not found")
	}

	var fdscChannels []string
	iter, err := k.Keeper.DatastoreChannels.Iterate(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer iter.Close()
	for ; iter.Valid(); iter.Next() {
		key, _ := iter.Key()
		fdscChannels = append(fdscChannels, key)
	}

	// 4. 断片の配送
	var roundRobinIndex int
	var totalFragments uint64 = 0

	for _, pFile := range processedFiles {
		mappings, err := k.uploadFragments(ctx, pFile.Chunks, manifest.ProjectName, pFile.Path, fdscChannels, &roundRobinIndex, msg.UploadId, storedRoot)
		if err != nil {
			return nil, err
		}
		manifest.Files[pFile.Path].Fragments = mappings
		totalFragments += uint64(len(mappings))
	}

	// 5. IBC完了待機セッションの開始 (MDSCへのコミット)
	finalGp := types.GatewayPacketData{
		Packet: &types.GatewayPacketData_ManifestPacket{ManifestPacket: manifest},
	}
	finalManifestBytes, _ := finalGp.Marshal()

	if err := k.Keeper.InitIBCWaitSession(ctx, msg.UploadId, mdscChannel, totalFragments, finalManifestBytes); err != nil {
		return nil, err
	}

	k.Keeper.CleanupUploadSession(ctx, msg.UploadId)
	ctx.Logger().Info("Distribution started with signature verification", "id", msg.UploadId)
	return &types.MsgSignUploadResponse{}, nil
}

// 共通ヘルパー関数は変更なし
func (k msgServer) uploadFragments(ctx sdk.Context, chunks [][]byte, projectName, filename string, fdscChannels []string, roundRobinIndex *int, uploadID, siteRoot string) ([]*types.PacketFragmentMapping, error) {
	const TimeoutSeconds = 600
	var fragmentMappings []*types.PacketFragmentMapping
	for i, chunkData := range chunks {
		rr := *roundRobinIndex
		fragmentIDNum := computeFragmentID(projectName, filename, i)
		fragmentIDStr := strconv.FormatUint(fragmentIDNum, 10)
		packetData := types.GatewayPacketData{
			Packet: &types.GatewayPacketData_FragmentPacket{
				FragmentPacket: &types.FragmentPacket{Id: fragmentIDNum, Data: chunkData, SiteRoot: siteRoot},
			},
		}
		timeoutTimestamp := uint64(ctx.BlockTime().UnixNano()) + uint64(TimeoutSeconds*1_000_000_000)
		targetChannel := fdscChannels[rr%len(fdscChannels)]
		*roundRobinIndex = rr + 1
		_, err := k.Keeper.TransmitGatewayPacketData(ctx, packetData, "gateway", targetChannel, clienttypes.ZeroHeight(), timeoutTimestamp)
		if err != nil {
			return nil, err
		}
		k.Keeper.FragmentToSession.Set(ctx, fragmentIDStr, uploadID)
		fragmentMappings = append(fragmentMappings, &types.PacketFragmentMapping{FdscId: targetChannel, FragmentId: fragmentIDStr})
	}
	return fragmentMappings, nil
}

func computeFragmentID(projectName, filename string, index int) uint64 {
	h := fnv.New64a()
	h.Write([]byte(projectName))
	h.Write([]byte{0})
	h.Write([]byte(filename))
	h.Write([]byte{0})
	h.Write([]byte(strconv.Itoa(index)))
	return h.Sum64()
}

func (k msgServer) RegisterStorage(goCtx context.Context, msg *types.MsgRegisterStorage) (*types.MsgRegisterStorageResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	for _, info := range msg.StorageInfos {
		if info.ChannelId == "" {
			return nil, fmt.Errorf("channel_id required")
		}
		k.Keeper.StorageInfos.Set(ctx, info.ChannelId, *info)
	}
	return &types.MsgRegisterStorageResponse{}, nil
}

func (k Keeper) TransmitGatewayPacketData(ctx sdk.Context, packetData types.GatewayPacketData, sourcePort, sourceChannel string, timeoutHeight clienttypes.Height, timeoutTimestamp uint64) (uint64, error) {
	packetBytes, err := packetData.Marshal()
	if err != nil {
		return 0, err
	}
	return k.ibcKeeperFn().ChannelKeeper.SendPacket(ctx, sourcePort, sourceChannel, timeoutHeight, timeoutTimestamp, packetBytes)
}
