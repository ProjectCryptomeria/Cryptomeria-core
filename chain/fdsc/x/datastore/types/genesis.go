package types

import (
	"fmt"

	host "github.com/cosmos/ibc-go/v10/modules/core/24-host"
)

// DefaultGenesis returns the default genesis state
func DefaultGenesis() *GenesisState {
	return &GenesisState{
		Params: DefaultParams(),
		PortId: PortID, FragmentMap: []Fragment{}}
}

// Validate performs basic genesis state validation returning an error upon any
// failure.
func (gs GenesisState) Validate() error {
	if err := host.PortIdentifierValidator(gs.PortId); err != nil {
		return err
	}
	fragmentIndexMap := make(map[string]struct{})

	for _, elem := range gs.FragmentMap {
		index := fmt.Sprint(elem.FragmentId)
		if _, ok := fragmentIndexMap[index]; ok {
			return fmt.Errorf("duplicated index for fragment")
		}
		fragmentIndexMap[index] = struct{}{}
	}

	return gs.Params.Validate()
}
