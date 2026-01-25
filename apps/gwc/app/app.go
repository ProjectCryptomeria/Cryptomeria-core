package app

import (
	"io"

	clienthelpers "cosmossdk.io/client/v2/helpers"
	"cosmossdk.io/core/appmodule"
	"cosmossdk.io/depinject"
	"cosmossdk.io/log"
	storetypes "cosmossdk.io/store/types"
	circuitkeeper "cosmossdk.io/x/circuit/keeper"
	upgradekeeper "cosmossdk.io/x/upgrade/keeper"

	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	"github.com/cosmos/cosmos-sdk/runtime"
	"github.com/cosmos/cosmos-sdk/server"
	"github.com/cosmos/cosmos-sdk/server/api"
	"github.com/cosmos/cosmos-sdk/server/config"
	servertypes "github.com/cosmos/cosmos-sdk/server/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/module"
	"github.com/cosmos/cosmos-sdk/x/auth"
	authkeeper "github.com/cosmos/cosmos-sdk/x/auth/keeper"
	authsims "github.com/cosmos/cosmos-sdk/x/auth/simulation"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	authzkeeper "github.com/cosmos/cosmos-sdk/x/authz/keeper"
	bankkeeper "github.com/cosmos/cosmos-sdk/x/bank/keeper"
	consensuskeeper "github.com/cosmos/cosmos-sdk/x/consensus/keeper"
	distrkeeper "github.com/cosmos/cosmos-sdk/x/distribution/keeper"
	"github.com/cosmos/cosmos-sdk/x/genutil"
	genutiltypes "github.com/cosmos/cosmos-sdk/x/genutil/types"
	govkeeper "github.com/cosmos/cosmos-sdk/x/gov/keeper"
	mintkeeper "github.com/cosmos/cosmos-sdk/x/mint/keeper"
	paramskeeper "github.com/cosmos/cosmos-sdk/x/params/keeper"
	paramstypes "github.com/cosmos/cosmos-sdk/x/params/types"
	slashingkeeper "github.com/cosmos/cosmos-sdk/x/slashing/keeper"
	stakingkeeper "github.com/cosmos/cosmos-sdk/x/staking/keeper"
	icacontrollerkeeper "github.com/cosmos/ibc-go/v10/modules/apps/27-interchain-accounts/controller/keeper"
	icahostkeeper "github.com/cosmos/ibc-go/v10/modules/apps/27-interchain-accounts/host/keeper"
	ibctransferkeeper "github.com/cosmos/ibc-go/v10/modules/apps/transfer/keeper"
	ibckeeper "github.com/cosmos/ibc-go/v10/modules/core/keeper"

	"gwc/docs"
	gatewaykeeper "gwc/x/gateway/keeper"
	gatewayserver "gwc/x/gateway/server"
)

const (
	// Name はアプリケーションの名前です。
	Name = "gwc"
	// AccountAddressPrefix はアカウントアドレスのプレフィックスです。
	AccountAddressPrefix = "cosmos"
	// ChainCoinType はチェーンのコインタイプです。
	ChainCoinType = 118
)

// DefaultNodeHome はアプリケーションデーモンのデフォルトホームディレクトリです。
var DefaultNodeHome string

var (
	_ runtime.AppI            = (*App)(nil)
	_ servertypes.Application = (*App)(nil)
)

// App は ABCI アプリケーションを拡張したものですが、ほとんどのパラメータがエクスポートされています。
// これらはヘルパー関数の作成を容易にするためにエクスポートされており、テスト目的でオブジェクト機能が必要なわけではありません。
type App struct {
	*runtime.App
	legacyAmino       *codec.LegacyAmino
	appCodec          codec.Codec
	txConfig          client.TxConfig
	interfaceRegistry codectypes.InterfaceRegistry
	appOpts           servertypes.AppOptions

	// キーパー (Keepers)
	// アプリで必要なキーパーのみを公開しています。
	// すべてのモジュールのリストは app_config で利用可能です。
	AuthKeeper            authkeeper.AccountKeeper
	BankKeeper            bankkeeper.Keeper
	StakingKeeper         *stakingkeeper.Keeper
	SlashingKeeper        slashingkeeper.Keeper
	MintKeeper            mintkeeper.Keeper
	DistrKeeper           distrkeeper.Keeper
	GovKeeper             *govkeeper.Keeper
	UpgradeKeeper         *upgradekeeper.Keeper
	AuthzKeeper           authzkeeper.Keeper
	ConsensusParamsKeeper consensuskeeper.Keeper
	CircuitBreakerKeeper  circuitkeeper.Keeper
	ParamsKeeper          paramskeeper.Keeper

	// IBC キーパー
	IBCKeeper           *ibckeeper.Keeper
	ICAControllerKeeper icacontrollerkeeper.Keeper
	ICAHostKeeper       icahostkeeper.Keeper
	TransferKeeper      ibctransferkeeper.Keeper

	// シミュレーションマネージャー
	sm            *module.SimulationManager
	GatewayKeeper gatewaykeeper.Keeper
}

func init() {
	var err error
	clienthelpers.EnvPrefix = Name
	DefaultNodeHome, err = clienthelpers.GetNodeHomeDirectory("." + Name)
	if err != nil {
		panic(err)
	}
}

// AppConfig はデフォルトのアプリ設定を返します。
func AppConfig() depinject.Config {
	return depinject.Configs(
		appConfig,
		depinject.Supply(
			// カスタムモジュール設定を提供
			map[string]module.AppModuleBasic{
				genutiltypes.ModuleName: genutil.NewAppModuleBasic(genutiltypes.DefaultMessageValidator),
			},
		),
	)
}

// New は初期化された App への参照を返します。
func New(
	logger log.Logger,
	db dbm.DB,
	traceStore io.Writer,
	loadLatest bool,
	appOpts servertypes.AppOptions,
	baseAppOptions ...func(*baseapp.BaseApp),
) *App {
	var (
		app        = &App{}
		appBuilder *runtime.AppBuilder

		// AppConfig とその他の設定を1つの設定にマージします
		appConfig = depinject.Configs(
			AppConfig(),
			depinject.Supply(
				appOpts, // アプリオプションの提供
				logger,  // ロガーの提供

				// App Wiring を使用する IBC モジュール用の IBC Keeper ゲッターを提供します。
				// IBC Keeper はまだ初期化されていないため、直接渡すことはできません。
				// ゲッターを渡すことで、アプリの IBC Keeper に常にアクセスできるようになります。
				// IBC が App Wiring をサポートした後は、これを削除する必要があります。
				app.GetIBCKeeper,

				// ここで、DI コンテナに代替オプションを提供できます。
				// これらのオプションを使用して、一部のモジュールのデフォルト動作をオーバーライドできます。
				// 例えば、bech32 アドレスを使用しないカスタムアドレスコーデックを提供するなどです。
				// 使用可能なオプションとその使用方法については、depinject のドキュメントと
				// depinject モジュールのワイヤリングを参照してください。
			),
		)
	)

	var appModules map[string]appmodule.AppModule
	if err := depinject.Inject(appConfig,
		&appBuilder,
		&appModules,
		&app.appCodec,
		&app.legacyAmino,
		&app.txConfig,
		&app.interfaceRegistry,
		&app.AuthKeeper,
		&app.BankKeeper,
		&app.StakingKeeper,
		&app.SlashingKeeper,
		&app.MintKeeper,
		&app.DistrKeeper,
		&app.GovKeeper,
		&app.UpgradeKeeper,
		&app.AuthzKeeper,
		&app.ConsensusParamsKeeper,
		&app.CircuitBreakerKeeper,
		&app.ParamsKeeper,
		&app.ParamsKeeper,
		&app.GatewayKeeper,
	); err != nil {
		panic(err)
	}

	// デフォルトの baseapp オプションに追加
	// 楽観的実行 (Optimistic Execution) を有効化
	baseAppOptions = append(baseAppOptions, baseapp.SetOptimisticExecution())

	// アプリのビルド
	app.App = appBuilder.Build(db, traceStore, baseAppOptions...)
	app.appOpts = appOpts

	// レガシーモジュールの登録
	if err := app.registerIBCModules(appOpts); err != nil {
		panic(err)
	}

	/**** モジュールオプション ****/

	// シミュレーションマネージャーを作成し、決定論的シミュレーションのためのモジュールの順序を定義します
	overrideModules := map[string]module.AppModuleSimulation{
		authtypes.ModuleName: auth.NewAppModule(app.appCodec, app.AuthKeeper, authsims.RandomGenesisAccounts, nil),
	}
	app.sm = module.NewSimulationManagerFromAppModules(app.ModuleManager.Modules, overrideModules)

	app.sm.RegisterStoreDecoders()

	// カスタム InitChainer は、追加の genesis 前初期化ロジックが必要な場合に設定します。
	// これは、App Wiring をサポートしていない手動登録モジュールに必要です。
	// 以下に示すように、モジュールバージョンマップを手動で設定します。
	// アップグレードモジュールは、モジュールバージョンマップの重複排除を自動的に処理します。
	app.SetInitChainer(func(ctx sdk.Context, req *abci.RequestInitChain) (*abci.ResponseInitChain, error) {
		if err := app.UpgradeKeeper.SetModuleVersionMap(ctx, app.ModuleManager.GetVersionMap()); err != nil {
			return nil, err
		}
		return app.App.InitChainer(ctx, req)
	})

	if err := app.Load(loadLatest); err != nil {
		panic(err)
	}

	return app
}

// GetSubspace は指定されたモジュール名のパラメータサブスペースを返します。
func (app *App) GetSubspace(moduleName string) paramstypes.Subspace {
	subspace, _ := app.ParamsKeeper.GetSubspace(moduleName)
	return subspace
}

// LegacyAmino はアプリの Amino コーデックを返します。
func (app *App) LegacyAmino() *codec.LegacyAmino {
	return app.legacyAmino
}

// AppCodec はアプリのアプリコーデックを返します。
func (app *App) AppCodec() codec.Codec {
	return app.appCodec
}

// InterfaceRegistry はアプリの InterfaceRegistry を返します。
func (app *App) InterfaceRegistry() codectypes.InterfaceRegistry {
	return app.interfaceRegistry
}

// TxConfig はアプリの TxConfig を返します。
func (app *App) TxConfig() client.TxConfig {
	return app.txConfig
}

// GetKey は指定されたストアキーに対応する KVStoreKey を返します。
func (app *App) GetKey(storeKey string) *storetypes.KVStoreKey {
	kvStoreKey, ok := app.UnsafeFindStoreKey(storeKey).(*storetypes.KVStoreKey)
	if !ok {
		return nil
	}
	return kvStoreKey
}

// SimulationManager は SimulationApp インターフェースを実装します。
func (app *App) SimulationManager() *module.SimulationManager {
	return app.sm
}

// RegisterAPIRoutes は、APIサーバーにすべてのアプリケーションモジュールのルートを登録します。
func (app *App) RegisterAPIRoutes(apiSvr *api.Server, apiConfig config.APIConfig) {
	// 【重要】カスタムHTTPルートの登録を最初に行います。
	// ベース実装(app.App.RegisterAPIRoutes)は、gRPC-Gatewayのキャッチオールハンドラ("/")を
	// 登録するため、それよりも前に登録しないとリクエストが到達しません。
	// gorilla/muxは登録された順序でマッチングを行います。

	// 1. AppOptionsからGateway設定を読み込み
	mdscEndpoint, _ := app.appOpts.Get("gwc.mdsc_endpoint").(string)
	fdscEndpointsRaw, _ := app.appOpts.Get("gwc.fdsc_endpoints").(map[string]interface{})

	fdscEndpoints := make(map[string]string)
	for k, v := range fdscEndpointsRaw {
		if strVal, ok := v.(string); ok {
			fdscEndpoints[k] = strVal
		}
	}

	gatewayConfig := gatewayserver.GatewayConfig{
		MDSCEndpoint:  mdscEndpoint,
		FDSCEndpoints: fdscEndpoints,
	}

	// 2. カスタムHTTPハンドラ（TUSアップロード/レンダリング）の登録
	gatewayserver.RegisterCustomHTTPRoutes(apiSvr.ClientCtx, apiSvr.Router, app.GatewayKeeper, gatewayConfig)

	// 3. Swagger / OpenAPI の登録（これらも特定のプレフィックスを持つため、キャッチオールより前に登録推奨）
	// 他のアプリケーションが容易にオーバーライドできるように、swagger API を app.go で登録します。
	if err := server.RegisterSwaggerAPI(apiSvr.ClientCtx, apiSvr.Router, apiConfig.Swagger); err != nil {
		panic(err)
	}

	// アプリの OpenAPI ルートを登録します。
	docs.RegisterOpenAPIService(Name, apiSvr.Router)

	// 4. 標準APIルート（gRPC Gateway）の登録
	// ここで "/" へのキャッチオールハンドラが登録されます。
	app.App.RegisterAPIRoutes(apiSvr, apiConfig)
}

// GetMaccPerms はモジュールアカウントの権限のコピーを返します。
//
// 注意: これはテスト目的でのみ使用されます。
func GetMaccPerms() map[string][]string {
	dup := make(map[string][]string)
	for _, perms := range moduleAccPerms {
		dup[perms.GetAccount()] = perms.GetPermissions()
	}

	return dup
}

// BlockedAddresses はアプリのブロックされたアカウントアドレスをすべて返します。
func BlockedAddresses() map[string]bool {
	result := make(map[string]bool)

	if len(blockAccAddrs) > 0 {
		for _, addr := range blockAccAddrs {
			result[addr] = true
		}
	} else {
		for addr := range GetMaccPerms() {
			result[addr] = true
		}
	}

	return result
}
