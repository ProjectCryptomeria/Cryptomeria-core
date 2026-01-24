package keeper

import (
	"errors"
	"fmt"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"gwc/x/gateway/types"
)

// GetSession loads a session by session_id.
func (k Keeper) GetSession(ctx sdk.Context, sessionID string) (types.Session, error) {
	return k.Sessions.Get(ctx, sessionID)
}

// HasSession checks if a session exists.
func (k Keeper) HasSession(ctx sdk.Context, sessionID string) (bool, error) {
	return k.Sessions.Has(ctx, sessionID)
}

// SetSession stores the full session object (session_id must be set).
func (k Keeper) SetSession(ctx sdk.Context, s types.Session) error {
	if s.SessionId == "" {
		return fmt.Errorf("session_id is empty")
	}
	return k.Sessions.Set(ctx, s.SessionId, s)
}

// MustGetSession is a helper returning a clearer error if not found.
// (Later Issues should replace this with module-specific typed errors.)
func (k Keeper) MustGetSession(ctx sdk.Context, sessionID string) (types.Session, error) {
	s, err := k.Sessions.Get(ctx, sessionID)
	if err == nil {
		return s, nil
	}

	if errors.Is(err, collections.ErrNotFound) {
		return types.Session{}, fmt.Errorf("session not found: %s", sessionID)
	}
	return types.Session{}, err
}

// MarkFragmentSeen marks (session_id, path, index) as seen and rejects duplicates.
func (k Keeper) MarkFragmentSeen(ctx sdk.Context, sessionID, path string, index uint64) error {
	fragKey := MakeFragKey(sessionID, path, index)
	has, err := k.SessionFragmentSeen.Has(ctx, fragKey)
	if err != nil {
		return err
	}
	if has {
		return fmt.Errorf("duplicate fragment: session_id=%s path=%s index=%d", sessionID, path, index)
	}
	return k.SessionFragmentSeen.Set(ctx, fragKey)
}

// IsFragmentSeen checks if a fragment key is already marked.
func (k Keeper) IsFragmentSeen(ctx sdk.Context, sessionID, path string, index uint64) (bool, error) {
	fragKey := MakeFragKey(sessionID, path, index)
	return k.SessionFragmentSeen.Has(ctx, fragKey)
}

// BindFragmentSeq binds an IBC fragment packet sequence to a fragment key (for ACK correlation).
func (k Keeper) BindFragmentSeq(ctx sdk.Context, seq uint64, sessionID, path string, index uint64) error {
	seqKey := MakeSeqKey(seq)
	fragKey := MakeFragKey(sessionID, path, index)
	return k.FragmentSeqToFragmentKey.Set(ctx, seqKey, fragKey)
}

// UnbindFragmentSeq removes a binding after ACK handling.
func (k Keeper) UnbindFragmentSeq(ctx sdk.Context, seq uint64) error {
	seqKey := MakeSeqKey(seq)
	return k.FragmentSeqToFragmentKey.Remove(ctx, seqKey)
}

// GetFragmentKeyBySeq resolves a fragment key from an IBC fragment sequence.
func (k Keeper) GetFragmentKeyBySeq(ctx sdk.Context, seq uint64) (string, error) {
	seqKey := MakeSeqKey(seq)
	return k.FragmentSeqToFragmentKey.Get(ctx, seqKey)
}

// BindManifestSeq binds an IBC manifest packet sequence to a session_id (for ACK correlation).
func (k Keeper) BindManifestSeq(ctx sdk.Context, seq uint64, sessionID string) error {
	seqKey := MakeSeqKey(seq)
	return k.ManifestSeqToSessionID.Set(ctx, seqKey, sessionID)
}

// UnbindManifestSeq removes a binding after ACK handling.
func (k Keeper) UnbindManifestSeq(ctx sdk.Context, seq uint64) error {
	seqKey := MakeSeqKey(seq)
	return k.ManifestSeqToSessionID.Remove(ctx, seqKey)
}

// GetSessionIDByManifestSeq resolves a session_id from an IBC manifest sequence.
func (k Keeper) GetSessionIDByManifestSeq(ctx sdk.Context, seq uint64) (string, error) {
	seqKey := MakeSeqKey(seq)
	return k.ManifestSeqToSessionID.Get(ctx, seqKey)
}

// SetUploadTokenHash stores a hash of the off-chain upload token (never store token plaintext).
func (k Keeper) SetUploadTokenHash(ctx sdk.Context, sessionID string, tokenHash []byte) error {
	if sessionID == "" {
		return fmt.Errorf("session_id is empty")
	}
	return k.SessionUploadTokenHash.Set(ctx, sessionID, tokenHash)
}

// GetUploadTokenHash loads a stored hash of the off-chain upload token.
func (k Keeper) GetUploadTokenHash(ctx sdk.Context, sessionID string) ([]byte, error) {
	return k.SessionUploadTokenHash.Get(ctx, sessionID)
}
