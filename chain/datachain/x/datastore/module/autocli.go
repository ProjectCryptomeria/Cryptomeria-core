package datastore

import (
	autocliv1 "cosmossdk.io/api/cosmos/autocli/v1"

	"datachain/x/datastore/types"
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
					RpcMethod: "ListStoredChunk",
					Use:       "list-stored-chunk",
					Short:     "List all storedChunk",
				},
				{
					RpcMethod:      "GetStoredChunk",
					Use:            "get-stored-chunk [id]",
					Short:          "Gets a storedChunk",
					Alias:          []string{"show-stored-chunk"},
					PositionalArgs: []*autocliv1.PositionalArgDescriptor{{ProtoField: "index"}},
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
					RpcMethod:      "CreateStoredChunk",
					Use:            "create-stored-chunk [index] [data]",
					Short:          "Create a new storedChunk",
					PositionalArgs: []*autocliv1.PositionalArgDescriptor{{ProtoField: "index"}, {ProtoField: "data", Varargs: true}},
				},
				{
					RpcMethod:      "UpdateStoredChunk",
					Use:            "update-stored-chunk [index] [data]",
					Short:          "Update storedChunk",
					PositionalArgs: []*autocliv1.PositionalArgDescriptor{{ProtoField: "index"}, {ProtoField: "data", Varargs: true}},
				},
				{
					RpcMethod:      "DeleteStoredChunk",
					Use:            "delete-stored-chunk [index]",
					Short:          "Delete storedChunk",
					PositionalArgs: []*autocliv1.PositionalArgDescriptor{{ProtoField: "index"}},
				},
				// this line is used by ignite scaffolding # autocli/tx
			},
		},
	}
}
