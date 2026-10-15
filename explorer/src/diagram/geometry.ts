import type { Point } from './types'

/** Orthogonal route with rounded corners. */
export function roundedPath(points: Point[], radius = 8): string {
  if (points.length === 0) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const [prev, p, next] = [points[i - 1], points[i], points[i + 1]]
    const r = Math.min(radius, dist(prev, p) / 2, dist(p, next) / 2)
    const a = towards(p, prev, r)
    const b = towards(p, next, r)
    d += ` L ${a.x} ${a.y} Q ${p.x} ${p.y} ${b.x} ${b.y}`
  }
  const last = points[points.length - 1]
  return `${d} L ${last.x} ${last.y}`
}

/** Point halfway along a polyline. */
export function midpoint(points: Point[]): Point {
  const total = points.slice(1).reduce((s, p, i) => s + dist(points[i], p), 0)
  let left = total / 2
  for (let i = 1; i < points.length; i++) {
    const seg = dist(points[i - 1], points[i])
    if (seg >= left && seg > 0) return towards(points[i - 1], points[i], left)
    left -= seg
  }
  return points[0]
}

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)

function towards(from: Point, to: Point, len: number): Point {
  const d = dist(from, to)
  return d === 0 ? from : { x: from.x + ((to.x - from.x) * len) / d, y: from.y + ((to.y - from.y) * len) / d }
}
