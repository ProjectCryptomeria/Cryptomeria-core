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
	case *types.MetastorePacketData_NoDataPacket:
		return channeltypes.NewResultAcknowledgement([]byte{byte(1)})

	case *types.MetastorePacketData_FragmentPacket:
		// MDSC should not receive fragments; accept for forward-compat without persisting.
		_ = packet.FragmentPacket
		return channeltypes.NewResultAcknowledgement([]byte{byte(1)})

	case *types.MetastorePacketData_ManifestPacket:
		manifestData := packet.ManifestPacket
		projectName := manifestData.ProjectName

		if err := types.ValidateManifestPacketIdentity(manifestData); err != nil {
			errMsg := fmt.Errorf("invalid manifest packet: %w", err)
			ctx.Logger().Error(errMsg.Error())
			return channeltypes.NewErrorAcknowledgement(errMsg)
		}

		ctx.Logger().Info("Receiving Manifest Packet",
			"project", projectName,
			"version", manifestData.Version,
			"root_proof", manifestData.RootProof,
			"owner", manifestData.Owner,
			"session_id", manifestData.SessionId)

		// 1. 既存または新規のManifestを取得
		manifest, err := im.keeper.Manifest.Get(ctx, projectName)
		if err != nil { // 新規作成
			manifest = types.Manifest{
				ProjectName: projectName,
				Version:     manifestData.Version,
				Owner:       manifestData.Owner,
				Files:       make(map[string]*types.FileInfo),

				RootProof:    manifestData.RootProof,
				SessionId:    manifestData.SessionId,
				FragmentSize: manifestData.FragmentSize,
			}
		} else { // 更新
			manifest.Version = manifestData.Version
			manifest.Owner = manifestData.Owner
			manifest.RootProof = manifestData.RootProof
			manifest.SessionId = manifestData.SessionId
			manifest.FragmentSize = manifestData.FragmentSize

			if manifest.Files == nil {
				manifest.Files = make(map[string]*types.FileInfo)
			}
		}

		// 2. 受信したファイル情報をストレージ形式に変換してマージ
		for filePath, fileMeta := range manifestData.Files {
			// FragmentLocationリストの変換
			var storedFragments []*types.FragmentLocation
			for _, f := range fileMeta.Fragments {
				storedFragments = append(storedFragments, &types.FragmentLocation{
					FdscId:     f.FdscId,
					FragmentId: f.FragmentId,
				})
			}

			// FileInfoの作成
			fileInfo := types.FileInfo{
				MimeType:  fileMeta.MimeType,
				Size_:     fileMeta.Size_,
				Fragments: storedFragments,
				FileRoot:  fileMeta.FileRoot,
			}

			// マップに登録（上書き）
			manifest.Files[filePath] = &fileInfo
		}

		// 3. 保存
		if err := im.keeper.Manifest.Set(ctx, projectName, manifest); err != nil {
			errMsg := fmt.Errorf("failed to save manifest for project %s: %w", projectName, err)
			ctx.Logger().Error(errMsg.Error())
			return channeltypes.NewErrorAcknowledgement(errMsg)
		}

		// デバッグログ
		fmt.Printf("\n[DEBUG] Manifest Saved: Project=%s, RootProof=%s\n", projectName, manifest.RootProof)

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
