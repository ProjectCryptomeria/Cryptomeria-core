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

	// --- アップロードセッション管理 (フェーズ 1: インタラクティブ) ---
	// Key: upload_id
	// Value: 状態 (例: "UPLOADING", "PENDING_SIGN")
	UploadSessionState collections.Map[string, string]

	// Key: upload_id
	// Value: 蓄積されたバイナリデータ (Zip)
	UploadSessionBuffer collections.Map[string, []byte]

	// Key: upload_id
	// Value: 結果文字列 ("ID|ROOT|B64Manifest")
	UploadSessionResult collections.Map[string, string]

	// --- アップロードセッション管理 (フェーズ 2: IBC Waiter) ---
	UploadSessionPending     collections.Map[string, string]
	UploadSessionManifest    collections.Map[string, string]
	UploadSessionMDSCChannel collections.Map[string, string]
	FragmentToSession        collections.Map[string, string]

	ibcKeeperFn   func() *ibckeeper.Keeper
	bankKeeper    types.BankKeeper
	accountKeeper types.AccountKeeper // CSUプロトコルでの署名検証に必要

	// 設定
	ChunkSize int
}

func NewKeeper(
	storeService corestore.KVStoreService,
	cdc codec.Codec,
	addressCodec address.Codec,
	authority []byte,
	ibcKeeperFn func() *ibckeeper.Keeper,
	bankKeeper types.BankKeeper,
	accountKeeper types.AccountKeeper, // 追加
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
		accountKeeper: accountKeeper, // 初期化
		ibcKeeperFn:   ibcKeeperFn,
		Port:          collections.NewItem(sb, types.PortKey, "port", collections.StringValue),
		Params:        collections.NewItem(sb, types.ParamsKey, "params", codec.CollValue[types.Params](cdc)),

		MetastoreChannel:  collections.NewItem(sb, types.MetastoreChannelKey, "metastore_channel", collections.StringValue),
		DatastoreChannels: collections.NewKeySet(sb, types.DatastoreChannelKey, "datastore_channels", collections.StringKey),
		StorageInfos:      collections.NewMap(sb, types.StorageEndpointKey, "storage_infos", collections.StringKey, codec.CollValue[types.StorageInfo](cdc)),

		UploadSessionState:  collections.NewMap(sb, types.UploadSessionStateKey, "upload_session_state", collections.StringKey, collections.StringValue),
		UploadSessionBuffer: collections.NewMap(sb, types.UploadSessionBufferKey, "upload_session_buffer", collections.StringKey, collections.BytesValue),
		UploadSessionResult: collections.NewMap(sb, types.UploadSessionResultKey, "upload_session_result", collections.StringKey, collections.StringValue),

		UploadSessionPending:     collections.NewMap(sb, types.UploadSessionPendingKey, "upload_session_pending", collections.StringKey, collections.StringValue),
		UploadSessionManifest:    collections.NewMap(sb, types.UploadSessionManifestKey, "upload_session_manifest", collections.StringKey, collections.StringValue),
		UploadSessionMDSCChannel: collections.NewMap(sb, types.UploadSessionMDSCChannelKey, "upload_session_mdsc_channel", collections.StringKey, collections.StringValue),
		FragmentToSession:        collections.NewMap(sb, types.FragmentToSessionKey, "fragment_to_session", collections.StringKey, collections.StringValue),
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
