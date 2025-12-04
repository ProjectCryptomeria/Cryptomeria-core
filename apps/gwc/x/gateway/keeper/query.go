package keeper

import (
	"context"

	"gwc/x/gateway/types"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type queryServer struct {
	Keeper
}

// NewQueryServerImpl returns an implementation of the QueryServer interface
// for the provided Keeper.
func NewQueryServerImpl(k Keeper) types.QueryServer {
	return queryServer{Keeper: k}
}

var _ types.QueryServer = queryServer{}

func (k queryServer) Params(goCtx context.Context, req *types.QueryParamsRequest) (*types.QueryParamsResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}
	ctx := sdk.UnwrapSDKContext(goCtx)

	params, err := k.Keeper.Params.Get(ctx)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryParamsResponse{Params: params}, nil
}

func (k queryServer) StorageEndpoints(goCtx context.Context, req *types.QueryStorageEndpointsRequest) (*types.QueryStorageEndpointsResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)

	var storageInfos []*types.StorageInfo

	// StorageInfosマップ (Key: ChannelID, Value: StorageInfo) を走査
	err := k.Keeper.StorageInfos.Walk(ctx, nil, func(channelID string, info types.StorageInfo) (bool, error) {
		// マップから取得した値(info)のアドレスを取るのではなく、新しい構造体を作成してリストに追加
		// (Protoの繰り返しフィールドはポインタのスライスであることが多いため)
		storageInfos = append(storageInfos, &types.StorageInfo{
			ChannelId:      info.ChannelId, // KeyのChannelIDを優先（あるいはinfo内のものと一致しているはず）
			ChainId:        info.ChainId,
			ApiEndpoint:    info.ApiEndpoint,
			ConnectionType: info.ConnectionType,
		})
		return false, nil
	})
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	// Proto定義のフィールド名は `storage_infos` なので Go構造体では `StorageInfos`
	return &types.QueryStorageEndpointsResponse{StorageInfos: storageInfos}, nil
}
