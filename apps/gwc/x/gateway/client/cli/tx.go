package cli

import (
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/spf13/cobra"

	"gwc/x/gateway/types"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/client/tx"
)

var (
	DefaultRelativePacketTimeoutTimestamp = uint64((time.Duration(10) * time.Minute).Nanoseconds())
)

const (
	flagPacketTimeoutTimestamp = "packet-timeout-timestamp"
	listSeparator              = ","
)

// GetTxCmd returns the transaction commands for this module
func GetTxCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:                        types.ModuleName,
		Short:                      fmt.Sprintf("%s transactions subcommands", types.ModuleName),
		DisableFlagParsing:         true,
		SuggestionsMinimumDistance: 2,
		RunE:                       client.ValidateCmd,
	}

	cmd.AddCommand(CmdInitUpload())
	cmd.AddCommand(CmdPostChunk())
	cmd.AddCommand(CmdCompleteUpload())
	cmd.AddCommand(CmdSignUpload())

	cmd.AddCommand(CmdRegisterStorage())
	cmd.AddCommand(CmdUpdateParams())

	return cmd
}

// 1. Init Upload
func CmdInitUpload() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "init-upload [project-name] [expected-size]",
		Short: "Initialize a new upload session",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			projectName := args[0]
			expectedSize, err := strconv.ParseUint(args[1], 10, 64)
			if err != nil {
				return err
			}

			msg := types.MsgInitUpload{
				Creator:      clientCtx.GetFromAddress().String(),
				ProjectName:  projectName,
				ExpectedSize: expectedSize,
			}

			if err := msg.ValidateBasic(); err != nil {
				return err
			}
			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

// 2. Post Chunk (For testing mainly, usually handled by SDK)
func CmdPostChunk() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "post-chunk [upload-id] [chunk-index] [file-path]",
		Short: "Post a data chunk for an upload session",
		Args:  cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			uploadID := args[0]
			chunkIndex, err := strconv.ParseUint(args[1], 10, 64)
			if err != nil {
				return err
			}

			filePath := args[2]
			data, err := os.ReadFile(filePath)
			if err != nil {
				return err
			}

			msg := types.MsgPostChunk{
				Creator:    clientCtx.GetFromAddress().String(),
				UploadId:   uploadID,
				ChunkIndex: chunkIndex,
				Data:       data,
			}

			if err := msg.ValidateBasic(); err != nil {
				return err
			}
			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

// 3. Complete Upload
func CmdCompleteUpload() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "complete-upload [upload-id] [filename] [version] [fragment-size]",
		Short: "Complete upload and request server processing",
		Args:  cobra.ExactArgs(4),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			uploadID := args[0]
			filename := args[1]
			version := args[2]
			fragSize, err := strconv.ParseUint(args[3], 10, 64)
			if err != nil {
				return err
			}

			msg := types.MsgCompleteUpload{
				Creator:      clientCtx.GetFromAddress().String(),
				UploadId:     uploadID,
				Filename:     filename,
				Version:      version,
				FragmentSize: fragSize,
			}

			if err := msg.ValidateBasic(); err != nil {
				return err
			}
			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

// 4. Sign Upload
func CmdSignUpload() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "sign-upload [upload-id] [site-root] [signature-base64]",
		Short: "Sign the calculated site root and finalize upload",
		Args:  cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			uploadID := args[0]
			siteRoot := args[1]
			sigBytes, err := base64.StdEncoding.DecodeString(args[2])
			if err != nil {
				return fmt.Errorf("invalid base64 signature: %w", err)
			}

			msg := types.MsgSignUpload{
				Creator:   clientCtx.GetFromAddress().String(),
				UploadId:  uploadID,
				SiteRoot:  siteRoot,
				Signature: sigBytes,
			}

			if err := msg.ValidateBasic(); err != nil {
				return err
			}
			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdRegisterStorage() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "register-storage [channel-id] [chain-id] [api-endpoint] [connection-type]",
		Short: "Register or update a storage node endpoint",
		Args:  cobra.ExactArgs(4),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			info := types.StorageInfo{
				ChannelId:      args[0],
				ChainId:        args[1],
				ApiEndpoint:    args[2],
				ConnectionType: args[3],
			}

			msg := types.MsgRegisterStorage{
				Creator:      clientCtx.GetFromAddress().String(),
				StorageInfos: []*types.StorageInfo{&info},
			}

			if err := msg.ValidateBasic(); err != nil {
				return err
			}
			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdUpdateParams() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "update-params [params]",
		Short: "Update the parameters of the module",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			// (Implementation omitted for brevity, usually auto-scaffolded)
			return nil
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}
