package datastore

import (
	"math/rand"

	"github.com/cosmos/cosmos-sdk/types/module"
	simtypes "github.com/cosmos/cosmos-sdk/types/simulation"
	"github.com/cosmos/cosmos-sdk/x/simulation"

	"datachain/testutil/sample"
	datastoresimulation "datachain/x/datastore/simulation"
	"datachain/x/datastore/types"
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
		StoredChunkMap: []types.StoredChunk{{Creator: sample.AccAddress(),
			Index: "0",
		}, {Creator: sample.AccAddress(),
			Index: "1",
		}}}
	simState.GenState[types.ModuleName] = simState.Cdc.MustMarshalJSON(&datastoreGenesis)
}

// RegisterStoreDecoder registers a decoder.
func (am AppModule) RegisterStoreDecoder(_ simtypes.StoreDecoderRegistry) {}

// WeightedOperations returns the all the gov module operations with their respective weights.
func (am AppModule) WeightedOperations(simState module.SimulationState) []simtypes.WeightedOperation {
	operations := make([]simtypes.WeightedOperation, 0)
	const (
		opWeightMsgCreateStoredChunk          = "op_weight_msg_datastore"
		defaultWeightMsgCreateStoredChunk int = 100
	)

	var weightMsgCreateStoredChunk int
	simState.AppParams.GetOrGenerate(opWeightMsgCreateStoredChunk, &weightMsgCreateStoredChunk, nil,
		func(_ *rand.Rand) {
			weightMsgCreateStoredChunk = defaultWeightMsgCreateStoredChunk
		},
	)
	operations = append(operations, simulation.NewWeightedOperation(
		weightMsgCreateStoredChunk,
		datastoresimulation.SimulateMsgCreateStoredChunk(am.authKeeper, am.bankKeeper, am.keeper, simState.TxConfig),
	))
	const (
		opWeightMsgUpdateStoredChunk          = "op_weight_msg_datastore"
		defaultWeightMsgUpdateStoredChunk int = 100
	)

	var weightMsgUpdateStoredChunk int
	simState.AppParams.GetOrGenerate(opWeightMsgUpdateStoredChunk, &weightMsgUpdateStoredChunk, nil,
		func(_ *rand.Rand) {
			weightMsgUpdateStoredChunk = defaultWeightMsgUpdateStoredChunk
		},
	)
	operations = append(operations, simulation.NewWeightedOperation(
		weightMsgUpdateStoredChunk,
		datastoresimulation.SimulateMsgUpdateStoredChunk(am.authKeeper, am.bankKeeper, am.keeper, simState.TxConfig),
	))
	const (
		opWeightMsgDeleteStoredChunk          = "op_weight_msg_datastore"
		defaultWeightMsgDeleteStoredChunk int = 100
	)

	var weightMsgDeleteStoredChunk int
	simState.AppParams.GetOrGenerate(opWeightMsgDeleteStoredChunk, &weightMsgDeleteStoredChunk, nil,
		func(_ *rand.Rand) {
			weightMsgDeleteStoredChunk = defaultWeightMsgDeleteStoredChunk
		},
	)
	operations = append(operations, simulation.NewWeightedOperation(
		weightMsgDeleteStoredChunk,
		datastoresimulation.SimulateMsgDeleteStoredChunk(am.authKeeper, am.bankKeeper, am.keeper, simState.TxConfig),
	))

	return operations
}

// ProposalMsgs returns msgs used for governance proposals for simulations.
func (am AppModule) ProposalMsgs(simState module.SimulationState) []simtypes.WeightedProposalMsg {
	return []simtypes.WeightedProposalMsg{}
}
