package keeper_test

import (
	"context"
	"strconv"
	"testing"

	"github.com/cosmos/cosmos-sdk/types/query"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"datachain/x/datastore/keeper"
	"datachain/x/datastore/types"
)

func createNStoredChunk(keeper keeper.Keeper, ctx context.Context, n int) []types.StoredChunk {
	items := make([]types.StoredChunk, n)
	for i := range items {
		items[i].Index = strconv.Itoa(i)
		items[i].Data = []byte{1 + i%1, 2 + i%2, 3 + i%3}
		_ = keeper.StoredChunk.Set(ctx, items[i].Index, items[i])
	}
	return items
}

func TestStoredChunkQuerySingle(t *testing.T) {
	f := initFixture(t)
	qs := keeper.NewQueryServerImpl(f.keeper)
	msgs := createNStoredChunk(f.keeper, f.ctx, 2)
	tests := []struct {
		desc     string
		request  *types.QueryGetStoredChunkRequest
		response *types.QueryGetStoredChunkResponse
		err      error
	}{
		{
			desc: "First",
			request: &types.QueryGetStoredChunkRequest{
				Index: msgs[0].Index,
			},
			response: &types.QueryGetStoredChunkResponse{StoredChunk: msgs[0]},
		},
		{
			desc: "Second",
			request: &types.QueryGetStoredChunkRequest{
				Index: msgs[1].Index,
			},
			response: &types.QueryGetStoredChunkResponse{StoredChunk: msgs[1]},
		},
		{
			desc: "KeyNotFound",
			request: &types.QueryGetStoredChunkRequest{
				Index: strconv.Itoa(100000),
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
			response, err := qs.GetStoredChunk(f.ctx, tc.request)
			if tc.err != nil {
				require.ErrorIs(t, err, tc.err)
			} else {
				require.NoError(t, err)
				require.EqualExportedValues(t, tc.response, response)
			}
		})
	}
}

func TestStoredChunkQueryPaginated(t *testing.T) {
	f := initFixture(t)
	qs := keeper.NewQueryServerImpl(f.keeper)
	msgs := createNStoredChunk(f.keeper, f.ctx, 5)

	request := func(next []byte, offset, limit uint64, total bool) *types.QueryAllStoredChunkRequest {
		return &types.QueryAllStoredChunkRequest{
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
			resp, err := qs.ListStoredChunk(f.ctx, request(nil, uint64(i), uint64(step), false))
			require.NoError(t, err)
			require.LessOrEqual(t, len(resp.StoredChunk), step)
			require.Subset(t, msgs, resp.StoredChunk)
		}
	})
	t.Run("ByKey", func(t *testing.T) {
		step := 2
		var next []byte
		for i := 0; i < len(msgs); i += step {
			resp, err := qs.ListStoredChunk(f.ctx, request(next, 0, uint64(step), false))
			require.NoError(t, err)
			require.LessOrEqual(t, len(resp.StoredChunk), step)
			require.Subset(t, msgs, resp.StoredChunk)
			next = resp.Pagination.NextKey
		}
	})
	t.Run("Total", func(t *testing.T) {
		resp, err := qs.ListStoredChunk(f.ctx, request(nil, 0, 0, true))
		require.NoError(t, err)
		require.Equal(t, len(msgs), int(resp.Pagination.Total))
		require.EqualExportedValues(t, msgs, resp.StoredChunk)
	})
	t.Run("InvalidRequest", func(t *testing.T) {
		_, err := qs.ListStoredChunk(f.ctx, nil)
		require.ErrorIs(t, err, status.Error(codes.InvalidArgument, "invalid request"))
	})
}
