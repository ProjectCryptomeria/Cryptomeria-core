package types

import "cosmossdk.io/collections"

const (
	// ModuleName defines the module name
	ModuleName = "gateway"

	// StoreKey defines the primary module store key
	StoreKey = ModuleName

	// GovModuleName duplicates the gov module's name to avoid a dependency with x/gov.
	GovModuleName = "gov"

	// Version defines the current version the IBC module supports
	Version = "cryptomeria-1"

	// PortID is the default port id that module binds to
	PortID = "gateway"
)

var (
	// PortKey defines the key to store the port ID in store
	PortKey = collections.NewPrefix("gateway-port-")
)

// ParamsKey is the prefix to retrieve all Params
var ParamsKey = collections.NewPrefix("p_gateway")

var (
	// MetastoreChannelKey: MDSCへのチャネルIDを保存 (1つ)
	MetastoreChannelKey = collections.NewPrefix("channel_mdsc")

	// DatastoreChannelKey: FDSCへのチャネルIDリストを保存 (複数可)
	DatastoreChannelKey = collections.NewPrefix("channel_fdsc")

	// ストレージエンドポイント保存用 (Key: ChainID, Value: API URL)
	StorageEndpointKey = collections.NewPrefix("storage_endpoint")

	// --- Upload session management ---
	
	// UploadSessionStateKey: セッションの状態 (Uploading, PendingSign)
	UploadSessionStateKey = collections.NewPrefix("session_state")

	// UploadSessionBufferKey: 受信中のZipデータ (バイナリ)
	UploadSessionBufferKey = collections.NewPrefix("session_buffer")

	// UploadSessionConfigKey: ファイル名、バージョン、フラグメントサイズ等の設定
	UploadSessionConfigKey = collections.NewPrefix("session_config")

	// UploadSessionResultKey: 計算済みのSiteRootとManifest(一時保存)
	UploadSessionResultKey = collections.NewPrefix("session_result")

	// Legacy/IBC Waiter keys
	UploadSessionPendingKey = collections.NewPrefix("upload_session_pending")
	UploadSessionManifestKey = collections.NewPrefix("upload_session_manifest")
	UploadSessionMDSCChannelKey = collections.NewPrefix("upload_session_mdsc_channel")
	FragmentToSessionKey = collections.NewPrefix("fragment_to_session")
)