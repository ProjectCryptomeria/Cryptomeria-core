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

	MetastoreChannel  collections.Item[string]
	DatastoreChannels collections.KeySet[string]
	StorageInfos      collections.Map[string, types.StorageInfo]

	Sessions                 collections.Map[string, types.Session]
	SessionFragmentSeen      collections.KeySet[string]
	FragmentSeqToFragmentKey collections.Map[string, string]
	ManifestSeqToSessionID   collections.Map[string, string]
	SessionUploadTokenHash   collections.Map[string, []byte]

	ibcKeeperFn   func() *ibckeeper.Keeper
	bankKeeper    types.BankKeeper
	accountKeeper types.AccountKeeper

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
		storeService:   storeService,
		cdc:            cdc,
		addressCodec:   addressCodec,
		authority:      authority,
		bankKeeper:     bankKeeper,
		accountKeeper:  accountKeeper,
		ibcKeeperFn:    ibcKeeperFn,
		authzKeeper:    authzKeeper,
		feegrantKeeper: feegrantKeeper,

		Port:   collections.NewItem(sb, types.PortKey, "port", collections.StringValue),
		Params: collections.NewItem(sb, types.ParamsKey, "params", codec.CollValue[types.Params](cdc)),

		MetastoreChannel:  collections.NewItem(sb, types.MetastoreChannelKey, "metastore_channel", collections.StringValue),
		DatastoreChannels: collections.NewKeySet(sb, types.DatastoreChannelKey, "datastore_channels", collections.StringKey),
		StorageInfos:      collections.NewMap(sb, types.StorageEndpointKey, "storage_infos", collections.StringKey, codec.CollValue[types.StorageInfo](cdc)),

		Sessions:                 collections.NewMap(sb, types.SessionKey, "sessions", collections.StringKey, codec.CollValue[types.Session](cdc)),
		SessionFragmentSeen:      collections.NewKeySet(sb, types.SessionFragmentSeenKey, "session_fragment_seen", collections.StringKey),
		FragmentSeqToFragmentKey: collections.NewMap(sb, types.FragmentSeqToFragmentKey, "fragment_seq_to_fragment_key", collections.StringKey, collections.StringValue),
		ManifestSeqToSessionID:   collections.NewMap(sb, types.ManifestSeqToSessionKey, "manifest_seq_to_session_id", collections.StringKey, collections.StringValue),
		SessionUploadTokenHash:   collections.NewMap(sb, types.SessionUploadTokenHashKey, "session_upload_token_hash", collections.StringKey, collections.BytesValue),
	}

	schema, err := sb.Build()
	if err != nil {
		panic(err)
	}
	k.Schema = schema

	return k
}

// HandleExpiredSessions は期限を過ぎたセッションを安全にクローズし、権限を剥奪します。
func (k Keeper) HandleExpiredSessions(ctx sdk.Context) error {
	currentTime := ctx.BlockTime().Unix()
	var expiredIDs []string

	err := k.Sessions.Walk(ctx, nil, func(id string, sess types.Session) (bool, error) {
		if sess.State != types.SessionState_SESSION_STATE_CLOSED_SUCCESS &&
			sess.State != types.SessionState_SESSION_STATE_CLOSED_FAILED &&
			sess.DeadlineUnix < currentTime {
			expiredIDs = append(expiredIDs, id)
		}
		return false, nil
	})
	if err != nil {
		return err
	}

	for _, id := range expiredIDs {
		sess, _ := k.Sessions.Get(ctx, id)
		sess.State = types.SessionState_SESSION_STATE_CLOSED_FAILED
		sess.CloseReason = "EXPIRED"
		k.SetSession(ctx, sess)

		// 権限の物理的撤去
		k.RevokeCSUGrants(ctx, sess.Owner)

		ctx.Logger().Info("Session expired and closed", "session_id", id)
	}
	return nil
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

	var connectionType string
	switch counterpartyPort {
	case "metastore":
		connectionType = "mdsc"
		k.MetastoreChannel.Set(ctx, channelID)
	case "datastore":
		connectionType = "fdsc"
		k.DatastoreChannels.Set(ctx, channelID)
	default:
		return nil
	}

	info := types.StorageInfo{
		ChannelId:      channelID,
		ConnectionType: connectionType,
	}
	k.StorageInfos.Set(ctx, channelID, info)
	return nil
}
