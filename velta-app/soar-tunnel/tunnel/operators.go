package tunnel

// OperatorResolvers maps a SIM's MCC+MNC to resolvers its operator runs.
// They usually answer their own subscribers only, which is exactly when they
// matter: on allowlist-only mobile internet the operator's DNS is the one
// most likely to keep answering. For everyone else they would be dead
// paths, so they are added only for a matching SIM.
//
// The phone's operator-assigned resolver (Config.SystemResolvers) covers any
// operator missing here.
var OperatorResolvers = map[string][]string{
	// MTS: all seven answered and forwarded the tunnel zone from MTS
	// residential Globalping probes, twice (2026-10-11), and from no other
	// network. Its regional business resolvers (213.87.74.x, .99.x) did not.
	"25001": {
		"213.87.2.88:53", "213.87.2.89:53", "195.34.32.116:53", "212.188.4.10:53",
		"213.87.0.1:53", "213.87.1.1:53", "217.66.16.35:53",
	},
	// MegaFon (and Yota on its network): a lookup-site entry; Globalping has
	// no MegaFon probe to confirm it.
	"25002": {"178.176.63.46:53"},
	"25011": {"178.176.63.46:53"},
	// Beeline: none. Its published resolvers refused or failed from a Beeline
	// probe (2026-10-11); the phone's network DNS covers it.
}
