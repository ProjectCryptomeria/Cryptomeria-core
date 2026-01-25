package types

import (
	"fmt"

	errorsmod "cosmossdk.io/errors"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

// Default parameter values (safe-ish operational defaults).
// Tune via governance with MsgUpdateParams.
const (
	DefaultMaxFragmentBytes       uint64 = 1_048_576 // 1 MiB
	DefaultMaxFragmentsPerSession uint64 = 50_000
	DefaultDeadlineSeconds        int64  = 24 * 60 * 60 // 24h
)

// NewParams creates a new Params instance.
func NewParams(
	maxFragmentBytes uint64,
	maxFragmentsPerSession uint64,
	defaultDeadlineSeconds int64,
	enableLegacyUpload bool,
	localAdmin string,
) Params {
	return Params{
		MaxFragmentBytes:       maxFragmentBytes,
		MaxFragmentsPerSession: maxFragmentsPerSession,
		DefaultDeadlineSeconds: defaultDeadlineSeconds,
		LocalAdmin:             localAdmin,
	}
}

// DefaultParams returns a default set of parameters.
// NOTE: local_admin default is empty; operator MUST set it via genesis or UpdateParams for CSU to work.
func DefaultParams() Params {
	return NewParams(
		DefaultMaxFragmentBytes,
		DefaultMaxFragmentsPerSession,
		DefaultDeadlineSeconds,
		false, // enable_legacy_upload default: false
		"",    // local_admin must be set externally
	)
}

// Validate validates the set of params.
// NOTE: local_admin is allowed to be empty at param-level, but CSU handlers will reject if it's empty.
func (p Params) Validate() error {
	if p.MaxFragmentBytes == 0 {
		return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "max_fragment_bytes must be > 0")
	}
	if p.MaxFragmentsPerSession == 0 {
		return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "max_fragments_per_session must be > 0")
	}
	if p.DefaultDeadlineSeconds <= 0 {
		return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "default_deadline_seconds must be > 0")
	}

	// Very small sanity: deadline should not be absurdly large (prevents obvious misconfig).
	if p.DefaultDeadlineSeconds > 365*24*60*60 {
		return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, fmt.Sprintf("default_deadline_seconds too large: %d", p.DefaultDeadlineSeconds))
	}

	// local_admin validation is intentionally NOT strict here to avoid genesis defaults failing.
	// CSU handlers enforce local_admin != "".

	return nil
}
