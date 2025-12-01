package cli

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"gwc/x/gateway/types"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/client/tx"
)

var DefaultRelativePacketTimeoutTimestamp = uint64((time.Duration(10) * time.Minute).Nanoseconds())

const listSeparator = ","

// GetTxCmd returns the transaction commands for this module.
func GetTxCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:                        types.ModuleName,
		Short:                      fmt.Sprintf("%s transactions subcommands", types.ModuleName),
		DisableFlagParsing:         true,
		SuggestionsMinimumDistance: 2,
		RunE:                       client.ValidateCmd,
	}

	// 手動定義した CmdUpload をコマンドリストに追加
	cmd.AddCommand(CmdUpload())

	return cmd
}

// CmdUpload は upload トランザクションコマンドを定義します
func CmdUpload() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "upload [filename] [data]",
		Short: "Broadcast message upload",
		// 引数が正確に2つ必要であることを指定
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			// 引数の取得
			argFilename := args[0]
			// 文字列として受け取ったデータをバイト列に変換
			argData := []byte(args[1])

			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			// メッセージの作成
			msg := &types.MsgUpload{
				Creator:  clientCtx.GetFromAddress().String(),
				Filename: argFilename,
				Data:     argData,
			}

			if err := msg.ValidateBasic(); err != nil {
				return err
			}

			// トランザクションの生成とブロードキャスト
			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), msg)
		},
	}

	flags.AddTxFlagsToCmd(cmd)

	return cmd
}
