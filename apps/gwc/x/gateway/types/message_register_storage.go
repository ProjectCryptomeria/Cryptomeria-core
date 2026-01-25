package types

import (
	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

var _ sdk.Msg = &MsgRegisterStorage{}

// NewMsgRegisterStorage は MsgRegisterStorage の新しいインスタンスを作成します。
func NewMsgRegisterStorage(authority string, storageInfos []*StorageInfo) *MsgRegisterStorage {
	return &MsgRegisterStorage{
		Authority:    authority,
		StorageInfos: storageInfos,
	}
}

// ValidateBasic はメッセージの基本的な整合性チェックを行います。
func (msg *MsgRegisterStorage) ValidateBasic() error {
	// 署名者が正しいアドレス形式か確認
	_, err := sdk.AccAddressFromBech32(msg.Authority)
	if err != nil {
		return errorsmod.Wrapf(sdkerrors.ErrInvalidAddress, "invalid authority address (%s)", err)
	}

	// ストレージ情報が空でないか確認
	if len(msg.StorageInfos) == 0 {
		return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "storage_infos cannot be empty")
	}

	for _, info := range msg.StorageInfos {
		// 識別子となる ChannelId は必須
		if info.ChannelId == "" {
			return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "channel_id cannot be empty")
		}
	}

	return nil
}
