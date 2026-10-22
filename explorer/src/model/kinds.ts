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
  mariadb: { label: 'MariaDB Cluster', plural: 'MariaDB Clusters', badge: 'MDB', order: 10.1, family: 'service' },
  mongodb: { label: 'MongoDB Cluster', plural: 'MongoDB Clusters', badge: 'MGO', order: 10.2, family: 'service' },
  inmemorydb: { label: 'In-Memory DB', plural: 'In-Memory DBs', badge: 'IMD', order: 10.3, family: 'service' },
  kafka: { label: 'Kafka Cluster', plural: 'Kafka Clusters', badge: 'KFK', order: 10.4, family: 'service' },
  nfs: { label: 'Network File Storage', plural: 'Network File Storages', badge: 'NFS', order: 10.5, family: 'storage' },
  nfsshare: { label: 'NFS Share', plural: 'NFS Shares', badge: 'SHR', order: 10.6, family: 'storage' },
  autoscaling: { label: 'Auto Scaling Group', plural: 'Auto Scaling Groups', badge: 'ASG', order: 10.7, family: 'compute' },
  vpngateway: { label: 'VPN Gateway', plural: 'VPN Gateways', badge: 'VPN', order: 11, family: 'network' },
  vpntunnel: { label: 'VPN Tunnel', plural: 'VPN Tunnels', badge: 'TUN', order: 11.5, family: 'network' },
  targetgroup: { label: 'Target Group', plural: 'Target Groups', badge: 'TG', order: 11.8, family: 'network' },
  ipblock: { label: 'IP Block', plural: 'IP Blocks', badge: 'IP', order: 12, family: 'network' },
  dnszone: { label: 'DNS Zone', plural: 'DNS Zones', badge: 'DNS', order: 12.2, family: 'network' },
  dnsrecord: { label: 'DNS Record', plural: 'DNS Records', badge: 'REC', order: 12.3, family: 'network' },
  cdn: { label: 'CDN Distribution', plural: 'CDN Distributions', badge: 'CDN', order: 12.4, family: 'network' },
  certificate: { label: 'Certificate', plural: 'Certificates', badge: 'CRT', order: 12.6, family: 'meta' },
  volume: { label: 'Volume', plural: 'Volumes', badge: 'VOL', order: 13, family: 'storage' },
  nic: { label: 'NIC', plural: 'NICs', badge: 'NIC', order: 14, family: 'compute' },
  image: { label: 'Image', plural: 'Images', badge: 'IMG', order: 15, family: 'storage' },
  snapshot: { label: 'Volume Snapshot', plural: 'Volume Snapshots', badge: 'SNP', order: 15.2, family: 'storage' },
  backupunit: { label: 'Backup Unit', plural: 'Backup Units', badge: 'BU', order: 15.3, family: 'storage' },
  registry: { label: 'Container Registry', plural: 'Container Registries', badge: 'CR', order: 15.4, family: 'storage' },
  pipeline: { label: 'Pipeline', plural: 'Pipelines', badge: 'PL', order: 15.6, family: 'meta' },
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
  mariadb: 'mariadb',
  maria: 'mariadb',
  mongodb: 'mongodb',
  mongo: 'mongodb',
  inmemorydb: 'inmemorydb',
  redis: 'inmemorydb',
  imdb: 'inmemorydb',
  kafka: 'kafka',
  nfs: 'nfs',
  share: 'nfsshare',
  nfsshare: 'nfsshare',
  autoscaling: 'autoscaling',
  asg: 'autoscaling',
  dns: 'dnsrecord',
  record: 'dnsrecord',
  dnsrecord: 'dnsrecord',
  zone: 'dnszone',
  dnszone: 'dnszone',
  cdn: 'cdn',
  cert: 'certificate',
  certificate: 'certificate',
  registry: 'registry',
  cr: 'registry',
  pipeline: 'pipeline',
  logging: 'pipeline',
  monitoring: 'pipeline',
  snapshot: 'snapshot',
  backup: 'backupunit',
  backupunit: 'backupunit',
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

/**
 * Managed services attached to a LAN (a `connection` edge): drawn in the
 * datacenter of their LAN, on the network graph for paths. The name is
 * the product, and the fact holding its version.
 */
export const LAN_SERVICES: ReadonlyMap<NodeKind, string> = new Map<NodeKind, string>([
  ['postgres', 'PostgreSQL'],
  ['mariadb', 'MariaDB'],
  ['mongodb', 'MongoDB'],
  ['inmemorydb', 'In-Memory DB'],
  ['kafka', 'Kafka'],
  ['nfs', 'NFS'],
])

export function subtypeLabel(kind: NodeKind, subtype?: string): string | undefined {
  if (!subtype) return undefined
  if (kind === 'server') return SERVER_TYPES[subtype] ?? subtype
  return subtype
}
