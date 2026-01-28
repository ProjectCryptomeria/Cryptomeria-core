package app

import (
	"fmt"
	"io"
	"net/http"
	"strings"

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
type App struct {
	*runtime.App
	legacyAmino       *codec.LegacyAmino
	appCodec          codec.Codec
	txConfig          client.TxConfig
	interfaceRegistry codectypes.InterfaceRegistry
	appOpts           servertypes.AppOptions

	// キーパー (Keepers)
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

		appConfig = depinject.Configs(
			AppConfig(),
			depinject.Supply(
				appOpts,
				logger,
				app.GetIBCKeeper,
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
		&app.GatewayKeeper,
	); err != nil {
		panic(err)
	}

	baseAppOptions = append(baseAppOptions, baseapp.SetOptimisticExecution())

	app.App = appBuilder.Build(db, traceStore, baseAppOptions...)
	app.appOpts = appOpts

	if err := app.registerIBCModules(appOpts); err != nil {
		panic(err)
	}

	overrideModules := map[string]module.AppModuleSimulation{
		authtypes.ModuleName: auth.NewAppModule(app.appCodec, app.AuthKeeper, authsims.RandomGenesisAccounts, nil),
	}
	app.sm = module.NewSimulationManagerFromAppModules(app.ModuleManager.Modules, overrideModules)

	app.sm.RegisterStoreDecoders()

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
	fmt.Println("DEBUG: RegisterAPIRoutes - Starting Injection")

	// 1. TUSハンドラーの初期化
	uploadDir := "./tmp/uploads"
	// 【重要】ベースパスを "/upload/tus-stream/" (末尾スラッシュあり) に固定します。
	// tusd内部でのID解析の起点となるため、末尾スラッシュは必須です。
	tusBasePath := "/upload/tus-stream/"

	tusHandler, err := gatewayserver.NewTusHandler(apiSvr.ClientCtx, app.GatewayKeeper, uploadDir, tusBasePath)
	if err != nil {
		panic(fmt.Sprintf("Failed to init TUS: %v", err))
	}

	// 2. TUSリクエスト専用の優先ミドルウェア
	apiSvr.Router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			// TUS関連のリクエストパス（/upload/tus-stream...）を検知
			if strings.HasPrefix(req.URL.Path, "/upload/tus-stream") {

				// --- パスの正規化 (Normalization) ---
				// クライアントが末尾スラッシュを忘れた場合 ("/upload/tus-stream") でも、
				// コレクションエンドポイント ("/upload/tus-stream/") として扱うように補完します。
				if req.URL.Path == "/upload/tus-stream" {
					req.URL.Path = "/upload/tus-stream/"
				}

				// 詳細デバッグログ
				fmt.Printf("\n🎯 [TUS DEBUG] Method: %s | Path: %s\n", req.Method, req.URL.Path)

				// ブラウザおよびスクリプト向けのCORSヘッダー強制付与
				w.Header().Set("Access-Control-Allow-Origin", "*")
				w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE, PATCH, HEAD")
				w.Header().Set("Access-Control-Allow-Headers", "*")
				// Locationヘッダーを公開しないと、クライアントが次のPATCHリクエスト先を知ることができません。
				w.Header().Set("Access-Control-Expose-Headers", "Location, Tus-Resumable, Upload-Offset, Upload-Length")

				// OPTIONS (プリフライト) は 204 で即答して終了
				if req.Method == http.MethodOptions {
					w.WriteHeader(http.StatusNoContent)
					return
				}

				// 【重要】StripPrefix は行わず、正規化したパスをそのまま tusHandler (tusd) へ渡します。
				// tusd は config.BasePath と req.URL.Path を比較して処理を分岐するためです。
				tusHandler.ServeHTTP(w, req)
				return // TUSとして処理を完結させる
			}

			// TUS以外（通常のCosmos SDKルート）はそのまま次へ
			next.ServeHTTP(w, req)
		})
	})

	// 3. カスタムハンドラー設定の準備 (Render用)
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
		UploadDir:     uploadDir,
	}

	// 4. Render用GETルート等の登録
	gatewayserver.RegisterCustomHTTPRoutes(apiSvr.ClientCtx, apiSvr.Router, app.GatewayKeeper, gatewayConfig, tusHandler)

	// 5. 標準Cosmos SDK APIルートの登録
	app.App.RegisterAPIRoutes(apiSvr, apiConfig)

	fmt.Println("DEBUG: RegisterAPIRoutes - Injection Complete")
}

// GetMaccPerms はモジュールアカウントの権限のコピーを返します。
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
