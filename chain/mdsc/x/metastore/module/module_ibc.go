package metastore

import (
	"fmt"

	errorsmod "cosmossdk.io/errors"

	"mdsc/x/metastore/keeper"
	"mdsc/x/metastore/types"

	"github.com/cosmos/cosmos-sdk/codec"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	channeltypes "github.com/cosmos/ibc-go/v10/modules/core/04-channel/types"
	ibcexported "github.com/cosmos/ibc-go/v10/modules/core/exported"
)

// IBCModule implements the ICS26 interface for interchain accounts host chains
type IBCModule struct {
	cdc    codec.Codec
	keeper keeper.Keeper
}

// NewIBCModule creates a new IBCModule given the associated keeper
func NewIBCModule(cdc codec.Codec, k keeper.Keeper) IBCModule {
	return IBCModule{
		cdc:    cdc,
		keeper: k,
	}
}

// OnChanOpenInit implements the IBCModule interface
func (im IBCModule) OnChanOpenInit(
	ctx sdk.Context,
	order channeltypes.Order,
	connectionHops []string,
	portID string,
	channelID string,
	counterparty channeltypes.Counterparty,
	version string,
) (string, error) {
	if version != types.Version {
		return "", errorsmod.Wrapf(types.ErrInvalidVersion, "got %s, expected %s", version, types.Version)
	}

	return version, nil
}

// OnChanOpenTry implements the IBCModule interface
func (im IBCModule) OnChanOpenTry(
	ctx sdk.Context,
	order channeltypes.Order,
	connectionHops []string,
	portID,
	channelID string,
	counterparty channeltypes.Counterparty,
	counterpartyVersion string,
) (string, error) {
	if counterpartyVersion != types.Version {
		return "", errorsmod.Wrapf(types.ErrInvalidVersion, "invalid counterparty version: got: %s, expected %s", counterpartyVersion, types.Version)
	}

	return counterpartyVersion, nil
}

// OnChanOpenAck implements the IBCModule interface
func (im IBCModule) OnChanOpenAck(
	ctx sdk.Context,
	portID,
	channelID,
	counterpartyChannelID,
	counterpartyVersion string,
) error {
	if counterpartyVersion != types.Version {
		return errorsmod.Wrapf(types.ErrInvalidVersion, "invalid counterparty version: %s, expected %s", counterpartyVersion, types.Version)
	}
	return nil
}

// OnChanOpenConfirm implements the IBCModule interface
func (im IBCModule) OnChanOpenConfirm(
	ctx sdk.Context,
	portID,
	channelID string,
) error {
	return nil
}

// OnChanCloseInit implements the IBCModule interface
func (im IBCModule) OnChanCloseInit(
	ctx sdk.Context,
	portID,
	channelID string,
) error {
	// Disallow user-initiated channel closing for channels
	return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "user cannot close channel")
}

// OnChanCloseConfirm implements the IBCModule interface
func (im IBCModule) OnChanCloseConfirm(
	ctx sdk.Context,
	portID,
	channelID string,
) error {
	return nil
}

// OnRecvPacket implements the IBCModule interface
func (im IBCModule) OnRecvPacket(
	ctx sdk.Context,
	channelVersion string,
	modulePacket channeltypes.Packet,
	relayer sdk.AccAddress,
) ibcexported.Acknowledgement {
	var modulePacketData types.MetastorePacketData
	if err := modulePacketData.Unmarshal(modulePacket.GetData()); err != nil {
		return channeltypes.NewErrorAcknowledgement(errorsmod.Wrapf(sdkerrors.ErrUnknownRequest, "cannot unmarshal packet data: %s", err.Error()))
	}

	// Dispatch packet
	switch packet := modulePacketData.Packet.(type) {
	// --- ManifestPacketの受信処理 ---
	case *types.MetastorePacketData_ManifestPacket:
		manifestData := packet.ManifestPacket

		// 1. FragmentLocationリストの変換 (Packet型 -> 保存型)
		var storedFragments []*types.FragmentLocation
		for _, f := range manifestData.Fragments {
			storedFragments = append(storedFragments, &types.FragmentLocation{
				FdscId:     f.FdscId,
				FragmentId: f.FragmentId,
			})
		}

		// 2. FileInfoの作成 (値型)
		fileInfo := types.FileInfo{
			MimeType:  manifestData.MimeType,
			FileSize:  manifestData.FileSize,
			Fragments: storedFragments,
		}

		// 3. Manifestの作成と保存
		// 今回は PoC としてファイル名 = プロジェクト名 として簡易的に保存
		projectName := manifestData.Filename

		// 既存のマニフェストがあれば取得して更新、なければ新規作成
		// Note: Collections APIを使用。Getは値とエラーを返す。
		manifest, err := im.keeper.Manifest.Get(ctx, projectName)
		if err != nil { // Not Found (collections.ErrNotFound) or other errors
			// 新規作成
			manifest = types.Manifest{
				ProjectName: projectName,
				Version:     "1.0.0", // 初期バージョン
				Creator:     "ibc-user",
				// 修正: Filesマップをポインタ型 (*types.FileInfo) で初期化
				Files: make(map[string]*types.FileInfo),
			}
			// 新規Mapにエントリを追加 (値型をポインタに変換)
			manifest.Files[manifestData.Filename] = &fileInfo // 👈 修正: & を使用
		} else {
			// 更新
			// Protobufのmapがnilの場合の初期化
			if manifest.Files == nil {
				// 修正: Filesマップをポインタ型 (*types.FileInfo) で初期化
				manifest.Files = make(map[string]*types.FileInfo)
			}
			// Mapにエントリを更新 (値型をポインタに変換)
			manifest.Files[manifestData.Filename] = &fileInfo // 👈 修正: & を使用
		}

		// 保存
		if err := im.keeper.Manifest.Set(ctx, projectName, manifest); err != nil {
			return channeltypes.NewErrorAcknowledgement(fmt.Errorf("failed to save manifest: %w", err))
		}

		ctx.Logger().Info("Manifest Packet Received & Saved", "project", projectName, "fragments_count", len(storedFragments))

		return channeltypes.NewResultAcknowledgement([]byte{byte(1)})

	default:
		err := fmt.Errorf("unrecognized %s packet type: %T", types.ModuleName, packet)
		return channeltypes.NewErrorAcknowledgement(err)
	}
}

// OnAcknowledgementPacket implements the IBCModule interface
func (im IBCModule) OnAcknowledgementPacket(
	ctx sdk.Context,
	channelVersion string,
	modulePacket channeltypes.Packet,
	acknowledgement []byte,
	relayer sdk.AccAddress,
) error {
	var ack channeltypes.Acknowledgement
	if err := im.cdc.UnmarshalJSON(acknowledgement, &ack); err != nil {
		return errorsmod.Wrapf(sdkerrors.ErrUnknownRequest, "cannot unmarshal packet acknowledgement: %v", err)
	}

	var eventType = types.EventTypePacket

	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			eventType,
			sdk.NewAttribute(types.AttributeKeyAck, fmt.Sprintf("%v", ack)),
		),
	)

	switch resp := ack.Response.(type) {
	case *channeltypes.Acknowledgement_Result:
		ctx.EventManager().EmitEvent(
			sdk.NewEvent(
				eventType,
				sdk.NewAttribute(types.AttributeKeyAckSuccess, string(resp.Result)),
			),
		)
	case *channeltypes.Acknowledgement_Error:
		ctx.EventManager().EmitEvent(
			sdk.NewEvent(
				eventType,
				sdk.NewAttribute(types.AttributeKeyAckError, resp.Error),
			),
		)
	}

	return nil
}

// OnTimeoutPacket implements the IBCModule interface
func (im IBCModule) OnTimeoutPacket(
	ctx sdk.Context,
	channelVersion string,
	modulePacket channeltypes.Packet,
	relayer sdk.AccAddress,
) error {
	var modulePacketData types.MetastorePacketData
	if err := modulePacketData.Unmarshal(modulePacket.GetData()); err != nil {
		return errorsmod.Wrapf(sdkerrors.ErrUnknownRequest, "cannot unmarshal packet data: %s", err.Error())
	}

	// Dispatch packet
	switch packet := modulePacketData.Packet.(type) {
	default:
		ctx.Logger().Error("Packet Timeout", "type", fmt.Sprintf("%T", packet))
		return nil
	}
}
