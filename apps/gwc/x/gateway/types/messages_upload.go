package types

import (
	"encoding/base64"
	"encoding/hex"

	errors "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

var _ sdk.Msg = &MsgInitSession{}
var _ sdk.Msg = &MsgCommitRootProof{}
var _ sdk.Msg = &MsgDistributeBatch{}
var _ sdk.Msg = &MsgFinalizeAndCloseSession{}
var _ sdk.Msg = &MsgAbortAndCloseSession{}

// MsgInitSession
func (msg *MsgInitSession) ValidateBasic() error {
	_, err := sdk.AccAddressFromBech32(msg.Owner)
	if err != nil {
		return errors.Wrapf(sdkerrors.ErrInvalidAddress, "invalid owner address (%s)", err)
	}
	_, err = sdk.AccAddressFromBech32(msg.Executor)
	if err != nil {
		return errors.Wrapf(sdkerrors.ErrInvalidAddress, "invalid executor address (%s)", err)
	}
	if msg.FragmentSize == 0 {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "fragment_size must be > 0")
	}
	if msg.DeadlineUnix < 0 {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "deadline_unix must be >= 0")
	}
	return nil
}

// MsgCommitRootProof
func (msg *MsgCommitRootProof) ValidateBasic() error {
	_, err := sdk.AccAddressFromBech32(msg.Owner)
	if err != nil {
		return errors.Wrapf(sdkerrors.ErrInvalidAddress, "invalid owner address (%s)", err)
	}
	if msg.SessionId == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "session_id cannot be empty")
	}
	if msg.RootProofHex == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "root_proof_hex cannot be empty")
	}
	if _, err := hex.DecodeString(msg.RootProofHex); err != nil {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "root_proof_hex must be valid hex")
	}
	return nil
}

// MsgDistributeBatch
func (msg *MsgDistributeBatch) ValidateBasic() error {
	_, err := sdk.AccAddressFromBech32(msg.Executor)
	if err != nil {
		return errors.Wrapf(sdkerrors.ErrInvalidAddress, "invalid executor address (%s)", err)
	}
	if msg.SessionId == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "session_id cannot be empty")
	}
	if len(msg.Items) == 0 {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "items cannot be empty")
	}
	for _, it := range msg.Items {
		if it.Path == "" {
			return errors.Wrap(sdkerrors.ErrInvalidRequest, "item.path cannot be empty")
		}
		if len(it.FragmentBytes) == 0 {
			return errors.Wrap(sdkerrors.ErrInvalidRequest, "item.fragment_bytes cannot be empty")
		}
		// proofs may be empty in single-leaf case; on-chain verification enforced in handler (Issue4)
	}
	return nil
}

// MsgFinalizeAndCloseSession
func (msg *MsgFinalizeAndCloseSession) ValidateBasic() error {
	_, err := sdk.AccAddressFromBech32(msg.Executor)
	if err != nil {
		return errors.Wrapf(sdkerrors.ErrInvalidAddress, "invalid executor address (%s)", err)
	}
	if msg.SessionId == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "session_id cannot be empty")
	}
	if msg.Manifest.ProjectName == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "manifest.project_name cannot be empty")
	}
	if msg.Manifest.Version == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "manifest.version cannot be empty")
	}
	if msg.Manifest.RootProof == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "manifest.root_proof cannot be empty")
	}
	if msg.Manifest.Owner == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "manifest.owner cannot be empty")
	}
	if msg.Manifest.SessionId == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "manifest.session_id cannot be empty")
	}
	return nil
}

// MsgAbortAndCloseSession
func (msg *MsgAbortAndCloseSession) ValidateBasic() error {
	_, err := sdk.AccAddressFromBech32(msg.Executor)
	if err != nil {
		return errors.Wrapf(sdkerrors.ErrInvalidAddress, "invalid executor address (%s)", err)
	}
	if msg.SessionId == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "session_id cannot be empty")
	}
	return nil
}

// DecodeBase64Std is a small helper for CLI (keeps imports localized)
func DecodeBase64Std(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}
