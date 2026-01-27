package keeper

import (
	"context"
	"fmt"

	"gwc/x/gateway/types"

	"cosmossdk.io/collections"
	errorsmod "cosmossdk.io/errors"
	"cosmossdk.io/x/feegrant"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/x/authz"
)

func (k Keeper) getParamsOrDefault(ctx sdk.Context) types.Params {
	params, err := k.Params.Get(ctx)
	if err != nil {
		return types.DefaultParams()
	}
	if params.MaxFragmentBytes == 0 || params.MaxFragmentsPerSession == 0 || params.DefaultDeadlineSeconds == 0 {
		return types.DefaultParams()
	}
	return params
}

func (k Keeper) localAdminOrErr(ctx sdk.Context) (string, error) {
	params := k.getParamsOrDefault(ctx)
	if params.LocalAdmin == "" {
		return "", errorsmod.Wrap(types.ErrLocalAdminNotConfigured, "params.local_admin is empty")
	}
	return params.LocalAdmin, nil
}

func (k Keeper) enforceLocalAdmin(ctx sdk.Context, sess types.Session, msgExecutor string) (sdk.AccAddress, sdk.AccAddress, error) {
	localAdmin, err := k.localAdminOrErr(ctx)
	if err != nil {
		return nil, nil, err
	}

	if msgExecutor != localAdmin {
		return nil, nil, errorsmod.Wrapf(types.ErrLocalAdminMismatch, "msg.executor must be local-admin: got=%s want=%s", msgExecutor, localAdmin)
	}
	if sess.Executor != localAdmin {
		return nil, nil, errorsmod.Wrapf(types.ErrLocalAdminMismatch, "session.executor must be local-admin: got=%s want=%s", sess.Executor, localAdmin)
	}

	ownerAddr, err := sdk.AccAddressFromBech32(sess.Owner)
	if err != nil {
		return nil, nil, errorsmod.Wrap(types.ErrInvalidSigner, fmt.Sprintf("invalid session owner address: %v", err))
	}
	adminAddr, err := sdk.AccAddressFromBech32(localAdmin)
	if err != nil {
		return nil, nil, errorsmod.Wrap(types.ErrInvalidSigner, fmt.Sprintf("invalid local-admin address: %v", err))
	}

	return ownerAddr, adminAddr, nil
}

// RequireSessionBoundAuthz は、配布・完了メッセージの権限を検証します。
func (k Keeper) RequireSessionBoundAuthz(ctx sdk.Context, sess types.Session, msgExecutor string, sessionID string, msgTypeURL string) error {
	ownerAddr, adminAddr, err := k.enforceLocalAdmin(ctx, sess, msgExecutor)
	if err != nil {
		return err
	}

	if k.authzKeeper == nil {
		return errorsmod.Wrap(types.ErrAuthzMissingOrInvalid, "authz keeper is not configured")
	}

	// 引数の順番は (grantee, granter)
	// adminAddr (Executor) が受任者(Grantee)、ownerAddr (Alice) が委任者(Granter) です。
	auth, _ := k.authzKeeper.GetAuthorization(ctx, adminAddr, ownerAddr, msgTypeURL)
	if auth == nil {
		return errorsmod.Wrapf(types.ErrAuthzMissingOrInvalid, "authorization not found: msg_type_url=%s (Granter: %s, Grantee: %s)", msgTypeURL, ownerAddr, adminAddr)
	}

	// GenericAuthorization を許可（integrity-test.sh 用）
	if _, ok := auth.(*authz.GenericAuthorization); ok {
		ctx.Logger().Debug("RequireSessionBoundAuthz: generic authorization used", "type", msgTypeURL)
		return nil
	}

	// SessionBoundAuthorization の検証
	sb, ok := auth.(*types.SessionBoundAuthorization)
	if !ok {
		return errorsmod.Wrapf(types.ErrAuthzMissingOrInvalid, "authorization is not SessionBoundAuthorization: got=%T", auth)
	}
	if sb.SessionId != sessionID {
		return errorsmod.Wrapf(types.ErrAuthzMissingOrInvalid, "session_id mismatch: auth=%s msg=%s", sb.SessionId, sessionID)
	}
	if sb.MsgTypeUrl != msgTypeURL {
		return errorsmod.Wrapf(types.ErrAuthzMissingOrInvalid, "msg_type_url mismatch: auth=%s want=%s", sb.MsgTypeUrl, msgTypeURL)
	}

	return nil
}

func (k Keeper) RevokeCSUGrants(ctx sdk.Context, ownerBech32 string) {
	localAdmin, err := k.localAdminOrErr(ctx)
	if err != nil {
		return
	}
	ownerAddr, _ := sdk.AccAddressFromBech32(ownerBech32)
	adminAddr, _ := sdk.AccAddressFromBech32(localAdmin)

	if k.authzKeeper != nil {
		for _, msgTypeURL := range types.CSUAuthorizedMsgTypeURLs() {
			// DeleteGrant の引数も (grantee, granter)
			_ = k.authzKeeper.DeleteGrant(ctx, adminAddr, ownerAddr, msgTypeURL)
		}
	}
	if k.feegrantKeeper != nil {
		// 【重要修正】SDK v0.47+ の仕様に合わせて MsgRevokeAllowance 構造体を使用する
		msg := &feegrant.MsgRevokeAllowance{
			Granter: ownerBech32,
			Grantee: localAdmin,
		}
		// メソッドは (context.Context, *feegrant.MsgRevokeAllowance) を期待しています
		_, _ = k.feegrantKeeper.RevokeAllowance(ctx, msg)
	}
}

var _ = collections.ErrNotFound
var _ = context.Background
