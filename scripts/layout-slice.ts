// Deterministic graph layout shared by the renderer and validator.
//
// Small slices keep the model-authored composition from annotations.json.
// Large slices use an expandable, deterministic grid so node count affects
// density and canvas size, never whether the artifact can be produced.

export const BASE_CANVAS = { width: 1180, height: 620 }
export const NODE_BOX = { width: 168, height: 48 }
export const MANUAL_LAYOUT_THRESHOLD = 20
export const LARGE_FILE_WARNING_THRESHOLD = 100

export type LayoutPoint = { x: number; y: number }
export type LayoutNode = { id: string; status: string }
export type LayoutEdge = { from: string; to: string }
export type LayoutResult = {
  mode: 'manual' | 'automatic'
  positions: Record<string, LayoutPoint>
  canvas: { width: number; height: number }
}

const HORIZONTAL_STEP = 224
const VERTICAL_STEP = 92
const CANVAS_PADDING = 40
const MIN_EPICENTER_SEPARATION = 200
const CHANGED = new Set(['added', 'modified', 'deleted'])
const STATUS_RANK: Record<string, number> = {
  modified: 0,
  added: 1,
  deleted: 2,
  blast: 3,
  context: 4,
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Above the manual-layout threshold, pack every node into a stable expanded
 * canvas. Epicenters land first, their direct neighbors follow, and higher
 * degree nodes stay nearer the center. No random seed or traversal order can
 * change the result.
 */
export function resolveGraphLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  epicenters: string[],
  annotated: Record<string, LayoutPoint> = {},
): LayoutResult {
  if (nodes.length <= MANUAL_LAYOUT_THRESHOLD) {
    return {
      mode: 'manual',
      positions: annotated,
      canvas: { ...BASE_CANVAS },
    }
  }

  const count = nodes.length
  const columns = Math.max(1, Math.ceil(Math.sqrt(count * 0.82)))
  const rows = Math.ceil(count / columns)
  const usedWidth = NODE_BOX.width + (columns - 1) * HORIZONTAL_STEP
  const usedHeight = NODE_BOX.height + (rows - 1) * VERTICAL_STEP
  const canvas = {
    width: Math.max(BASE_CANVAS.width, usedWidth + CANVAS_PADDING * 2),
    height: Math.max(BASE_CANVAS.height, usedHeight + CANVAS_PADDING * 2),
  }
  const firstX = (canvas.width - usedWidth) / 2 + NODE_BOX.width / 2
  const firstY = (canvas.height - usedHeight) / 2 + NODE_BOX.height / 2
  const centerX = canvas.width / 2
  const centerY = canvas.height / 2

  const cells: LayoutPoint[] = []
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      cells.push({
        x: firstX + column * HORIZONTAL_STEP,
        y: firstY + row * VERTICAL_STEP,
      })
    }
  }
  cells.sort(
    (a, b) =>
      Math.hypot(a.x - centerX, a.y - centerY) - Math.hypot(b.x - centerX, b.y - centerY) ||
      a.y - b.y ||
      a.x - b.x,
  )

  const degree = new Map<string, number>()
  const epicenterSet = new Set(epicenters)
  const epicenterNeighbors = new Set<string>()
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
    if (epicenterSet.has(edge.from)) epicenterNeighbors.add(edge.to)
    if (epicenterSet.has(edge.to)) epicenterNeighbors.add(edge.from)
  }

  const ordered = [...nodes].sort((a, b) => {
    const group = (node: LayoutNode) => {
      if (epicenterSet.has(node.id)) return 0
      if (epicenterNeighbors.has(node.id)) return 1
      if (CHANGED.has(node.status)) return 2
      return 3
    }
    return (
      group(a) - group(b) ||
      (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99) ||
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
      byString(a.id, b.id)
    )
  })

  const positions: Record<string, LayoutPoint> = {}
  const available = [...cells]
  const placedEpicenters: LayoutPoint[] = []
  for (const node of ordered) {
    let cellIndex = 0
    if (epicenterSet.has(node.id) && placedEpicenters.length) {
      const separated = available.findIndex((candidate) =>
        placedEpicenters.every((placed) => Math.hypot(candidate.x - placed.x, candidate.y - placed.y) >= MIN_EPICENTER_SEPARATION),
      )
      if (separated >= 0) cellIndex = separated
    }
    const [point] = available.splice(cellIndex, 1)
    positions[node.id] = point
    if (epicenterSet.has(node.id)) placedEpicenters.push(point)
  }

  return { mode: 'automatic', positions, canvas }
}
