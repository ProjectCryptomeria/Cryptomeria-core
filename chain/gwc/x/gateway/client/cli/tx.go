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

	cmd.AddCommand(CmdUpload())
	cmd.AddCommand(CmdRegisterStorage()) // 追加

	return cmd
}

// CmdUpload は upload トランザクションコマンドを定義します
func CmdUpload() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "upload [filename] [data]",
		Short: "Broadcast message upload",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			argFilename := args[0]
			argData := []byte(args[1])

			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			msg := types.NewMsgUpload(
				clientCtx.GetFromAddress().String(),
				argFilename,
				argData,
			)
			if err := msg.ValidateBasic(); err != nil {
				return err
			}
			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), msg)
		},
	}

	flags.AddTxFlagsToCmd(cmd)

	return cmd
}

// 追加: CmdRegisterStorage
func CmdRegisterStorage() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "register-storage [chain-id] [url] ...",
		Short: "Register storage node endpoints (e.g. mdsc http://localhost:1317)",
		Args:  cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args)%2 != 0 {
				return fmt.Errorf("arguments must be pairs of [chain-id] [url]")
			}

			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			var endpoints []*types.StorageEndpoint
			for i := 0; i < len(args); i += 2 {
				endpoints = append(endpoints, &types.StorageEndpoint{
					ChainId:     args[i],
					ApiEndpoint: args[i+1],
				})
			}

			msg := types.NewMsgRegisterStorage(
				clientCtx.GetFromAddress().String(),
				endpoints,
			)

			if err := msg.ValidateBasic(); err != nil {
				return err
			}
			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}
