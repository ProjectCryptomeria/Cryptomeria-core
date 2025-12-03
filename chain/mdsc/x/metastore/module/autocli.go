package metastore

import (
	autocliv1 "cosmossdk.io/api/cosmos/autocli/v1"

	"mdsc/x/metastore/types"
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
					RpcMethod: "ListManifest",
					Use:       "list-manifest",
					Short:     "List all manifest",
				},
				{
					RpcMethod:      "GetManifest",
					Use:            "get-manifest [id]",
					Short:          "Gets a manifest",
					Alias:          []string{"show-manifest"},
					PositionalArgs: []*autocliv1.PositionalArgDescriptor{{ProtoField: "project_name"}},
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
					RpcMethod:      "CreateManifest",
					Use:            "create-manifest [project_name] [version]",
					Short:          "Create a new manifest",
					PositionalArgs: []*autocliv1.PositionalArgDescriptor{{ProtoField: "project_name"}, {ProtoField: "version"}},
				},
				{
					RpcMethod:      "UpdateManifest",
					Use:            "update-manifest [project_name] [version]",
					Short:          "Update manifest",
					PositionalArgs: []*autocliv1.PositionalArgDescriptor{{ProtoField: "project_name"}, {ProtoField: "version"}},
				},
				{
					RpcMethod:      "DeleteManifest",
					Use:            "delete-manifest [project_name]",
					Short:          "Delete manifest",
					PositionalArgs: []*autocliv1.PositionalArgDescriptor{{ProtoField: "project_name"}},
				},
				// this line is used by ignite scaffolding # autocli/tx
			},
		},
	}
}
