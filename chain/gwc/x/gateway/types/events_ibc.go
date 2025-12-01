package types

// IBC events
const (
	EventTypeTimeout = "timeout"
	// 追加
	EventTypePacket = "gateway_packet"

	AttributeKeyAckSuccess = "success"
	AttributeKeyAck        = "acknowledgement"
	AttributeKeyAckError   = "error"
)
