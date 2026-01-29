package cmd

import (
	"time"

	cmtcfg "github.com/cometbft/cometbft/config"
	serverconfig "github.com/cosmos/cosmos-sdk/server/config"
)

// initCometBFTConfig helps to override default CometBFT Config values.
// return cmtcfg.DefaultConfig if no custom configuration is required for the application.
func initCometBFTConfig() *cmtcfg.Config {
	cfg := cmtcfg.DefaultConfig()

	// -------------------------------------------------------------------------
	// entrypoint-chain.sh settings migration
	// -------------------------------------------------------------------------

	// P2P/RPC Listen Address & CORS
	// sed: laddr = "tcp://0.0.0.0:26657"
	cfg.RPC.ListenAddress = "tcp://0.0.0.0:26657"
	// sed: cors_allowed_origins = ["*"]
	cfg.RPC.CORSAllowedOrigins = []string{"*"}
	// sed: timeout_broadcast_tx_commit = "60s"
	cfg.RPC.TimeoutBroadcastTxCommit = 60 * time.Second
	// Large TX support (10 GiB)
	// sed: max_body_bytes, max_tx_bytes, max_txs_bytes = 10737418240
	const largeTxSize = 10737418240
	cfg.RPC.MaxBodyBytes = largeTxSize
	cfg.Mempool.MaxTxBytes = largeTxSize
	cfg.Mempool.MaxTxsBytes = largeTxSize

	// -------------------------------------------------------------------------
	// ▼▼▼ ここを追加：ブロック生成速度の調整 ▼▼▼
	// -------------------------------------------------------------------------

	// TimeoutCommit: ブロック確定後、次の高さへ移る前の待機時間 (デフォルトは5s程度)
	// これを短くするとブロック生成が速くなります。
	cfg.Consensus.TimeoutCommit = 1 * time.Second

	// TimeoutPropose: ブロック提案を待つ時間
	cfg.Consensus.TimeoutPropose = 1 * time.Second
	return cfg
}

// initAppConfig helps to override default appConfig template and configs.
// return "", nil if no custom configuration is required for the application.
func initAppConfig() (string, interface{}) {
	// The following code snippet is just for reference.
	type CustomAppConfig struct {
		serverconfig.Config `mapstructure:",squash"`
	}

	// Optionally allow the chain developer to overwrite the SDK's default
	// server config.
	srvCfg := serverconfig.DefaultConfig()

	// -------------------------------------------------------------------------
	// entrypoint-chain.sh settings migration
	// -------------------------------------------------------------------------

	// API / gRPC Configuration
	// sed: [api] enable = true, address = "tcp://0.0.0.0:1317"
	srvCfg.API.Enable = true
	srvCfg.API.Address = "tcp://0.0.0.0:1317"
	srvCfg.API.EnableUnsafeCORS = true

	// sed: [grpc] enable = true
	srvCfg.GRPC.Enable = true
	// sed: [grpc-web] enable = true
	srvCfg.GRPCWeb.Enable = true

	// Large TX support (10 GiB)
	// sed: rpc-max-body-bytes max-request-body-size, max-recv-msg-size, max-send-msg-size
	const largeTxSize = 10737418240
	srvCfg.API.RPCMaxBodyBytes = largeTxSize
	srvCfg.GRPC.MaxRecvMsgSize = largeTxSize
	srvCfg.GRPC.MaxSendMsgSize = largeTxSize

	// Min Gas Prices
	// script start flag: --minimum-gas-prices=0uatom
	srvCfg.MinGasPrices = "0uatom"

	customAppConfig := CustomAppConfig{
		Config: *srvCfg,
	}

	customAppTemplate := serverconfig.DefaultConfigTemplate

	return customAppTemplate, customAppConfig
}
