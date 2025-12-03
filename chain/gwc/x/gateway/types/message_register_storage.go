package types

import (
	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

var _ sdk.Msg = &MsgRegisterStorage{}

func NewMsgRegisterStorage(creator string, endpoints []*StorageEndpoint) *MsgRegisterStorage {
	return &MsgRegisterStorage{
		Creator:   creator,
		Endpoints: endpoints,
	}
}

func (msg *MsgRegisterStorage) ValidateBasic() error {
	_, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return errorsmod.Wrapf(sdkerrors.ErrInvalidAddress, "invalid creator address (%s)", err)
	}

	if len(msg.Endpoints) == 0 {
		return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "endpoints cannot be empty")
	}

	for _, ep := range msg.Endpoints {
		if ep.ChainId == "" {
			return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "chain_id cannot be empty")
		}
		if ep.ApiEndpoint == "" {
			return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "api_endpoint cannot be empty")
		}
	}

	return nil
}
