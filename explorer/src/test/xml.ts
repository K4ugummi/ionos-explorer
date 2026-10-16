/**
 * A small, strict XML parser for tests (Node has no DOMParser): elements,
 * attributes, text, comments, the XML declaration and the five named
 * entities plus character references. Throws on anything not well-formed
 * that matters here: unescaped `<` or `&`, mismatched or unclosed tags,
 * duplicate attributes, characters XML 1.0 forbids.
 */
export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlElement[]
  /** The element's own text (not its children's), entities decoded. */
  text: string
  parent?: XmlElement
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const NAME = /^[A-Za-z_:][\w.:-]*/
const FORBIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function decode(s: string, at: number): string {
  if (/</.test(s)) throw new Error(`unescaped < near ${at}`)
  return s.replace(/&([^;\s]*);?/g, (m, e: string) => {
    if (!m.endsWith(';')) throw new Error(`bare & near ${at}`)
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16))
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10))
    if (!(e in ENTITIES)) throw new Error(`unknown entity &${e}; near ${at}`)
    return ENTITIES[e]
  })
}

export function parseXml(src: string): XmlElement {
  if (FORBIDDEN.test(src)) throw new Error('character not allowed in XML')
  let i = 0
  const root: XmlElement = { name: '#document', attrs: {}, children: [], text: '' }
  let cur = root
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    const text = src.slice(i, lt < 0 ? src.length : lt)
    if (text.trim()) {
      if (cur === root) throw new Error(`text outside the root element near ${i}`)
      cur.text += decode(text, i)
    }
    if (lt < 0) break
    i = lt
    if (src.startsWith('<?', i)) {
      i = src.indexOf('?>', i) + 2
    } else if (src.startsWith('<!--', i)) {
      i = src.indexOf('-->', i) + 3
    } else if (src.startsWith('</', i)) {
      const end = src.indexOf('>', i)
      const name = src.slice(i + 2, end).trim()
      if (name !== cur.name) throw new Error(`</${name}> closes <${cur.name}> near ${i}`)
      cur = cur.parent!
      i = end + 1
    } else {
      i++
      const name = NAME.exec(src.slice(i))?.[0]
      if (!name) throw new Error(`bad tag near ${i}`)
      i += name.length
      const el: XmlElement = { name, attrs: {}, children: [], text: '', parent: cur }
      for (;;) {
        const m = /^\s*(?:(\/?>)|([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'))/.exec(src.slice(i))
        if (!m) throw new Error(`bad attribute in <${name}> near ${i}`)
        i += m[0].length
        if (m[1]) {
          if (cur === root && root.children.length) throw new Error('more than one root element')
          cur.children.push(el)
          if (m[1] === '>') cur = el
          break
        }
        if (m[2] in el.attrs) throw new Error(`duplicate attribute ${m[2]} in <${name}>`)
        el.attrs[m[2]] = decode(m[3] ?? m[4], i)
      }
    }
  }
  if (cur !== root) throw new Error(`<${cur.name}> is not closed`)
  if (root.children.length !== 1) throw new Error('no root element')
  return root.children[0]
}

/** All elements below `el` (depth first, document order). */
export function descendants(el: XmlElement): XmlElement[] {
  return el.children.flatMap((c) => [c, ...descendants(c)])
}
