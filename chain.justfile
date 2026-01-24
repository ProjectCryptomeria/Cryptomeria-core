# chain.just
set shell := ["bash", "-c"]

PROJECT_NAME := "cryptomeria"

_default:
    @just -l chain

# =============================================================================
# 🛠️ Operations & Utilities
# =============================================================================

# [Status] システムステータスを表示
status:
	@./ops/scripts/util/show-status.sh

# [Network] ネットワーク接続状況を表示
network:
	@./ops/scripts/util/show-network-status.sh

# [Health] システムの健康状態を診断
health:
	@./ops/scripts/util/monitor-health.sh

# [Accounts] 全チェーンのアカウントと残高一覧を表示
accounts:
	@./ops/scripts/util/list-accounts.sh

# [Logs] 特定コンポーネントのログを表示
logs target:
	@kubectl logs -f -n {{PROJECT_NAME}} -l app.kubernetes.io/component={{target}} --max-log-requests=10

# [Monitor] Mempool内のトランザクション数をリアルタイム監視 (Ctrl+Cで停止)
monitor-mempool:
    @watch -n 2 ./ops/scripts/util/monitor-mempool.sh

# [Wallet] GWCにクライアント用ウォレットをインポート (対話モード)
add-account name binary="./apps/gwc/dist/gwcd":
    @{{binary}} keys add {{name}} --recover --keyring-backend test

delete-account name binary="./apps/gwc/dist/gwcd":
    @{{binary}} keys delete {{name}} --keyring-backend test

# [Scale] FDSCのノード数を指定した数に変更する (例: just scale 3)
scale-fdsc count:
    @./ops/scripts/control/scale-fdsc.sh {{count}}

# [Faucet] 任意のアドレスにミリオネアから送金
# name: 送金先アドレス名 (必須)
# amount: 送金額 (オプション、デフォルト値あり)
# binary: クライアントバイナリパス (オプション、デフォルト値あり)
faucet name amount="10000000uatom" binary="./apps/gwc/dist/gwcd":
    #!/usr/bin/env sh
    set -e
    ALICE_ADDR=$({{binary}} keys show {{name}} -a --keyring-backend test)
    ./ops/scripts/util/faucet.sh $ALICE_ADDR {{amount}}