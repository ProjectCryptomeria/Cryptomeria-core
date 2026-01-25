package cli

import (
	"encoding/json"
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

	// CSU commands
	cmd.AddCommand(CmdInitSession())
	cmd.AddCommand(CmdCommitRootProof())
	cmd.AddCommand(CmdDistributeBatch())
	cmd.AddCommand(CmdFinalizeAndCloseSession())
	cmd.AddCommand(CmdAbortAndCloseSession())

	// existing
	cmd.AddCommand(CmdRegisterStorage())
	cmd.AddCommand(CmdUpdateParams())

	return cmd
}

// init-session [fragment-size] [deadline-unix(0=default)]
// executor引数は不要のため削除
func CmdInitSession() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "init-session [fragment-size] [deadline-unix]",
		Short: "Initialize a new CSU session (returns session_id and session_upload_token)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			// args[0] is fragment-size
			fragSize, err := strconv.ParseUint(args[0], 10, 64)
			if err != nil {
				return err
			}
			// args[1] is deadline-unix
			deadlineUnix, err := strconv.ParseInt(args[1], 10, 64)
			if err != nil {
				return err
			}

			msg := types.MsgInitSession{
				Owner: clientCtx.GetFromAddress().String(),
				// Executor field is removed from MsgInitSession
				FragmentSize: fragSize,
				DeadlineUnix: deadlineUnix,
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

// commit-root-proof [session-id] [root-proof-hex]
func CmdCommitRootProof() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "commit-root-proof [session-id] [root-proof-hex]",
		Short: "Commit RootProof for a session",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			msg := types.MsgCommitRootProof{
				Owner:        clientCtx.GetFromAddress().String(),
				SessionId:    args[0],
				RootProofHex: args[1],
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

// distribute-batch [session-id] [items.json]
//
// items.json format:
//
//	{
//	  "items": [
//	    {
//	      "path": "index.html",
//	      "index": 0,
//	      "fragment_bytes_base64": "...",
//	      "fragment_proof": {"steps":[{"sibling_hex":"..","sibling_is_left":true}]},
//	      "file_size": 123,
//	      "file_proof": {"steps":[...]}
//	    }
//	  ]
//	}
func CmdDistributeBatch() *cobra.Command {
	type itemJSON struct {
		Path                string            `json:"path"`
		Index               uint64            `json:"index"`
		FragmentBytesBase64 string            `json:"fragment_bytes_base64"`
		FragmentProof       types.MerkleProof `json:"fragment_proof"`
		FileSize            uint64            `json:"file_size"`
		FileProof           types.MerkleProof `json:"file_proof"`
	}
	type body struct {
		Items []itemJSON `json:"items"`
	}

	cmd := &cobra.Command{
		Use:   "distribute-batch [session-id] [items.json]",
		Short: "Distribute fragments to FDSC (executor signer). Proofs are supplied via json.",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			b, err := os.ReadFile(args[1])
			if err != nil {
				return err
			}
			var doc body
			if err := json.Unmarshal(b, &doc); err != nil {
				return err
			}
			if len(doc.Items) == 0 {
				return fmt.Errorf("items.json has no items")
			}

			items := make([]types.DistributeItem, 0, len(doc.Items))
			for _, it := range doc.Items {
				fragBytes, err := decodeBase64(it.FragmentBytesBase64)
				if err != nil {
					return fmt.Errorf("invalid fragment_bytes_base64: %w", err)
				}
				items = append(items, types.DistributeItem{
					Path:          it.Path,
					Index:         it.Index,
					FragmentBytes: fragBytes,
					FragmentProof: &it.FragmentProof,
					FileSize:      it.FileSize,
					FileProof:     &it.FileProof,
				})
			}

			msg := types.MsgDistributeBatch{
				Executor:  clientCtx.GetFromAddress().String(),
				SessionId: args[0],
				Items:     items,
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

// finalize-and-close [session-id] [manifest.json]
func CmdFinalizeAndCloseSession() *cobra.Command {
	type manifestJSON struct {
		ProjectName  string                         `json:"project_name"`
		Version      string                         `json:"version"`
		Files        map[string]*types.FileMetadata `json:"files"`
		RootProof    string                         `json:"root_proof"`
		FragmentSize uint64                         `json:"fragment_size"`
		Owner        string                         `json:"owner"`
		SessionId    string                         `json:"session_id"`
	}

	cmd := &cobra.Command{
		Use:   "finalize-and-close [session-id] [manifest.json]",
		Short: "Send manifest to MDSC and close on MDSC ACK (executor signer)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			b, err := os.ReadFile(args[1])
			if err != nil {
				return err
			}
			var mj manifestJSON
			if err := json.Unmarshal(b, &mj); err != nil {
				return err
			}

			manifest := types.ManifestPacket{
				ProjectName:  mj.ProjectName,
				Version:      mj.Version,
				Files:        mj.Files,
				RootProof:    mj.RootProof,
				FragmentSize: mj.FragmentSize,
				Owner:        mj.Owner,
				SessionId:    mj.SessionId,
			}

			msg := types.MsgFinalizeAndCloseSession{
				Executor:  clientCtx.GetFromAddress().String(),
				SessionId: args[0],
				Manifest:  manifest,
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

// abort-and-close [session-id] [reason]
func CmdAbortAndCloseSession() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "abort-and-close [session-id] [reason]",
		Short: "Abort and close a session immediately (executor signer)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			msg := types.MsgAbortAndCloseSession{
				Executor:  clientCtx.GetFromAddress().String(),
				SessionId: args[0],
				Reason:    args[1],
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

// --- existing cmds (keep) ---

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
				Authority:    clientCtx.GetFromAddress().String(),
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
		RunE: func(cmd *cobra.Command, args []string) error {
			return nil
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

// helper: minimal base64 decode without extra deps
func decodeBase64(s string) ([]byte, error) {
	// stdlib base64
	return types.DecodeBase64Std(s)
}
