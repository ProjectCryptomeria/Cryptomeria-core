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

	// ストレージエンドポイント保存用 (Key: ChannelID, Value: StorageInfo)
	StorageEndpointKey = collections.NewPrefix("storage_endpoint")

	// --- CSU Session management ---

	// SessionKey: セッション本体 (Key: session_id, Value: types.Session)
	SessionKey = collections.NewPrefix("session")

	// SessionFragmentSeenKey: (session_id, path, index) の重複防止 (Key: frag_key, Value: empty)
	SessionFragmentSeenKey = collections.NewPrefix("sess_frag_seen")

	// FragmentSeqToFragmentKey: FDSCへ送った FragmentPacket の IBC sequence -> frag_key
	// Key: seq_key (zero-padded decimal string), Value: frag_key
	FragmentSeqToFragmentKey = collections.NewPrefix("seq_frag")

	// ManifestSeqToSessionKey: MDSCへ送った ManifestPacket の IBC sequence -> session_id
	// Key: seq_key (zero-padded decimal string), Value: session_id
	ManifestSeqToSessionKey = collections.NewPrefix("seq_manifest")

	// SessionUploadTokenHashKey: off-chain upload token の hash を保存（平文保存しない）
	// Key: session_id, Value: sha256(token) など
	SessionUploadTokenHashKey = collections.NewPrefix("sess_upload_token_hash")
)
