package cli

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/spf13/cobra"

	"mdsc/x/metastore/types"
)

func CmdListManifest() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list-manifest",
		Short: "List all manifest",
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

			params := &types.QueryAllManifestRequest{
				Pagination: pageReq,
			}

			res, err := queryClient.ListManifest(context.Background(), params)
			if err != nil {
				return err
			}

			// 🚀 ここがポイント: AutoCLI (jsonpb) を使わず、標準の json.MarshalIndent で出力
			// これにより、ポインタやマップの問題を回避し、確実にデータを出力します。
			bz, err := json.MarshalIndent(res, "", "  ")
			if err != nil {
				return err
			}

			// コンソールに出力
			fmt.Println(string(bz))
			return nil
		},
	}

	flags.AddPaginationFlagsToCmd(cmd, "list-manifest")
	flags.AddQueryFlagsToCmd(cmd)

	return cmd
}
