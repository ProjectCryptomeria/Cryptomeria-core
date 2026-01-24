package types

// DONTCOVER

import (
	"cosmossdk.io/errors"
)

// x/gateway module sentinel errors
var (
	ErrInvalidSigner         = errors.Register(ModuleName, 1100, "invalid signer")
	ErrSessionNotFound       = errors.Register(ModuleName, 1101, "session not found")
	ErrSessionClosed         = errors.Register(ModuleName, 1102, "session is closed")
	ErrSessionInvalidState   = errors.Register(ModuleName, 1103, "invalid session state")
	ErrRootProofNotCommitted = errors.Register(ModuleName, 1104, "root proof not committed")
	ErrInvalidRootProof      = errors.Register(ModuleName, 1105, "invalid root proof")
	ErrExecutorMismatch      = errors.Register(ModuleName, 1106, "executor mismatch")
	ErrDuplicateFragment     = errors.Register(ModuleName, 1107, "duplicate fragment")
	ErrNoDatastoreChannels   = errors.Register(ModuleName, 1108, "no datastore channels")
	ErrNoMetastoreChannel    = errors.Register(ModuleName, 1109, "no metastore channel")
	ErrInvalidManifest       = errors.Register(ModuleName, 1110, "invalid manifest")

	// layer4
	ErrInvalidProof = errors.Register(ModuleName, 1111, "invalid merkle proof")

	ErrInvalidPacketTimeout = errors.Register(ModuleName, 1500, "invalid packet timeout")
	ErrInvalidVersion       = errors.Register(ModuleName, 1501, "invalid version")
)
