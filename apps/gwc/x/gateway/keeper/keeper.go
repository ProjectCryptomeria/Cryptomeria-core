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

	// チャネル管理用
	MetastoreChannel  collections.Item[string]
	DatastoreChannels collections.KeySet[string]
	StorageInfos      collections.Map[string, types.StorageInfo]

	// --- CSU Session management (upload_id 完全削除 / 後方互換なし) ---

	// Sessions: Key=session_id, Value=types.Session
	Sessions collections.Map[string, types.Session]

	// SessionFragmentSeen: Key=frag_key (session_id\x00path\x00%020d(index))
	SessionFragmentSeen collections.KeySet[string]

	// FragmentSeqToFragmentKey: Key=seq_key (%020d), Value=frag_key
	FragmentSeqToFragmentKey collections.Map[string, string]

	// ManifestSeqToSessionID: Key=seq_key (%020d), Value=session_id
	ManifestSeqToSessionID collections.Map[string, string]

	// SessionUploadTokenHash: Key=session_id, Value=sha256(token) etc.
	SessionUploadTokenHash collections.Map[string, []byte]

	ibcKeeperFn   func() *ibckeeper.Keeper
	bankKeeper    types.BankKeeper
	accountKeeper types.AccountKeeper // 既存：後続Issueで整理（現Issueでは保持）

	// Issue6/7/8
	authzKeeper    types.AuthzKeeper
	feegrantKeeper types.FeegrantKeeper
}

func NewKeeper(
	storeService corestore.KVStoreService,
	cdc codec.Codec,
	addressCodec address.Codec,
	authority []byte,
	ibcKeeperFn func() *ibckeeper.Keeper,
	bankKeeper types.BankKeeper,
	accountKeeper types.AccountKeeper,
	authzKeeper types.AuthzKeeper,
	feegrantKeeper types.FeegrantKeeper,
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

		bankKeeper:    bankKeeper,
		accountKeeper: accountKeeper,
		ibcKeeperFn:   ibcKeeperFn,

		authzKeeper:    authzKeeper,
		feegrantKeeper: feegrantKeeper,

		Port:   collections.NewItem(sb, types.PortKey, "port", collections.StringValue),
		Params: collections.NewItem(sb, types.ParamsKey, "params", codec.CollValue[types.Params](cdc)),

		MetastoreChannel:  collections.NewItem(sb, types.MetastoreChannelKey, "metastore_channel", collections.StringValue),
		DatastoreChannels: collections.NewKeySet(sb, types.DatastoreChannelKey, "datastore_channels", collections.StringKey),
		StorageInfos:      collections.NewMap(sb, types.StorageEndpointKey, "storage_infos", collections.StringKey, codec.CollValue[types.StorageInfo](cdc)),

		Sessions: collections.NewMap(
			sb,
			types.SessionKey,
			"sessions",
			collections.StringKey,
			codec.CollValue[types.Session](cdc),
		),

		SessionFragmentSeen: collections.NewKeySet(
			sb,
			types.SessionFragmentSeenKey,
			"session_fragment_seen",
			collections.StringKey,
		),

		FragmentSeqToFragmentKey: collections.NewMap(
			sb,
			types.FragmentSeqToFragmentKey,
			"fragment_seq_to_fragment_key",
			collections.StringKey,
			collections.StringValue,
		),

		ManifestSeqToSessionID: collections.NewMap(
			sb,
			types.ManifestSeqToSessionKey,
			"manifest_seq_to_session_id",
			collections.StringKey,
			collections.StringValue,
		),

		SessionUploadTokenHash: collections.NewMap(
			sb,
			types.SessionUploadTokenHashKey,
			"session_upload_token_hash",
			collections.StringKey,
			collections.BytesValue,
		),
	}

	schema, err := sb.Build()
	if err != nil {
		panic(err)
	}
	k.Schema = schema

	return k
}

func (k Keeper) GetAuthority() []byte {
	return k.authority
}

func (k Keeper) RegisterChannel(ctx sdk.Context, portID, channelID string) error {
	channel, found := k.ibcKeeperFn().ChannelKeeper.GetChannel(ctx, portID, channelID)
	if !found {
		return fmt.Errorf("channel not found: %s", channelID)
	}
	counterpartyPort := channel.Counterparty.PortId
	ctx.Logger().Info("🔗 Detecting IBC Channel Connection", "channel_id", channelID, "counterparty_port", counterpartyPort)

	var connectionType string
	switch counterpartyPort {
	case "metastore":
		connectionType = "mdsc"
		if err := k.MetastoreChannel.Set(ctx, channelID); err != nil {
			return err
		}
	case "datastore":
		connectionType = "fdsc"
		if err := k.DatastoreChannels.Set(ctx, channelID); err != nil {
			return err
		}
	default:
		return nil
	}

	info := types.StorageInfo{
		ChannelId:      channelID,
		ConnectionType: connectionType,
	}
	if err := k.StorageInfos.Set(ctx, channelID, info); err != nil {
		return fmt.Errorf("failed to initialize storage info: %w", err)
	}
	return nil
}
