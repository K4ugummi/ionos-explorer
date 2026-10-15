import type { Coverage, Manifest } from '../snapshot/types'

export type NodeKind =
  | 'contract'
  | 'datacenter'
  | 'lan'
  | 'server'
  | 'nic'
  | 'volume'
  | 'natgateway'
  | 'securitygroup'
  | 'nlb'
  | 'alb'
  | 'targetgroup'
  | 'pcc'
  | 'ipblock'
  | 'image'
  | 'k8s'
  | 'nodepool'
  | 'postgres'
  | 'vpngateway'
  | 'vpntunnel'
  | 'external' // outside the contract: a VPN remote host, or a site the user added
  | 'other'

export interface Fact {
  label: string
  value: string
}

export interface GraphNode {
  /** IONOS UUID where available; LANs use `<dcId>:lan:<lanId>` because LAN ids are per datacenter. */
  id: string
  kind: NodeKind
  /** Kind-specific variant: server type (CUBE, ENTERPRISE, …), `public`/`private` for LANs, endpoint for `other`. */
  subtype?: string
  name: string
  parentId?: string
  dcId?: string
  location?: string
  state?: string
  ips: string[]
  macs: string[]
  labels: Record<string, string>
  facts: Fact[]
  /** Extra free-text terms for search (descriptions, image names, DNS names, …). */
  terms: string[]
  /** Lower-cased haystack built from all of the above; used by search. */
  searchText: string
  /** True for nodes inferred from references when the resource itself is not visible. */
  placeholder?: boolean
  /** NICs: whether IONOS hands out the IP by DHCP. When false the VM sets its own, which may differ. */
  dhcp?: boolean
  /** NICs and their servers with an IP correction: the IPs IONOS reports. `ips` then holds the corrected ones. */
  ionosIps?: string[]
  /** When comparing with an older snapshot: new or changed since then (see diff/diff.ts). */
  change?: 'added' | 'changed'
  /** Datacenters, when comparing: how many resources in them were added, removed, changed. */
  changeCounts?: { added: number; removed: number; changed: number }
  /** Servers that look like network appliances, and why (see appliances.ts). */
  appliance?: Appliance
  raw: unknown
}

export interface Appliance {
  /** A product when the image names one, otherwise a role. */
  title: string
  confidence: 'high' | 'medium' | 'low'
  reasons: string[]
}

export type EdgeKind =
  | 'member' // server/nodepool → LAN (via a NIC or LAN attachment)
  | 'attached' // NIC → LAN, server → volume
  | 'cross-connect' // LAN → Cross Connect
  | 'listener' // load balancer → listener LAN
  | 'target-lan' // load balancer → target LAN
  | 'target' // load balancer / target group → server
  | 'forwards-to' // ALB → target group
  | 'gateway' // NAT gateway → LAN
  | 'uses-image' // volume → image
  | 'consumer' // IP block → resource using one of its IPs
  | 'connection' // managed service or VPN gateway → LAN
  | 'tunnel' // VPN tunnel / WireGuard peer → the resource or external host at its far end
  | 'manual' // a link the user added (annotations, not from the API)
  | 'secured-by' // server or NIC → Security Group

export interface GraphEdge {
  kind: EdgeKind
  from: string
  to: string
  label?: string
  /** Manual links: id of the annotation the edge comes from. */
  ref?: string
}

export interface CoverageIssue {
  api: string
  endpoint: string
  status: Coverage['status']
  count: number
  error?: string
}

export interface Model {
  manifest: Manifest
  rootId: string
  nodes: Map<string, GraphNode>
  edges: GraphEdge[]
  children: Map<string, string[]>
  edgesByNode: Map<string, GraphEdge[]>
  /** Non-ok coverage, grouped by endpoint template. */
  coverageIssues: CoverageIssue[]
  /** Problems found while building the model (dangling references, unreadable files). */
  warnings: string[]
}
