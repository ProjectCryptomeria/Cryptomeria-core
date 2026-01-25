package keeper

import (
	"context"
	"fmt"

	"gwc/x/gateway/types"

	"cosmossdk.io/collections"
	errorsmod "cosmossdk.io/errors"
	"cosmossdk.io/x/feegrant"
	sdk "github.com/cosmos/cosmos-sdk/types"
)

func (k Keeper) getParamsOrDefault(ctx sdk.Context) types.Params {
	params, err := k.Params.Get(ctx)
	if err != nil {
		// store not initialized etc -> default
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

// Enforce CSU executor fixed to local-admin (Issue8).
// Returns (ownerAddr, localAdminAddr).
func (k Keeper) enforceLocalAdmin(ctx sdk.Context, sess types.Session, msgExecutor string) (sdk.AccAddress, sdk.AccAddress, error) {
	localAdmin, err := k.localAdminOrErr(ctx)
	if err != nil {
		return nil, nil, err
	}

	// signer==executor is guaranteed by proto signer option; here we enforce executor == local-admin.
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

// RequireSessionBoundAuthz checks that:
// - granter == session.owner
// - grantee == local-admin
// - authz grant exists for msgTypeURL
// - authorization is SessionBoundAuthorization and session_id matches
func (k Keeper) RequireSessionBoundAuthz(ctx sdk.Context, sess types.Session, msgExecutor string, sessionID string, msgTypeURL string) error {
	ownerAddr, adminAddr, err := k.enforceLocalAdmin(ctx, sess, msgExecutor)
	if err != nil {
		return err
	}

	// authz keeper availability check (defensive)
	if k.authzKeeper == nil {
		return errorsmod.Wrap(types.ErrAuthzMissingOrInvalid, "authz keeper is not configured")
	}

	// NOTE: GetAuthorization no longer returns an error in SDK v0.47+
	auth, _ := k.authzKeeper.GetAuthorization(ctx, ownerAddr, adminAddr, msgTypeURL)
	if auth == nil {
		return errorsmod.Wrapf(types.ErrAuthzMissingOrInvalid, "authorization not found: msg_type_url=%s", msgTypeURL)
	}

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

// RevokeCSUGrants revokes authz + feegrant for (owner -> local-admin) on Close (Issue6/7).
// Best-effort: if revoke fails due to missing grant, it will just log and continue.
func (k Keeper) RevokeCSUGrants(ctx sdk.Context, ownerBech32 string) {
	localAdmin, err := k.localAdminOrErr(ctx)
	if err != nil {
		ctx.Logger().Error("RevokeCSUGrants: local_admin not configured", "err", err)
		return
	}

	ownerAddr, err := sdk.AccAddressFromBech32(ownerBech32)
	if err != nil {
		ctx.Logger().Error("RevokeCSUGrants: invalid owner address", "owner", ownerBech32, "err", err)
		return
	}
	adminAddr, err := sdk.AccAddressFromBech32(localAdmin)
	if err != nil {
		ctx.Logger().Error("RevokeCSUGrants: invalid local-admin address", "local_admin", localAdmin, "err", err)
		return
	}

	// authz revoke (Issue6)
	if k.authzKeeper != nil {
		for _, msgTypeURL := range types.CSUAuthorizedMsgTypeURLs() {
			if err := k.authzKeeper.DeleteGrant(ctx, ownerAddr, adminAddr, msgTypeURL); err != nil {
				ctx.Logger().Info("RevokeCSUGrants: authz revoke failed (ignored)", "msg_type_url", msgTypeURL, "err", err)
			}
		}
	} else {
		ctx.Logger().Info("RevokeCSUGrants: authz keeper not configured; skip")
	}

	// feegrant revoke (Issue7)
	// We use the injected MsgServer wrapper to perform the revocation
	if k.feegrantKeeper != nil {
		msg := &feegrant.MsgRevokeAllowance{
			Granter: ownerBech32,
			Grantee: localAdmin,
		}
		if _, err := k.feegrantKeeper.RevokeAllowance(ctx, msg); err != nil {
			ctx.Logger().Info("RevokeCSUGrants: feegrant revoke failed (ignored)", "err", err)
		}
	} else {
		ctx.Logger().Info("RevokeCSUGrants: feegrant keeper not configured; skip")
	}
}

// NOTE:
// collections.ErrNotFound is referenced in other files. Keeping a trivial reference here avoids unused imports
// when different build tags/versions change behavior.
var _ = collections.ErrNotFound
var _ = context.Background
