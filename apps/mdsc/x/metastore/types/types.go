package types

import "fmt"

// ValidateManifestPacketIdentity performs minimal validation of the IBC ManifestPacket
// that is expected to be wire-compatible with GWC's `gwc.gateway.v1.ManifestPacket`.
//
// This is intentionally conservative (identity + CSU fields only).
// Deep validation (e.g., file graph completeness) can be added later.
func ValidateManifestPacketIdentity(p *ManifestPacket) error {
	if p == nil {
		return fmt.Errorf("manifest packet is nil")
	}

	if p.ProjectName == "" {
		return fmt.Errorf("project_name is empty")
	}
	if p.Version == "" {
		return fmt.Errorf("version is empty")
	}

	// CSU verification fields
	if p.RootProof == "" {
		return fmt.Errorf("root_proof is empty")
	}
	if p.FragmentSize == 0 {
		return fmt.Errorf("fragment_size must be > 0")
	}

	// identity fields
	if p.Owner == "" {
		return fmt.Errorf("owner is empty")
	}
	if p.SessionId == "" {
		return fmt.Errorf("session_id is empty")
	}

	return nil
}
