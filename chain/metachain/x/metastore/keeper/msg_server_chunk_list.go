package keeper

import (
	"context"

	"metachain/x/metastore/types"

	errorsmod "cosmossdk.io/errors"
)

func (k msgServer) ChunkList(ctx context.Context, msg *types.MsgChunkList) (*types.MsgChunkListResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(err, "invalid authority address")
	}

	// TODO: Handle the message

	return &types.MsgChunkListResponse{}, nil
}
