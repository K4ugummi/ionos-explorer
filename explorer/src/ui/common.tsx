import { useState } from 'react'
import { KINDS } from '../model/kinds'
import type { GraphNode, Model, NodeKind } from '../model/types'
import { nodeContext } from './context'

export function KindBadge({ kind }: { kind: NodeKind }) {
  const k = KINDS[kind]
  return (
    <span className="kind" data-family={k.family} title={k.label}>
      {k.badge}
    </span>
  )
}

export interface ListItem {
  node: GraphNode
  label?: string
}

/** Clickable list of nodes; long lists collapse behind a "show all" button. */
export function NodeList({
  model,
  items,
  onSelect,
  contextDc,
  limit = 25,
}: {
  model: Model
  items: ListItem[]
  onSelect: (id: string) => void
  contextDc?: string
  limit?: number
}) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, limit)
  return (
    <>
      <ul className="rel-list">
        {shown.map(({ node, label }, i) => (
          <li key={`${node.id}-${i}`}>
            <button onClick={() => onSelect(node.id)}>
              <KindBadge kind={node.kind} />
              <span>{node.name}</span>
              <span className="ctx">{[label, nodeContext(model, node, { skipDc: contextDc })].filter(Boolean).join(' · ')}</span>
            </button>
          </li>
        ))}
      </ul>
      {items.length > shown.length && (
        <button className="btn small more" onClick={() => setAll(true)}>
          Show all {items.length}
        </button>
      )}
    </>
  )
}
