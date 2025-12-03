package types

import (
	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

var _ sdk.Msg = &MsgRegisterStorage{}

// NewMsgRegisterStorage creates a new MsgRegisterStorage instance.
func NewMsgRegisterStorage(creator string, storageInfos []*StorageInfo) *MsgRegisterStorage {
	return &MsgRegisterStorage{
		Creator:      creator,
		StorageInfos: storageInfos,
	}
}

func (msg *MsgRegisterStorage) ValidateBasic() error {
	_, err := sdk.AccAddressFromBech32(msg.Creator)
	if err != nil {
		return errorsmod.Wrapf(sdkerrors.ErrInvalidAddress, "invalid creator address (%s)", err)
	}

	if len(msg.StorageInfos) == 0 {
		return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "storage_infos cannot be empty")
	}

	for _, info := range msg.StorageInfos {
		if info.ChannelId == "" {
			return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "channel_id cannot be empty")
		}
		// ChainIdやApiEndpointは更新時には空の場合があるため、ここでは必須チェックを緩和するか、
		// あるいは登録時必須とするかは要件次第ですが、一旦最低限ChannelIDがあれば良しとします。
		// もし完全新規登録を強制するならチェックを入れても良いですが、柔軟性のため外しておきます。
	}

	return nil
}
