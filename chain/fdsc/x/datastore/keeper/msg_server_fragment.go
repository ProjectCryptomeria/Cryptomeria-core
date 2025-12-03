package keeper

import (
	"context"
	"errors"
	"fmt"

	"fdsc/x/datastore/types"

	"cosmossdk.io/collections"
	errorsmod "cosmossdk.io/errors"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

func (k msgServer) CreateFragment(ctx context.Context, msg *types.MsgCreateFragment) (*types.MsgCreateFragmentResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidAddress, fmt.Sprintf("invalid address: %s", err))
	}

	// Check if the value already exists
	ok, err := k.Fragment.Has(ctx, msg.FragmentId)
	if err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, err.Error())
	} else if ok {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "index already set")
	}

	var fragment = types.Fragment{
		Creator:    msg.Creator,
		FragmentId: msg.FragmentId,
		Data:       msg.Data,
	}

	if err := k.Fragment.Set(ctx, fragment.FragmentId, fragment); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, err.Error())
	}

	return &types.MsgCreateFragmentResponse{}, nil
}

func (k msgServer) UpdateFragment(ctx context.Context, msg *types.MsgUpdateFragment) (*types.MsgUpdateFragmentResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidAddress, fmt.Sprintf("invalid signer address: %s", err))
	}

	// Check if the value exists
	val, err := k.Fragment.Get(ctx, msg.FragmentId)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, errorsmod.Wrap(sdkerrors.ErrKeyNotFound, "index not set")
		}

		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, err.Error())
	}

	// Checks if the msg creator is the same as the current owner
	if msg.Creator != val.Creator {
		return nil, errorsmod.Wrap(sdkerrors.ErrUnauthorized, "incorrect owner")
	}

	var fragment = types.Fragment{
		Creator:    msg.Creator,
		FragmentId: msg.FragmentId,
		Data:       msg.Data,
	}

	if err := k.Fragment.Set(ctx, fragment.FragmentId, fragment); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, "failed to update fragment")
	}

	return &types.MsgUpdateFragmentResponse{}, nil
}

func (k msgServer) DeleteFragment(ctx context.Context, msg *types.MsgDeleteFragment) (*types.MsgDeleteFragmentResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidAddress, fmt.Sprintf("invalid signer address: %s", err))
	}

	// Check if the value exists
	val, err := k.Fragment.Get(ctx, msg.FragmentId)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, errorsmod.Wrap(sdkerrors.ErrKeyNotFound, "index not set")
		}

		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, err.Error())
	}

	// Checks if the msg creator is the same as the current owner
	if msg.Creator != val.Creator {
		return nil, errorsmod.Wrap(sdkerrors.ErrUnauthorized, "incorrect owner")
	}

	if err := k.Fragment.Remove(ctx, msg.FragmentId); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, "failed to remove fragment")
	}

	return &types.MsgDeleteFragmentResponse{}, nil
}
