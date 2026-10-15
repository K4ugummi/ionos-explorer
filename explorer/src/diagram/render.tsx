import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, Position, type EdgeProps, type NodeProps } from '@xyflow/react'
import { useContext } from 'react'
import { KindBadge } from '../ui/common'
import { DiagramActions, type FlowEdge, type FlowNode, type FlowNodeData } from './flow'
import { midpoint, roundedPath } from './geometry'
import type { Point } from './types'

/**
 * Edges are routed by the layout; handles only anchor the unrouted ones:
 * down from the bottom into the top, or, to a box above, up from the top
 * into its bottom (`toFlow` picks them).
 */
function Handles() {
  return (
    <>
      <Handle type="target" id="top" position={Position.Top} isConnectable={false} className="dg-handle" />
      <Handle type="source" id="bottom" position={Position.Bottom} isConnectable={false} className="dg-handle" />
      <Handle type="source" id="top-out" position={Position.Top} isConnectable={false} className="dg-handle" />
      <Handle type="target" id="bottom-in" position={Position.Bottom} isConnectable={false} className="dg-handle" />
    </>
  )
}

function classes(d: FlowNodeData, selected: boolean, extra = '') {
  return [
    'dg-node',
    `dg-${d.node.type}`,
    extra,
    selected && 'selected',
    d.related && 'related',
    d.dim && 'dim',
    d.matches > 0 && 'match',
    d.node.data.inactive && 'inactive',
    d.node.data.placeholder && 'placeholder',
    d.node.data.public && 'public',
    d.node.data.change && `chg-${d.node.data.change}`,
  ]
    .filter(Boolean)
    .join(' ')
}

export function GroupNode({ data }: NodeProps<FlowNode>) {
  const { setOpen } = useContext(DiagramActions)
  const { title, subtitle, kind, lans, only, collapsible } = data.node.data
  const extra = kind ? `dg-group-servers${lans ? ' dg-group-router' : ''}` : 'dg-group-plain'
  return (
    <div className={classes(data, false, extra)}>
      {/* Server groups carry their members' LAN edges; without handles React Flow drops them. */}
      <Handles />
      <div className="dg-group-label">
        <span className="t">{title}</span>
        {subtitle && <span className="s">{subtitle}</span>}
        {lans && <Lans count={lans} />}
        {only && <OnlyHere only={only} />}
        {collapsible && (
          <button
            type="button"
            className="dg-collapse nodrag"
            title="Show only a few members again"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(data.node.id, false)
            }}
          >
            Collapse
          </button>
        )}
      </div>
    </div>
  )
}

/** LANs nothing but this router uses: folded into it; a click shows them as boxes, another folds them again. */
function OnlyHere({ only }: { only: { lans: string[]; key: string; open?: boolean } }) {
  const { setOpen } = useContext(DiagramActions)
  const n = only.lans.length
  return (
    <button
      type="button"
      className="dg-only nodrag"
      aria-expanded={!!only.open}
      title={`Only on this router: ${only.lans.join(', ')}\n${only.open ? 'Click to fold its LANs into it again' : 'Click to show them as boxes'}`}
      onClick={(e) => {
        e.stopPropagation()
        setOpen(only.key, !only.open)
      }}
    >
      {/* Open, its LANs that lead only to a Cross Connect are boxes again too, so no count. */}
      {only.open ? 'fold LANs again' : `+${n} ${n === 1 ? 'LAN' : 'LANs'} only here`}
    </button>
  )
}

/** The members a collapsed group does not show; a click shows them all. */
export function MoreNode({ data }: NodeProps<FlowNode>) {
  const { setOpen } = useContext(DiagramActions)
  const d = data.node.data
  const hits = data.matches
  return (
    <div className={classes(data, false)}>
      {/* Load balancer targets in the group end here. */}
      <Handles />
      <button
        type="button"
        className="dg-more-btn nodrag"
        title={[d.subtitle, hits > 0 && `${hits === 1 ? '1 search hit is' : `${hits} search hits are`} among them`]
          .filter(Boolean)
          .join('\n')}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(data.node.parent!, true)
        }}
      >
        <span className="t">{d.title}</span>
        {hits > 0 && <span className="dg-hits">{hits === 1 ? '1 match' : `${hits} matches`}</span>}
      </button>
    </div>
  )
}

/** A router's LAN count; the lines to them are drawn while it is selected. */
function Lans({ count }: { count: number }) {
  return (
    <span className="dg-lans" title="Lines to all its LANs are drawn while it is selected">
      {count} LANs
    </span>
  )
}

export function DcNode({ data, selected }: NodeProps<FlowNode>) {
  const { openDc } = useContext(DiagramActions)
  const d = data.node.data
  return (
    <div className={classes(data, selected)} title={d.title}>
      <Handles />
      <div className="dg-head">
        <KindBadge kind="datacenter" />
        <span className="t">{d.title}</span>
        {d.public && (
          <span className="dg-net" title="Has a public LAN">
            internet
          </span>
        )}
      </div>
      {d.subtitle && <div className="s">{d.subtitle}</div>}
      <div className="dg-pills">
        {d.changes && (
          <span className="pill chg" title="Added, changed, removed since the older snapshot">
            {d.changes}
          </span>
        )}
        {d.pills?.map((p) => (
          <span className="pill" key={p}>
            {p}
          </span>
        ))}
      </div>
      <div className="dg-foot">
        {data.matches > 0 && <span className="dg-hits">{data.matches === 1 ? '1 match' : `${data.matches} matches`}</span>}
        <button
          className="btn small nodrag"
          onClick={(e) => {
            e.stopPropagation()
            openDc(data.node.ref!)
          }}
        >
          Open diagram ›
        </button>
      </div>
    </div>
  )
}

export function PeerNode({ data, selected }: NodeProps<FlowNode>) {
  const d = data.node.data
  return (
    <div className={classes(data, selected)} title={`Open the diagram of ${d.title}`}>
      <Handles />
      <div className="dg-head">
        <KindBadge kind="datacenter" />
        <span className="t">{d.title}</span>
        <span className="dg-go" aria-hidden>
          ↗
        </span>
      </div>
      <div className="s">{d.subtitle}</div>
    </div>
  )
}

export function BoxNode({ data, selected }: NodeProps<FlowNode>) {
  const d = data.node.data
  return (
    <div
      className={classes(data, selected)}
      title={[
        d.title,
        d.subtitle,
        d.tag && `Network appliance: ${d.tag}`,
        d.lans && `In ${d.lans} LANs: select it to draw all its lines`,
        d.only && `Only on this router: ${d.only.lans.join(', ')}`,
        d.via && `Also reached through ${d.via}: select this LAN to draw the line`,
      ]
        .filter(Boolean)
        .join('\n')}
    >
      <Handles />
      <div className="dg-head">
        {d.kind && <KindBadge kind={d.kind} />}
        <span className="t">{d.title}</span>
        {d.tag && <span className={`dg-tag ${d.tagLevel ?? ''}`}>{d.tag}</span>}
        {d.inactive && <span className="dg-off" title="Not running" />}
      </div>
      {d.via && <span className="dg-via">via {d.via}</span>}
      {d.subtitle && <div className="s">{d.subtitle}</div>}
      {d.lans && (
        <div className="s">
          <Lans count={d.lans} />
          {d.only && (
            <>
              {' · '}
              <OnlyHere only={d.only} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function ExternalNode({ data, selected }: NodeProps<FlowNode>) {
  const d = data.node.data
  return (
    <div className={classes(data, selected)} title={[d.title, d.subtitle].filter(Boolean).join('\n')}>
      <Handles />
      <div className="dg-head">
        <KindBadge kind="external" />
        <span className="t">{d.title}</span>
      </div>
      {d.subtitle && <div className="s">{d.subtitle}</div>}
    </div>
  )
}

export function InternetNode({ data }: NodeProps<FlowNode>) {
  return (
    <div className={classes(data, false)}>
      <Handles />
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
      <span className="t">Internet</span>
    </div>
  )
}

// --- edges ---------------------------------------------------------------------

export function RoutedEdge(props: EdgeProps<FlowEdge>) {
  const { id, data, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style } = props
  let path: string
  let label: Point
  if (data?.points && data.points.length > 1) {
    path = roundedPath(data.points)
    label = midpoint(data.points)
  } else {
    const [p, x, y] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
    path = p
    label = { x, y }
  }
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={14} />
      {data?.showLabel && data.label && (
        <EdgeLabelRenderer>
          <div
            className={`dg-edge-label ${data.kind}`}
            style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
