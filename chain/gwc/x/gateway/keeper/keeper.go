package keeper

import (
	"fmt"

	"cosmossdk.io/collections"
	"cosmossdk.io/core/address"
	corestore "cosmossdk.io/core/store"
	"github.com/cosmos/cosmos-sdk/codec"
	ibckeeper "github.com/cosmos/ibc-go/v10/modules/core/keeper"

	"gwc/x/gateway/types"
)

type Keeper struct {
	storeService corestore.KVStoreService
	cdc          codec.Codec
	addressCodec address.Codec
	authority    []byte

	Schema collections.Schema
	Params collections.Item[types.Params]

	Port collections.Item[string]

	ibcKeeperFn func() *ibckeeper.Keeper
	// 修正: ScopedKeeper を削除（他ファイルでの引数エラー回避のため）

	bankKeeper types.BankKeeper
}

func NewKeeper(
	storeService corestore.KVStoreService,
	cdc codec.Codec,
	addressCodec address.Codec,
	authority []byte,
	ibcKeeperFn func() *ibckeeper.Keeper,
	// 修正: ScopedKeeper 引数を削除
	bankKeeper types.BankKeeper,
) Keeper {
	if _, err := addressCodec.BytesToString(authority); err != nil {
		panic(fmt.Sprintf("invalid authority address %s: %s", authority, err))
	}

	sb := collections.NewSchemaBuilder(storeService)

	k := Keeper{
		storeService: storeService,
		cdc:          cdc,
		addressCodec: addressCodec,
		authority:    authority,

		bankKeeper:  bankKeeper,
		ibcKeeperFn: ibcKeeperFn,
		// 修正: ScopedKeeper 削除
		Port:   collections.NewItem(sb, types.PortKey, "port", collections.StringValue),
		Params: collections.NewItem(sb, types.ParamsKey, "params", codec.CollValue[types.Params](cdc)),
	}

	schema, err := sb.Build()
	if err != nil {
		panic(err)
	}
	k.Schema = schema

	return k
}

// GetAuthority returns the module's authority.
func (k Keeper) GetAuthority() []byte {
	return k.authority
}
