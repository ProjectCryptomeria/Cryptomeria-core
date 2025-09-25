package keeper

import (
	"context"
	"errors"

	"datachain/x/datastore/types"

	"cosmossdk.io/collections"
	"github.com/cosmos/cosmos-sdk/types/query"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (q queryServer) ListStoredChunk(ctx context.Context, req *types.QueryAllStoredChunkRequest) (*types.QueryAllStoredChunkResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	storedChunks, pageRes, err := query.CollectionPaginate(
		ctx,
		q.k.StoredChunk,
		req.Pagination,
		func(_ string, value types.StoredChunk) (types.StoredChunk, error) {
			return value, nil
		},
	)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryAllStoredChunkResponse{StoredChunk: storedChunks, Pagination: pageRes}, nil
}

func (q queryServer) GetStoredChunk(ctx context.Context, req *types.QueryGetStoredChunkRequest) (*types.QueryGetStoredChunkResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	val, err := q.k.StoredChunk.Get(ctx, req.Index)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "not found")
		}

		return nil, status.Error(codes.Internal, "internal error")
	}

	return &types.QueryGetStoredChunkResponse{StoredChunk: val}, nil
}
