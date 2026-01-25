package datastore

import (
	"bytes"
	"errors"
	"fmt"

	"cosmossdk.io/collections"
	errorsmod "cosmossdk.io/errors"

	"fdsc/x/datastore/keeper"
	"fdsc/x/datastore/types"

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
	var modulePacketData types.DatastorePacketData
	if err := modulePacketData.Unmarshal(modulePacket.GetData()); err != nil {
		return channeltypes.NewErrorAcknowledgement(errorsmod.Wrapf(sdkerrors.ErrUnknownRequest, "cannot unmarshal packet data: %s", err.Error()))
	}

	// Dispatch packet
	switch packet := modulePacketData.Packet.(type) {
	// --- FragmentPacketの受信処理 ---
	case *types.DatastorePacketData_FragmentPacket:
		fragment := packet.FragmentPacket

		// GWC送信の (session_id, path, index) から、FDSC保存用 fragment_id を決定
		fragmentIdStr := types.MakeFragmentID(fragment.SessionId, fragment.Path, fragment.Index)

		// 既に保存済みの場合はチェック
		exists, err := im.keeper.Fragment.Has(ctx, fragmentIdStr)
		if err != nil {
			return channeltypes.NewErrorAcknowledgement(fmt.Errorf("failed to check fragment existence: %w", err))
		}
		if exists {
			existing, err := im.keeper.Fragment.Get(ctx, fragmentIdStr)
			if err != nil {
				if !errors.Is(err, collections.ErrNotFound) {
					return channeltypes.NewErrorAcknowledgement(fmt.Errorf("failed to load existing fragment: %w", err))
				}
			} else {
				if bytes.Equal(existing.Data, fragment.Data) {
					ctx.Logger().Info("Duplicate fragment received", "id", fragmentIdStr)
					return channeltypes.NewResultAcknowledgement([]byte{byte(1)})
				}
				return channeltypes.NewErrorAcknowledgement(fmt.Errorf("fragment conflict: %s", fragmentIdStr))
			}
		}

		// 保存データを作成
		val := types.Fragment{
			FragmentId: fragmentIdStr,
			Data:       fragment.Data,
			Creator:    "ibc-sender",

			// CSU metadata
			RootProof: fragment.RootProof,
			SessionId: fragment.SessionId,
			Path:      fragment.Path,
			Index:     fragment.Index,
		}

		if err := im.keeper.Fragment.Set(ctx, fragmentIdStr, val); err != nil {
			return channeltypes.NewErrorAcknowledgement(fmt.Errorf("failed to save fragment: %w", err))
		}

		ctx.Logger().Info("Fragment Saved",
			"id", fragmentIdStr,
			"session_id", fragment.SessionId,
			"path", fragment.Path,
			"index", fragment.Index,
		)

		return channeltypes.NewResultAcknowledgement([]byte{byte(1)})

	case *types.DatastorePacketData_NoDataPacket:
		return channeltypes.NewResultAcknowledgement([]byte{byte(1)})

	case *types.DatastorePacketData_ManifestPacket:
		// FDSC should not receive manifests; accept for forward-compat without persisting.
		_ = packet.ManifestPacket
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
	return nil
}
