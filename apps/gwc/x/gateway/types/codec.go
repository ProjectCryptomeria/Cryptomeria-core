package types

import (
	"github.com/cosmos/cosmos-sdk/codec/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/msgservice"
	"github.com/cosmos/cosmos-sdk/x/authz"
)

func RegisterInterfaces(registry types.InterfaceRegistry) {
	registry.RegisterImplementations((*sdk.Msg)(nil),
		&MsgUpdateParams{},
		&MsgInitSession{},
		&MsgCommitRootProof{},
		&MsgDistributeBatch{},
		&MsgFinalizeAndCloseSession{},
		&MsgAbortAndCloseSession{},
		&MsgRegisterStorage{},
	)

	// Authz: session-bound authorization
	registry.RegisterImplementations((*authz.Authorization)(nil),
		&SessionBoundAuthorization{},
	)

	msgservice.RegisterMsgServiceDesc(registry, &_Msg_serviceDesc)
}
