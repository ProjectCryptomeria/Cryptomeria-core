package gateway

import (
	"fmt"
	"strings"

	errorsmod "cosmossdk.io/errors"

	"gwc/x/gateway/keeper"
	"gwc/x/gateway/types"

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

	// チャネルの自動登録を実行
	if err := im.keeper.RegisterChannel(ctx, portID, channelID); err != nil {
		ctx.Logger().Error("Failed to register channel", "error", err)
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
	var modulePacketData types.GatewayPacketData
	if err := modulePacketData.Unmarshal(modulePacket.GetData()); err != nil {
		return channeltypes.NewErrorAcknowledgement(errorsmod.Wrapf(sdkerrors.ErrUnknownRequest, "cannot unmarshal packet data: %s", err.Error()))
	}

	// GWC 側は基本的に送信者なので、受信Packetは想定しない（現状）
	switch packet := modulePacketData.Packet.(type) {
	default:
		err := fmt.Errorf("unrecognized %s packet type: %T", types.ModuleName, packet)
		return channeltypes.NewErrorAcknowledgement(err)
	}
}

// splitFragKey extracts session_id from frag_key:
//
//	session_id + "\x00" + path + "\x00" + index(%020d)
//
// (indexやpathは不要なので先頭だけ取り出す)
func splitFragKey(fragKey string) (sessionID string, ok bool) {
	parts := strings.SplitN(fragKey, "\x00", 2)
	if len(parts) != 2 {
		return "", false
	}
	return parts[0], true
}

// OnAcknowledgementPacket implements the IBCModule interface
func (im IBCModule) OnAcknowledgementPacket(
	ctx sdk.Context,
	channelVersion string,
	modulePacket channeltypes.Packet,
	acknowledgement []byte,
	relayer sdk.AccAddress,
) error {
	// NOTE: ibc-go v10 は proto bytes を渡す。Ackは Unmarshal が正しい。
	var ack channeltypes.Acknowledgement
	if err := ack.Unmarshal(acknowledgement); err != nil {
		return errorsmod.Wrapf(sdkerrors.ErrUnknownRequest, "cannot unmarshal acknowledgement: %v", err)
	}

	var modulePacketData types.GatewayPacketData
	if err := modulePacketData.Unmarshal(modulePacket.GetData()); err != nil {
		return errorsmod.Wrapf(sdkerrors.ErrUnknownRequest, "cannot unmarshal packet data: %s", err.Error())
	}

	// (既存) ACKイベントは残す
	ctx.EventManager().EmitEvent(
		sdk.NewEvent(
			types.EventTypePacket,
			sdk.NewAttribute(types.AttributeKeyAck, fmt.Sprintf("%v", ack)),
		),
	)

	switch resp := ack.Response.(type) {
	case *channeltypes.Acknowledgement_Result:
		ctx.EventManager().EmitEvent(
			sdk.NewEvent(
				types.EventTypePacket,
				sdk.NewAttribute(types.AttributeKeyAckSuccess, string(resp.Result)),
			),
		)
	case *channeltypes.Acknowledgement_Error:
		ctx.EventManager().EmitEvent(
			sdk.NewEvent(
				types.EventTypePacket,
				sdk.NewAttribute(types.AttributeKeyAckError, resp.Error),
			),
		)
	}

	// Dispatch packet
	switch packet := modulePacketData.Packet.(type) {

	case *types.GatewayPacketData_FragmentPacket:
		// layer5: seq -> frag_key -> session_id で相関する
		seq := modulePacket.Sequence

		fragKey, err := im.keeper.GetFragmentKeyBySeq(ctx, seq)
		if err != nil {
			// mappingが無いなら無視（古い/異常系/すでに掃除済み）
			return nil
		}
		// mapping はACK/Timeout処理で不要になるので削除
		_ = im.keeper.UnbindFragmentSeq(ctx, seq)

		sessionID, ok := splitFragKey(fragKey)
		if !ok {
			return nil
		}

		sess, err := im.keeper.GetSession(ctx, sessionID)
		if err != nil {
			// セッションが無いなら無視
			return nil
		}

		switch r := ack.Response.(type) {
		case *channeltypes.Acknowledgement_Result:
			sess.AckSuccessCount++
		case *channeltypes.Acknowledgement_Error:
			sess.AckErrorCount++
			// fragment側のACKエラーで即Closeするかは設計次第だが、
			// layer0要件は "MDSC ACKで成功" なので、ここではカウントのみ増やす。
			_ = r
		}

		_ = im.keeper.SetSession(ctx, sess)
		return nil

	case *types.GatewayPacketData_ManifestPacket:
		// layer0/layer5: MDSC manifest の ACK が「完了条件」
		seq := modulePacket.Sequence

		sessionID, err := im.keeper.GetSessionIDByManifestSeq(ctx, seq)
		if err != nil {
			return nil
		}
		_ = im.keeper.UnbindManifestSeq(ctx, seq)

		sess, err := im.keeper.GetSession(ctx, sessionID)
		if err != nil {
			return nil
		}

		switch r := ack.Response.(type) {
		case *channeltypes.Acknowledgement_Result:
			sess.State = types.SessionState_SESSION_STATE_CLOSED_SUCCESS
			sess.CloseReason = ""
			ctx.EventManager().EmitEvent(
				sdk.NewEvent(
					"csu_close_success",
					sdk.NewAttribute("session_id", sessionID),
				),
			)
			_ = r
		case *channeltypes.Acknowledgement_Error:
			sess.State = types.SessionState_SESSION_STATE_CLOSED_FAILED
			sess.CloseReason = r.Error
			ctx.EventManager().EmitEvent(
				sdk.NewEvent(
					"csu_close_failed",
					sdk.NewAttribute("session_id", sessionID),
					sdk.NewAttribute("reason", r.Error),
				),
			)
		}

		_ = im.keeper.SetSession(ctx, sess)
		return nil

	default:
		errMsg := fmt.Sprintf("unrecognized %s packet type: %T", types.ModuleName, packet)
		return errorsmod.Wrap(sdkerrors.ErrUnknownRequest, errMsg)
	}
}

// OnTimeoutPacket implements the IBCModule interface
func (im IBCModule) OnTimeoutPacket(
	ctx sdk.Context,
	channelVersion string,
	modulePacket channeltypes.Packet,
	relayer sdk.AccAddress,
) error {
	var modulePacketData types.GatewayPacketData
	if err := modulePacketData.Unmarshal(modulePacket.GetData()); err != nil {
		return errorsmod.Wrapf(sdkerrors.ErrUnknownRequest, "cannot unmarshal packet data: %s", err.Error())
	}

	switch packet := modulePacketData.Packet.(type) {

	case *types.GatewayPacketData_FragmentPacket:
		// fragment timeout -> ack_error_count++
		seq := modulePacket.Sequence

		fragKey, err := im.keeper.GetFragmentKeyBySeq(ctx, seq)
		if err == nil {
			_ = im.keeper.UnbindFragmentSeq(ctx, seq)

			sessionID, ok := splitFragKey(fragKey)
			if ok {
				sess, err := im.keeper.GetSession(ctx, sessionID)
				if err == nil {
					sess.AckErrorCount++
					_ = im.keeper.SetSession(ctx, sess)
				}
			}
		}

		ctx.Logger().Error("Fragment Packet Timeout", "seq", seq)
		_ = packet
		return nil

	case *types.GatewayPacketData_ManifestPacket:
		// manifest timeout -> close failed (layer0)
		seq := modulePacket.Sequence

		sessionID, err := im.keeper.GetSessionIDByManifestSeq(ctx, seq)
		if err == nil {
			_ = im.keeper.UnbindManifestSeq(ctx, seq)

			sess, err := im.keeper.GetSession(ctx, sessionID)
			if err == nil {
				sess.State = types.SessionState_SESSION_STATE_CLOSED_FAILED
				sess.CloseReason = "manifest packet timeout"
				_ = im.keeper.SetSession(ctx, sess)
			}

			ctx.EventManager().EmitEvent(
				sdk.NewEvent(
					"csu_close_failed",
					sdk.NewAttribute("session_id", sessionID),
					sdk.NewAttribute("reason", "manifest timeout"),
				),
			)
		}

		ctx.Logger().Error("Manifest Packet Timeout", "seq", seq)
		_ = packet
		return nil

	default:
		errMsg := fmt.Sprintf("unrecognized %s packet type: %T", types.ModuleName, packet)
		return errorsmod.Wrap(sdkerrors.ErrUnknownRequest, errMsg)
	}
}
