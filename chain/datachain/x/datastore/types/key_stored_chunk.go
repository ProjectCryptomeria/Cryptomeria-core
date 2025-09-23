package types

import "cosmossdk.io/collections"

// StoredChunkKey is the prefix to retrieve all StoredChunk
var StoredChunkKey = collections.NewPrefix("storedChunk/value/")
