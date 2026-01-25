package types

const (
	MsgTypeURLDistributeBatch         = "/gwc.gateway.v1.MsgDistributeBatch"
	MsgTypeURLFinalizeAndCloseSession = "/gwc.gateway.v1.MsgFinalizeAndCloseSession"
	MsgTypeURLAbortAndCloseSession    = "/gwc.gateway.v1.MsgAbortAndCloseSession"
)

func CSUAuthorizedMsgTypeURLs() []string {
	return []string{
		MsgTypeURLDistributeBatch,
		MsgTypeURLFinalizeAndCloseSession,
		MsgTypeURLAbortAndCloseSession,
	}
}
