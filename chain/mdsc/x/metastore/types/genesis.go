package types

import (
	"fmt"

	host "github.com/cosmos/ibc-go/v10/modules/core/24-host"
)

// DefaultGenesis returns the default genesis state
func DefaultGenesis() *GenesisState {
	return &GenesisState{
		Params: DefaultParams(),
		PortId: PortID, ManifestMap: []Manifest{}}
}

// Validate performs basic genesis state validation returning an error upon any
// failure.
func (gs GenesisState) Validate() error {
	if err := host.PortIdentifierValidator(gs.PortId); err != nil {
		return err
	}
	manifestIndexMap := make(map[string]struct{})

	for _, elem := range gs.ManifestMap {
		index := fmt.Sprint(elem.ProjectName)
		if _, ok := manifestIndexMap[index]; ok {
			return fmt.Errorf("duplicated index for manifest")
		}
		manifestIndexMap[index] = struct{}{}
	}

	return gs.Params.Validate()
}
