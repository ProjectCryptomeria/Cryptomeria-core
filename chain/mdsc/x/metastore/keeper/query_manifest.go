package keeper

import (
	"context"
	"errors"

	"mdsc/x/metastore/types"

	"cosmossdk.io/collections"
	"github.com/cosmos/cosmos-sdk/types/query"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (q queryServer) ListManifest(ctx context.Context, req *types.QueryAllManifestRequest) (*types.QueryAllManifestResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	manifests, pageRes, err := query.CollectionPaginate(
		ctx,
		q.k.Manifest,
		req.Pagination,
		func(_ string, value types.Manifest) (types.Manifest, error) {
			return value, nil
		},
	)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryAllManifestResponse{Manifest: manifests, Pagination: pageRes}, nil
}

func (q queryServer) GetManifest(ctx context.Context, req *types.QueryGetManifestRequest) (*types.QueryGetManifestResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	val, err := q.k.Manifest.Get(ctx, req.ProjectName)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "not found")
		}

		return nil, status.Error(codes.Internal, "internal error")
	}

	return &types.QueryGetManifestResponse{Manifest: val}, nil
}
