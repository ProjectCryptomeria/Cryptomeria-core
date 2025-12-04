package keeper_test

import (
	"testing"

	"fdsc/x/datastore/types"

	"github.com/stretchr/testify/require"
)

func TestGenesis(t *testing.T) {
	genesisState := types.GenesisState{
		Params:      types.DefaultParams(),
		PortId:      types.PortID,
		FragmentMap: []types.Fragment{{FragmentId: "0"}, {FragmentId: "1"}}}

	f := initFixture(t)
	err := f.keeper.InitGenesis(f.ctx, genesisState)
	require.NoError(t, err)
	got, err := f.keeper.ExportGenesis(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, got)

	require.Equal(t, genesisState.PortId, got.PortId)
	require.EqualExportedValues(t, genesisState.Params, got.Params)
	require.EqualExportedValues(t, genesisState.FragmentMap, got.FragmentMap)

}
