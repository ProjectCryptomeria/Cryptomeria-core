package types

import (
	"context"

	errorsmod "cosmossdk.io/errors"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	"github.com/cosmos/cosmos-sdk/x/authz"
)

// Ensure SessionBoundAuthorization implements authz.Authorization.
var _ authz.Authorization = (*SessionBoundAuthorization)(nil)

type sessionIDGetter interface {
	GetSessionId() string
}

func (a *SessionBoundAuthorization) MsgTypeURL() string {
	return a.MsgTypeUrl
}

func (a *SessionBoundAuthorization) ValidateBasic() error {
	if a.SessionId == "" {
		return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "session_id must not be empty")
	}
	if a.MsgTypeUrl == "" {
		return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "msg_type_url must not be empty")
	}
	return nil
}

// Accept enforces:
// 1) msg type url == a.msg_type_url
// 2) msg has session_id and it equals a.session_id
func (a *SessionBoundAuthorization) Accept(_ context.Context, msg sdk.Msg) (authz.AcceptResponse, error) {
	msgTypeURL := sdk.MsgTypeURL(msg)

	if msgTypeURL != a.MsgTypeUrl {
		return authz.AcceptResponse{Accept: false, Delete: false, Updated: nil}, nil
	}

	g, ok := msg.(sessionIDGetter)
	if !ok {
		return authz.AcceptResponse{Accept: false, Delete: false, Updated: nil},
			errorsmod.Wrapf(sdkerrors.ErrInvalidRequest, "msg does not have session_id: %T", msg)
	}

	if g.GetSessionId() != a.SessionId {
		return authz.AcceptResponse{Accept: false, Delete: false, Updated: nil},
			errorsmod.Wrapf(sdkerrors.ErrUnauthorized, "session_id mismatch: auth=%s msg=%s", a.SessionId, g.GetSessionId())
	}

	// keep the authorization; it will be revoked on Close (Issue6).
	return authz.AcceptResponse{Accept: true, Delete: false, Updated: nil}, nil
}
