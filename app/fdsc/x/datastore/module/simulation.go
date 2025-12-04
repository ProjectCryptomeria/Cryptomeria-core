package datastore

import (
	"math/rand"

	"github.com/cosmos/cosmos-sdk/types/module"
	simtypes "github.com/cosmos/cosmos-sdk/types/simulation"
	"github.com/cosmos/cosmos-sdk/x/simulation"

	"fdsc/testutil/sample"
	datastoresimulation "fdsc/x/datastore/simulation"
	"fdsc/x/datastore/types"
)

// GenerateGenesisState creates a randomized GenState of the module.
func (AppModule) GenerateGenesisState(simState *module.SimulationState) {
	accs := make([]string, len(simState.Accounts))
	for i, acc := range simState.Accounts {
		accs[i] = acc.Address.String()
	}
	datastoreGenesis := types.GenesisState{
		Params: types.DefaultParams(),
		PortId: types.PortID,
		FragmentMap: []types.Fragment{{Creator: sample.AccAddress(),
			FragmentId: "0",
		}, {Creator: sample.AccAddress(),
			FragmentId: "1",
		}}}
	simState.GenState[types.ModuleName] = simState.Cdc.MustMarshalJSON(&datastoreGenesis)
}

// RegisterStoreDecoder registers a decoder.
func (am AppModule) RegisterStoreDecoder(_ simtypes.StoreDecoderRegistry) {}

// WeightedOperations returns the all the gov module operations with their respective weights.
func (am AppModule) WeightedOperations(simState module.SimulationState) []simtypes.WeightedOperation {
	operations := make([]simtypes.WeightedOperation, 0)
	const (
		opWeightMsgCreateFragment          = "op_weight_msg_datastore"
		defaultWeightMsgCreateFragment int = 100
	)

	var weightMsgCreateFragment int
	simState.AppParams.GetOrGenerate(opWeightMsgCreateFragment, &weightMsgCreateFragment, nil,
		func(_ *rand.Rand) {
			weightMsgCreateFragment = defaultWeightMsgCreateFragment
		},
	)
	operations = append(operations, simulation.NewWeightedOperation(
		weightMsgCreateFragment,
		datastoresimulation.SimulateMsgCreateFragment(am.authKeeper, am.bankKeeper, am.keeper, simState.TxConfig),
	))
	const (
		opWeightMsgUpdateFragment          = "op_weight_msg_datastore"
		defaultWeightMsgUpdateFragment int = 100
	)

	var weightMsgUpdateFragment int
	simState.AppParams.GetOrGenerate(opWeightMsgUpdateFragment, &weightMsgUpdateFragment, nil,
		func(_ *rand.Rand) {
			weightMsgUpdateFragment = defaultWeightMsgUpdateFragment
		},
	)
	operations = append(operations, simulation.NewWeightedOperation(
		weightMsgUpdateFragment,
		datastoresimulation.SimulateMsgUpdateFragment(am.authKeeper, am.bankKeeper, am.keeper, simState.TxConfig),
	))
	const (
		opWeightMsgDeleteFragment          = "op_weight_msg_datastore"
		defaultWeightMsgDeleteFragment int = 100
	)

	var weightMsgDeleteFragment int
	simState.AppParams.GetOrGenerate(opWeightMsgDeleteFragment, &weightMsgDeleteFragment, nil,
		func(_ *rand.Rand) {
			weightMsgDeleteFragment = defaultWeightMsgDeleteFragment
		},
	)
	operations = append(operations, simulation.NewWeightedOperation(
		weightMsgDeleteFragment,
		datastoresimulation.SimulateMsgDeleteFragment(am.authKeeper, am.bankKeeper, am.keeper, simState.TxConfig),
	))

	return operations
}

// ProposalMsgs returns msgs used for governance proposals for simulations.
func (am AppModule) ProposalMsgs(simState module.SimulationState) []simtypes.WeightedProposalMsg {
	return []simtypes.WeightedProposalMsg{}
}
