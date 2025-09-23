package types

import (
	"fmt"

	host "github.com/cosmos/ibc-go/v10/modules/core/24-host"
)

// DefaultGenesis returns the default genesis state
func DefaultGenesis() *GenesisState {
	return &GenesisState{
		Params: DefaultParams(),
		PortId: PortID, StoredChunkMap: []StoredChunk{}}
}

// Validate performs basic genesis state validation returning an error upon any
// failure.
func (gs GenesisState) Validate() error {
	if err := host.PortIdentifierValidator(gs.PortId); err != nil {
		return err
	}
	storedChunkIndexMap := make(map[string]struct{})

	for _, elem := range gs.StoredChunkMap {
		index := fmt.Sprint(elem.Index)
		if _, ok := storedChunkIndexMap[index]; ok {
			return fmt.Errorf("duplicated index for storedChunk")
		}
		storedChunkIndexMap[index] = struct{}{}
	}

	return gs.Params.Validate()
}
