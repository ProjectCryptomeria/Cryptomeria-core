package types

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// MakeFragmentID deterministically derives the datastore-local fragment_id from CSU identity.
// This MUST be consistent across:
// - FDSC (storage key / lookup key)
// - Off-chain manifest builder (PacketFragmentMapping.fragment_id)
// - Any client that tries to fetch a fragment by id
//
// Scheme (stable, printable ASCII):
//
//	fragment_id = hex( sha256( "FDSC_FRAG_ID:{session_id}:{path}:{index_decimal}" ) )
//
// Notes:
// - `path` must match exactly what was used when GWC built the CSU root proof and sent DistributeBatch.
// - `index` is decimal.
// - We intentionally avoid separators like '\x00' to keep the id safe for URLs/JSON/logging.
func MakeFragmentID(sessionID, path string, index uint64) string {
	payload := []byte(fmt.Sprintf("FDSC_FRAG_ID:%s:%s:%d", sessionID, path, index))
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}
