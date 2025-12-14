package types

import (
	"regexp"

	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

var _ sdk.Msg = &MsgUpload{}

// 正規表現: 英数字、ハイフン、アンダースコアのみ許可
var projectNameRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

const (
	MaxProjectNameLength = 64
	MaxVersionLength     = 32
	MinFragmentSize      = 1024 // 1KB
)

// NewMsgUpload creates a new MsgUpload instance
func NewMsgUpload(creator string, filename string, data []byte, projectName string, version string, fragmentSize uint64) *MsgUpload {
	return &MsgUpload{
		Creator:      creator,
		Filename:     filename,
		Data:         data,
		ProjectName:  projectName,
		Version:      version,
		FragmentSize: fragmentSize,
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

	// プロジェクト名の検証
	if msg.ProjectName == "" {
		return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "project_name cannot be empty")
	}
	if len(msg.ProjectName) > MaxProjectNameLength {
		return errorsmod.Wrapf(sdkerrors.ErrInvalidRequest, "project_name too long (max %d)", MaxProjectNameLength)
	}
	if !projectNameRegex.MatchString(msg.ProjectName) {
		return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "project_name contains invalid characters (alphanumeric, -, _ only)")
	}

	// バージョンの検証 (任意項目だが、指定時は長さチェック)
	if len(msg.Version) > MaxVersionLength {
		return errorsmod.Wrapf(sdkerrors.ErrInvalidRequest, "version too long (max %d)", MaxVersionLength)
	}

	// フラグメントサイズの検証
	// 0の場合はサーバー側のデフォルトを使用するため許容するが、指定がある場合は最小サイズをチェック
	if msg.FragmentSize != 0 && msg.FragmentSize < MinFragmentSize {
		return errorsmod.Wrapf(sdkerrors.ErrInvalidRequest, "fragment_size too small (min %d)", MinFragmentSize)
	}

	return nil
}
