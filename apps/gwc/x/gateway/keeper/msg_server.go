package keeper

import (
	"context"
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

// UpdateParams
func (k msgServer) UpdateParams(goCtx context.Context, msg *types.MsgUpdateParams) (*types.MsgUpdateParamsResponse, error) {
	if err := k.Params.Set(sdk.UnwrapSDKContext(goCtx), msg.Params); err != nil {
		return nil, err
	}
	return &types.MsgUpdateParamsResponse{}, nil
}

// ----------------------------------------------------------------
// New Upload Flow: Init -> PostChunk -> Complete -> Sign
// ----------------------------------------------------------------

// 1. InitUpload: セッションの開始
func (k msgServer) InitUpload(goCtx context.Context, msg *types.MsgInitUpload) (*types.MsgInitUploadResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	
	// Create unique ID
	uploadID := fmt.Sprintf("%s-%d", msg.Creator, ctx.BlockTime().UnixNano())
	
	if err := k.Keeper.CreateUploadSession(ctx, uploadID); err != nil {
		return nil, err
	}
	
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
	
	// Retrieve all buffered data
	zipData, err := k.Keeper.GetUploadSessionBuffer(ctx, msg.UploadId)
	if err != nil || len(zipData) == 0 {
		return nil, fmt.Errorf("no data found for session %s", msg.UploadId)
	}

	chunkSize := int(msg.FragmentSize)
	if chunkSize <= 0 { chunkSize = 10 * 1024 }

	// Unzip, Normalize, Calc Merkle
	_, siteRoot, fileRoots, err := ProcessZipAndCalcMerkle(zipData, chunkSize)
	if err != nil {
		return nil, fmt.Errorf("processing failed: %w", err)
	}

	// Build Manifest (Temporary) to save state
	projectName := msg.Filename
	// Warning: Using Filename as ProjectName for now, similar to old logic
	// In production, msg should have explicit ProjectName
	
	// We need to construct the FileMetadata map for the manifest
	// Note: We need to re-process files to get content-type and sizes. 
	// ProcessZipAndCalcMerkle returned processedFiles but we discarded them to save memory in return sig?
	// Let's call it again or refactor. The helper returns processedFiles.
	processedFiles, _, _, _ := ProcessZipAndCalcMerkle(zipData, chunkSize) // Re-using result
	
	filesMap := make(map[string]*types.FileMetadata)
	for _, pFile := range processedFiles {
		mimeType := http.DetectContentType(pFile.Content)
		filesMap[pFile.Path] = &types.FileMetadata{
			MimeType: mimeType,
			Size_:    uint64(len(pFile.Content)),
			FileRoot: fileRoots[pFile.Path],
			// Fragments are not assigned FDSC IDs yet, so we leave them empty or placeholder
			// We will assign them in SignUpload phase
			Fragments: []*types.PacketFragmentMapping{}, 
		}
	}

	manifestPacket := types.ManifestPacket{
		ProjectName: projectName,
		Version:     msg.Version,
		SiteRoot:    siteRoot,
		Files:       filesMap,
		FragmentSize: uint64(chunkSize),
	}
	
	// Pack into GatewayPacketData to serialize
	gp := types.GatewayPacketData{
		Packet: &types.GatewayPacketData_ManifestPacket{ManifestPacket: &manifestPacket},
	}
	manifestBytes, err := gp.Marshal()
	if err != nil { return nil, err }

	// Transition to PendingSign
	if err := k.Keeper.SetSessionPendingSign(ctx, msg.UploadId, manifestBytes, siteRoot); err != nil {
		return nil, err
	}

	ctx.Logger().Info("Upload processed, waiting for sign", "id", msg.UploadId, "site_root", siteRoot)
	return &types.MsgCompleteUploadResponse{SiteRoot: siteRoot}, nil
}

// 4. SignUpload: 署名検証、IBC配信 (確定)
func (k msgServer) SignUpload(goCtx context.Context, msg *types.MsgSignUpload) (*types.MsgSignUploadResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	// Verify Session State
	storedRoot, manifestBytes, err := k.Keeper.GetSessionPendingResult(ctx, msg.UploadId)
	if err != nil {
		return nil, err
	}

	// 1. Verify Site Root match
	if storedRoot != msg.SiteRoot {
		return nil, fmt.Errorf("site_root mismatch: stored=%s, signed=%s", storedRoot, msg.SiteRoot)
	}

	// 2. Verify Signature (TODO: Implement actual crypto verification using Creator's PubKey)
	// For PoC, we assume if the Tx is signed by Creator, and Creator provided the Signature in payload,
	// and the payload contains the SiteRoot they agreed to, it is valid.
	// Strictly, we should verify `msg.Signature` against `msg.SiteRoot` using `msg.Creator`'s pubkey.
	// ctx.Logger().Info("Signature verification skipped in PoC")

	// 3. Prepare Distribution
	
	// Recover Manifest
	var gp types.GatewayPacketData
	if err := gp.Unmarshal(manifestBytes); err != nil { return nil, err }
	manifest := gp.GetManifestPacket()
	if manifest == nil { return nil, fmt.Errorf("invalid manifest data") }

	// Inject Client Signature
	manifest.ClientSignature = msg.Signature
	manifest.Creator = msg.Creator
	
	// Re-load Zip Data to send fragments
	zipData, err := k.Keeper.GetUploadSessionBuffer(ctx, msg.UploadId)
	if err != nil { return nil, err }
	
	// Re-process to get chunks (CPU cost acceptable for security)
	processedFiles, _, _, err := ProcessZipAndCalcMerkle(zipData, int(manifest.FragmentSize))
	if err != nil { return nil, err }

	// Resolve Channels
	mdscChannel, err := k.Keeper.MetastoreChannel.Get(ctx)
	if err != nil { return nil, fmt.Errorf("MDSC channel not found") }
	
	var fdscChannels []string
	iter, err := k.Keeper.DatastoreChannels.Iterate(ctx, nil)
	if err != nil { return nil, err }
	defer iter.Close()
	for ; iter.Valid(); iter.Next() {
		key, _ := iter.Key()
		fdscChannels = append(fdscChannels, key)
	}
	if len(fdscChannels) == 0 { return nil, fmt.Errorf("no FDSC channels") }

	// 4. Distribute Fragments
	var roundRobinIndex int
	var totalFragments uint64 = 0

	for _, pFile := range processedFiles {
		// Upload chunks
		mappings, err := k.uploadFragments(ctx, pFile.Chunks, manifest.ProjectName, pFile.Path, fdscChannels, &roundRobinIndex, msg.UploadId, storedRoot)
		if err != nil { return nil, err }
		
		// Update Manifest with Locations
		manifest.Files[pFile.Path].Fragments = mappings
		totalFragments += uint64(len(mappings))
	}

	// 5. Start IBC Wait Session (for MDSC commit)
	// Re-marshal manifest with locations and signature
	finalGp := types.GatewayPacketData{
		Packet: &types.GatewayPacketData_ManifestPacket{ManifestPacket: manifest},
	}
	finalManifestBytes, _ := finalGp.Marshal()

	if err := k.Keeper.InitIBCWaitSession(ctx, msg.UploadId, mdscChannel, totalFragments, finalManifestBytes); err != nil {
		return nil, err
	}

	// Cleanup Buffer (Keep wait session keys)
	k.Keeper.CleanupUploadSession(ctx, msg.UploadId)

	ctx.Logger().Info("Distribution started", "id", msg.UploadId)
	return &types.MsgSignUploadResponse{}, nil
}


// Helper: Upload Fragments (Modified to include SiteRoot)
func (k msgServer) uploadFragments(
	ctx sdk.Context,
	chunks [][]byte,
	projectName string,
	filename string,
	fdscChannels []string,
	roundRobinIndex *int,
	uploadID string,
	siteRoot string,
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
					SiteRoot: siteRoot, // Added to packet
				},
			},
		}

		timeoutTimestamp := uint64(ctx.BlockTime().UnixNano()) + uint64(TimeoutSeconds*1_000_000_000)
		targetChannel := fdscChannels[rr%len(fdscChannels)]
		*roundRobinIndex = rr + 1

		_, err := k.Keeper.TransmitGatewayPacketData(ctx, packetData, "gateway", targetChannel, clienttypes.ZeroHeight(), timeoutTimestamp)
		if err != nil { return nil, err }

		if err := k.Keeper.FragmentToSession.Set(ctx, fragmentIDStr, uploadID); err != nil { return nil, err }

		fragmentMappings = append(fragmentMappings, &types.PacketFragmentMapping{
			FdscId: targetChannel,
			FragmentId: fragmentIDStr,
		})
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

// RegisterStorage (Existing)
func (k msgServer) RegisterStorage(goCtx context.Context, msg *types.MsgRegisterStorage) (*types.MsgRegisterStorageResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	for _, info := range msg.StorageInfos {
		if info.ChannelId == "" { return nil, fmt.Errorf("channel_id required") }
		k.Keeper.StorageInfos.Set(ctx, info.ChannelId, *info)
	}
	return &types.MsgRegisterStorageResponse{}, nil
}

// TransmitGatewayPacketData (Existing helper wrapper)
func (k Keeper) TransmitGatewayPacketData(ctx sdk.Context, packetData types.GatewayPacketData, sourcePort, sourceChannel string, timeoutHeight clienttypes.Height, timeoutTimestamp uint64) (uint64, error) {
	packetBytes, err := packetData.Marshal()
	if err != nil { return 0, err }
	return k.ibcKeeperFn().ChannelKeeper.SendPacket(ctx, sourcePort, sourceChannel, timeoutHeight, timeoutTimestamp, packetBytes)
}