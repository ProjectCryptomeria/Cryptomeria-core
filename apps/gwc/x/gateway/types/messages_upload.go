package types

import (
	errors "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

var _ sdk.Msg = &MsgInitUpload{}
var _ sdk.Msg = &MsgPostChunk{}
var _ sdk.Msg = &MsgCompleteUpload{}
var _ sdk.Msg = &MsgSignUpload{}

// --- MsgInitUpload ---

func (msg *MsgInitUpload) ValidateBasic() error {
	_, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return errors.Wrapf(sdkerrors.ErrInvalidAddress, "invalid creator address (%s)", err)
	}
	if msg.ProjectName == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "project name cannot be empty")
	}
	// ExpectedSize can be 0 (unknown)
	return nil
}

// --- MsgPostChunk ---

func (msg *MsgPostChunk) ValidateBasic() error {
	_, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return errors.Wrapf(sdkerrors.ErrInvalidAddress, "invalid creator address (%s)", err)
	}
	if msg.UploadId == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "upload id cannot be empty")
	}
	if len(msg.Data) == 0 {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "chunk data cannot be empty")
	}
	return nil
}

// --- MsgCompleteUpload ---

func (msg *MsgCompleteUpload) ValidateBasic() error {
	_, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return errors.Wrapf(sdkerrors.ErrInvalidAddress, "invalid creator address (%s)", err)
	}
	if msg.UploadId == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "upload id cannot be empty")
	}
	if msg.Filename == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "filename cannot be empty")
	}
	return nil
}

// --- MsgSignUpload ---

func (msg *MsgSignUpload) ValidateBasic() error {
	_, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return errors.Wrapf(sdkerrors.ErrInvalidAddress, "invalid creator address (%s)", err)
	}
	if msg.UploadId == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "upload id cannot be empty")
	}
	if msg.SiteRoot == "" {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "site root cannot be empty")
	}
	if len(msg.Signature) == 0 {
		return errors.Wrap(sdkerrors.ErrInvalidRequest, "signature cannot be empty")
	}
	return nil
}
