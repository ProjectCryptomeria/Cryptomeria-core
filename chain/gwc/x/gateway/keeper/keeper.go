package keeper

import (
	"fmt"

	"cosmossdk.io/collections"
	"cosmossdk.io/core/address"
	corestore "cosmossdk.io/core/store"
	"github.com/cosmos/cosmos-sdk/codec"
	sdk "github.com/cosmos/cosmos-sdk/types"
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
	Port   collections.Item[string]

	// チャネル管理用ストア
	MetastoreChannel  collections.Item[string]
	DatastoreChannels collections.KeySet[string]

	// 追加: ChainID -> API URL のマップ
	StorageEndpoints collections.Map[string, string]

	ibcKeeperFn func() *ibckeeper.Keeper
	bankKeeper  types.BankKeeper
}

func NewKeeper(
	storeService corestore.KVStoreService,
	cdc codec.Codec,
	addressCodec address.Codec,
	authority []byte,
	ibcKeeperFn func() *ibckeeper.Keeper,
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
		Port:        collections.NewItem(sb, types.PortKey, "port", collections.StringValue),
		Params:      collections.NewItem(sb, types.ParamsKey, "params", codec.CollValue[types.Params](cdc)),

		MetastoreChannel:  collections.NewItem(sb, types.MetastoreChannelKey, "metastore_channel", collections.StringValue),
		DatastoreChannels: collections.NewKeySet(sb, types.DatastoreChannelKey, "datastore_channels", collections.StringKey),

		// 追加: マップ初期化
		StorageEndpoints: collections.NewMap(sb, types.StorageEndpointKey, "storage_endpoints", collections.StringKey, collections.StringValue),
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

// RegisterChannel はハンドシェイク完了時に呼ばれ、相手のポート名を見て種別を自動判別・保存します
func (k Keeper) RegisterChannel(ctx sdk.Context, portID, channelID string) error {
	// IBC Keeperからチャネル情報を取得
	channel, found := k.ibcKeeperFn().ChannelKeeper.GetChannel(ctx, portID, channelID)
	if !found {
		return fmt.Errorf("channel not found: %s", channelID)
	}

	// 相手側のポートID (Counterparty PortID) を確認
	counterpartyPort := channel.Counterparty.PortId

	ctx.Logger().Info("🔗 Detecting IBC Channel Connection",
		"channel_id", channelID,
		"counterparty_port", counterpartyPort)

	// ポート名で分岐して保存
	switch counterpartyPort {
	case "metastore":
		// MDSCとして登録
		if err := k.MetastoreChannel.Set(ctx, channelID); err != nil {
			return err
		}
		ctx.Logger().Info("✅ Registered MDSC Channel", "channel_id", channelID)

	case "datastore":
		// FDSCとして登録 (Setに追加)
		if err := k.DatastoreChannels.Set(ctx, channelID); err != nil {
			return err
		}
		ctx.Logger().Info("✅ Registered FDSC Channel", "channel_id", channelID)

	default:
		ctx.Logger().Info("⚠️ Unknown counterparty port, skipping registration", "port", counterpartyPort)
	}

	return nil
}
