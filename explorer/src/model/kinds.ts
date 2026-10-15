import type { NodeKind } from './types'

export interface KindInfo {
  label: string
  plural: string
  /** Short code shown in the kind badge. */
  badge: string
  /** Sort order in result lists: infrastructure containers first. */
  order: number
  /** Colour family of the badge. */
  family: 'compute' | 'network' | 'service' | 'storage' | 'meta'
}

export const KINDS: Record<NodeKind, KindInfo> = {
  contract: { label: 'Contract', plural: 'Contracts', badge: 'CT', order: 0, family: 'meta' },
  datacenter: { label: 'Datacenter', plural: 'Datacenters', badge: 'DC', order: 1, family: 'meta' },
  pcc: { label: 'Cross Connect', plural: 'Cross Connects', badge: 'CC', order: 2, family: 'network' },
  server: { label: 'Server', plural: 'Servers', badge: 'VM', order: 3, family: 'compute' },
  lan: { label: 'LAN', plural: 'LANs', badge: 'LAN', order: 4, family: 'network' },
  nlb: { label: 'Network Load Balancer', plural: 'Network Load Balancers', badge: 'NLB', order: 5, family: 'network' },
  alb: { label: 'Application Load Balancer', plural: 'Application Load Balancers', badge: 'ALB', order: 6, family: 'network' },
  natgateway: { label: 'NAT Gateway', plural: 'NAT Gateways', badge: 'NAT', order: 7, family: 'network' },
  securitygroup: { label: 'Security Group', plural: 'Security Groups', badge: 'SG', order: 7.5, family: 'network' },
  k8s: { label: 'Kubernetes Cluster', plural: 'Kubernetes Clusters', badge: 'K8S', order: 8, family: 'service' },
  nodepool: { label: 'Node Pool', plural: 'Node Pools', badge: 'NP', order: 9, family: 'service' },
  postgres: { label: 'PostgreSQL Cluster', plural: 'PostgreSQL Clusters', badge: 'PG', order: 10, family: 'service' },
  vpngateway: { label: 'VPN Gateway', plural: 'VPN Gateways', badge: 'VPN', order: 11, family: 'network' },
  vpntunnel: { label: 'VPN Tunnel', plural: 'VPN Tunnels', badge: 'TUN', order: 11.5, family: 'network' },
  targetgroup: { label: 'Target Group', plural: 'Target Groups', badge: 'TG', order: 11.8, family: 'network' },
  ipblock: { label: 'IP Block', plural: 'IP Blocks', badge: 'IP', order: 12, family: 'network' },
  volume: { label: 'Volume', plural: 'Volumes', badge: 'VOL', order: 13, family: 'storage' },
  nic: { label: 'NIC', plural: 'NICs', badge: 'NIC', order: 14, family: 'compute' },
  image: { label: 'Image', plural: 'Images', badge: 'IMG', order: 15, family: 'storage' },
  external: { label: 'External endpoint', plural: 'External endpoints', badge: 'EXT', order: 16, family: 'meta' },
  other: { label: 'Other', plural: 'Other', badge: '…', order: 99, family: 'meta' },
}

/** DCD naming for Cloud API server types. */
export const SERVER_TYPES: Record<string, string> = {
  ENTERPRISE: 'Dedicated Core',
  CUBE: 'Cube',
  VCPU: 'vCPU',
  GPU: 'GPU',
}

/** Words users type for a server type, mapped to the API value. */
export const SERVER_TYPE_ALIASES: Record<string, string> = {
  enterprise: 'ENTERPRISE',
  dedicated: 'ENTERPRISE',
  'dedicated-core': 'ENTERPRISE',
  dedicatedcore: 'ENTERPRISE',
  cube: 'CUBE',
  cubes: 'CUBE',
  vcpu: 'VCPU',
  gpu: 'GPU',
}

/** Words users type for a kind. */
export const KIND_ALIASES: Record<string, NodeKind> = {
  contract: 'contract',
  dc: 'datacenter',
  vdc: 'datacenter',
  datacenter: 'datacenter',
  lan: 'lan',
  network: 'lan',
  server: 'server',
  vm: 'server',
  nic: 'nic',
  volume: 'volume',
  disk: 'volume',
  nat: 'natgateway',
  natgateway: 'natgateway',
  sg: 'securitygroup',
  nsg: 'securitygroup',
  securitygroup: 'securitygroup',
  nlb: 'nlb',
  alb: 'alb',
  lb: 'nlb',
  targetgroup: 'targetgroup',
  tg: 'targetgroup',
  pcc: 'pcc',
  cc: 'pcc',
  crossconnect: 'pcc',
  'cross-connect': 'pcc',
  ipblock: 'ipblock',
  image: 'image',
  k8s: 'k8s',
  kubernetes: 'k8s',
  nodepool: 'nodepool',
  postgres: 'postgres',
  postgresql: 'postgres',
  pg: 'postgres',
  vpn: 'vpngateway',
  vpngateway: 'vpngateway',
  tunnel: 'vpntunnel',
  vpntunnel: 'vpntunnel',
  peer: 'vpntunnel',
  external: 'external',
  ext: 'external',
  site: 'external',
  other: 'other',
}

export function subtypeLabel(kind: NodeKind, subtype?: string): string | undefined {
  if (!subtype) return undefined
  if (kind === 'server') return SERVER_TYPES[subtype] ?? subtype
  return subtype
}
