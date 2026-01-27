package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"

	"gwc/x/gateway/types"
)

// GetQueryCmd returns the cli query commands for this module
func GetQueryCmd(queryRoute string) *cobra.Command {
	// Use all query commands under the subdirectory
	cmd := &cobra.Command{
		Use:                        types.ModuleName,
		Short:                      fmt.Sprintf("Querying commands for the %s module", types.ModuleName),
		DisableFlagParsing:         true,
		SuggestionsMinimumDistance: 2,
		RunE:                       client.ValidateCmd,
	}

	// 追加: 標準的なクエリコマンド
	cmd.AddCommand(CmdParams())
	cmd.AddCommand(CmdEndpoints())
	
	// 【追加】セッション関連のクエリコマンド
	cmd.AddCommand(CmdSession())
	cmd.AddCommand(CmdSessionsByOwner())

	// 追加: ダウンロードコマンド
	cmd.AddCommand(CmdDownload())

	return cmd
}

func CmdParams() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "params",
		Short: "shows the parameters of the module",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientQueryContext(cmd)
			if err != nil {
				return err
			}

			queryClient := types.NewQueryClient(clientCtx)

			res, err := queryClient.Params(cmd.Context(), &types.QueryParamsRequest{})
			if err != nil {
				return err
			}

			return clientCtx.PrintProto(res)
		},
	}

	flags.AddQueryFlagsToCmd(cmd)

	return cmd
}

func CmdEndpoints() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "endpoints",
		Short: "shows the registered storage endpoints",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientQueryContext(cmd)
			if err != nil {
				return err
			}

			queryClient := types.NewQueryClient(clientCtx)

			pageReq, err := client.ReadPageRequest(cmd.Flags())
			if err != nil {
				return err
			}

			params := &types.QueryStorageEndpointsRequest{
				Pagination: pageReq,
			}

			res, err := queryClient.StorageEndpoints(cmd.Context(), params)
			if err != nil {
				return err
			}

			return clientCtx.PrintProto(res)
		},
	}

	flags.AddQueryFlagsToCmd(cmd)
	flags.AddPaginationFlagsToCmd(cmd, "endpoints")

	return cmd
}

// 【新規追加】指定したIDのセッション情報を取得するコマンド
func CmdSession() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "session [session-id]",
		Short: "query a specific session by ID",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientQueryContext(cmd)
			if err != nil {
				return err
			}

			queryClient := types.NewQueryClient(clientCtx)

			params := &types.QuerySessionRequest{
				SessionId: args[0],
			}

			res, err := queryClient.Session(cmd.Context(), params)
			if err != nil {
				return err
			}

			return clientCtx.PrintProto(res)
		},
	}

	flags.AddQueryFlagsToCmd(cmd)
	return cmd
}

// 【新規追加】特定の所有者のセッション一覧を取得するコマンド
func CmdSessionsByOwner() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list-sessions [owner-address]",
		Short: "query sessions owned by a specific address",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientQueryContext(cmd)
			if err != nil {
				return err
			}

			queryClient := types.NewQueryClient(clientCtx)

			pageReq, err := client.ReadPageRequest(cmd.Flags())
			if err != nil {
				return err
			}

			params := &types.QuerySessionsByOwnerRequest{
				Owner:      args[0],
				Pagination: pageReq,
			}

			res, err := queryClient.SessionsByOwner(cmd.Context(), params)
			if err != nil {
				return err
			}

			return clientCtx.PrintProto(res)
		},
	}

	flags.AddQueryFlagsToCmd(cmd)
	flags.AddPaginationFlagsToCmd(cmd, "sessions")
	return cmd
}