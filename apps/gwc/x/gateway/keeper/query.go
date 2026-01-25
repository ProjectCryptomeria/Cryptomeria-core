package keeper

import (
	"context"
	"encoding/hex"

	"gwc/x/gateway/types"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type queryServer struct {
	Keeper
}

// NewQueryServerImpl は QueryServer インターフェースの実装を返します。
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

	err := k.Keeper.StorageInfos.Walk(ctx, nil, func(channelID string, info types.StorageInfo) (bool, error) {
		storageInfos = append(storageInfos, &types.StorageInfo{
			ChannelId:      info.ChannelId,
			ChainId:        info.ChainId,
			ApiEndpoint:    info.ApiEndpoint,
			ConnectionType: info.ConnectionType,
		})
		return false, nil
	})
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryStorageEndpointsResponse{StorageInfos: storageInfos}, nil
}

func (k queryServer) Session(goCtx context.Context, req *types.QuerySessionRequest) (*types.QuerySessionResponse, error) {
	if req == nil || req.SessionId == "" {
		return nil, status.Error(codes.InvalidArgument, "session_id required")
	}
	ctx := sdk.UnwrapSDKContext(goCtx)

	sess, err := k.Keeper.Sessions.Get(ctx, req.SessionId)
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	return &types.QuerySessionResponse{Session: sess}, nil
}

func (k queryServer) SessionsByOwner(goCtx context.Context, req *types.QuerySessionsByOwnerRequest) (*types.QuerySessionsByOwnerResponse, error) {
	if req == nil || req.Owner == "" {
		return nil, status.Error(codes.InvalidArgument, "owner required")
	}
	ctx := sdk.UnwrapSDKContext(goCtx)

	var out []types.Session
	err := k.Keeper.Sessions.Walk(ctx, nil, func(sessionID string, sess types.Session) (bool, error) {
		if sess.Owner == req.Owner {
			out = append(out, sess)
		}
		return false, nil
	})
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QuerySessionsByOwnerResponse{Sessions: out}, nil
}

// SessionUploadTokenHash は HTTP サーバーがトークンのハッシュを確認するために使用します。
func (k queryServer) SessionUploadTokenHash(goCtx context.Context, req *types.QuerySessionUploadTokenHashRequest) (*types.QuerySessionUploadTokenHashResponse, error) {
	if req == nil || req.SessionId == "" {
		return nil, status.Error(codes.InvalidArgument, "session_id required")
	}
	ctx := sdk.UnwrapSDKContext(goCtx)

	hash, err := k.Keeper.GetUploadTokenHash(ctx, req.SessionId)
	if err != nil {
		return nil, status.Error(codes.NotFound, "upload token hash not found")
	}

	return &types.QuerySessionUploadTokenHashResponse{
		TokenHashHex: hex.EncodeToString(hash),
	}, nil
}
