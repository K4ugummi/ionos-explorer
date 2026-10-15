import { useContext, useState } from 'react'
import { normalizeIP, removeIpFix, setIpFix } from '../annotations/annotations'
import { AnnotationsContext } from '../annotations/context'
import type { GraphNode, Model } from '../model/types'

/*
 * IONOS only knows the IP it has on record for a NIC. With DHCP off it never
 * hands that IP out: the VM configures its own, which may differ. This shows
 * which addresses IONOS cannot vouch for and lets the user correct them.
 */

const lanOf = (model: Model, nic: GraphNode) => {
  const e = (model.edgesByNode.get(nic.id) ?? []).find((x) => x.kind === 'attached' && x.from === nic.id)
  return e ? model.nodes.get(e.to) : undefined
}

/** The IP section of a server (one row per NIC) or of a single NIC. */
export function IpAddresses({ model, node }: { model: Model; node: GraphNode }) {
  const ctx = useContext(AnnotationsContext)
  if (node.kind !== 'server' && node.kind !== 'nic') return null
  const nics =
    node.kind === 'nic' ? [node] : (model.children.get(node.id) ?? []).map((id) => model.nodes.get(id)!).filter((n) => n.kind === 'nic')
  if (!nics.length) return null
  const off = nics.filter((n) => n.dhcp === false).length
  const unverified = nics.filter((n) => n.dhcp === false && !n.ionosIps).length

  return (
    <section className="section ip-check">
      <h2>{node.kind === 'nic' ? 'IP address' : 'IP addresses'}</h2>
      {unverified > 0 && (
        <p className="hint">
          {nics.length === 1
            ? 'DHCP is off for this NIC'
            : off === nics.length
              ? 'DHCP is off for all NICs'
              : `DHCP is off for ${off} of ${nics.length} NICs`}
          : IONOS does not assign {off === 1 ? 'this address' : 'these addresses'}, the VM sets its own, which may differ.
          {ctx ? ` If you know the real ${off === 1 ? 'one' : 'ones'}, correct ${off === 1 ? 'it' : 'them'} here.` : ''}
        </p>
      )}
      <ul className="ip-rows">
        {nics.map((n) => (
          <NicRow key={n.id} model={model} nic={n} showLan={node.kind === 'server'} />
        ))}
      </ul>
    </section>
  )
}

function NicRow({ model, nic, showLan }: { model: Model; nic: GraphNode; showLan: boolean }) {
  const ctx = useContext(AnnotationsContext)
  const [editing, setEditing] = useState(false)
  const fix = ctx?.annotations.ips.find((f) => f.nic === nic.id)
  const lan = lanOf(model, nic)

  return (
    <li>
      <div className="ip-row">
        {showLan && <span className="ip-lan">{lan?.name ?? nic.name}</span>}
        <code className="ip-value">{nic.ips.join(', ') || 'no IP'}</code>
        {nic.ionosIps ? (
          <span className="pill fix" title="You corrected this address">
            corrected
          </span>
        ) : nic.dhcp === false ? (
          <span className="pill warn" title="DHCP is off: IONOS does not assign this address">
            not verified
          </span>
        ) : nic.dhcp ? (
          <span className="pill" title="IONOS assigns this address by DHCP">
            DHCP
          </span>
        ) : null}
        {ctx && !editing && (
          <span className="ip-actions">
            <button className="btn small" onClick={() => setEditing(true)}>
              {fix ? 'Edit' : 'Correct…'}
            </button>
            {fix && (
              <button
                className="btn small"
                aria-label={`Remove the correction for ${lan?.name ?? nic.name}`}
                title="Remove the correction"
                onClick={() => ctx.update((a) => removeIpFix(a, nic.id))}
              >
                ✕
              </button>
            )}
          </span>
        )}
      </div>
      {nic.ionosIps && (
        <div className="ip-was">
          IONOS has <code>{nic.ionosIps.join(', ') || 'no IP'}</code>
          {fix?.note ? ` · ${fix.note}` : ''}
        </div>
      )}
      {editing && ctx && (
        <IpForm
          initial={fix ? fix.ips.join(', ') : nic.ips.filter((ip) => !ip.includes(':')).join(', ')}
          note={fix?.note}
          onCancel={() => setEditing(false)}
          onSave={(ips, note) => {
            ctx.update((a) => setIpFix(a, { nic: nic.id, ips, note }))
            setEditing(false)
          }}
        />
      )}
    </li>
  )
}

function IpForm({
  initial,
  note: initialNote,
  onSave,
  onCancel,
}: {
  initial: string
  note?: string
  onSave: (ips: string[], note?: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const [note, setNote] = useState(initialNote ?? '')
  const [error, setError] = useState<string>()
  const save = () => {
    const parts = value.split(/[\s,;]+/).filter(Boolean)
    const bad = parts.filter((p) => !normalizeIP(p))
    if (!parts.length) return setError('Enter at least one IP address.')
    if (bad.length) return setError(`Not an IP address: ${bad.join(', ')}`)
    onSave([...new Set(parts.map((p) => normalizeIP(p)!))].slice(0, 16), note.trim() || undefined)
  }
  return (
    <form
      className="add-link ip-form"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <label>
        <span className="hint">IP the VM really uses (several: separate with commas)</span>
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-label="Real IP addresses" spellCheck={false} />
      </label>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional), e.g. where you checked"
        aria-label="Note"
      />
      {error && (
        <p className="hint error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className="btn small primary" type="submit">
          Save correction
        </button>
        <button className="btn small" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="hint">Kept in this browser with your links, never in the snapshot. It does not change anything at IONOS.</p>
    </form>
  )
}
