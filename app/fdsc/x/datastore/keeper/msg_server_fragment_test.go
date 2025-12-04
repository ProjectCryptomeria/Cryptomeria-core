package keeper_test

import (
	"strconv"
	"testing"

	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	"github.com/stretchr/testify/require"

	"fdsc/x/datastore/keeper"
	"fdsc/x/datastore/types"
)

func TestFragmentMsgServerCreate(t *testing.T) {
	f := initFixture(t)
	srv := keeper.NewMsgServerImpl(f.keeper)
	creator, err := f.addressCodec.BytesToString([]byte("signerAddr__________________"))
	require.NoError(t, err)

	for i := 0; i < 5; i++ {
		expected := &types.MsgCreateFragment{Creator: creator,
			FragmentId: strconv.Itoa(i),
		}
		_, err := srv.CreateFragment(f.ctx, expected)
		require.NoError(t, err)
		rst, err := f.keeper.Fragment.Get(f.ctx, expected.FragmentId)
		require.NoError(t, err)
		require.Equal(t, expected.Creator, rst.Creator)
	}
}

func TestFragmentMsgServerUpdate(t *testing.T) {
	f := initFixture(t)
	srv := keeper.NewMsgServerImpl(f.keeper)

	creator, err := f.addressCodec.BytesToString([]byte("signerAddr__________________"))
	require.NoError(t, err)

	unauthorizedAddr, err := f.addressCodec.BytesToString([]byte("unauthorizedAddr___________"))
	require.NoError(t, err)

	expected := &types.MsgCreateFragment{Creator: creator,
		FragmentId: strconv.Itoa(0),
	}
	_, err = srv.CreateFragment(f.ctx, expected)
	require.NoError(t, err)

	tests := []struct {
		desc    string
		request *types.MsgUpdateFragment
		err     error
	}{
		{
			desc: "invalid address",
			request: &types.MsgUpdateFragment{Creator: "invalid",
				FragmentId: strconv.Itoa(0),
			},
			err: sdkerrors.ErrInvalidAddress,
		},
		{
			desc: "unauthorized",
			request: &types.MsgUpdateFragment{Creator: unauthorizedAddr,
				FragmentId: strconv.Itoa(0),
			},
			err: sdkerrors.ErrUnauthorized,
		},
		{
			desc: "key not found",
			request: &types.MsgUpdateFragment{Creator: creator,
				FragmentId: strconv.Itoa(100000),
			},
			err: sdkerrors.ErrKeyNotFound,
		},
		{
			desc: "completed",
			request: &types.MsgUpdateFragment{Creator: creator,
				FragmentId: strconv.Itoa(0),
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.desc, func(t *testing.T) {
			_, err = srv.UpdateFragment(f.ctx, tc.request)
			if tc.err != nil {
				require.ErrorIs(t, err, tc.err)
			} else {
				require.NoError(t, err)
				rst, err := f.keeper.Fragment.Get(f.ctx, expected.FragmentId)
				require.NoError(t, err)
				require.Equal(t, expected.Creator, rst.Creator)
			}
		})
	}
}

func TestFragmentMsgServerDelete(t *testing.T) {
	f := initFixture(t)
	srv := keeper.NewMsgServerImpl(f.keeper)

	creator, err := f.addressCodec.BytesToString([]byte("signerAddr__________________"))
	require.NoError(t, err)

	unauthorizedAddr, err := f.addressCodec.BytesToString([]byte("unauthorizedAddr___________"))
	require.NoError(t, err)

	_, err = srv.CreateFragment(f.ctx, &types.MsgCreateFragment{Creator: creator,
		FragmentId: strconv.Itoa(0),
	})
	require.NoError(t, err)

	tests := []struct {
		desc    string
		request *types.MsgDeleteFragment
		err     error
	}{
		{
			desc: "invalid address",
			request: &types.MsgDeleteFragment{Creator: "invalid",
				FragmentId: strconv.Itoa(0),
			},
			err: sdkerrors.ErrInvalidAddress,
		},
		{
			desc: "unauthorized",
			request: &types.MsgDeleteFragment{Creator: unauthorizedAddr,
				FragmentId: strconv.Itoa(0),
			},
			err: sdkerrors.ErrUnauthorized,
		},
		{
			desc: "key not found",
			request: &types.MsgDeleteFragment{Creator: creator,
				FragmentId: strconv.Itoa(100000),
			},
			err: sdkerrors.ErrKeyNotFound,
		},
		{
			desc: "completed",
			request: &types.MsgDeleteFragment{Creator: creator,
				FragmentId: strconv.Itoa(0),
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.desc, func(t *testing.T) {
			_, err = srv.DeleteFragment(f.ctx, tc.request)
			if tc.err != nil {
				require.ErrorIs(t, err, tc.err)
			} else {
				require.NoError(t, err)
				found, err := f.keeper.Fragment.Has(f.ctx, tc.request.FragmentId)
				require.NoError(t, err)
				require.False(t, found)
			}
		})
	}
}
