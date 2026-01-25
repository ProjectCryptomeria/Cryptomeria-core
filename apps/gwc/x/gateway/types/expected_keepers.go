package types

import (
	"context"
	"time"

	"cosmossdk.io/core/address"
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
	// GetAuthorization returns (authorization, expiration, error).
	// When no grant exists, authorization should be nil (or error depending on implementation).
	GetAuthorization(ctx context.Context, granter sdk.AccAddress, grantee sdk.AccAddress, msgTypeURL string) (authz.Authorization, *time.Time, error)

	// Revoke revokes a single msgTypeURL grant.
	Revoke(ctx context.Context, granter sdk.AccAddress, grantee sdk.AccAddress, msgTypeURL string) error
}

// FeegrantKeeper defines the expected interface for the Feegrant module (Issue7).
type FeegrantKeeper interface {
	// RevokeAllowance revokes allowance (granter -> grantee).
	RevokeAllowance(ctx context.Context, granter sdk.AccAddress, grantee sdk.AccAddress) error
}

// ParamSubspace defines the expected Subspace interface for parameters.
type ParamSubspace interface {
	Get(context.Context, []byte, interface{})
	Set(context.Context, []byte, interface{})
}
