package keeper

import (
	"context"
	"errors"

	"fdsc/x/datastore/types"

	"cosmossdk.io/collections"
	"github.com/cosmos/cosmos-sdk/types/query"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (q queryServer) ListFragment(ctx context.Context, req *types.QueryAllFragmentRequest) (*types.QueryAllFragmentResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	fragments, pageRes, err := query.CollectionPaginate(
		ctx,
		q.k.Fragment,
		req.Pagination,
		func(_ string, value types.Fragment) (types.Fragment, error) {
			return value, nil
		},
	)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &types.QueryAllFragmentResponse{Fragment: fragments, Pagination: pageRes}, nil
}

func (q queryServer) GetFragment(ctx context.Context, req *types.QueryGetFragmentRequest) (*types.QueryGetFragmentResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "invalid request")
	}

	val, err := q.k.Fragment.Get(ctx, req.FragmentId)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, status.Error(codes.NotFound, "not found")
		}

		return nil, status.Error(codes.Internal, "internal error")
	}

	return &types.QueryGetFragmentResponse{Fragment: val}, nil
}
