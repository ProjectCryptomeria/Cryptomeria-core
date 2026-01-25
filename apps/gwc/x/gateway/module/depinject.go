package gateway

import (
	"os"

	"cosmossdk.io/core/address"
	"cosmossdk.io/core/appmodule"
	"cosmossdk.io/core/store"
	"cosmossdk.io/depinject"
	"cosmossdk.io/depinject/appconfig"
	feegrantkeeper "cosmossdk.io/x/feegrant/keeper"
	"github.com/cosmos/cosmos-sdk/codec"
	authkeeper "github.com/cosmos/cosmos-sdk/x/auth/keeper"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	authzkeeper "github.com/cosmos/cosmos-sdk/x/authz/keeper"
	bankkeeper "github.com/cosmos/cosmos-sdk/x/bank/keeper"
	ibckeeper "github.com/cosmos/ibc-go/v10/modules/core/keeper"

	"gwc/x/gateway/keeper"
	"gwc/x/gateway/types"
)

var _ depinject.OnePerModuleType = AppModule{}

// IsOnePerModuleType implements the depinject.OnePerModuleType interface.
func (AppModule) IsOnePerModuleType() {}

func init() {
	appconfig.Register(
		&types.Module{},
		appconfig.Provide(ProvideModule),
	)
}

type ModuleInputs struct {
	depinject.In

	Config       *types.Module
	StoreService store.KVStoreService
	Cdc          codec.Codec
	AddressCodec address.Codec

	// Use standard SDK interfaces or concrete types for depinject resolution
	AuthKeeper authkeeper.AccountKeeper
	BankKeeper bankkeeper.Keeper

	// Issue6/7/8
	// depinject will inject the concrete structs provided by these modules
	AuthzKeeper    authzkeeper.Keeper
	FeegrantKeeper feegrantkeeper.Keeper

	IBCKeeperFn   func() *ibckeeper.Keeper `optional:"true"`
	AccountKeeper authkeeper.AccountKeeper
}

type ModuleOutputs struct {
	depinject.Out

	GatewayKeeper keeper.Keeper
	Module        appmodule.AppModule
}

func ProvideModule(in ModuleInputs) ModuleOutputs {
	// default to governance authority if not provided
	authority := authtypes.NewModuleAddress(types.GovModuleName)

	// Priority 1: Environment Variable (for Dev/Ops override)
	// This allows local-admin to act as authority without code changes
	if envAuth := os.Getenv("GWC_GATEWAY_AUTHORITY"); envAuth != "" {
		authority = authtypes.NewModuleAddressOrBech32Address(envAuth)
	} else if in.Config.Authority != "" {
		// Priority 2: Config file
		authority = authtypes.NewModuleAddressOrBech32Address(in.Config.Authority)
	}

	// Create a MsgServer wrapper for feegrant to expose Revoke functionality to the gateway keeper
	feegrantMsgServer := feegrantkeeper.NewMsgServerImpl(in.FeegrantKeeper)

	k := keeper.NewKeeper(
		in.StoreService,
		in.Cdc,
		in.AddressCodec,
		authority,
		in.IBCKeeperFn,
		in.BankKeeper,
		in.AccountKeeper,
		&in.AuthzKeeper,   // Pass pointer to concrete struct
		feegrantMsgServer, // Pass MsgServer implementation which satisfies types.FeegrantKeeper
	)
	m := NewAppModule(in.Cdc, k, in.AuthKeeper, in.BankKeeper)

	return ModuleOutputs{GatewayKeeper: k, Module: m}
}
