package keeper

import (
	"context"
	"errors"
	"fmt"

	"mdsc/x/metastore/types"

	"cosmossdk.io/collections"
	errorsmod "cosmossdk.io/errors"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

func (k msgServer) CreateManifest(ctx context.Context, msg *types.MsgCreateManifest) (*types.MsgCreateManifestResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidAddress, fmt.Sprintf("invalid address: %s", err))
	}

	// Check if the value already exists
	ok, err := k.Manifest.Has(ctx, msg.ProjectName)
	if err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, err.Error())
	} else if ok {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "index already set")
	}

	// 修正: Filesマップをポインタ型 (*types.FileInfo) で初期化
	var manifest = types.Manifest{
		Creator:     msg.Creator,
		ProjectName: msg.ProjectName,
		Version:     msg.Version,
		Files:       make(map[string]*types.FileInfo), // 👈 修正: ポインタ型 (*) で初期化
	}

	if err := k.Manifest.Set(ctx, manifest.ProjectName, manifest); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, err.Error())
	}

	return &types.MsgCreateManifestResponse{}, nil
}

// 新規追加: Manifestにファイル情報を追加するハンドラ
func (k msgServer) AddFileToManifest(ctx context.Context, msg *types.MsgAddFileToManifest) (*types.MsgAddFileToManifestResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidAddress, fmt.Sprintf("invalid signer address: %s", err))
	}

	// 既存のManifestを取得
	val, err := k.Manifest.Get(ctx, msg.ProjectName)
	if err != nil {
		if errors.Is(err, collections.ErrNotFound) {
			return nil, errorsmod.Wrap(sdkerrors.ErrKeyNotFound, "Manifest not found")
		}
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, err.Error())
	}

	// 認証チェック
	if msg.Creator != val.Creator {
		return nil, errorsmod.Wrap(sdkerrors.ErrUnauthorized, "incorrect owner")
	}

	// ManifestのFilesマップが未初期化 (nil) の場合、ポインタ型で初期化する
	if val.Files == nil {
		val.Files = make(map[string]*types.FileInfo) // 👈 修正: ポインタ型 (*) で初期化
	}

	// ファイル情報をマップに追加/更新 (値のアドレスをポインタとして使用)
	val.Files[msg.FilePath] = &msg.FileInfo // 👈 修正: ポインタ (&) を使用

	// Manifestを更新して保存
	if err := k.Manifest.Set(ctx, val.ProjectName, val); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, "failed to update manifest with file info")
	}

	return &types.MsgAddFileToManifestResponse{}, nil
}

func (k msgServer) UpdateManifest(ctx context.Context, msg *types.MsgUpdateManifest) (*types.MsgUpdateManifestResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidAddress, fmt.Sprintf("invalid signer address: %s", err))
	}

	// Check if the value exists
	val, err := k.Manifest.Get(ctx, msg.ProjectName)
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

	// 修正: 既存の Manifest (val) から Files マップを引き継ぐ
	var manifest = types.Manifest{
		Creator:     msg.Creator,
		ProjectName: msg.ProjectName,
		Version:     msg.Version,
		Files:       val.Files, // 👈 修正: 既存のファイル情報を引き継ぐ
	}

	if err := k.Manifest.Set(ctx, manifest.ProjectName, manifest); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, "failed to update manifest")
	}

	return &types.MsgUpdateManifestResponse{}, nil
}

func (k msgServer) DeleteManifest(ctx context.Context, msg *types.MsgDeleteManifest) (*types.MsgDeleteManifestResponse, error) {
	if _, err := k.addressCodec.StringToBytes(msg.Creator); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrInvalidAddress, fmt.Sprintf("invalid signer address: %s", err))
	}

	// Check if the value exists
	val, err := k.Manifest.Get(ctx, msg.ProjectName)
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

	if err := k.Manifest.Remove(ctx, msg.ProjectName); err != nil {
		return nil, errorsmod.Wrap(sdkerrors.ErrLogic, "failed to remove manifest")
	}

	return &types.MsgDeleteManifestResponse{}, nil
}
