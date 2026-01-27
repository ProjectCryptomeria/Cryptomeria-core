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

type IBCModule struct {
	cdc    codec.Codec
	keeper keeper.Keeper
}

func NewIBCModule(cdc codec.Codec, k keeper.Keeper) IBCModule {
	return IBCModule{
		cdc:    cdc,
		keeper: k,
	}
}

func (im IBCModule) OnChanOpenInit(ctx sdk.Context, order channeltypes.Order, connectionHops []string, portID string, channelID string, counterparty channeltypes.Counterparty, version string) (string, error) {
	if version != types.Version {
		return "", errorsmod.Wrapf(types.ErrInvalidVersion, "got %s, expected %s", version, types.Version)
	}
	return version, nil
}

func (im IBCModule) OnChanOpenTry(ctx sdk.Context, order channeltypes.Order, connectionHops []string, portID, channelID string, counterparty channeltypes.Counterparty, counterpartyVersion string) (string, error) {
	if counterpartyVersion != types.Version {
		return "", errorsmod.Wrapf(types.ErrInvalidVersion, "invalid counterparty version: got: %s, expected %s", counterpartyVersion, types.Version)
	}
	return counterpartyVersion, nil
}

func (im IBCModule) OnChanOpenAck(ctx sdk.Context, portID, channelID, counterpartyChannelID, counterpartyVersion string) error {
	if counterpartyVersion != types.Version {
		return errorsmod.Wrapf(types.ErrInvalidVersion, "invalid counterparty version: %s, expected %s", counterpartyVersion, types.Version)
	}
	if err := im.keeper.RegisterChannel(ctx, portID, channelID); err != nil {
		ctx.Logger().Error("Failed to register channel", "error", err)
	}
	return nil
}

func (im IBCModule) OnChanOpenConfirm(ctx sdk.Context, portID, channelID string) error { return nil }

func (im IBCModule) OnChanCloseInit(ctx sdk.Context, portID, channelID string) error {
	return errorsmod.Wrap(sdkerrors.ErrInvalidRequest, "user cannot close channel")
}

func (im IBCModule) OnChanCloseConfirm(ctx sdk.Context, portID, channelID string) error { return nil }

func (im IBCModule) OnRecvPacket(ctx sdk.Context, channelVersion string, modulePacket channeltypes.Packet, relayer sdk.AccAddress) ibcexported.Acknowledgement {
	return channeltypes.NewErrorAcknowledgement(fmt.Errorf("GWC does not expect to receive packets"))
}

func splitFragKey(fragKey string) (sessionID string, ok bool) {
	parts := strings.SplitN(fragKey, "\x00", 2)
	if len(parts) != 2 {
		return "", false
	}
	return parts[0], true
}

func (im IBCModule) OnAcknowledgementPacket(ctx sdk.Context, channelVersion string, modulePacket channeltypes.Packet, acknowledgement []byte, relayer sdk.AccAddress) error {
	var ack channeltypes.Acknowledgement

	// 修正: 直接 Unmarshal するのではなく、Codecを使用してデコードを試みる
	// ネットワーク上のパケット形式に合わせて UnmarshalJSON か Unmarshal を選択します。
	// ここでは、受信側の実装と合わせるために JSON デコードを試行し、失敗したら ProtoBuf を試す構成が安全です。
	if err := im.cdc.UnmarshalJSON(acknowledgement, &ack); err != nil {
		// JSONで失敗した場合は ProtoBuf を試行
		if err := ack.Unmarshal(acknowledgement); err != nil {
			return errorsmod.Wrapf(sdkerrors.ErrUnknownRequest, "cannot unmarshal acknowledgement: %v", err)
		}
	}

	var modulePacketData types.GatewayPacketData
	if err := modulePacketData.Unmarshal(modulePacket.GetData()); err != nil {
		return errorsmod.Wrapf(sdkerrors.ErrUnknownRequest, "cannot unmarshal packet data: %s", err.Error())
	}

	switch packet := modulePacketData.Packet.(type) {
	case *types.GatewayPacketData_FragmentPacket:
		seq := modulePacket.Sequence
		fragKey, err := im.keeper.GetFragmentKeyBySeq(ctx, seq)
		if err != nil {
			return nil
		}
		_ = im.keeper.UnbindFragmentSeq(ctx, seq)

		sessionID, ok := splitFragKey(fragKey)
		if !ok {
			return nil
		}

		sess, err := im.keeper.GetSession(ctx, sessionID)
		if err != nil {
			return nil
		}

		// r を使用しないため宣言を削除します
		switch ack.Response.(type) {
		case *channeltypes.Acknowledgement_Result:
			sess.AckSuccessCount++
		case *channeltypes.Acknowledgement_Error:
			sess.AckErrorCount++
		}
		_ = im.keeper.SetSession(ctx, sess)
		return nil

	case *types.GatewayPacketData_ManifestPacket:
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
		case *channeltypes.Acknowledgement_Error:
			sess.State = types.SessionState_SESSION_STATE_CLOSED_FAILED
			sess.CloseReason = r.Error
			// 異常終了時も確実に権限を剥奪します
			im.keeper.RevokeCSUGrants(ctx, sess.Owner)
		}

		_ = im.keeper.SetSession(ctx, sess)
		return nil

	default:
		return errorsmod.Wrapf(sdkerrors.ErrUnknownRequest, "unrecognized packet type: %T", packet)
	}
}

func (im IBCModule) OnTimeoutPacket(ctx sdk.Context, channelVersion string, modulePacket channeltypes.Packet, relayer sdk.AccAddress) error {
	var modulePacketData types.GatewayPacketData
	if err := modulePacketData.Unmarshal(modulePacket.GetData()); err != nil {
		return err
	}

	switch packet := modulePacketData.Packet.(type) {
	case *types.GatewayPacketData_FragmentPacket:
		seq := modulePacket.Sequence
		fragKey, err := im.keeper.GetFragmentKeyBySeq(ctx, seq)
		if err == nil {
			_ = im.keeper.UnbindFragmentSeq(ctx, seq)
			if sessionID, ok := splitFragKey(fragKey); ok {
				sess, _ := im.keeper.GetSession(ctx, sessionID)
				sess.AckErrorCount++
				_ = im.keeper.SetSession(ctx, sess)
			}
		}
		return nil

	case *types.GatewayPacketData_ManifestPacket:
		seq := modulePacket.Sequence
		if sessionID, err := im.keeper.GetSessionIDByManifestSeq(ctx, seq); err == nil {
			_ = im.keeper.UnbindManifestSeq(ctx, seq)
			sess, _ := im.keeper.GetSession(ctx, sessionID)
			sess.State = types.SessionState_SESSION_STATE_CLOSED_FAILED
			sess.CloseReason = "manifest packet timeout"
			_ = im.keeper.SetSession(ctx, sess)
			// タイムアウト時も確実に権限を剥奪します
			im.keeper.RevokeCSUGrants(ctx, sess.Owner)
		}
		return nil

	default:
		return errorsmod.Wrapf(sdkerrors.ErrUnknownRequest, "unrecognized packet type: %T", packet)
	}
}
