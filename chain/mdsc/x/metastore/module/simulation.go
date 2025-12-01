package metastore

import (
	"math/rand"

	"github.com/cosmos/cosmos-sdk/types/module"
	simtypes "github.com/cosmos/cosmos-sdk/types/simulation"
	"github.com/cosmos/cosmos-sdk/x/simulation"

	"mdsc/testutil/sample"
	metastoresimulation "mdsc/x/metastore/simulation"
	"mdsc/x/metastore/types"
)

// GenerateGenesisState creates a randomized GenState of the module.
func (AppModule) GenerateGenesisState(simState *module.SimulationState) {
	accs := make([]string, len(simState.Accounts))
	for i, acc := range simState.Accounts {
		accs[i] = acc.Address.String()
	}
	metastoreGenesis := types.GenesisState{
		Params: types.DefaultParams(),
		PortId: types.PortID,
		ManifestMap: []types.Manifest{{Creator: sample.AccAddress(),
			ProjectName: "0",
		}, {Creator: sample.AccAddress(),
			ProjectName: "1",
		}}}
	simState.GenState[types.ModuleName] = simState.Cdc.MustMarshalJSON(&metastoreGenesis)
}

// RegisterStoreDecoder registers a decoder.
func (am AppModule) RegisterStoreDecoder(_ simtypes.StoreDecoderRegistry) {}

// WeightedOperations returns the all the gov module operations with their respective weights.
func (am AppModule) WeightedOperations(simState module.SimulationState) []simtypes.WeightedOperation {
	operations := make([]simtypes.WeightedOperation, 0)
	const (
		opWeightMsgCreateManifest          = "op_weight_msg_metastore"
		defaultWeightMsgCreateManifest int = 100
	)

	var weightMsgCreateManifest int
	simState.AppParams.GetOrGenerate(opWeightMsgCreateManifest, &weightMsgCreateManifest, nil,
		func(_ *rand.Rand) {
			weightMsgCreateManifest = defaultWeightMsgCreateManifest
		},
	)
	operations = append(operations, simulation.NewWeightedOperation(
		weightMsgCreateManifest,
		metastoresimulation.SimulateMsgCreateManifest(am.authKeeper, am.bankKeeper, am.keeper, simState.TxConfig),
	))
	const (
		opWeightMsgUpdateManifest          = "op_weight_msg_metastore"
		defaultWeightMsgUpdateManifest int = 100
	)

	var weightMsgUpdateManifest int
	simState.AppParams.GetOrGenerate(opWeightMsgUpdateManifest, &weightMsgUpdateManifest, nil,
		func(_ *rand.Rand) {
			weightMsgUpdateManifest = defaultWeightMsgUpdateManifest
		},
	)
	operations = append(operations, simulation.NewWeightedOperation(
		weightMsgUpdateManifest,
		metastoresimulation.SimulateMsgUpdateManifest(am.authKeeper, am.bankKeeper, am.keeper, simState.TxConfig),
	))
	const (
		opWeightMsgDeleteManifest          = "op_weight_msg_metastore"
		defaultWeightMsgDeleteManifest int = 100
	)

	var weightMsgDeleteManifest int
	simState.AppParams.GetOrGenerate(opWeightMsgDeleteManifest, &weightMsgDeleteManifest, nil,
		func(_ *rand.Rand) {
			weightMsgDeleteManifest = defaultWeightMsgDeleteManifest
		},
	)
	operations = append(operations, simulation.NewWeightedOperation(
		weightMsgDeleteManifest,
		metastoresimulation.SimulateMsgDeleteManifest(am.authKeeper, am.bankKeeper, am.keeper, simState.TxConfig),
	))

	return operations
}

// ProposalMsgs returns msgs used for governance proposals for simulations.
func (am AppModule) ProposalMsgs(simState module.SimulationState) []simtypes.WeightedProposalMsg {
	return []simtypes.WeightedProposalMsg{}
}
