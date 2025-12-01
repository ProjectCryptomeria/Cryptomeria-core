package datastore

import (
	autocliv1 "cosmossdk.io/api/cosmos/autocli/v1"

	"fdsc/x/datastore/types"
)

// AutoCLIOptions implements the autocli.HasAutoCLIConfig interface.
func (am AppModule) AutoCLIOptions() *autocliv1.ModuleOptions {
	return &autocliv1.ModuleOptions{
		Query: &autocliv1.ServiceCommandDescriptor{
			Service: types.Query_serviceDesc.ServiceName,
			RpcCommandOptions: []*autocliv1.RpcCommandOptions{
				{
					RpcMethod: "Params",
					Use:       "params",
					Short:     "Shows the parameters of the module",
				},
				{
					RpcMethod: "ListFragment",
					Use:       "list-fragment",
					Short:     "List all fragment",
				},
				{
					RpcMethod:      "GetFragment",
					Use:            "get-fragment [id]",
					Short:          "Gets a fragment",
					Alias:          []string{"show-fragment"},
					PositionalArgs: []*autocliv1.PositionalArgDescriptor{{ProtoField: "fragment_id"}},
				},
				// this line is used by ignite scaffolding # autocli/query
			},
		},
		Tx: &autocliv1.ServiceCommandDescriptor{
			Service:              types.Msg_serviceDesc.ServiceName,
			EnhanceCustomCommand: true, // only required if you want to use the custom command
			RpcCommandOptions: []*autocliv1.RpcCommandOptions{
				{
					RpcMethod: "UpdateParams",
					Skip:      true, // skipped because authority gated
				},
				{
					RpcMethod:      "CreateFragment",
					Use:            "create-fragment [fragment_id] [data]",
					Short:          "Create a new fragment",
					PositionalArgs: []*autocliv1.PositionalArgDescriptor{{ProtoField: "fragment_id"}, {ProtoField: "data", Varargs: true}},
				},
				{
					RpcMethod:      "UpdateFragment",
					Use:            "update-fragment [fragment_id] [data]",
					Short:          "Update fragment",
					PositionalArgs: []*autocliv1.PositionalArgDescriptor{{ProtoField: "fragment_id"}, {ProtoField: "data", Varargs: true}},
				},
				{
					RpcMethod:      "DeleteFragment",
					Use:            "delete-fragment [fragment_id]",
					Short:          "Delete fragment",
					PositionalArgs: []*autocliv1.PositionalArgDescriptor{{ProtoField: "fragment_id"}},
				},
				// this line is used by ignite scaffolding # autocli/tx
			},
		},
	}
}
