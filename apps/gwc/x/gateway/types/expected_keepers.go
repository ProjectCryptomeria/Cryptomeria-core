package types

import (
	"context"
	"time"

	"cosmossdk.io/core/address"
	"cosmossdk.io/x/feegrant"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/x/authz"
)

// AccountKeeper は署名検証のために Auth モジュールに期待するインターフェースを定義します。
type AccountKeeper interface {
	// GetAccount は指定されたアドレスのアカウント情報を取得します。
	GetAccount(context.Context, sdk.AccAddress) sdk.AccountI
}

// AuthKeeper defines the expected interface for the Auth module.
type AuthKeeper interface {
	AddressCodec() address.Codec
	GetAccount(context.Context, sdk.AccAddress) sdk.AccountI // only used for simulation
	// Methods imported from account should be defined here
}

// BankKeeper defines the expected interface for the Bank module.
type BankKeeper interface {
	SpendableCoins(context.Context, sdk.AccAddress) sdk.Coins
	// Methods imported from bank should be defined here
}

// AuthzKeeper defines the expected interface for the Authz module (Issue6/8).
type AuthzKeeper interface {
	// GetAuthorization returns (authorization, expiration).
	// NOTE: In SDK v0.47+, this method does not return an error.
	GetAuthorization(ctx context.Context, granter sdk.AccAddress, grantee sdk.AccAddress, msgTypeURL string) (authz.Authorization, *time.Time)

	// DeleteGrant revokes a single msgTypeURL grant.
	// NOTE: SDK v0.50+ renamed Revoke to DeleteGrant.
	DeleteGrant(ctx context.Context, granter sdk.AccAddress, grantee sdk.AccAddress, msgTypeURL string) error
}

// FeegrantKeeper defines the expected interface for the Feegrant module (Issue7).
// We use the MsgServer signature here to allow revocation via the MsgServer wrapper,
// since the Keeper does not export RevokeAllowance directly.
type FeegrantKeeper interface {
	RevokeAllowance(context.Context, *feegrant.MsgRevokeAllowance) (*feegrant.MsgRevokeAllowanceResponse, error)
}

// ParamSubspace defines the expected Subspace interface for parameters.
type ParamSubspace interface {
	Get(context.Context, []byte, interface{})
	Set(context.Context, []byte, interface{})
}
