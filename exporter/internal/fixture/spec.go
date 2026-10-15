package fixture

// The demo contract: 14 virtual datacenters in five locations, wired together
// with Cross Connects (PCCs). Names are made up; the shape mirrors a typical
// enterprise setup (firewall VMs routing between LANs, shared transit
// networks per location, managed services attached to private LANs).

type dcSpec struct {
	Name, Location, Env, Description string
	LANs                             []lanSpec
	Servers                          []serverSpec
	NAT                              *natSpec
	NLB                              *lbSpec
	ALB                              *lbSpec
	NodePools                        []nodePoolSpec
	Postgres                         []pgSpec
	SecurityGroups                   []sgSpec
	OrphanVolumes                    []string // volumes not attached to any server
}

type lanSpec struct {
	Key, Name string
	Public    bool
	PCC       string // Cross Connect name; peers share one L2 segment/subnet
}

type serverSpec struct {
	Name      string // fmt pattern, receives the 1-based index
	Count     int
	Type      string // ENTERPRISE | CUBE | VCPU | GPU
	Cores     int
	RAM       int    // MB; CUBE servers take cores/RAM from Template
	Template  string // CUBE template name
	LANs      []string
	Role      string
	DataGB    int
	DataType  string
	Windows   bool
	Image     string // private (uploaded) image, e.g. a vendor appliance
	Stopped   bool
	PublicVIP bool // reserve a failover IP on the public LAN shared by all members
}

type natSpec struct {
	Name string
	LANs []string
}

type lbSpec struct {
	Name, Listener, Target string
	Port                   int
	TargetRole             string
}

type nodePoolSpec struct {
	Cluster, Name     string
	Nodes, Cores, RAM int
	LANs              []string
}

// Network Security Groups attach to servers by role. A server with one has
// no firewall rules of its own on its NICs: the group replaces them.
type sgSpec struct {
	Name, Description string
	Rules             string   // rule preset, as for NIC firewalls (by role)
	Roles             []string // servers with these roles get the group
}

type pgSpec struct {
	Name, LAN, Version string
	Instances          int
}

type pccSpec struct{ Name, Description string }

// Managed VPN gateways (regional VPN Gateway API). A tunnel's Remote is either
// the name of a server in the contract (its public IP is used) or a host
// outside the contract.
type vpnSpec struct {
	Name, Kind, DC, LAN, Description string // Kind: ipsec | wireguard
	Tunnels                          []tunnelSpec
}

type tunnelSpec struct {
	Name, Description string
	Remote            string
	Networks          []string // IPsec: peer networks; WireGuard: allowed IPs
	Port              int      // WireGuard endpoint port; 0 = roaming peer without endpoint
}

var vpnSpecs = []vpnSpec{
	{Name: "vpngw-mgmt", Kind: "ipsec", DC: "fra-mgmt", LAN: "mgmt", Description: "Managed VPN into the management network",
		Tunnels: []tunnelSpec{
			{Name: "hq-office", Description: "Head office firewall", Remote: "192.0.2.10", Networks: []string{"172.16.0.0/16"}},
			{Name: "txl-core", Description: "Berlin core VPN appliance", Remote: "txl-core-vpn-01", Networks: []string{"10.0.0.0/8"}},
		}},
	{Name: "wg-staging", Kind: "wireguard", DC: "lhr-staging", LAN: "app", Description: "Developer access to UK staging",
		Tunnels: []tunnelSpec{
			{Name: "build-agent-uk", Description: "Build agent in the office", Remote: "192.0.2.77", Port: 51820, Networks: []string{"192.168.77.2/32"}},
			{Name: "laptop-ops-1", Description: "Roaming laptop", Networks: []string{"192.168.77.10/32"}},
		}},
}

var pccSpecs = []pccSpec{
	{"fra-backbone", "Frankfurt production backbone"},
	{"fra-mgmt", "Management access into production"},
	{"txl-backbone", "Berlin backbone incl. backup network"},
	{"vit-dr", "DR replication network"},
	{"lhr-link", "UK edge to staging"},
	{"fra-legacy-link", "Old interconnect, no longer used"},
}

var cubeTemplates = []struct {
	Name             string
	Cores, RAM, Disk int
}{
	{"CUBES XS", 1, 1024, 30},
	{"CUBES S", 1, 2048, 50},
	{"CUBES M", 2, 4096, 80},
	{"CUBES L", 4, 8192, 160},
	{"CUBES XL", 6, 16384, 320},
	{"CUBES XXL", 8, 32768, 640},
}

var cpuFamilies = map[string]string{
	"de/fra":   "INTEL_ICELAKE",
	"de/fra/2": "INTEL_ICELAKE",
	"de/txl":   "INTEL_SKYLAKE",
	"es/vit":   "AMD_EPYC",
	"gb/lhr":   "INTEL_SKYLAKE",
}

var dcSpecs = []dcSpec{
	// --- de/fra -------------------------------------------------------------
	{
		Name: "fra-prod-core", Location: "de/fra", Env: "prod",
		Description: "Production core: edge firewalls, shared app tier",
		LANs: []lanSpec{
			{"inet", "internet", true, ""},
			{"transit", "transit-fra", false, "fra-backbone"},
			{"app", "app", false, ""},
			{"db", "db", false, ""},
			{"mgmt", "mgmt", false, "fra-mgmt"},
		},
		Servers: []serverSpec{
			{Name: "fra-core-fw-%02d", Count: 2, Type: "ENTERPRISE", Cores: 4, RAM: 8192, LANs: []string{"inet", "transit", "app", "db", "mgmt"}, Role: "firewall", PublicVIP: true},
			{Name: "fra-core-vpn-%02d", Count: 1, Type: "ENTERPRISE", Cores: 4, RAM: 8192, LANs: []string{"inet", "transit"}, Role: "vpn", Image: "cisco-c8000v-17.12.03a"},
			{Name: "fra-core-web-%02d", Count: 4, Type: "CUBE", Template: "CUBES M", LANs: []string{"app"}, Role: "web"},
			{Name: "fra-core-api-%02d", Count: 3, Type: "VCPU", Cores: 4, RAM: 8192, LANs: []string{"app", "db"}, Role: "api", DataGB: 50},
			{Name: "fra-core-db-%02d", Count: 2, Type: "ENTERPRISE", Cores: 8, RAM: 32768, LANs: []string{"db"}, Role: "database", DataGB: 500},
		},
		NAT: &natSpec{"fra-core-natgw", []string{"app", "db"}},
		NLB: &lbSpec{Name: "fra-core-nlb", Listener: "inet", Target: "app", Port: 443, TargetRole: "web"},
	},
	{
		Name: "fra-prod-shop", Location: "de/fra", Env: "prod",
		Description: "Online shop frontend",
		LANs: []lanSpec{
			{"inet", "public", true, ""},
			{"transit", "transit-fra", false, "fra-backbone"},
			{"web", "web", false, ""},
		},
		Servers: []serverSpec{
			{Name: "shop-web-%02d", Count: 6, Type: "CUBE", Template: "CUBES L", LANs: []string{"web", "transit"}, Role: "web"},
			{Name: "shop-cache-%02d", Count: 2, Type: "VCPU", Cores: 2, RAM: 16384, LANs: []string{"web"}, Role: "cache"},
		},
		NAT: &natSpec{"shop-natgw", []string{"web"}},
		ALB: &lbSpec{Name: "shop-alb", Listener: "inet", Target: "web", Port: 443, TargetRole: "web"},
	},
	{
		Name: "fra-prod-data", Location: "de/fra", Env: "prod",
		Description: "Data platform: Kubernetes and managed databases",
		LANs: []lanSpec{
			{"transit", "transit-fra", false, "fra-backbone"},
			{"db", "db", false, ""},
			{"k8s", "k8s-nodes", false, ""},
		},
		Servers: []serverSpec{
			{Name: "data-etl-%02d", Count: 2, Type: "ENTERPRISE", Cores: 16, RAM: 65536, LANs: []string{"transit", "db"}, Role: "etl", DataGB: 1000},
		},
		NodePools: []nodePoolSpec{
			{Cluster: "k8s-prod-fra", Name: "np-general", Nodes: 6, Cores: 4, RAM: 16384, LANs: []string{"k8s", "db"}},
			{Cluster: "k8s-prod-fra", Name: "np-memory", Nodes: 3, Cores: 8, RAM: 65536, LANs: []string{"k8s", "db"}},
		},
		Postgres: []pgSpec{
			{Name: "pg-orders-prod", LAN: "db", Version: "15", Instances: 3},
			{Name: "pg-analytics", LAN: "db", Version: "16", Instances: 2},
		},
	},
	{
		Name: "fra-mgmt", Location: "de/fra", Env: "mgmt",
		Description: "Management: bastion, monitoring, CI",
		LANs: []lanSpec{
			{"inet", "public", true, ""},
			{"mgmt", "mgmt", false, "fra-mgmt"},
			{"tools", "tools", false, ""},
		},
		Servers: []serverSpec{
			{Name: "bastion-%02d", Count: 1, Type: "VCPU", Cores: 2, RAM: 4096, LANs: []string{"inet", "mgmt"}, Role: "bastion"},
			{Name: "monitoring-%02d", Count: 2, Type: "VCPU", Cores: 4, RAM: 16384, LANs: []string{"mgmt", "tools"}, Role: "monitoring", DataGB: 200},
			{Name: "gitlab-runner-%02d", Count: 3, Type: "CUBE", Template: "CUBES XL", LANs: []string{"tools"}, Role: "ci"},
		},
		NAT: &natSpec{"mgmt-natgw", []string{"tools"}},
	},
	{
		Name: "fra-lab", Location: "de/fra", Env: "lab",
		Description: "ML experiments (isolated)",
		LANs: []lanSpec{
			{"inet", "public", true, ""},
			{"lab", "lab", false, ""},
		},
		Servers: []serverSpec{
			{Name: "gpu-trainer-%02d", Count: 1, Type: "GPU", Cores: 16, RAM: 131072, LANs: []string{"lab"}, Role: "ml", DataGB: 2000},
			{Name: "lab-jump-%02d", Count: 1, Type: "CUBE", Template: "CUBES S", LANs: []string{"inet", "lab"}, Role: "bastion"},
			{Name: "lab-old-notebook-%02d", Count: 1, Type: "VCPU", Cores: 2, RAM: 8192, LANs: []string{"lab"}, Role: "ml", Stopped: true},
		},
		OrphanVolumes: []string{"old-dataset"},
	},
	// --- de/txl -------------------------------------------------------------
	{
		Name: "txl-prod-core", Location: "de/txl", Env: "prod",
		Description: "Berlin production core",
		LANs: []lanSpec{
			{"inet", "internet", true, ""},
			{"transit", "transit-txl", false, "txl-backbone"},
			{"app", "app", false, ""},
		},
		Servers: []serverSpec{
			{Name: "txl-core-fw-%02d", Count: 2, Type: "ENTERPRISE", Cores: 4, RAM: 8192, LANs: []string{"inet", "transit", "app"}, Role: "firewall", PublicVIP: true},
			{Name: "txl-core-vpn-%02d", Count: 1, Type: "ENTERPRISE", Cores: 4, RAM: 8192, LANs: []string{"inet", "transit"}, Role: "vpn", Image: "cisco-c8000v-17.12.03a"},
			{Name: "txl-core-app-%02d", Count: 4, Type: "VCPU", Cores: 4, RAM: 8192, LANs: []string{"app"}, Role: "app"},
		},
		NLB: &lbSpec{Name: "txl-core-nlb", Listener: "inet", Target: "app", Port: 443, TargetRole: "app"},
	},
	{
		Name: "txl-prod-erp", Location: "de/txl", Env: "prod",
		Description: "ERP system",
		LANs: []lanSpec{
			{"transit", "transit-txl", false, "txl-backbone"},
			{"erp", "erp", false, ""},
			{"db", "db", false, ""},
		},
		Servers: []serverSpec{
			{Name: "erp-app-%02d", Count: 3, Type: "ENTERPRISE", Cores: 8, RAM: 32768, LANs: []string{"transit", "erp"}, Role: "erp-app", Windows: true, DataGB: 200},
			{Name: "erp-db-%02d", Count: 2, Type: "ENTERPRISE", Cores: 16, RAM: 131072, LANs: []string{"erp", "db"}, Role: "database", Windows: true, DataGB: 2000},
		},
	},
	{
		Name: "txl-backup", Location: "de/txl", Env: "prod",
		Description: "Backup targets",
		LANs: []lanSpec{
			{"backup", "backup", false, "txl-backbone"},
		},
		Servers: []serverSpec{
			{Name: "backup-store-%02d", Count: 2, Type: "ENTERPRISE", Cores: 4, RAM: 16384, LANs: []string{"backup"}, Role: "backup", DataGB: 4000, DataType: "HDD"},
		},
	},
	{
		Name: "txl-dev", Location: "de/txl", Env: "dev",
		Description: "Development sandbox",
		LANs: []lanSpec{
			{"inet", "public", true, ""},
			{"dev", "dev", false, ""},
		},
		Servers: []serverSpec{
			{Name: "dev-vm-%02d", Count: 5, Type: "CUBE", Template: "CUBES S", LANs: []string{"dev"}, Role: "dev"},
			{Name: "dev-jump-%02d", Count: 1, Type: "CUBE", Template: "CUBES XS", LANs: []string{"inet", "dev"}, Role: "bastion"},
			{Name: "dev-legacy-%02d", Count: 2, Type: "VCPU", Cores: 2, RAM: 4096, LANs: []string{"dev"}, Role: "dev", Stopped: true},
		},
		NAT:           &natSpec{"dev-natgw", []string{"dev"}},
		NodePools:     []nodePoolSpec{{Cluster: "k8s-dev-txl", Name: "np-dev", Nodes: 3, Cores: 2, RAM: 8192, LANs: []string{"dev"}}},
		OrphanVolumes: []string{"tmp-restore"},
	},
	// --- de/fra/2 -----------------------------------------------------------
	{
		Name: "fra2-dr", Location: "de/fra/2", Env: "dr",
		Description: "Cold standby for fra-prod-core",
		LANs: []lanSpec{
			{"inet", "internet", true, ""},
			{"app", "app", false, ""},
		},
		Servers: []serverSpec{
			{Name: "dr-fw-%02d", Count: 1, Type: "ENTERPRISE", Cores: 4, RAM: 8192, LANs: []string{"inet", "app"}, Role: "firewall"},
			{Name: "dr-app-%02d", Count: 2, Type: "VCPU", Cores: 4, RAM: 8192, LANs: []string{"app"}, Role: "app", Stopped: true},
		},
	},
	// --- es/vit -------------------------------------------------------------
	{
		Name: "vit-dr-core", Location: "es/vit", Env: "dr",
		Description: "Logroño DR site: edge and app tier",
		LANs: []lanSpec{
			{"inet", "internet", true, ""},
			{"repl", "replication", false, "vit-dr"},
			{"app", "app", false, ""},
		},
		Servers: []serverSpec{
			{Name: "vit-fw-%02d", Count: 1, Type: "ENTERPRISE", Cores: 4, RAM: 8192, LANs: []string{"inet", "repl", "app"}, Role: "firewall"},
			{Name: "vit-app-%02d", Count: 2, Type: "VCPU", Cores: 4, RAM: 8192, LANs: []string{"app"}, Role: "app"},
		},
	},
	{
		Name: "vit-dr-data", Location: "es/vit", Env: "dr",
		Description: "Logroño DR site: database replicas",
		LANs: []lanSpec{
			{"repl", "replication", false, "vit-dr"},
		},
		Servers: []serverSpec{
			{Name: "vit-db-%02d", Count: 2, Type: "ENTERPRISE", Cores: 8, RAM: 32768, LANs: []string{"repl"}, Role: "database", DataGB: 1000},
		},
	},
	// --- gb/lhr -------------------------------------------------------------
	{
		Name: "lhr-prod-edge", Location: "gb/lhr", Env: "prod",
		Description: "UK edge proxies",
		LANs: []lanSpec{
			{"inet", "internet", true, ""},
			{"link", "lhr-link", false, "lhr-link"},
		},
		Servers: []serverSpec{
			{Name: "lhr-proxy-%02d", Count: 3, Type: "CUBE", Template: "CUBES M", LANs: []string{"inet", "link"}, Role: "proxy"},
			// Deliberately unremarkable name: detection must rely on image and firewall rules.
			{Name: "lhr-edge-gw-%02d", Count: 1, Type: "ENTERPRISE", Cores: 4, RAM: 8192, LANs: []string{"inet", "link"}, Role: "vpn", Image: "asav9-20-2-15"},
		},
		NLB: &lbSpec{Name: "lhr-nlb", Listener: "inet", Target: "link", Port: 443, TargetRole: "proxy"},
		SecurityGroups: []sgSpec{
			{Name: "sg-edge-web", Description: "HTTPS from anywhere", Rules: "proxy", Roles: []string{"proxy"}},
			{Name: "sg-edge-ipsec", Description: "IPsec from partner sites", Rules: "vpn", Roles: []string{"vpn"}},
		},
	},
	{
		Name: "lhr-staging", Location: "gb/lhr", Env: "staging",
		Description: "UK staging",
		LANs: []lanSpec{
			{"link", "lhr-link", false, "lhr-link"},
			{"app", "app", false, ""},
		},
		Servers: []serverSpec{
			{Name: "lhr-stg-app-%02d", Count: 3, Type: "VCPU", Cores: 2, RAM: 4096, LANs: []string{"link", "app"}, Role: "app"},
		},
	},
}
