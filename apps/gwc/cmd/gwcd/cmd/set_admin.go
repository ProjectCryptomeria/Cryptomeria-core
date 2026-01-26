package cmd

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/server"
	"github.com/cosmos/cosmos-sdk/x/genutil"
	genutiltypes "github.com/cosmos/cosmos-sdk/x/genutil/types"

	"gwc/x/gateway/types"
)

// SetAdminCmd は、genesis.json 内の gateway モジュールの管理者アドレスを設定するコマンドを生成します。
// 引数として受け取ったアドレスを local_admin パラメータに設定します。
func SetAdminCmd(defaultNodeHome string) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "set-admin [address]",
		Short: "Set the administrator address for the gateway module in genesis.json",
		Long: `This command updates the 'local_admin' parameter within the gateway module's state in the genesis file.
The CSU (Client Storage Unit) requires this address to be set for validating storage operations.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx := client.GetClientContextFromCmd(cmd)
			serverCtx := server.GetServerContextFromCmd(cmd)
			config := serverCtx.Config

			// 入力された管理者アドレスを取得
			adminAddr := args[0]

			// genesis ファイルのパスを取得
			genFile := config.GenesisFile()

			// genesis データを AppGenesis オブジェクトとして読み込む
			appGenesis, err := genutiltypes.AppGenesisFromFile(genFile)
			if err != nil {
				return fmt.Errorf("failed to load genesis file: %w", err)
			}

			// AppState (JSON) を map に変換して編集可能にする
			var appState map[string]json.RawMessage
			if err := json.Unmarshal(appGenesis.AppState, &appState); err != nil {
				return fmt.Errorf("failed to unmarshal app state: %w", err)
			}

			// gateway モジュールの状態を取得または初期化
			var gatewayGenState types.GenesisState
			if appState[types.ModuleName] != nil {
				clientCtx.Codec.MustUnmarshalJSON(appState[types.ModuleName], &gatewayGenState)
			} else {
				// モジュール名 "gateway" のデフォルト値をロード
				gatewayGenState = *types.DefaultGenesis()
			}

			// 管理者アドレス (local_admin) を更新
			gatewayGenState.Params.LocalAdmin = adminAddr

			// 修正した状態を JSON にシリアライズして appState マップに戻す
			appState[types.ModuleName] = clientCtx.Codec.MustMarshalJSON(&gatewayGenState)

			// AppGenesis オブジェクト内の AppState を、更新した JSON データで上書きする
			updatedAppState, err := json.MarshalIndent(appState, "", "  ")
			if err != nil {
				return fmt.Errorf("failed to marshal updated app state: %w", err)
			}
			appGenesis.AppState = updatedAppState

			// 変更をファイルに書き出す
			// Cosmos SDK v0.50+ では、ExportGenesisFile(appGenesis, filePath) の形式で呼び出します
			err = genutil.ExportGenesisFile(appGenesis, genFile)
			if err != nil {
				return fmt.Errorf("failed to export genesis file: %w", err)
			}

			fmt.Printf("Successfully set local admin to: %s\n", adminAddr)
			return nil
		},
	}

	return cmd
}
