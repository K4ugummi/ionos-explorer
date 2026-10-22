import { getBezierPath, getSmoothStepPath, Position } from '@xyflow/react'
import { KINDS } from '../model/kinds'
import type { NodeKind } from '../model/types'
import { ALWAYS_LABELLED, handles } from './flow'
import { midpoint, roundedPath } from './geometry'
import { absolutePositions } from './layout'
import type { DiagramEdgeKind, Layout, PlacedEdge, PlacedNode, Point } from './types'

/**
 * Export of the current view as SVG, PNG (the SVG drawn on a canvas) and
 * draw.io XML. Everything is built from the layout the canvas draws (own
 * positions applied) and the node data, not from the DOM: the files do not
 * depend on the zoom, the level of detail, the colour scheme or the app's
 * CSS. What is exported is the view at rest: no selection, no search or
 * emphasis dimming, no lines drawn only on selection, every box at full
 * detail. Change markers of a comparison are part of the picture and stay.
 */

export interface ExportInfo {
  /** What the view shows: "All datacenters", a datacenter, "Focus: …", "Path: … → …". */
  title: string
  /** For the file name: "contract", a datacenter's name, "focus-…", "path-…-to-…". */
  view: string
  contract?: number | string
  /** The snapshot's creation time (ISO). */
  snapshot: string
  /** When comparing: the older snapshot's creation time (ISO). */
  comparedWith?: string
}

// --- colours and fonts ------------------------------------------------------------

/** The light colour tokens of `index.css` (a file has no CSS variables; it is always light). */
export const TOKENS = {
  bg: '#f5f6f8',
  surface: '#ffffff',
  'surface-2': '#f0f2f5',
  fg: '#1b2230',
  muted: '#5b6577',
  faint: '#8a93a3',
  border: '#dde1e7',
  accent: '#1f62d1',
  warn: '#9a5b00',
  'warn-soft': '#fff4e0',
  'k-compute': '#1f62d1',
  'k-network': '#0f7b6c',
  'k-service': '#7a3fc2',
  'k-storage': '#a15c00',
  'k-meta': '#5b6577',
  edge: '#8f9aab',
  'edge-cc': '#0f7b6c',
  'edge-inet': '#1f62d1',
  'edge-target': '#7a3fc2',
  'edge-vpn': '#b4237a',
  'edge-manual': '#c2410c',
  'chg-added': '#15803d',
  'chg-changed': '#b45309',
  'group-border': '#c9cfd8',
} as const

const T = TOKENS
/** `--group-bg`: the muted colour at 5 %. */
const GROUP_FILL_OPACITY = 0.05

/**
 * Fonts every system has in a metric-compatible form (Arial, Helvetica,
 * Liberation Sans), so the text widths estimated below hold wherever the
 * file is opened. The app's system-ui font is not used: its width differs
 * per system and truncated names would overflow their boxes.
 */
export const SANS = "Arial, Helvetica, 'Liberation Sans', 'Nimbus Sans', sans-serif"
export const MONO = "Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace"

// Glyph widths of Arial/Helvetica (1/1000 em) for ' ' to '~'.
// prettier-ignore
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]
// prettier-ignore
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889,
  611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
]

export interface Font {
  size: number
  bold?: boolean
  mono?: boolean
}

/**
 * Estimated width of a text, a little on the safe side: ASCII from the
 * table, combining marks none, other letters like a wide Latin letter,
 * symbols, CJK and emoji a full em (they come from a fallback font).
 */
export function textWidth(text: string, font: Font): number {
  let em = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c >= 0x300 && c < 0x370) continue
    if (font.mono) em += c >= 0x2000 ? 1 : 0.61
    else if (c >= 32 && c < 127) em += (font.bold ? BOLD : REGULAR)[c - 32] / 1000
    else em += c >= 0x2000 ? 1 : font.bold ? 0.65 : 0.6
  }
  return em * font.size * 1.03
}

/** The text cut to `max` pixels, with an ellipsis if it had to be cut. */
export function fitText(text: string, max: number, font: Font): string {
  if (textWidth(text, font) <= max) return text
  const chars = Array.from(text)
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (textWidth(chars.slice(0, mid).join('').trimEnd() + '…', font) <= max) lo = mid
    else hi = mid - 1
  }
  return lo ? chars.slice(0, lo).join('').trimEnd() + '…' : ''
}

/** `color-mix(in srgb, a p%, b)` of two hex colours. */
export function mix(a: string, p: number, b: string): string {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [rgb(a), rgb(b)]
  return (
    '#' +
    x
      .map((v, i) =>
        Math.round((v * p + y[i] * (100 - p)) / 100)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  )
}

// --- escaping ------------------------------------------------------------------------

/** Characters XML 1.0 does not allow. */
const NOT_XML =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * Text for XML (element content and attribute values). Names can hold any
 * character: markup is escaped, and characters XML 1.0 does not allow
 * (control characters, lone surrogates, U+FFFE/U+FFFF) become U+FFFD, so
 * the file always parses.
 */
export function xml(text: string): string {
  return text
    .replace(NOT_XML, '\uFFFD')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const num = (v: number) => String(Math.round(v * 10) / 10)

// --- file names --------------------------------------------------------------------

export type ExportExt = 'svg' | 'png' | 'pdf' | 'drawio' | 'zip'

/**
 * `ionos-<contract>-<view>-<date>.<ext>`, the date being the snapshot's.
 * Only letters, digits, dots, dashes and underscores: accents are dropped,
 * anything else becomes a dash; a long view name is cut.
 */
export function exportFileName(info: Pick<ExportInfo, 'contract' | 'view' | 'snapshot'>, ext: ExportExt): string {
  const clean = (s: string, max: number) =>
    s
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9._]+/g, '-')
      .replace(/-{2,}/g, '-')
      .slice(0, max)
      .replace(/^[-.]+|[-.]+$/g, '')
  const date = /^\d{4}-\d{2}-\d{2}/.exec(info.snapshot)?.[0]
  const parts = ['ionos', clean(String(info.contract ?? ''), 20), clean(info.view, 80) || 'view', date].filter(Boolean)
  return `${parts.join('-')}.${ext}`
}

/** "2026-10-01 12:00 UTC" */
export function stamp(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

// --- geometry ------------------------------------------------------------------------

type Rect = Point & { width: number; height: number }

/** The lines drawn at rest: lines shown only on selection (router LANs, balancer targets) are left out. */
export const drawnEdges = (layout: Layout) => layout.edges.filter((e) => !e.onDemand)

const SIDE: Record<string, Position> = {
  top: Position.Top,
  'top-out': Position.Top,
  bottom: Position.Bottom,
  'bottom-in': Position.Bottom,
  'left-in': Position.Left,
  'left-out': Position.Left,
  'right-in': Position.Right,
  'right-out': Position.Right,
}

function anchorOn(r: Rect, side: Position): Point {
  if (side === Position.Top) return { x: r.x + r.width / 2, y: r.y }
  if (side === Position.Bottom) return { x: r.x + r.width / 2, y: r.y + r.height }
  if (side === Position.Left) return { x: r.x, y: r.y + r.height / 2 }
  return { x: r.x + r.width, y: r.y + r.height / 2 }
}

export interface EdgeShape {
  edge: PlacedEdge
  /** SVG path data, as the canvas draws it. */
  d: string
  /** Where the label sits. */
  label: Point
  /** Every point of the path, control points included (for the bounds). */
  hull: Point[]
  /** Sides the line leaves and enters by, for lines without a route. */
  sides?: [Position, Position]
}

/**
 * A line as the canvas draws it: its route with rounded corners; without a
 * route, a curve between the handles `handles` picks, or right-angled steps
 * for a line whose route was dropped because an end was moved.
 */
export function edgeShape(e: PlacedEdge, abs: ReadonlyMap<string, Rect>): EdgeShape | undefined {
  if (e.points && e.points.length > 1) return { edge: e, d: roundedPath(e.points), label: midpoint(e.points), hull: e.points }
  const [s, t] = [abs.get(e.source), abs.get(e.target)]
  if (!s || !t) return undefined
  const [hs, ht] = handles(s, t, e.moved)
  const sides: [Position, Position] = [SIDE[hs], SIDE[ht]]
  const [a, b] = [anchorOn(s, sides[0]), anchorOn(t, sides[1])]
  const args = { sourceX: a.x, sourceY: a.y, targetX: b.x, targetY: b.y, sourcePosition: sides[0], targetPosition: sides[1] }
  const [d, x, y] = e.moved ? getSmoothStepPath({ ...args, borderRadius: 8 }) : getBezierPath(args)
  const n = (d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number)
  const hull: Point[] = []
  for (let i = 0; i + 1 < n.length; i += 2) hull.push({ x: n[i], y: n[i + 1] })
  return { edge: e, d, label: { x, y }, hull, sides }
}

const EDGE_STYLE: Record<DiagramEdgeKind, { stroke: string; width: number; dash?: string; round?: boolean }> = {
  lan: { stroke: T.edge, width: 1.4 },
  internet: { stroke: T['edge-inet'], width: 1.8 },
  'cross-connect': { stroke: T['edge-cc'], width: 2.6 },
  peer: { stroke: T['edge-cc'], width: 2.6, dash: '6 4' },
  target: { stroke: T['edge-target'], width: 1.6, dash: '5 4' },
  tunnel: { stroke: T['edge-vpn'], width: 2.2, dash: '8 4' },
  manual: { stroke: T['edge-manual'], width: 2.2, dash: '2 4', round: true },
}

/** Label colours: the line's colour for the kinds that always carry their name. */
const LABEL_COLOUR: Partial<Record<DiagramEdgeKind, string>> = {
  'cross-connect': T['edge-cc'],
  peer: T['edge-cc'],
  tunnel: T['edge-vpn'],
  manual: T['edge-manual'],
}

const LABEL_FONT: Font = { size: 11, bold: true }
const LABEL_HEIGHT = 18

/** Lines whose name is drawn at rest (the canvas shows the others' only while selected). */
const labelled = (e: PlacedEdge) => ALWAYS_LABELLED.has(e.kind) && !!e.label

// --- the legend ----------------------------------------------------------------------

export interface LegendItem {
  label: string
  line?: DiagramEdgeKind
  bar?: 'added' | 'changed'
}

/** The line kinds the export draws (a peer line looks like a Cross Connect), and the change markers when comparing. */
export function legendItems(layout: Layout, info: Pick<ExportInfo, 'comparedWith'>): LegendItem[] {
  const kinds = new Set<DiagramEdgeKind>(drawnEdges(layout).map((e) => (e.kind === 'peer' ? 'cross-connect' : e.kind)))
  const items: [DiagramEdgeKind, string][] = [
    ['lan', 'LAN attachment'],
    ['internet', 'Internet'],
    ['cross-connect', 'Cross Connect'],
    ['tunnel', 'VPN tunnel'],
    ['manual', 'Manual link'],
    ['target', 'Load balancer target'],
  ]
  const out: LegendItem[] = items.filter(([k]) => kinds.has(k)).map(([line, label]) => ({ line, label }))
  if (info.comparedWith) {
    out.push({ bar: 'added', label: 'New' }, { bar: 'changed', label: `Changed since ${stamp(info.comparedWith).slice(0, 10)}` })
  }
  return out
}

// --- SVG -----------------------------------------------------------------------------

const MARGIN = 24
const BADGE_FONT: Font = { size: 10.5, bold: true }
const familyColour = (kind: NodeKind) => T[`k-${KINDS[kind]?.family ?? 'meta'}`]

class Svg {
  parts: string[] = []
  defs: string[] = []
  private ids = 0
  id(prefix: string) {
    return `${prefix}${++this.ids}`
  }
  add(s: string) {
    this.parts.push(s)
  }
  rect(r: Rect, attrs: string) {
    this.add(`<rect x="${num(r.x)}" y="${num(r.y)}" width="${num(Math.max(0, r.width))}" height="${num(Math.max(0, r.height))}" ${attrs}/>`)
  }
  /** One line of text, vertically centred on `cy`, cut to `max` pixels. Returns its width. */
  text(x: number, cy: number, text: string, font: Font, fill: string, max = Infinity, anchor?: 'middle' | 'end'): number {
    const t = fitText(text, max, font)
    if (!t) return 0
    const attrs = [
      `x="${num(x)}"`,
      `y="${num(cy + font.size * 0.35)}"`,
      `font-size="${font.size}"`,
      font.bold ? 'font-weight="bold"' : '',
      font.mono ? `font-family="${xml(MONO)}"` : '',
      `fill="${fill}"`,
      anchor ? `text-anchor="${anchor}"` : '',
    ]
    this.add(`<text ${attrs.filter(Boolean).join(' ')}>${xml(t)}</text>`)
    return textWidth(t, font)
  }
  /** A pill-shaped marker with text; returns its width. */
  pill(
    x: number,
    cy: number,
    text: string,
    o: {
      font: Font
      fill: string
      stroke: string
      colour: string
      padding?: number
      height?: number
      max?: number
      dash?: boolean
      strokeOpacity?: number
    },
  ) {
    const pad = o.padding ?? 6
    const h = o.height ?? 16
    const t = fitText(text, (o.max ?? Infinity) - 2 * pad - 2, o.font)
    if (!t) return 0
    const w = textWidth(t, o.font) + 2 * pad + 2
    this.rect(
      { x: x + 0.5, y: cy - h / 2 + 0.5, width: w - 1, height: h - 1 },
      `rx="${num(h / 2)}" fill="${o.fill}" stroke="${o.stroke}"${o.strokeOpacity !== undefined ? ` stroke-opacity="${o.strokeOpacity}"` : ''}${o.dash ? ' stroke-dasharray="3 2"' : ''}`,
    )
    this.text(x + pad + 1, cy, t, o.font, o.colour)
    return w
  }
  /** A kind badge ("VM", "LAN"); returns its width. */
  badge(x: number, cy: number, kind: NodeKind) {
    const label = KINDS[kind]?.badge ?? kind
    const c = familyColour(kind)
    const w = Math.max(34, textWidth(label, BADGE_FONT) + 10)
    this.rect(
      { x: x + 0.5, y: cy - 8, width: w - 1, height: 16 },
      `rx="4" fill="${c}" fill-opacity="0.1" stroke="${c}" stroke-opacity="0.45"`,
    )
    this.text(x + w / 2, cy, label, BADGE_FONT, c, Infinity, 'middle')
    return w
  }
}

/** The kind of box the canvas draws for a node (`dg-<type>` and its modifiers). */
function boxStyle(n: PlacedNode) {
  const d = n.data
  let fill: string = T.surface
  let stroke: string = T.border
  let dash = d.placeholder
  let rx = 6
  if (n.type === 'lan') {
    const c = d.public ? T['edge-inet'] : T['k-network']
    fill = mix(c, 7, T.surface)
  } else if (n.type === 'hub') {
    fill = mix(T['edge-cc'], 8, T.surface)
    stroke = T['edge-cc']
    rx = n.height / 2
  } else if (n.type === 'internet') {
    stroke = mix(T['edge-inet'], 50, T.bg)
    rx = n.height / 2
  } else if (n.type === 'peer') dash = true
  else if (n.type === 'external') {
    dash = true
    stroke = T['edge-vpn']
  } else if (n.type === 'more') {
    dash = true
    fill = T['surface-2']
  }
  return { fill, stroke, dash, rx }
}

/** Draws a box (not a group) with its contents at full detail. */
function drawBox(svg: Svg, n: PlacedNode, r: Rect) {
  const d = n.data
  const s = boxStyle(n)
  svg.rect(
    { x: r.x + 0.5, y: r.y + 0.5, width: r.width - 1, height: r.height - 1 },
    `rx="${num(s.rx)}" fill="${s.fill}" stroke="${s.stroke}"${s.dash ? ' stroke-dasharray="4 3"' : ''}`,
  )
  // LANs are bus bars with a thick left edge; routers have a thick bottom edge.
  if (n.type === 'lan') clipped(svg, r, s.rx, { x: r.x, y: r.y, width: 4, height: r.height }, d.public ? T['edge-inet'] : T['k-network'])
  if (n.type === 'router') clipped(svg, r, s.rx, { x: r.x, y: r.y + r.height - 3, width: r.width, height: 3 }, T['k-network'])
  // A change bar sits inside the border (an inset shadow on the canvas), over the padding.
  if (d.change) clipped(svg, r, s.rx, { x: r.x + (n.type === 'lan' ? 4 : 0), y: r.y, width: 4, height: r.height }, T[`chg-${d.change}`])
  if (d.focus) {
    svg.rect(
      { x: r.x - 4.5, y: r.y - 4.5, width: r.width + 9, height: r.height + 9 },
      `rx="${num(s.rx + 4.5)}" fill="none" stroke="${T.accent}" stroke-opacity="0.5" stroke-width="3"`,
    )
  }
  const textFill = d.inactive ? T.muted : T.fg

  if (n.type === 'internet') {
    const label = 'Internet'
    const font = { size: 14, bold: true }
    const w = 18 + 8 + textWidth(label, font)
    const x0 = r.x + (r.width - w) / 2
    const cy = r.y + r.height / 2
    svg.add(
      `<g transform="translate(${num(x0)} ${num(cy - 9)}) scale(0.75)" fill="none" stroke="${T['edge-inet']}" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></g>`,
    )
    svg.text(x0 + 26, cy, label, font, T['edge-inet'])
    return
  }
  if (n.type === 'more') {
    svg.text(r.x + r.width / 2, r.y + r.height / 2, d.title, { size: 14, bold: true }, T.accent, r.width - 16, 'middle')
    return
  }

  const [padX, padY] = n.type === 'dc' ? [12, 8] : n.type === 'member' ? [8, 4] : n.type === 'hub' ? [16, 6] : [10, 6]
  const left = r.x + padX + (n.type === 'lan' ? 4 : 0)
  const right = r.x + r.width - padX
  const titleFont: Font = { size: n.type === 'dc' ? 14.5 : 14, bold: true }

  /** Badge, title and the markers on the right; returns the right end of the title. */
  const head = (cy: number, maxRight: number) => {
    let x = left
    const kind = n.type === 'dc' || n.type === 'peer' ? 'datacenter' : n.type === 'external' ? 'external' : d.kind
    if (kind) x += svg.badge(x, cy, kind) + 6
    // Markers on the right: appliance tag, the "not running" dot, the datacenter's internet marker.
    let end = maxRight
    if (d.inactive) {
      svg.add(`<circle cx="${num(end - 4)}" cy="${num(cy)}" r="4" fill="${T.faint}"/>`)
      end -= 8 + (d.tag ? 4 : 0)
    }
    const markers: {
      text: string
      font: Font
      colour: string
      fill: string
      stroke: string
      strokeOpacity?: number
      dash?: boolean
      max: number
    }[] = []
    if (d.tag) {
      markers.push({
        text: d.tag,
        font: { size: 10, bold: d.tagLevel === 'high' },
        colour: T.warn,
        fill: T['warn-soft'],
        stroke: mix(T.warn, 35, T['warn-soft']),
        dash: d.tagLevel === 'low',
        max: 96,
      })
    }
    if (n.type === 'dc' && d.public) {
      markers.push({
        text: 'internet',
        font: { size: 10.5 },
        colour: T['edge-inet'],
        fill: T.surface,
        stroke: T['edge-inet'],
        strokeOpacity: 0.4,
        max: 96,
      })
    }
    for (const m of markers) {
      const w = Math.min(m.max, textWidth(m.text, m.font) + 14)
      end -= w
      svg.pill(end, cy, m.text, { ...m, max: m.max })
      end -= 6
    }
    const used = svg.text(x, cy, d.title, titleFont, textFill, Math.max(0, end - x))
    return x + used
  }

  if (n.type === 'lan') {
    // One row: name (at most 75 %), the "via router" marker, the subtitle right-aligned in the rest.
    const cy = r.y + r.height / 2
    const inner = right - left
    const titleEnd = head(cy, left + inner * 0.75)
    let x = titleEnd + 12
    if (d.via) {
      const text = `via ${d.via}`
      x +=
        svg.pill(x, cy, text, {
          font: { size: 10.5 },
          colour: T.muted,
          fill: 'none',
          stroke: T.faint,
          dash: true,
          max: Math.min(inner * 0.4, right - x),
        }) + 12
    }
    if (d.subtitle) svg.text(right, cy, d.subtitle, { size: 12 }, T.muted, Math.max(0, right - x), 'end')
    return
  }

  const lineH = 20.3
  let y = r.y + padY
  head(y + lineH / 2, right)
  y += lineH
  if (d.subtitle) {
    const font: Font = n.type === 'member' ? { size: 11, mono: true } : { size: 12 }
    const h = n.type === 'member' ? 16 : 17.4
    y += n.type === 'member' ? 0 : 2
    svg.text(left, y + h / 2, d.subtitle, font, T.muted, right - left)
    y += h
  }
  if (d.lans) {
    // A router: "N LANs" and the LANs folded into it.
    const font: Font = { size: 12 }
    const cy = y + 2 + 8.7
    let x = left + svg.text(left, cy, `${d.lans} LANs`, { ...font, bold: true }, T['k-network'], right - left)
    if (d.only && !d.only.open) {
      const k = d.only.lans.length
      // SVG drops spaces at the ends of a text, so the gaps around the dot are moved by hand.
      const gap = textWidth(' ', font)
      x += gap + svg.text(x + gap, cy, '·', font, T.muted) + gap
      svg.text(x, cy, `+${k} ${k === 1 ? 'LAN' : 'LANs'} only here`, font, T['k-network'], right - x)
    }
  }
  if (n.type === 'dc') {
    // The change counts first, then as many pills as fit on one row.
    const pills = [...(d.changes ? [{ text: d.changes, chg: true }] : []), ...(d.pills ?? []).map((text) => ({ text, chg: false }))]
    const cy = y + 6 + 9
    let x = left
    for (const p of pills) {
      const font: Font = { size: 11 }
      const w = textWidth(p.text, font) + 14
      if (x + w > right) break
      svg.pill(x, cy, p.text, {
        font,
        colour: p.chg ? T.fg : T.muted,
        fill: T['surface-2'],
        stroke: p.chg ? T['chg-changed'] : T.border,
        height: 18,
      })
      x += w + 3
    }
  }
}

/** A coloured part of a box (an edge bar, a change bar), cut to the box's rounded outline. */
function clipped(svg: Svg, box: Rect, rx: number, part: Rect, fill: string) {
  const id = svg.id('c')
  svg.defs.push(
    `<clipPath id="${id}"><rect x="${num(box.x + 1)}" y="${num(box.y + 1)}" width="${num(box.width - 2)}" height="${num(box.height - 2)}" rx="${num(Math.max(0, rx - 1))}"/></clipPath>`,
  )
  svg.rect(part, `fill="${fill}" clip-path="url(#${id})"`)
}

/** A group: location, server group, leftovers, a datacenter in a focus or path view. */
function drawGroup(svg: Svg, n: PlacedNode, r: Rect) {
  const d = n.data
  const servers = !!d.kind
  const rx = servers ? 8 : 10
  svg.rect(
    { x: r.x + 0.5, y: r.y + 0.5, width: r.width - 1, height: r.height - 1 },
    `rx="${rx}" fill="${T.muted}" fill-opacity="${GROUP_FILL_OPACITY}" stroke="${T['group-border']}"${servers ? ' stroke-dasharray="4 3"' : ''}`,
  )
  if (servers && d.lans) clipped(svg, r, rx, { x: r.x, y: r.y + r.height - 3, width: r.width, height: 3 }, T['k-network'])
  if (d.change) clipped(svg, r, rx, { x: r.x, y: r.y, width: 4, height: r.height }, T[`chg-${d.change}`])
  const [padX, padY] = servers ? [10, 7] : [12, 8]
  const cy = r.y + padY + 10
  const right = r.x + r.width - padX
  let x = r.x + padX
  const title: Font = servers ? { size: 12.5, bold: true } : { size: 13, bold: true, mono: true }
  x += svg.text(x, cy, d.title, title, T.fg, right - x) + 8
  if (d.subtitle && x < right) x += svg.text(x, cy, d.subtitle, { size: 12 }, T.muted, right - x) + 8
  if (d.lans && x < right) x += svg.text(x, cy, `${d.lans} LANs`, { size: 12, bold: true }, T['k-network'], right - x) + 8
  if (d.only && !d.only.open && x < right) {
    const k = d.only.lans.length
    svg.text(x, cy, `+${k} ${k === 1 ? 'LAN' : 'LANs'} only here`, { size: 12 }, T['k-network'], right - x)
  }
}

function drawEdge(svg: Svg, s: EdgeShape) {
  const st = EDGE_STYLE[s.edge.kind]
  svg.add(
    `<path d="${s.d}" fill="none" stroke="${st.stroke}" stroke-width="${st.width}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}${st.round ? ' stroke-linecap="round"' : ''} stroke-linejoin="round"/>`,
  )
}

function labelRect(s: EdgeShape): Rect {
  const w = textWidth(s.edge.label!, LABEL_FONT) + 12
  return { x: s.label.x - w / 2, y: s.label.y - LABEL_HEIGHT / 2, width: w, height: LABEL_HEIGHT }
}

function drawLabel(svg: Svg, s: EdgeShape) {
  const r = labelRect(s)
  const c = LABEL_COLOUR[s.edge.kind] ?? T.muted
  const dash = s.edge.kind === 'manual' ? ' stroke-dasharray="3 2"' : ''
  svg.rect(
    { x: r.x + 0.5, y: r.y + 0.5, width: r.width - 1, height: r.height - 1 },
    `rx="4" fill="${T.surface}" stroke="${mix(c, 45, T.surface)}"${dash}`,
  )
  svg.text(s.label.x, s.label.y, s.edge.label!, LABEL_FONT, c, Infinity, 'middle')
}

/** What the export of a layout contains, worked out once for SVG and draw.io. */
export function exportScene(layout: Layout) {
  const abs = absolutePositions(layout)
  const shapes = drawnEdges(layout).flatMap((e) => edgeShape(e, abs) ?? [])
  // Bounds of everything drawn: boxes (with the focus outline), lines, labels.
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  const take = (r: Rect) => {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.width)
    y1 = Math.max(y1, r.y + r.height)
  }
  for (const n of layout.nodes) {
    const r = abs.get(n.id)!
    const o = n.data.focus ? 6 : 0
    take({ x: r.x - o, y: r.y - o, width: r.width + 2 * o, height: r.height + 2 * o })
  }
  for (const s of shapes) {
    for (const p of s.hull) take({ ...p, width: 0, height: 0 })
    if (labelled(s.edge)) take(labelRect(s))
  }
  if (!Number.isFinite(x0)) [x0, y0, x1, y1] = [0, 0, 0, 0]
  return { abs, shapes, bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } }
}

/** The footer: what this is, of which snapshot, and the legend. */
function drawFooter(svg: Svg, info: ExportInfo, legend: LegendItem[], top: number, width: number) {
  const left = MARGIN
  const right = width - MARGIN
  svg.add(`<line x1="${left}" y1="${num(top)}" x2="${num(right)}" y2="${num(top)}" stroke="${T.border}"/>`)
  let y = top + 20
  svg.text(left, y, info.title, { size: 14, bold: true }, T.fg, right - left)
  y += 20
  const line = [
    info.contract !== undefined && info.contract !== '' ? `Contract ${info.contract}` : undefined,
    `snapshot ${stamp(info.snapshot)}`,
    info.comparedWith ? `compared with ${stamp(info.comparedWith)}` : undefined,
    'IONOS Explorer',
  ]
    .filter(Boolean)
    .join(' · ')
  svg.text(left, y, line, { size: 12 }, T.muted, right - left)
  y += 14
  // The legend in rows below, as wide as the picture.
  const font: Font = { size: 11.5 }
  let x = left
  y += 14
  for (const item of legend) {
    const w = 30 + textWidth(item.label, font)
    if (x > left && x + w > right) {
      x = left
      y += 20
    }
    if (item.line) {
      const st = EDGE_STYLE[item.line]
      svg.add(
        `<line x1="${num(x + 1)}" y1="${num(y)}" x2="${num(x + 25)}" y2="${num(y)}" stroke="${st.stroke}" stroke-width="2"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}${st.round ? ' stroke-linecap="round"' : ''}/>`,
      )
    } else if (item.bar) {
      svg.rect({ x: x + 9, y: y - 7, width: 4, height: 14 }, `rx="1" fill="${T[`chg-${item.bar}`]}"`)
    }
    svg.text(x + 30, y, item.label, font, T.muted)
    x += w + 16
  }
  return y + 10 + MARGIN
}

/** Height of the footer for a width (drawn once to measure; cheap). */
function footerHeight(info: ExportInfo, legend: LegendItem[], width: number) {
  return drawFooter(new Svg(), info, legend, 0, width)
}

/** The narrowest file: the footer needs some room even for a single box. */
const MIN_WIDTH = 420

/**
 * The view as a standalone SVG document: light colours, fixed fonts and
 * sizes, every box at full detail, the legend and title in a footer. With
 * `transparent` there is no background (boxes and groups keep their fills).
 */
export function exportSvg(
  layout: Layout,
  info: ExportInfo,
  { transparent = false }: { transparent?: boolean } = {},
): { svg: string; width: number; height: number } {
  const { abs, shapes, bounds } = exportScene(layout)
  const width = Math.ceil(Math.max(bounds.width + 2 * MARGIN, MIN_WIDTH))
  const legend = legendItems(layout, info)
  const top = Math.ceil(bounds.height + 2 * MARGIN)
  const height = Math.ceil(top + footerHeight(info, legend, width))
  // The picture's top left corner lands at the margin (own positions can move boxes to negative coordinates).
  const [dx, dy] = [MARGIN - bounds.x, MARGIN - bounds.y]
  const svg = new Svg()
  if (!transparent) svg.add(`<rect width="${width}" height="${height}" fill="${T.bg}"/>`)
  svg.add(`<g transform="translate(${num(dx)} ${num(dy)})">`)
  for (const n of layout.nodes) if (n.type === 'group') drawGroup(svg, n, abs.get(n.id)!)
  for (const s of shapes) drawEdge(svg, s)
  for (const n of layout.nodes) if (n.type !== 'group') drawBox(svg, n, abs.get(n.id)!)
  for (const s of shapes) if (labelled(s.edge)) drawLabel(svg, s)
  svg.add('</g>')
  drawFooter(svg, info, legend, top, width)
  const doc = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${xml(SANS)}" font-size="14">`,
    `<title>${xml(info.title)}</title>`,
    `<desc>${xml(`Snapshot ${stamp(info.snapshot)}${info.contract !== undefined ? `, contract ${info.contract}` : ''}. Exported from IONOS Explorer.`)}</desc>`,
    svg.defs.length ? `<defs>${svg.defs.join('')}</defs>` : '',
    ...svg.parts,
    '</svg>',
  ]
  return { svg: doc.filter(Boolean).join('\n') + '\n', width, height }
}

// --- PNG -----------------------------------------------------------------------------

/** Browsers refuse canvases beyond about this many pixels (and memory runs out before). */
const MAX_PIXELS = 50_000_000
const MAX_SIDE = 32_000

/** The scale for a PNG: 2× unless the canvas would get too large, then as large as allowed. */
export function pngScale(width: number, height: number, wanted = 2): number {
  return Math.min(
    wanted,
    Math.sqrt(MAX_PIXELS / Math.max(1, width * height)),
    MAX_SIDE / Math.max(1, width),
    MAX_SIDE / Math.max(1, height),
  )
}

/** Draws the SVG on a canvas and encodes it as PNG. */
export async function svgToPng(svg: string, width: number, height: number, wanted = 2): Promise<{ blob: Blob; scale: number }> {
  const { canvas, scale } = await svgToCanvas(svg, width, height, wanted)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error(`The picture is too large for a PNG (${canvas.width} × ${canvas.height} pixels); export SVG instead`)
  return { blob, scale }
}

/** Draws the SVG on a canvas (an image from a `blob:` URL, allowed by the CSP's img-src), at `wanted` times its size or as large as allowed. */
export async function svgToCanvas(
  svg: string,
  width: number,
  height: number,
  wanted = 2,
  maxPixels = MAX_PIXELS,
): Promise<{ canvas: HTMLCanvasElement; scale: number }> {
  const scale = Math.min(pngScale(width, height, wanted), Math.sqrt(maxPixels / Math.max(1, width * height)))
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('The browser could not draw the SVG'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No canvas available')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return { canvas, scale }
  } finally {
    URL.revokeObjectURL(url)
  }
}

// --- draw.io -------------------------------------------------------------------------

/** HTML for a draw.io label (`html=1`): text escaped, then the whole value escaped again as an attribute. */
const html = (text: string) => xml(text)

const style = (s: Record<string, string | number | undefined | false>) =>
  Object.entries(s)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => `${k}=${v}`)
    .join(';') + ';'

function vertexStyle(n: PlacedNode): string {
  const d = n.data
  if (n.type === 'group') {
    const servers = !!d.kind
    return style({
      rounded: 1,
      absoluteArcSize: 1,
      arcSize: servers ? 16 : 20,
      container: 1,
      collapsible: 0,
      recursiveResize: 0,
      html: 1,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      fillColor: T.muted,
      fillOpacity: 5,
      strokeColor: d.change ? T[`chg-${d.change}`] : servers && d.lans ? T['k-network'] : T['group-border'],
      strokeWidth: d.change ? 2 : undefined,
      dashed: servers ? 1 : undefined,
      align: 'left',
      verticalAlign: 'top',
      spacingLeft: servers ? 8 : 10,
      spacingTop: 2,
      fontFamily: servers ? undefined : 'Courier New',
      fontSize: servers ? 12 : 13,
      fontColor: T.fg,
    })
  }
  const s = boxStyle(n)
  const stroke = d.change
    ? T[`chg-${d.change}`]
    : d.focus
      ? T.accent
      : n.type === 'lan'
        ? d.public
          ? T['edge-inet']
          : T['k-network']
        : n.type === 'router'
          ? T['k-network']
          : s.stroke
  const centred = n.type === 'internet' || n.type === 'more'
  return style({
    rounded: 1,
    absoluteArcSize: n.type === 'hub' || n.type === 'internet' ? undefined : 1,
    arcSize: n.type === 'hub' || n.type === 'internet' ? 50 : 12,
    html: 1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    fillColor: s.fill,
    strokeColor: stroke,
    strokeWidth: d.change || d.focus ? 2 : undefined,
    dashed: s.dash ? 1 : undefined,
    align: centred ? 'center' : 'left',
    verticalAlign: centred || n.type === 'lan' ? 'middle' : 'top',
    spacingLeft: centred ? undefined : n.type === 'member' ? 6 : 8,
    spacingTop: centred || n.type === 'lan' ? undefined : 2,
    fontSize: 12,
    fontColor: n.type === 'internet' ? T['edge-inet'] : n.type === 'more' ? T.accent : T.fg,
  })
}

/** A draw.io label: kind badge and title bold, then the details on their own lines. */
function vertexValue(n: PlacedNode): string {
  const d = n.data
  const small = (t: string, colour: string = T.muted) => `<font style="font-size:10px" color="${colour}">${html(t)}</font>`
  if (n.type === 'group') {
    const rest = [d.subtitle, d.lans && `${d.lans} LANs`].filter((x): x is string => !!x)
    return [`<b>${html(d.title)}</b>`, ...rest.map((t) => small(t))].join('&nbsp;&nbsp;')
  }
  if (n.type === 'internet' || n.type === 'more') return `<b>${html(n.type === 'internet' ? 'Internet' : d.title)}</b>`
  const kind = n.type === 'dc' || n.type === 'peer' ? 'datacenter' : n.type === 'external' ? 'external' : d.kind
  const head = [kind && `<font color="${familyColour(kind)}"><b>${html(KINDS[kind]?.badge ?? kind)}</b></font>`, `<b>${html(d.title)}</b>`]
    .filter(Boolean)
    .join(' ')
  const marks = [d.tag && small(d.tag, T.warn), n.type === 'dc' && d.public && small('internet', T['edge-inet'])].filter(Boolean)
  const lines = [[head, ...marks].join(' ')]
  if (n.type === 'lan') {
    const tail = [d.via && `via ${d.via}`, d.subtitle].filter((x): x is string => !!x)
    return [lines[0], ...tail.map((t) => small(t))].join('&nbsp;&nbsp;')
  }
  if (d.subtitle) lines.push(small(d.subtitle))
  if (d.lans) lines.push(small(`${d.lans} LANs${d.only && !d.only.open ? ` · +${d.only.lans.length} only here` : ''}`, T['k-network']))
  const pills = [d.changes, ...(d.pills ?? [])].filter((x): x is string => !!x)
  if (pills.length) lines.push(small(pills.join(' · ')))
  return lines.join('<br>')
}

function edgeStyle(s: EdgeShape, sAbs: Rect, tAbs: Rect): string {
  const e = s.edge
  const st = EDGE_STYLE[e.kind]
  const routed = !!e.points && e.points.length > 1
  // Where the line leaves and enters, relative to the boxes (draw.io's exit/entry constraints).
  const rel = (p: Point, r: Rect) =>
    [r.width ? (p.x - r.x) / r.width : 0.5, r.height ? (p.y - r.y) / r.height : 0.5].map((v) => num(Math.min(1, Math.max(0, v))))
  const [start, end] = routed ? [e.points![0], e.points!.at(-1)!] : [anchorOn(sAbs, s.sides![0]), anchorOn(tAbs, s.sides![1])]
  const [ex, ey] = rel(start, sAbs)
  const [nx, ny] = rel(end, tAbs)
  const c = LABEL_COLOUR[e.kind] ?? T.muted
  return style({
    edgeStyle: routed ? 'none' : 'orthogonalEdgeStyle',
    curved: !routed && !e.moved ? 1 : undefined,
    rounded: 1,
    html: 1,
    endArrow: 'none',
    startArrow: 'none',
    strokeColor: st.stroke,
    strokeWidth: st.width,
    dashed: st.dash ? 1 : undefined,
    dashPattern: st.dash,
    exitX: ex,
    exitY: ey,
    exitPerimeter: 0,
    entryX: nx,
    entryY: ny,
    entryPerimeter: 0,
    fontSize: 11,
    fontStyle: LABEL_COLOUR[e.kind] ? 1 : undefined,
    fontColor: c,
    labelBackgroundColor: T.surface,
    labelBorderColor: e.label ? mix(c, 45, T.surface) : undefined,
  })
}

/**
 * The view as an uncompressed draw.io file: one vertex per box, groups as
 * containers (children placed relative to them), one edge per line with
 * ELK's bend points as waypoints where it was routed. An edge belongs to the
 * innermost group holding both its ends, so moving that group in draw.io
 * takes its lines along. A second layer holds the title and the legend.
 */
export function exportDrawio(layout: Layout, info: ExportInfo): string {
  return exportDrawioPages([{ layout, info }])
}

/** Several views in one draw.io file, one page (tab) each, named after the view. */
export function exportDrawioPages(pages: { layout: Layout; info: ExportInfo }[]): string {
  return ['<mxfile host="IONOS Explorer" type="device">', ...pages.map((p, i) => drawioPage(p.layout, p.info, i)), '</mxfile>', ''].join('\n')
}

function drawioPage(layout: Layout, info: ExportInfo, page: number): string {
  const { abs, shapes, bounds } = exportScene(layout)
  const cell = new Map(layout.nodes.map((n, i) => [n.id, `n${i + 1}`]))
  const byId = new Map(layout.nodes.map((n) => [n.id, n]))
  const ancestors = (id: string) => {
    const out: string[] = []
    for (let p = byId.get(id)?.parent; p; p = byId.get(p)?.parent) out.push(p)
    return out
  }
  const out: string[] = []
  // Moved to the origin; children keep their place relative to their group.
  const [ox, oy] = [MARGIN - bounds.x, MARGIN - bounds.y]
  for (const n of layout.nodes) {
    const parent = n.parent && cell.has(n.parent) ? cell.get(n.parent)! : '1'
    const [x, y] = parent === '1' ? [abs.get(n.id)!.x + ox, abs.get(n.id)!.y + oy] : [n.x, n.y]
    out.push(
      `<mxCell id="${cell.get(n.id)}" value="${xml(vertexValue(n))}" style="${xml(vertexStyle(n))}" vertex="1" parent="${parent}">` +
        `<mxGeometry x="${num(x)}" y="${num(y)}" width="${num(n.width)}" height="${num(n.height)}" as="geometry"/></mxCell>`,
    )
  }
  shapes.forEach((s, i) => {
    const e = s.edge
    const [sa, ta] = [abs.get(e.source)!, abs.get(e.target)!]
    const up = new Set(ancestors(e.source))
    const common = ancestors(e.target).find((a) => up.has(a))
    const parent = common ? cell.get(common)! : '1'
    // Waypoints are in the parent's coordinates.
    const origin = common ? abs.get(common)! : { x: -ox, y: -oy }
    const bends = e.points && e.points.length > 2 ? e.points.slice(1, -1) : []
    const points = bends.length
      ? `<Array as="points">${bends.map((p) => `<mxPoint x="${num(p.x - origin.x)}" y="${num(p.y - origin.y)}"/>`).join('')}</Array>`
      : ''
    const value = labelled(e) ? xml(html(e.label!)) : ''
    out.push(
      `<mxCell id="e${i + 1}" value="${value}" style="${xml(edgeStyle(s, sa, ta))}" edge="1" parent="${parent}" source="${cell.get(e.source)}" target="${cell.get(e.target)}">` +
        `<mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell>`,
    )
  })

  // Title and legend below the picture, on a layer of their own.
  const top = bounds.height + 2 * MARGIN
  const width = Math.max(bounds.width + 2 * MARGIN, MIN_WIDTH)
  const sub = [
    info.contract !== undefined && info.contract !== '' ? `Contract ${info.contract}` : undefined,
    `snapshot ${stamp(info.snapshot)}`,
    info.comparedWith ? `compared with ${stamp(info.comparedWith)}` : undefined,
    'IONOS Explorer',
  ]
    .filter(Boolean)
    .join(' · ')
  const legend = legendItems(layout, info)
    .map((l) => {
      const colour = l.line ? EDGE_STYLE[l.line].stroke : T[`chg-${l.bar!}`]
      return `<font color="${colour}">${l.line ? '━━' : '▌'}</font> ${html(l.label)}`
    })
    .join('&nbsp;&nbsp;&nbsp;')
  const titleValue = `<b>${html(info.title)}</b><br><font color="${T.muted}" style="font-size:11px">${html(sub)}</font>${legend ? `<br><font style="font-size:11px">${legend}</font>` : ''}`
  out.push(
    `<mxCell id="t1" value="${xml(titleValue)}" style="${xml(style({ text: 1, html: 1, align: 'left', verticalAlign: 'top', whiteSpace: 'wrap', fontSize: 13, fontColor: T.fg }))}" vertex="1" parent="legend">` +
      `<mxGeometry x="${MARGIN}" y="${num(top)}" width="${num(width - 2 * MARGIN)}" height="60" as="geometry"/></mxCell>`,
  )

  const height = top + 80
  return [
    `<diagram id="ionos-explorer${page ? `-${page + 1}` : ''}" name="${xml(info.title)}">`,
    `<mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="${Math.ceil(width)}" pageHeight="${Math.ceil(height)}" background="${T.bg}" math="0" shadow="0">`,
    '<root>',
    '<mxCell id="0"/>',
    '<mxCell id="1" value="Diagram" parent="0"/>',
    '<mxCell id="legend" value="Title and legend" parent="0"/>',
    ...out,
    '</root>',
    '</mxGraphModel>',
    '</diagram>',
  ].join('\n')
}

// --- saving --------------------------------------------------------------------------

/** Hands a file to the browser's downloads (`a[download]` on a `blob:` URL, revoked afterwards). Nothing leaves the machine. */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
  // Some browsers read the URL only after the click has been handled.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
