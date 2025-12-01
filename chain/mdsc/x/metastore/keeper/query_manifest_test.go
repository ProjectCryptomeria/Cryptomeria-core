package keeper_test

import (
	"context"
	"strconv"
	"testing"

	"github.com/cosmos/cosmos-sdk/types/query"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"mdsc/x/metastore/keeper"
	"mdsc/x/metastore/types"
)

func createNManifest(keeper keeper.Keeper, ctx context.Context, n int) []types.Manifest {
	items := make([]types.Manifest, n)
	for i := range items {
		items[i].ProjectName = strconv.Itoa(i)
		items[i].Version = strconv.Itoa(i)
		_ = keeper.Manifest.Set(ctx, items[i].ProjectName, items[i])
	}
	return items
}

func TestManifestQuerySingle(t *testing.T) {
	f := initFixture(t)
	qs := keeper.NewQueryServerImpl(f.keeper)
	msgs := createNManifest(f.keeper, f.ctx, 2)
	tests := []struct {
		desc     string
		request  *types.QueryGetManifestRequest
		response *types.QueryGetManifestResponse
		err      error
	}{
		{
			desc: "First",
			request: &types.QueryGetManifestRequest{
				ProjectName: msgs[0].ProjectName,
			},
			response: &types.QueryGetManifestResponse{Manifest: msgs[0]},
		},
		{
			desc: "Second",
			request: &types.QueryGetManifestRequest{
				ProjectName: msgs[1].ProjectName,
			},
			response: &types.QueryGetManifestResponse{Manifest: msgs[1]},
		},
		{
			desc: "KeyNotFound",
			request: &types.QueryGetManifestRequest{
				ProjectName: strconv.Itoa(100000),
			},
			err: status.Error(codes.NotFound, "not found"),
		},
		{
			desc: "InvalidRequest",
			err:  status.Error(codes.InvalidArgument, "invalid request"),
		},
	}
	for _, tc := range tests {
		t.Run(tc.desc, func(t *testing.T) {
			response, err := qs.GetManifest(f.ctx, tc.request)
			if tc.err != nil {
				require.ErrorIs(t, err, tc.err)
			} else {
				require.NoError(t, err)
				require.EqualExportedValues(t, tc.response, response)
			}
		})
	}
}

func TestManifestQueryPaginated(t *testing.T) {
	f := initFixture(t)
	qs := keeper.NewQueryServerImpl(f.keeper)
	msgs := createNManifest(f.keeper, f.ctx, 5)

	request := func(next []byte, offset, limit uint64, total bool) *types.QueryAllManifestRequest {
		return &types.QueryAllManifestRequest{
			Pagination: &query.PageRequest{
				Key:        next,
				Offset:     offset,
				Limit:      limit,
				CountTotal: total,
			},
		}
	}
	t.Run("ByOffset", func(t *testing.T) {
		step := 2
		for i := 0; i < len(msgs); i += step {
			resp, err := qs.ListManifest(f.ctx, request(nil, uint64(i), uint64(step), false))
			require.NoError(t, err)
			require.LessOrEqual(t, len(resp.Manifest), step)
			require.Subset(t, msgs, resp.Manifest)
		}
	})
	t.Run("ByKey", func(t *testing.T) {
		step := 2
		var next []byte
		for i := 0; i < len(msgs); i += step {
			resp, err := qs.ListManifest(f.ctx, request(next, 0, uint64(step), false))
			require.NoError(t, err)
			require.LessOrEqual(t, len(resp.Manifest), step)
			require.Subset(t, msgs, resp.Manifest)
			next = resp.Pagination.NextKey
		}
	})
	t.Run("Total", func(t *testing.T) {
		resp, err := qs.ListManifest(f.ctx, request(nil, 0, 0, true))
		require.NoError(t, err)
		require.Equal(t, len(msgs), int(resp.Pagination.Total))
		require.EqualExportedValues(t, msgs, resp.Manifest)
	})
	t.Run("InvalidRequest", func(t *testing.T) {
		_, err := qs.ListManifest(f.ctx, nil)
		require.ErrorIs(t, err, status.Error(codes.InvalidArgument, "invalid request"))
	})
}
