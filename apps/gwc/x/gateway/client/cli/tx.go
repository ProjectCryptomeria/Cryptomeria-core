package cli

import (
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"gwc/x/gateway/types"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/client/tx"
)

var DefaultRelativePacketTimeoutTimestamp = uint64((time.Duration(10) * time.Minute).Nanoseconds())

const (
	listSeparator = ","
	flagProject   = "project-name"
	flagVersion   = "version"
	flagFragSize  = "fragment-size"
)

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
	cmd.AddCommand(CmdRegisterStorage())

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
			var argData []byte

			// Check if data argument starts with @, indicating a file path
			if len(args[1]) > 0 && args[1][0] == '@' {
				filePath := args[1][1:]
				var err error
				argData, err = os.ReadFile(filePath)
				if err != nil {
					return fmt.Errorf("failed to read file %s: %w", filePath, err)
				}
			} else {
				argData = []byte(args[1])
			}

			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			// フラグの取得
			projectName, err := cmd.Flags().GetString(flagProject)
			if err != nil {
				return err
			}
			version, err := cmd.Flags().GetString(flagVersion)
			if err != nil {
				return err
			}
			fragmentSize, err := cmd.Flags().GetUint64(flagFragSize)
			if err != nil {
				return err
			}

			msg := types.NewMsgUpload(
				clientCtx.GetFromAddress().String(),
				argFilename,
				argData,
				projectName,
				version,
				fragmentSize,
			)
			if err := msg.ValidateBasic(); err != nil {
				return err
			}
			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), msg)
		},
	}

	cmd.Flags().String(flagProject, "", "Project name (required for manifest)")
	cmd.Flags().String(flagVersion, "", "Version string (optional)")
	cmd.Flags().Uint64(flagFragSize, 0, "Fragment size in bytes (default 0: use server default)")

	flags.AddTxFlagsToCmd(cmd)

	return cmd
}

// CmdRegisterStorage
// 構造変更に対応: [channel-id] [chain-id] [url] のトリプレットを受け取る
func CmdRegisterStorage() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "register-storage [channel-id] [chain-id] [url] ...",
		Short: "Register storage node info (e.g. channel-0 fdsc-1 http://localhost:1317)",
		Args:  cobra.MinimumNArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args)%3 != 0 {
				return fmt.Errorf("arguments must be triplets of [channel-id] [chain-id] [url]")
			}

			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			var storageInfos []*types.StorageInfo
			for i := 0; i < len(args); i += 3 {
				storageInfos = append(storageInfos, &types.StorageInfo{
					ChannelId:   args[i],
					ChainId:     args[i+1],
					ApiEndpoint: args[i+2],
					// ConnectionType is usually set automatically by the keeper via IBC hooks,
					// but can be inferred or left empty here if just updating endpoint.
				})
			}

			msg := &types.MsgRegisterStorage{
				Creator:      clientCtx.GetFromAddress().String(),
				StorageInfos: storageInfos,
			}

			if err := msg.ValidateBasic(); err != nil {
				return err
			}
			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}
