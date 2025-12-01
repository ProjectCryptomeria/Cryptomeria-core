package keeper

import (
	"context"

	"gwc/x/gateway/types"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// queryServer 構造体を定義 (Keeperを埋め込む)
type queryServer struct {
	Keeper
}

// NewQueryServerImpl returns an implementation of the QueryServer interface
// for the provided Keeper.
func NewQueryServerImpl(k Keeper) types.QueryServer {
	return queryServer{Keeper: k}
}

var _ types.QueryServer = queryServer{}

// Params クエリの実装 (レシーバを queryServer に変更)
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

// StorageEndpoints クエリの実装 (レシーバを queryServer に変更)
func (k queryServer) StorageEndpoints(goCtx context.Context, req *types.QueryStorageEndpointsRequest) (*types.QueryStorageEndpointsResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	ctx := sdk.UnwrapSDKContext(goCtx)

	var endpoints []*types.StorageEndpoint

	// StorageEndpoints は Keeper のフィールドなので k.Keeper.StorageEndpoints でアクセス
	err := k.Keeper.StorageEndpoints.Walk(ctx, nil, func(chainID, url string) (bool, error) {
		endpoints = append(endpoints, &types.StorageEndpoint{
			ChainId:     chainID,
			ApiEndpoint: url,
		})
		return false, nil
	})
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryStorageEndpointsResponse{Endpoints: endpoints}, nil
}
