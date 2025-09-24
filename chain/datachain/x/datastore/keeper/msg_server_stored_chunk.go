package keeper

import (
	"context"
	"errors"
	"fmt"

	"datachain/x/datastore/types"

	"cosmossdk.io/collections"
	errorsmod "cosmossdk.io/errors"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

func (k msgServer) CreateStoredChunk(ctx context.Context, msg *types.MsgCreateStoredChunk) (*types.MsgCreateStoredChunkResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidAddress, fmt.Sprintf("invalid address: %s", err))
	}

	// Check if the value already exists
	ok, err := k.StoredChunk.Has(ctx, msg.Index)
	if err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, err.Error())
	} else if ok {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "index already set")
	}

	var storedChunk = types.StoredChunk{
		Creator: msg.Creator,
		Index:   msg.Index,
		Data:    msg.Data,
	}

	if err := k.StoredChunk.Set(ctx, storedChunk.Index, storedChunk); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, err.Error())
	}

	return &types.MsgCreateStoredChunkResponse{}, nil
}

func (k msgServer) UpdateStoredChunk(ctx context.Context, msg *types.MsgUpdateStoredChunk) (*types.MsgUpdateStoredChunkResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidAddress, fmt.Sprintf("invalid signer address: %s", err))
	}

	// Check if the value exists
	val, err := k.StoredChunk.Get(ctx, msg.Index)
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

	var storedChunk = types.StoredChunk{
		Creator: msg.Creator,
		Index:   msg.Index,
		Data:    msg.Data,
	}

	if err := k.StoredChunk.Set(ctx, storedChunk.Index, storedChunk); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, "failed to update storedChunk")
	}

	return &types.MsgUpdateStoredChunkResponse{}, nil
}

func (k msgServer) DeleteStoredChunk(ctx context.Context, msg *types.MsgDeleteStoredChunk) (*types.MsgDeleteStoredChunkResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidAddress, fmt.Sprintf("invalid signer address: %s", err))
	}

	// Check if the value exists
	val, err := k.StoredChunk.Get(ctx, msg.Index)
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

	if err := k.StoredChunk.Remove(ctx, msg.Index); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, "failed to remove storedChunk")
	}

	return &types.MsgDeleteStoredChunkResponse{}, nil
}
