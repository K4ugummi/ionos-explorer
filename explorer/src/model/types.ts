import type { Coverage, Manifest } from '../snapshot/types'

export type NodeKind =
  | 'contract'
  | 'datacenter'
  | 'lan'
  | 'server'
  | 'nic'
  | 'volume'
  | 'natgateway'
  | 'nlb'
  | 'alb'
  | 'targetgroup'
  | 'pcc'
  | 'ipblock'
  | 'image'
  | 'k8s'
  | 'nodepool'
  | 'postgres'
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
  raw: unknown
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
  | 'connection' // managed service → LAN

export interface GraphEdge {
  kind: EdgeKind
  from: string
  to: string
  label?: string
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
