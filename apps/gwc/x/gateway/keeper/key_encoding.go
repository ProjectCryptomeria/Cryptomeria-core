package keeper

import "fmt"

// MakeFragKey encodes (session_id, path, index) into a single unique string key.
//
// Format:
//
//	session_id + "\x00" + path + "\x00" + %020d(index)
//
// Notes:
// - "\x00" is chosen as a separator to avoid ambiguity.
// - index is zero-padded for stable lexicographic ordering.
func MakeFragKey(sessionID, path string, index uint64) string {
	return sessionID + "\x00" + path + "\x00" + fmt.Sprintf("%020d", index)
}

// MakeSeqKey encodes an IBC packet sequence (uint64) into a lexicographically stable key.
// We use zero-padded decimal for stable string ordering and easy debugging.
func MakeSeqKey(seq uint64) string {
	return fmt.Sprintf("%020d", seq)
}
