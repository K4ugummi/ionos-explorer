import type { NodeKind } from '../model/types'

/**
 * A diagram is derived from the model for one view (the whole contract or a
 * single datacenter). It is pure data: sizes are fixed per node type so the
 * layout can run before anything is rendered.
 */
export type DiagramNodeType =
  | 'group' // location or server group; sized by its children
  | 'dc' // datacenter card in the contract view
  | 'hub' // Cross Connect with other than two peer datacenters
  | 'peer' // another datacenter, reached through a Cross Connect
  | 'lan'
  | 'resource' // server, load balancer, NAT gateway, managed service
  | 'member' // compact resource inside a group
  | 'internet'
  | 'external' // outside the contract: VPN remote host or a site the user added

export interface NodeData {
  title: string
  subtitle?: string
  kind?: NodeKind
  pills?: string[]
  /** Not running / not available. */
  inactive?: boolean
  placeholder?: boolean
  /** Public LAN, internet-facing. */
  public?: boolean
  /** Short marker, e.g. the product of a detected network appliance. */
  tag?: string
  tagLevel?: 'high' | 'medium' | 'low'
}

export interface DiagramNode {
  id: string
  type: DiagramNodeType
  parent?: string
  /** Model node this box stands for. */
  ref?: string
  /** Fixed size; groups are sized by the layout. */
  width?: number
  height?: number
  /** ELK options for the children of a group. */
  layout?: Record<string, string>
  data: NodeData
}

export type DiagramEdgeKind = 'cross-connect' | 'lan' | 'internet' | 'peer' | 'target' | 'tunnel' | 'manual'

export interface DiagramEdge {
  id: string
  source: string
  target: string
  kind: DiagramEdgeKind
  label?: string
  /** Model nodes this edge stands for (a Cross Connect drawn as a line). */
  ref?: string
  /** Only drawn while one of its ends is selected. */
  onDemand?: boolean
}

export interface Diagram {
  /** Stable key for caching layouts. */
  key: string
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  /** Model node id → id of the diagram node or edge that shows it. */
  anchors: Map<string, string>
  rootLayout: Record<string, string>
}

export interface Point {
  x: number
  y: number
}

export interface PlacedNode extends DiagramNode {
  /** Relative to the parent, like React Flow sub flows. */
  x: number
  y: number
  width: number
  height: number
}

export interface PlacedEdge extends DiagramEdge {
  /** Absolute route from the layout; absent for edges drawn freely. */
  points?: Point[]
}

export interface Layout {
  key: string
  nodes: PlacedNode[]
  edges: PlacedEdge[]
}
