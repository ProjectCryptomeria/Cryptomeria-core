package keeper

import (
	"context"
	"errors"
	"fmt"

	"metachain/x/metastore/types"

	"cosmossdk.io/collections"
	errorsmod "cosmossdk.io/errors"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

func (k msgServer) CreateManifest(ctx context.Context, msg *types.MsgCreateManifest) (*types.MsgCreateManifestResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidAddress, fmt.Sprintf("invalid address: %s", err))
	}

	// Check if the value already exists
	ok, err := k.Manifest.Has(ctx, msg.Url)
	if err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, err.Error())
	} else if ok {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "index already set")
	}

	var manifest = types.Manifest{
		Creator:  msg.Creator,
		Url:      msg.Url,
		Manifest: msg.Manifest,
	}

	if err := k.Manifest.Set(ctx, manifest.Url, manifest); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, err.Error())
	}

	return &types.MsgCreateManifestResponse{}, nil
}

func (k msgServer) UpdateManifest(ctx context.Context, msg *types.MsgUpdateManifest) (*types.MsgUpdateManifestResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidAddress, fmt.Sprintf("invalid signer address: %s", err))
	}

	// Check if the value exists
	val, err := k.Manifest.Get(ctx, msg.Url)
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

	var manifest = types.Manifest{
		Creator:  msg.Creator,
		Url:      msg.Url,
		Manifest: msg.Manifest,
	}

	if err := k.Manifest.Set(ctx, manifest.Url, manifest); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, "failed to update manifest")
	}

	return &types.MsgUpdateManifestResponse{}, nil
}

func (k msgServer) DeleteManifest(ctx context.Context, msg *types.MsgDeleteManifest) (*types.MsgDeleteManifestResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidAddress, fmt.Sprintf("invalid signer address: %s", err))
	}

	// Check if the value exists
	val, err := k.Manifest.Get(ctx, msg.Url)
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

	if err := k.Manifest.Remove(ctx, msg.Url); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, "failed to remove manifest")
	}

	return &types.MsgDeleteManifestResponse{}, nil
}
