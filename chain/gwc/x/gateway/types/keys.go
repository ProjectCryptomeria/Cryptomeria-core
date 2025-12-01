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
	Version = "raidchain-1"

	// PortID is the default port id that module binds to
	PortID = "gateway"
)

var (
	// PortKey defines the key to store the port ID in store
	PortKey = collections.NewPrefix("gateway-port-")
)

// ParamsKey is the prefix to retrieve all Params
var ParamsKey = collections.NewPrefix("p_gateway")

// --- 追加: チャネル管理用のキー ---
var (
	// MetastoreChannelKey: MDSCへのチャネルIDを保存 (1つ)
	MetastoreChannelKey = collections.NewPrefix("channel_mdsc")

	// DatastoreChannelKey: FDSCへのチャネルIDリストを保存 (複数可)
	DatastoreChannelKey = collections.NewPrefix("channel_fdsc")
)
