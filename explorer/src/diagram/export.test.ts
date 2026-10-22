import ELK from 'elkjs/lib/elk.bundled.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compareModels, markChanges } from '../diff/diff'
import { findPaths } from '../model/paths'
import type { Model } from '../model/types'
import { fixtureModel, previousFixtureModel } from '../test/fixture'
import { descendants, parseXml, type XmlElement } from '../test/xml'
import { contractDiagram, datacenterDiagram, focusDiagram, pathDiagram } from './build'
import {
  drawnEdges,
  exportDrawio,
  exportDrawioPages,
  exportFileName,
  exportSvg,
  fitText,
  legendItems,
  mix,
  pngScale,
  textWidth,
  TOKENS,
  xml,
  type ExportInfo,
} from './export'
import { absolutePositions, layoutDiagram, withData } from './layout'
import { applyPositions } from './positions'
import type { Diagram, Layout } from './types'

const named = (m: Model, name: string) => [...m.nodes.values()].find((n) => n.name === name)!
const elk = new ELK()
const laid = async (d: Diagram) => withData(await layoutDiagram(d, elk), d)
const info = (title = 'All datacenters', extra: Partial<ExportInfo> = {}): ExportInfo => ({
  title,
  view: 'contract',
  contract: 31812345,
  snapshot: '2026-10-14T06:00:00Z',
  ...extra,
})

/** The SVG's texts with their absolute positions (the picture is moved by one translate). */
function texts(svg: string) {
  const root = parseXml(svg)
  const shift = (el: XmlElement) => {
    let [x, y] = [0, 0]
    for (let p = el.parent; p; p = p.parent) {
      const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(p.attrs.transform ?? '')
      if (m) [x, y] = [x + Number(m[1]), y + Number(m[2])]
    }
    return { x, y }
  }
  return descendants(root)
    .filter((e) => e.name === 'text')
    .map((e) => {
      const s = shift(e)
      return { text: e.text, x: Number(e.attrs.x) + s.x, y: Number(e.attrs.y) + s.y, el: e }
    })
}

/** draw.io: the cells of the diagram layer (vertices and edges below layer "1"), by id. */
function drawio(file: string) {
  const root = parseXml(file)
  expect(root.name).toBe('mxfile')
  const cells = descendants(root).filter((e) => e.name === 'mxCell')
  const byId = new Map(cells.map((c) => [c.attrs.id, c]))
  const layer = (c: XmlElement): string | undefined => {
    for (let p: XmlElement | undefined = c; p; p = byId.get(p.attrs.parent)) if (p.attrs.parent === '0') return p.attrs.id
    return undefined
  }
  const inDiagram = cells.filter((c) => layer(c) === '1' && c.attrs.id !== '1')
  const geometry = (c: XmlElement) => c.children.find((g) => g.name === 'mxGeometry')!
  return {
    root,
    byId,
    vertices: inDiagram.filter((c) => c.attrs.vertex === '1'),
    edges: inDiagram.filter((c) => c.attrs.edge === '1'),
    others: cells.filter((c) => layer(c) !== '1' && c.attrs.vertex === '1'),
    geometry,
    points: (c: XmlElement) =>
      (geometry(c).children.find((a) => a.name === 'Array')?.children ?? []).map((p) => ({ x: Number(p.attrs.x), y: Number(p.attrs.y) })),
  }
}

describe('export', async () => {
  const model = await fixtureModel()
  const dcs = [...model.nodes.values()].filter((n) => n.kind === 'datacenter')
  const contract = await laid(contractDiagram(model))
  const core = named(model, 'fra-prod-core').id
  const coreLayout = await laid(datacenterDiagram(model, core))

  it('writes the contract view as SVG that parses, with every datacenter name once', () => {
    const { svg, width, height } = exportSvg(contract, info())
    const root = parseXml(svg)
    expect(root.name).toBe('svg')
    expect(root.attrs.xmlns).toBe('http://www.w3.org/2000/svg')
    expect(root.attrs.viewBox).toBe(`0 0 ${width} ${height}`)
    const all = texts(svg).map((t) => t.text)
    // Card titles (14.5 px); fra-mgmt is also the name of a Cross Connect line.
    const titles = texts(svg)
      .filter((t) => t.el.attrs['font-size'] === '14.5')
      .map((t) => t.text)
    expect(titles).toHaveLength(dcs.length)
    for (const dc of dcs) expect(titles.filter((t) => t === dc.name)).toHaveLength(1)
    // Internal ids stay out of the file.
    for (const dc of dcs) expect(svg).not.toContain(dc.id)
    // Title, snapshot and legend in the footer.
    expect(all).toContain('All datacenters')
    expect(all).toContain('Contract 31812345 · snapshot 2026-10-14 06:00 UTC · IONOS Explorer')
    expect(all).toEqual(expect.arrayContaining(['Cross Connect', 'VPN tunnel']))
    // Everything lies inside the picture.
    for (const t of texts(svg)) {
      expect(t.x).toBeGreaterThanOrEqual(0)
      expect(t.y).toBeGreaterThanOrEqual(0)
      expect(t.x).toBeLessThanOrEqual(width)
      expect(t.y).toBeLessThanOrEqual(height)
    }
    // No CSS, no fonts or images fetched from anywhere.
    expect(svg).not.toMatch(/<style|<image|href=|url\((?!#)/)
  })

  it('escapes names, whatever characters they hold', () => {
    const evil = 'a<b & "c" \'d\' \u0001 é 🙂'
    const l: Layout = { ...contract, nodes: contract.nodes.map((n) => (n.id === core ? { ...n, data: { ...n.data, title: evil } } : n)) }
    const { svg } = exportSvg(l, info('x < y & z'))
    expect(svg).not.toContain('a<b')
    expect(svg).toContain('a&lt;b &amp; &quot;c&quot; &apos;d&apos; \uFFFD é 🙂')
    expect(texts(svg).map((t) => t.text)).toContain('a<b & "c" \'d\' \uFFFD é 🙂')
    expect(parseXml(svg).children.find((c) => c.name === 'title')!.text).toBe('x < y & z')
    // draw.io labels are HTML in an attribute: escaped twice.
    const file = exportDrawio(l, info())
    const { vertices } = drawio(file)
    const value = vertices.map((v) => v.attrs.value).find((v) => v.includes('a&lt;b'))!
    expect(value).toContain('<b>a&lt;b &amp; &quot;c&quot; &apos;d&apos; \uFFFD é 🙂</b>')
    expect(file).toContain('&lt;b&gt;a&amp;lt;b &amp;amp;')
  })

  it('xml() leaves nothing XML cannot hold', () => {
    expect(xml('<&>"\'')).toBe('&lt;&amp;&gt;&quot;&apos;')
    expect(xml('a\u0000b\u001Fc\uFFFEd\uD800e\u0009\u000A')).toBe('a\uFFFDb\uFFFDc\uFFFDd\uFFFDe\u0009\u000A')
    expect(xml('🙂')).toBe('🙂')
  })

  it('leaves the background out when asked, for a transparent PNG', () => {
    const full = exportSvg(coreLayout, info()).svg
    const clear = exportSvg(coreLayout, info(), { transparent: true }).svg
    expect(full).toContain(`fill="${TOKENS.bg}"/>`)
    expect(clear).not.toMatch(new RegExp(`<rect width="\\d+" height="\\d+" fill="${TOKENS.bg}"/>`))
    expect(clear.length).toBeLessThan(full.length)
  })

  it('writes several views into one draw.io file, a page each', () => {
    const one = exportDrawio(coreLayout, info('fra-prod-core'))
    const both = exportDrawioPages([
      { layout: contract, info: info() },
      { layout: coreLayout, info: info('fra-prod-core') },
    ])
    const pages = parseXml(both).children.filter((c) => c.name === 'diagram')
    expect(pages.map((p) => [p.attrs.id, p.attrs.name])).toEqual([
      ['ionos-explorer', 'All datacenters'],
      ['ionos-explorer-2', 'fra-prod-core'],
    ])
    // A single view is the same file as before.
    expect(exportDrawioPages([{ layout: coreLayout, info: info('fra-prod-core') }])).toBe(one)
  })

  it('writes draw.io with one vertex per box, one edge per line and groups as containers', () => {
    for (const layout of [contract, coreLayout]) {
      const f = drawio(exportDrawio(layout, info()))
      const shown = drawnEdges(layout)
      expect(f.vertices).toHaveLength(layout.nodes.length)
      expect(f.edges).toHaveLength(shown.length)
      // Cells in layout order: n1, n2, …
      const cellOf = new Map(layout.nodes.map((n, i) => [n.id, f.byId.get(`n${i + 1}`)!]))
      const abs = absolutePositions(layout)
      for (const n of layout.nodes) {
        const c = cellOf.get(n.id)!
        const g = f.geometry(c)
        expect([Number(g.attrs.width), Number(g.attrs.height)]).toEqual([n.width, n.height].map((v) => Math.round(v * 10) / 10))
        if (n.parent) {
          const p = cellOf.get(n.parent)!
          expect(c.attrs.parent).toBe(p.attrs.id)
          expect(p.attrs.style).toContain('container=1')
          // Placed relative to the group.
          expect([Number(g.attrs.x), Number(g.attrs.y)]).toEqual([n.x, n.y].map((v) => Math.round(v * 10) / 10))
        } else expect(c.attrs.parent).toBe('1')
      }
      for (const [i, e] of shown.entries()) {
        const c = f.byId.get(`e${i + 1}`)!
        expect(c.attrs.source).toBe(cellOf.get(e.source)!.attrs.id)
        expect(c.attrs.target).toBe(cellOf.get(e.target)!.attrs.id)
        expect(c.attrs.style).toContain('endArrow=none')
        if (e.points && e.points.length > 1) {
          // Routed: straight segments through ELK's bend points, in the coordinates of the edge's parent.
          expect(c.attrs.style).toContain('edgeStyle=none')
          const parent = c.attrs.parent === '1' ? undefined : layout.nodes[Number(c.attrs.parent.slice(1)) - 1]
          const pts = f.points(c)
          expect(pts).toHaveLength(e.points.length - 2)
          if (parent) {
            const o = abs.get(parent.id)!
            pts.forEach((p, k) =>
              expect(p).toEqual({
                x: Math.round((e.points![k + 1].x - o.x) * 10) / 10,
                y: Math.round((e.points![k + 1].y - o.y) * 10) / 10,
              }),
            )
          }
        } else {
          expect(c.attrs.style).toContain('edgeStyle=orthogonalEdgeStyle')
          expect(f.points(c)).toEqual([])
        }
      }
      // Title and legend on a layer of their own.
      expect(f.others).toHaveLength(1)
      expect(f.others[0].attrs.value).toContain('IONOS Explorer')
    }
    // A line inside a location belongs to it, so it moves with the group in draw.io.
    const f = drawio(exportDrawio(contract, info()))
    const insideFra = f.edges.filter((c) => c.attrs.parent !== '1')
    expect(insideFra.length).toBeGreaterThan(0)
  })

  it('draws boxes where the user moved them', () => {
    const card = contract.nodes.find((n) => n.data.title === 'fra-prod-core')!
    const moved = applyPositions(contract, new Map([[card.id, { dx: 0, dy: 400 }]]))
    const at = (svg: string) => texts(svg).find((t) => t.text === 'fra-prod-core')!
    const other = (svg: string) => texts(svg).find((t) => t.text === 'fra-mgmt')!
    const [a, b] = [exportSvg(contract, info()).svg, exportSvg(moved, info()).svg]
    expect(at(b).x - other(b).x).toBe(at(a).x - other(a).x)
    expect(Math.round(at(b).y - other(b).y - (at(a).y - other(a).y))).toBe(400)
    // Its lines lost their routes: steps between the boxes, no waypoints in draw.io.
    const f = drawio(exportDrawio(moved, info()))
    const lost = drawnEdges(moved).flatMap((e, i) => (e.moved ? [f.byId.get(`e${i + 1}`)!] : []))
    expect(lost.length).toBeGreaterThan(0)
    for (const c of lost) {
      expect(f.points(c)).toEqual([])
      expect(c.attrs.style).not.toContain('curved=1')
    }
    // Moved far up and left: still inside the picture.
    const away = applyPositions(contract, new Map([[card.id, { dx: -3000, dy: -2000 }]]))
    const out = exportSvg(away, info())
    for (const t of texts(out.svg)) expect(Math.min(t.x, t.y)).toBeGreaterThanOrEqual(0)
    expect(out.width).toBeGreaterThan(3000)
    const g = drawio(exportDrawio(away, info()))
    for (const v of g.vertices.filter((c) => c.attrs.parent === '1')) expect(Number(g.geometry(v).attrs.x)).toBeGreaterThanOrEqual(0)
  })

  it('leaves out hidden layers and what collapsed groups hide, like the canvas', async () => {
    const lb = await laid(datacenterDiagram(model, core, { hidden: new Set(['lb']) }))
    expect(texts(exportSvg(coreLayout, info()).svg).map((t) => t.text)).toContain('fra-core-nlb')
    expect(texts(exportSvg(lb, info()).svg).map((t) => t.text)).not.toContain('fra-core-nlb')
    expect(drawio(exportDrawio(lb, info())).vertices).toHaveLength(lb.nodes.length)

    const shop = named(model, 'fra-prod-shop').id
    const closed = datacenterDiagram(model, shop)
    const group = closed.nodes.find((n) => n.type === 'group' && n.data.title === 'shop-web')!
    const words = (d: Diagram) => laid(d).then((l) => texts(exportSvg(l, info()).svg).map((t) => t.text))
    const before = await words(closed)
    expect(before).toContain('+6 more')
    expect(before).not.toContain('shop-web-12')
    const after = await words(datacenterDiagram(model, shop, { expanded: new Set([group.id]) }))
    expect(after).toContain('shop-web-12')
    expect(after).not.toContain('+6 more')

    // A router's folded LANs are counted on its box, not drawn.
    const core1 = texts(exportSvg(coreLayout, info()).svg).map((t) => t.text)
    expect(core1).toEqual(expect.arrayContaining(['7 LANs', '+2 LANs only here']))
  })

  it('draws no line that the canvas shows only on selection, and no selection or search marks', () => {
    const onDemand = coreLayout.edges.filter((e) => e.onDemand)
    expect(onDemand.length).toBeGreaterThan(0)
    const f = drawio(exportDrawio(coreLayout, info()))
    expect(f.edges).toHaveLength(coreLayout.edges.length - onDemand.length)
    const { svg } = exportSvg(coreLayout, info())
    expect(svg).not.toMatch(/opacity="0\.[23]"/)
    // Lines at rest: LAN attachments, internet, Cross Connects; no balancer targets.
    expect(legendItems(coreLayout, {}).map((i) => i.line)).toEqual(['lan', 'internet', 'cross-connect'])
  })

  it('keeps the change markers of a comparison, with the legend saying since when', async () => {
    const older = await previousFixtureModel()
    const m = markChanges(model, compareModels(older, model))
    const when = older.manifest.createdAt
    const l = await laid(datacenterDiagram(m, core))
    const changed = l.nodes.filter((n) => n.data.change)
    expect(changed.length).toBeGreaterThan(0)
    const { svg } = exportSvg(l, info('fra-prod-core', { comparedWith: when }))
    const bars = (svg.match(new RegExp(`fill="(${TOKENS['chg-added']}|${TOKENS['chg-changed']})" clip-path`, 'g')) ?? []).length
    expect(bars).toBe(changed.length)
    const all = texts(svg).map((t) => t.text)
    expect(all).toEqual(expect.arrayContaining(['New', `Changed since ${when.slice(0, 10)}`]))
    expect(all.some((t) => t.includes('compared with'))).toBe(true)
    // Datacenter cards carry their counts.
    const cards = await laid(contractDiagram(m))
    const counts = cards.nodes.flatMap((n) => (n.data.changes ? [n.data.changes] : []))
    expect(counts.length).toBeGreaterThan(0)
    const cardTexts = texts(exportSvg(cards, info('All datacenters', { comparedWith: when })).svg).map((t) => t.text)
    for (const c of counts) expect(cardTexts).toContain(c)
    // Without a comparison: no change legend.
    expect(legendItems(l, {}).some((i) => i.bar)).toBe(false)
  })

  it('exports focus and path views with their focus marked', async () => {
    const fw = named(model, 'fra-core-fw-01').id
    const focus = await laid(focusDiagram(model, [fw]))
    const f = exportSvg(focus, info('Focus: fra-core-fw-01'))
    parseXml(f.svg)
    expect(f.svg.match(/stroke-opacity="0.5" stroke-width="3"/g)).toHaveLength(1)
    expect(drawio(exportDrawio(focus, info())).vertices).toHaveLength(focus.nodes.length)

    const paths = findPaths(model, named(model, 'fra-core-web-01').id, named(model, 'pg-orders-prod').id)
    expect(paths.length).toBeGreaterThan(0)
    const path = await laid(pathDiagram(model, paths, { down: true }))
    const p = exportSvg(path, info('Path: fra-core-web-01 → pg-orders-prod'))
    expect(p.svg.match(/stroke-opacity="0.5" stroke-width="3"/g)).toHaveLength(2)
    const words = texts(p.svg).map((t) => t.text)
    expect(words).toEqual(expect.arrayContaining(['fra-core-web-01', 'pg-orders-prod', 'Path: fra-core-web-01 → pg-orders-prod']))
    const d = drawio(exportDrawio(path, info()))
    expect(d.vertices).toHaveLength(path.nodes.length)
    expect(d.edges).toHaveLength(drawnEdges(path).length)
  })

  it('cuts long names to their box', () => {
    const font = { size: 14, bold: true }
    const long = 'a-very-long-server-name-that-never-ends-01'
    const cut = fitText(long, 120, font)
    expect(cut.endsWith('…')).toBe(true)
    expect(textWidth(cut, font)).toBeLessThanOrEqual(120)
    expect(fitText('short', 120, font)).toBe('short')
    expect(fitText(long, 5, font)).toBe('')
    // Never splits a character made of two code units.
    expect(fitText('🙂🙂🙂🙂🙂🙂', 40, { size: 14 })).toMatch(/^(🙂)+…$/)
    expect(textWidth('WWW', font)).toBeGreaterThan(textWidth('iii', font))
    expect(textWidth('e\u0301', { size: 10 })).toBe(textWidth('e', { size: 10 }))
    // In the file: a long name in a member box is cut with an ellipsis.
    const l: Layout = {
      ...coreLayout,
      nodes: coreLayout.nodes.map((n) => (n.type === 'member' ? { ...n, data: { ...n.data, title: long } } : n)),
    }
    const members = texts(exportSvg(l, info()).svg).filter((t) => t.text.startsWith('a-very'))
    expect(members.length).toBe(l.nodes.filter((n) => n.type === 'member').length)
    for (const t of members) expect(t.text.endsWith('…')).toBe(true)
  })

  it('uses the light colours of index.css', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
    const light = css.slice(css.indexOf(':root {'), css.indexOf('@media'))
    for (const [k, v] of Object.entries(TOKENS)) expect(light).toContain(`--${k}: ${v};`)
    expect(mix('#0f7b6c', 7, '#ffffff')).toBe('#eef6f5')
    expect(mix('#000000', 50, '#ffffff')).toBe('#808080')
  })

  it('names files ionos-<contract>-<view>-<date>', () => {
    const at = '2026-10-14T06:00:00Z'
    expect(exportFileName({ contract: 31812345, view: 'contract', snapshot: at }, 'svg')).toBe('ionos-31812345-contract-2026-10-14.svg')
    expect(exportFileName({ contract: 31812345, view: 'fra-prod-core', snapshot: at }, 'drawio')).toBe(
      'ionos-31812345-fra-prod-core-2026-10-14.drawio',
    )
    expect(exportFileName({ contract: 1, view: 'path-web/01 → Zürich <db>', snapshot: at }, 'png')).toBe(
      'ionos-1-path-web-01-Zurich-db-2026-10-14.png',
    )
    expect(exportFileName({ view: '../../etc/passwd', snapshot: at }, 'svg')).toBe('ionos-etc-passwd-2026-10-14.svg')
    expect(exportFileName({ view: '🙂', snapshot: 'not a date' }, 'svg')).toBe('ionos-view.svg')
    const long = exportFileName({ contract: 1, view: 'x'.repeat(300), snapshot: at }, 'svg')
    expect(long).toBe(`ionos-1-${'x'.repeat(80)}-2026-10-14.svg`)
    for (const n of [long, exportFileName({ view: 'a\u0000b\nc:d*e?f"g|h', snapshot: at }, 'png')]) expect(n).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it('draws PNGs at twice the size unless that gets too large', () => {
    expect(pngScale(2000, 1500)).toBe(2)
    const s = pngScale(10312, 3422)
    expect(s).toBeLessThan(2)
    expect(10312 * 3422 * s * s).toBeLessThanOrEqual(50_000_000 + 1)
    expect(pngScale(60000, 100) * 60000).toBeLessThanOrEqual(32000)
  })
})
