package types

import (
	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

var _ sdk.Msg = &MsgUpload{}

// NewMsgUpload creates a new MsgUpload instance
func NewMsgUpload(creator string, filename string, data []byte) *MsgUpload {
	return &MsgUpload{
		Creator:  creator,
		Filename: filename,
		Data:     data,
	}
}

// ValidateBasic performs basic stateless validity checks
func (msg *MsgUpload) ValidateBasic() error {
	// アドレスの検証
	_, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return errorsmod.Wrapf(sdkerrors.ErrInvalidAddress, "invalid creator address (%s)", err)
	}

	// ファイル名の検証
	if msg.Filename == "" {
		return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "filename cannot be empty")
	}

	// データの検証
	if len(msg.Data) == 0 {
		return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "data cannot be empty")
	}

	return nil
}
