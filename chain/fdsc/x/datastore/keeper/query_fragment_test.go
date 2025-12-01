package keeper_test

import (
	"context"
	"strconv"
	"testing"

	"github.com/cosmos/cosmos-sdk/types/query"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"fdsc/x/datastore/keeper"
	"fdsc/x/datastore/types"
)

func createNFragment(keeper keeper.Keeper, ctx context.Context, n int) []types.Fragment {
	items := make([]types.Fragment, n)
	for i := range items {
		items[i].FragmentId = strconv.Itoa(i)
		// 修正: byte() でキャスト
		items[i].Data = []byte{byte(1 + i%1), byte(2 + i%2), byte(3 + i%3)}
		items[i].Creator = "any"
		_ = keeper.Fragment.Set(ctx, items[i].FragmentId, items[i])
	}
	return items
}

func TestFragmentQuerySingle(t *testing.T) {
	f := initFixture(t)
	qs := keeper.NewQueryServerImpl(f.keeper)
	msgs := createNFragment(f.keeper, f.ctx, 2)
	tests := []struct {
		desc     string
		request  *types.QueryGetFragmentRequest
		response *types.QueryGetFragmentResponse
		err      error
	}{
		{
			desc: "First",
			request: &types.QueryGetFragmentRequest{
				FragmentId: msgs[0].FragmentId,
			},
			response: &types.QueryGetFragmentResponse{Fragment: msgs[0]},
		},
		{
			desc: "Second",
			request: &types.QueryGetFragmentRequest{
				FragmentId: msgs[1].FragmentId,
			},
			response: &types.QueryGetFragmentResponse{Fragment: msgs[1]},
		},
		{
			desc: "KeyNotFound",
			request: &types.QueryGetFragmentRequest{
				FragmentId: strconv.Itoa(100000),
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
			response, err := qs.GetFragment(f.ctx, tc.request)
			if tc.err != nil {
				require.ErrorIs(t, err, tc.err)
			} else {
				require.NoError(t, err)
				require.EqualExportedValues(t, tc.response, response)
			}
		})
	}
}

func TestFragmentQueryPaginated(t *testing.T) {
	f := initFixture(t)
	qs := keeper.NewQueryServerImpl(f.keeper)
	msgs := createNFragment(f.keeper, f.ctx, 5)

	request := func(next []byte, offset, limit uint64, total bool) *types.QueryAllFragmentRequest {
		return &types.QueryAllFragmentRequest{
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
			resp, err := qs.ListFragment(f.ctx, request(nil, uint64(i), uint64(step), false))
			require.NoError(t, err)
			require.LessOrEqual(t, len(resp.Fragment), step)
			require.Subset(t, msgs, resp.Fragment)
		}
	})
	t.Run("ByKey", func(t *testing.T) {
		step := 2
		var next []byte
		for i := 0; i < len(msgs); i += step {
			resp, err := qs.ListFragment(f.ctx, request(next, 0, uint64(step), false))
			require.NoError(t, err)
			require.LessOrEqual(t, len(resp.Fragment), step)
			require.Subset(t, msgs, resp.Fragment)
			next = resp.Pagination.NextKey
		}
	})
	t.Run("Total", func(t *testing.T) {
		resp, err := qs.ListFragment(f.ctx, request(nil, 0, 0, true))
		require.NoError(t, err)
		require.Equal(t, len(msgs), int(resp.Pagination.Total))
		require.EqualExportedValues(t, msgs, resp.Fragment)
	})
	t.Run("InvalidRequest", func(t *testing.T) {
		_, err := qs.ListFragment(f.ctx, nil)
		require.ErrorIs(t, err, status.Error(codes.InvalidArgument, "invalid request"))
	})
}
