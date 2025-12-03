package cli

import (
	"bytes" // bytesパッケージを追加
	"context"
	"encoding/json" // encoding/jsonパッケージを追加
	"fmt"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/spf13/cobra"

	"mdsc/x/metastore/types"
)

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

			// -o jsonが指定された場合、Manifest配列のみを出力する
			if clientCtx.OutputFormat == "json" {
				// 1. Manifest配列 (res.Manifest) をGoの標準jsonライブラリでマーシャリング
				//    (スライスを渡すには clientCtx.Codec ではなく json.Marshal を使う必要がある)
				bz, err := clientCtx.Codec.MarshalJSON(res)
				if err != nil {
					return err
				}

				// 2. 標準の Go json ライブラリを使ってインデント（Pretty Print）
				var prettyJSON bytes.Buffer
				// インデントは空白2つ ("  ") に設定
				if err := json.Indent(&prettyJSON, bz, "", "  "); err != nil {
					return err
				}

				// 3. インデントされたJSON配列を標準出力
				fmt.Println(prettyJSON.String())
				return nil
			}

			// JSON以外の形式（YAMLなど）の場合は標準のPrintProtoを使用
			return clientCtx.PrintProto(res)
		},
	}

	flags.AddPaginationFlagsToCmd(cmd, "list-manifest")
	flags.AddQueryFlagsToCmd(cmd)

	return cmd
}

func CmdGetManifest() *cobra.Command {
	cmd := &cobra.Command{
		// [project-name] を引数として定義
		Use:   "get-manifest [project-name]",
		Short: "Query manifest by project name",
		// 引数が1つであることを強制
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientQueryContext(cmd)
			if err != nil {
				return err
			}

			queryClient := types.NewQueryClient(clientCtx)

			params := &types.QueryGetManifestRequest{
				// 最初の引数を ProjectName として使用
				ProjectName: args[0],
			}

			// gRPCクエリを実行
			res, err := queryClient.GetManifest(context.Background(), params)
			if err != nil {
				return err
			}

			// -o jsonが指定された場合、Manifestオブジェクトのみを出力する
			if clientCtx.OutputFormat == "json" {
				// 1. Manifestオブジェクト (res.Manifest) をGoの標準jsonライブラリでマーシャリング
				//    QueryGetManifestResponseから単一のManifestオブジェクトを抽出
				bz, err := json.Marshal(res.Manifest)
				if err != nil {
					return err
				}

				// 2. 標準の Go json ライブラリを使ってインデント（Pretty Print）
				var prettyJSON bytes.Buffer
				// インデントは空白2つ ("  ") に設定
				if err := json.Indent(&prettyJSON, bz, "", "  "); err != nil {
					return err
				}

				// 3. インデントされたJSONオブジェクトを標準出力
				fmt.Println(prettyJSON.String())
				return nil
			}

			// JSON以外の形式（YAMLなど）の場合は標準のPrintProtoを使用
			// Manifestオブジェクトがルートオブジェクトとして出力される
			return clientCtx.PrintProto(res)
		},
	}

	// Queryコマンドに必要な共通フラグを追加
	flags.AddQueryFlagsToCmd(cmd)

	return cmd
}
