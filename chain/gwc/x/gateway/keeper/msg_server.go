package keeper

import (
	"context"

	"gwc/x/gateway/types"

	sdk "github.com/cosmos/cosmos-sdk/types"
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

	// 修正: k.Logger() ではなく ctx.Logger() を使用する
	ctx.Logger().Info("Received MsgUpload",
		"creator", msg.Creator,
		"filename", msg.Filename,
		"data_size", len(msg.Data),
	)

	// TODO: ここに以下のロジックを実装予定
	// 1. データの分割 (Sharding)
	// 2. IBCパケットの作成 (FragmentPacket, ManifestPacket)
	// 3. 各チェーンへの送信 (SendPacket)

	return &types.MsgUploadResponse{}, nil
}

// UpdateParams は msg_update_params.go で実装されているため、ここからは削除しました。
