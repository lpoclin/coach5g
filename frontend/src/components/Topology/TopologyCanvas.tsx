import { useEffect, useRef, useCallback, useMemo, useState, memo } from 'react'
import cytoscape, { Core, ElementDefinition, EventObject, NodeSingular, EdgeSingular } from 'cytoscape'
import { useNavigate } from 'react-router-dom'
import type { TopologyGraph, TopologyNode, TopologyEdge, NetworkInterface } from '@/types/topology'

// ─── Props & internal types ───────────────────────────────────────────────────

interface Props {
  graph: TopologyGraph
  onNodeClick: (node: TopologyNode) => void
  onEdgeClick: (edge: TopologyEdge, sourceNode: TopologyNode) => void
  selectedNodeId?: string | null
  trafficEdgeIds?: Set<string>
  namespace?: string
  sidePanelOpen?: boolean
}

interface NodeTip {
  node: TopologyNode
  pos: { x: number; y: number }
}

interface DotTip {
  node: TopologyNode
  iface: string
  pos: { x: number; y: number }
}

interface EndpointDot {
  x: number; y: number
  node: TopologyNode
  iface: string
  edge: TopologyEdge
  isActive: boolean
}

// ─── Colors ───────────────────────────────────────────────────────────────────

const BG          = '#0d1117'
const NODE_FILL   = '#e6edf3'
const NODE_BORDER = '#30363d'
const SIGNAL_CLR  = '#58a6ff'
const UP_CLR      = '#3fb950'
// N4 is control-plane (PFCP) — same blue as signaling, dashed to distinguish

const MUTED       = '#8b949e'
const BADGE_OK    = '#3fb950'
const BADGE_WARN  = '#d29922'
const BADGE_ERR   = '#f85149'
const DOT_IDLE    = '#30363d'

// ─── 3GPP TS 23.501 fig 4.2.3-1 layout ──────────────────────────────────────

const TOP_ROW_Y = 80    // NSSF, NEF, NRF, PCF, UDM, AUSF, CHF, UDR
const BUS_Y     = 175   // SBI bus horizontal line (model space)
const MID_ROW_Y = 270   // AMF, SMF
const BOT_ROW_Y = 480   // UE, gNB, iUPF / PSA-UPF / DN

// Ordered left→right positions for top-row NFs. Fixed 130px step, centered
// on the same X=535 midpoint as the original 8-entry free5GC-only row (SCP
// and BSF, Open5GS-only, are added as one new slot at each end -- this
// preserves every original value unchanged rather than shifting them).
const TOP_NF_X: Partial<Record<string, number>> = {
  SCP: -50, NSSF: 80, NEF: 210, NRF: 340, PCF: 470, UDM: 600, AUSF: 730, CHF: 860, UDR: 990, BSF: 1120,
}
const TOP_ROW_TYPES = new Set(['SCP', 'NSSF', 'NEF', 'NRF', 'PCF', 'UDM', 'AUSF', 'CHF', 'UDR', 'BSF'])

function computePositions(
  nodes: TopologyNode[],
  saved?: Record<string, { x: number; y: number }>,
  edges?: TopologyEdge[],
): Map<string, { x: number; y: number }> {
  const nodeW   = 120   // logical node width for layout spacing
  // DN-from-UPF horizontal offset -- deliberately its own constant, not
  // reused from nodeW * 0.6 (psaSpacing's unrelated value), sized to clear
  // both nodes' own half-widths plus a real visible gap. PSA-UPF/UPF nodes
  // use the default Cytoscape node width (80); DN nodes get the narrower
  // 'sm' class width (70) -- see the node stylesheet/classification below.
  const UPF_HALF_WIDTH = 40   // 80 / 2
  const DN_HALF_WIDTH  = 35   // 70 / 2
  const DN_GAP         = 150  // desired visible gap between UPF's right edge and DN's left edge
  const dnOffsetFromUpf = UPF_HALF_WIDTH + DN_GAP + DN_HALF_WIDTH   // 225
  const isULCL = nodes.some(n => n.nfType === 'iUPF')
  const pos = new Map<string, { x: number; y: number }>()
  if (saved) for (const n of nodes) if (saved[n.id]) pos.set(n.id, saved[n.id])

  // Group by logical type
  const groups = new Map<string, TopologyNode[]>()
  for (const n of nodes) {
    if (n.nfType === 'DN') continue
    const key = n.nfType === 'UPF' && n.displayName.startsWith('PSA-UPF') ? 'PSA_UPF' : n.nfType
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(n)
  }

  const place = (nfType: string, baseX: number, y: number, spacingX = 130) => {
    const group = groups.get(nfType) ?? []
    group.forEach((n, i) => {
      if (pos.has(n.id)) return
      const off = group.length > 1 ? (i - (group.length - 1) / 2) * spacingX : 0
      pos.set(n.id, { x: baseX + off, y })
    })
  }

  // Top row: fixed X positions per spec
  for (const nfType of ['SCP', 'NSSF', 'NEF', 'NRF', 'PCF', 'UDM', 'AUSF', 'CHF', 'UDR', 'BSF']) {
    place(nfType, TOP_NF_X[nfType] ?? 500, TOP_ROW_Y)
  }

  // Mid row: AMF center-left, SMF center-right
  place('AMF', 310, MID_ROW_Y)
  place('SMF', 680, MID_ROW_Y)

  // Bottom row
  place('UE',  80,  BOT_ROW_Y, 80)
  place('gNB', 240, BOT_ROW_Y, 80)

  if (isULCL) {
    place('iUPF', 440, BOT_ROW_Y, 80)
    const psas       = groups.get('PSA_UPF') ?? []
    const psaSpacing = nodeW * 0.6
    const psaTotalW  = (psas.length - 1) * psaSpacing
    psas.forEach((n, i) => {
      if (pos.has(n.id)) return
      const xOff = i * psaSpacing - psaTotalW / 2
      const yOff = psas.length > 1 ? (i === 0 ? -50 : 50) : 0
      pos.set(n.id, { x: 660 + xOff, y: BOT_ROW_Y + yOff })
    })
  } else {
    place('UPF', 480, BOT_ROW_Y, 130)
  }

  // DN nodes — each DNN gets its own row, aligned to the Y of the UPF(s)
  // that actually serve it (via N6 edges); a DNN shared by multiple UPFs
  // sits at the vertical midpoint between them. Falls back to the previous
  // mirrored-offset/hardcoded anchor only when a DN's serving UPF(s) can't
  // be resolved from edges (e.g. missing/incomplete edge data), so nothing
  // regresses to an undefined position.
  const dns        = nodes.filter(n => n.nfType === 'DN')
  const psasForDn  = groups.get('PSA_UPF') ?? []
  const iupfs      = groups.get('iUPF') ?? []
  const lastPsa    = psasForDn[psasForDn.length - 1]
  const lastPsaPos = pos.get(lastPsa?.id)
  const iupfPos    = pos.get(iupfs[0]?.id)
  const psa0Pos    = pos.get(psasForDn[0]?.id)

  let fallbackBaseX = isULCL ? 860 : 680
  let fallbackY     = BOT_ROW_Y
  if (iupfPos && psa0Pos && lastPsaPos) {
    const dx = psa0Pos.x - iupfPos.x   // same Δx as iUPF1 → PSA-UPF1
    const dy = psa0Pos.y - iupfPos.y   // same Δy as iUPF1 → PSA-UPF1
    fallbackBaseX = lastPsaPos.x + dx
    fallbackY     = lastPsaPos.y + dy
  } else if (lastPsaPos) {
    fallbackBaseX = lastPsaPos.x + nodeW * 0.6
    fallbackY     = lastPsaPos.y
  }

  // DN ID → serving UPF node IDs, from N6 edges.
  const upfsByDn = new Map<string, string[]>()
  for (const e of edges ?? []) {
    if (e.interface !== 'n6') continue
    const list = upfsByDn.get(e.target) ?? []
    list.push(e.source)
    upfsByDn.set(e.target, list)
  }

  // Bucket DN nodes into rows keyed by resolved Y, so DNs sharing a row
  // (e.g. one UPF serving two DNNs) still space out on X the same way the
  // previous single-row logic did.
  interface DnRow { y: number; baseX: number; members: TopologyNode[] }
  const rows: DnRow[] = []
  const rowForY = (y: number, baseX: number): DnRow => {
    let row = rows.find(r => Math.abs(r.y - y) < 1)
    if (!row) { row = { y, baseX, members: [] }; rows.push(row) }
    return row
  }

  for (const dn of dns) {
    if (pos.has(dn.id)) continue
    const upfPositions = (upfsByDn.get(dn.id) ?? [])
      .map(id => pos.get(id))
      .filter((p): p is { x: number; y: number } => !!p)

    let y: number
    let baseXForRow: number
    if (upfPositions.length === 1) {
      y = upfPositions[0].y
      baseXForRow = upfPositions[0].x + dnOffsetFromUpf
    } else if (upfPositions.length > 1) {
      y = upfPositions.reduce((sum, p) => sum + p.y, 0) / upfPositions.length
      baseXForRow = Math.max(...upfPositions.map(p => p.x)) + dnOffsetFromUpf
    } else {
      y = fallbackY
      baseXForRow = fallbackBaseX
    }
    rowForY(y, baseXForRow).members.push(dn)
  }

  for (const row of rows) {
    row.members.forEach((n, i) => {
      const off = (i - (row.members.length - 1) / 2) * 130
      pos.set(n.id, { x: row.baseX + off, y: row.y })
    })
  }

  return pos
}

// ─── Edge style by interface ──────────────────────────────────────────────────

function eStyle(iface: string): { lineColor: string; lineStyle: 'solid' | 'dashed'; width: number; opacity: number } {
  switch (iface) {
    case 'n1':  return { lineColor: '#f0f6fc', lineStyle: 'solid',  width: 0,   opacity: 0    }
    case 'n2':  return { lineColor: SIGNAL_CLR, lineStyle: 'solid',  width: 2,   opacity: 0.85 }
    case 'n3':  return { lineColor: UP_CLR,    lineStyle: 'solid',  width: 2,   opacity: 0.85 }
    case 'n4':  return { lineColor: SIGNAL_CLR, lineStyle: 'dashed', width: 2,   opacity: 0.85 }
    case 'n6':  return { lineColor: UP_CLR,    lineStyle: 'solid',  width: 2,   opacity: 0.85 }
    case 'n9':  return { lineColor: UP_CLR,    lineStyle: 'solid',  width: 2,   opacity: 0.85 }
    case 'sbi': return { lineColor: SIGNAL_CLR, lineStyle: 'dashed', width: 1.5, opacity: 0.65 }
    default:    return { lineColor: NODE_BORDER, lineStyle: 'dashed', width: 1,   opacity: 0.4  }
  }
}

function getCNILabel(ifaceObj: NetworkInterface | undefined, primaryCNI: string, secondaryCNI: string): string {
  if (!ifaceObj) return ''
  if (ifaceObj.isDefault) return primaryCNI
  if (ifaceObj.name && ifaceObj.name !== '') return secondaryCNI
  const n = ifaceObj.interface.toLowerCase()
  if (n.includes('gtp'))                           return 'GTP'
  if (n.includes('tun'))                           return 'TUN'
  if (n.startsWith('dpdk'))                        return 'DPDK'
  if (n.startsWith('xdp') || n.startsWith('bpf'))  return 'eBPF/XDP'
  if (n.startsWith('veth'))                        return 'veth'
  return ''
}

const METRICS_REFRESH_MS = 300

// ─── Cytoscape stylesheet ─────────────────────────────────────────────────────

function buildStylesheet() {
  return [
    {
      selector: 'node',
      style: {
        'background-color': NODE_FILL,
        'border-color': BADGE_OK,
        'border-width': 3.5,
        'outline-width': 2,
        'outline-color': BG,
        'outline-offset': 0,
        'label': 'data(label)',
        'color': BG,
        'font-size': 14,
        'font-weight': 'bold',
        'font-family': 'Inter, system-ui, sans-serif',
        'text-valign': 'center',
        'text-halign': 'center',
        'width': 80,
        'height': 36,
        'shape': 'roundrectangle',
        'overlay-opacity': 0,
      } as cytoscape.Css.Node,
    },
    { selector: 'node.sm', style: { 'width': 70 } as cytoscape.Css.Node },
    {
      selector: 'node:selected',
      style: { 'border-color': '#00d9ff', 'border-width': 4, 'outline-width': 2, 'outline-color': BG, 'outline-offset': 0, 'background-color': '#d4e8ff' } as cytoscape.Css.Node,
    },
    {
      selector: 'node.hover',
      style: { 'border-color': '#6ee87a', 'border-width': 3.5, 'outline-width': 2, 'outline-color': BG, 'outline-offset': 0, 'overlay-color': '#6ee87a', 'overlay-opacity': 0.06 } as cytoscape.Css.Node,
    },
    { selector: 'node.error',    style: { 'border-color': BADGE_ERR,  'border-width': 3.5, 'outline-width': 2, 'outline-color': BG, 'outline-offset': 0 } as cytoscape.Css.Node },
    { selector: 'node.degraded', style: { 'border-color': BADGE_WARN, 'border-width': 3.5, 'outline-width': 2, 'outline-color': BG, 'outline-offset': 0 } as cytoscape.Css.Node },
    {
      selector: 'edge',
      style: {
        'curve-style': 'straight',
        'target-arrow-shape': 'none',
        'line-color': 'data(lineColor)',
        'line-style': 'data(lineStyle)',
        'line-dash-pattern': 'data(dashPattern)',
        'width': 'data(width)',
        'opacity': 'data(opacity)',
        'overlay-opacity': 0,
        'label': 'data(label)',
        'font-size': 12,
        'font-weight': 'bold',
        'color': '#ffffff',
        'text-rotation': 'autorotate',
        'text-background-color': BG,
        'text-background-opacity': 0.9,
        'text-background-padding': '2px',
      } as unknown as cytoscape.Css.Edge,
    },
    { selector: 'edge.hover',    style: { 'opacity': 1 } as cytoscape.Css.Edge },
    { selector: 'edge:selected', style: { 'opacity': 1, 'overlay-opacity': 0 } as cytoscape.Css.Edge },
    { selector: '.faded',        style: { 'opacity': 0.08 } as cytoscape.Css.Node & cytoscape.Css.Edge },
  ]
}

// ─── Cytoscape elements ───────────────────────────────────────────────────────

function buildElements(
  graph: TopologyGraph,
  positions: Map<string, { x: number; y: number }>,
): ElementDefinition[] {
  const els: ElementDefinition[] = []

  for (const node of graph.nodes) {
    const pos = positions.get(node.id) ?? { x: 700, y: 400 }
    const sm = node.nfType === 'gNB' || node.nfType === 'UE' || node.nfType === 'DN'
    const statusClass = ['CrashLoopBackOff', 'Error', 'OOMKilled'].includes(node.status.condition)
      ? 'error'
      : (node.status.condition === 'Pending' || node.status.condition === 'Unknown' || node.status.restarts > 3)
        ? 'degraded'
        : ''
    const classes = [sm ? 'sm' : '', statusClass].filter(Boolean).join(' ') || undefined
    els.push({
      group: 'nodes',
      data: {
        id: node.id,
        label: node.displayName,
        status: node.status.condition,
        restarts: node.status.restarts,
        _node: node,
      },
      classes,
      position: pos,
    })
  }

  for (const edge of graph.edges) {
    // SBI bus edges are drawn on the canvas overlay — skip as Cytoscape edges
    if (edge.busEdge) continue
    const s = eStyle(edge.interface)
    els.push({
      group: 'edges',
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label || edge.interface.toUpperCase(),
        lineColor: s.lineColor,
        lineStyle: s.lineStyle,
        dashPattern: s.lineStyle === 'dashed' ? [6, 4] : [1, 0],
        width: s.width,
        opacity: s.opacity,
        iface: edge.interface,
        _edge: edge,
      },
    })
  }
  return els
}

// ─── Canvas overlay helpers ───────────────────────────────────────────────────

function badgeColor(status: string, restarts: number): string {
  if (['CrashLoopBackOff', 'Error', 'OOMKilled'].includes(status)) return BADGE_ERR
  if (status === 'Pending' || status === 'Unknown') return BADGE_WARN
  if (restarts > 3) return BADGE_WARN
  return BADGE_OK
}

// Draws a sequence of small ">"-shaped chevrons spanning the actual on-screen
// distance from src to dst, spaced at a fixed pixel interval and animated via
// `phase` to suggest flow in the src->dst direction. Recomputes distance/unit
// vector every call (every frame), so it stays correct under zoom, pan, and
// manual dragging. `maxHalfHeight` caps each chevron's perpendicular size at
// or below the caller's own node block height -- never a fixed raw-pixel
// constant -- so the glyphs can never visually spill outside the node.
function drawChevrons(
  ctx: CanvasRenderingContext2D,
  src: { x: number; y: number }, dst: { x: number; y: number },
  phase: number, active: boolean, maxHalfHeight: number,
) {
  const dx = dst.x - src.x
  const dy = dst.y - src.y
  const dist = Math.hypot(dx, dy)
  if (dist < 1) return
  const ux = dx / dist
  const uy = dy / dist
  const angle = Math.atan2(dy, dx)

  const spacing  = 16
  const halfH    = Math.min(6, maxHalfHeight)
  const depth    = halfH * 0.9
  const offset   = (phase % 1) * spacing
  const count    = Math.floor(dist / spacing)

  ctx.strokeStyle = '#f0f6fc'
  ctx.lineWidth = active ? 1.5 : 1
  for (let i = 0; i <= count; i++) {
    const d = i * spacing + offset
    if (d < 0 || d > dist) continue
    // Fade near both ends of the actual edge, not a per-glyph radius fade.
    const edgeFade = Math.min(1, Math.min(d, dist - d) / spacing)
    const a = edgeFade * (active ? 0.85 : 0.2)
    if (a <= 0.01) continue
    ctx.save()
    ctx.translate(src.x + ux * d, src.y + uy * d)
    ctx.rotate(angle)
    ctx.beginPath()
    ctx.moveTo(-depth, -halfH)
    ctx.lineTo(depth, 0)
    ctx.lineTo(-depth, halfH)
    ctx.globalAlpha = a
    ctx.stroke()
    ctx.restore()
  }
  ctx.globalAlpha = 1
}

function drawEndDot(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, color: string, active: boolean, t: number,
) {
  const R = 5  // 10px diameter (E1)
  if (active) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 4)
    ctx.beginPath()
    ctx.arc(x, y, R + pulse * 3, 0, Math.PI * 2)
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.25 * (1 - pulse * 0.5)
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  ctx.beginPath()
  ctx.arc(x, y, R, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.strokeStyle = BG
  ctx.lineWidth = 1.5
  ctx.stroke()
}

function runDraw(
  canvas: HTMLCanvasElement | null,
  cy: Core | null,
  t: number,
  traffic: Set<string>,
  dotsRef: { current: EndpointDot[] },
  nodeMap: Map<string, TopologyNode>,
  sbiLabels: Map<string, string>,   // nodeId → SBI label (e.g. "Namf")
) {
  if (!canvas || !cy) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const pan  = cy.pan()
  const zoom = cy.zoom()
  const toS  = (p: { x: number; y: number }) => ({ x: p.x * zoom + pan.x, y: p.y * zoom + pan.y })

  // ── SBI Bus ──────────────────────────────────────────────────────────────
  const busScrY = BUS_Y * zoom + pan.y

  // Collect top-row and mid-row nodes for connector drawing
  let busXMin = Infinity
  let busXMax = -Infinity

  interface Connector {
    screenX: number
    screenY: number   // end at node (not bus) — top-row = node bottom, mid-row = node top
    isTop: boolean    // true = connector goes DOWN to bus
    label: string
    node: TopologyNode  // for eth0 dot (D8)
  }
  const connectors: Connector[] = []

  cy.nodes().forEach(cn => {
    const nodeData = cn.data('_node') as TopologyNode | undefined
    if (!nodeData) return
    const nfType = nodeData.nfType as string
    const sp = cn.renderedPosition()
    const w  = cn.renderedWidth()
    const h  = cn.renderedHeight()

    if (TOP_ROW_TYPES.has(nfType)) {
      busXMin = Math.min(busXMin, sp.x - w / 2)
      busXMax = Math.max(busXMax, sp.x + w / 2)
      const label = nfType === 'NRF' ? 'Nnrf' : (sbiLabels.get(nodeData.id) ?? '')
      connectors.push({ screenX: sp.x, screenY: sp.y + h / 2, isTop: true, label, node: nodeData })
    } else if (nfType === 'AMF' || nfType === 'SMF') {
      const label = sbiLabels.get(nodeData.id) ?? (nfType === 'AMF' ? 'Namf' : 'Nsmf')
      connectors.push({ screenX: sp.x, screenY: sp.y - h / 2, isTop: false, label, node: nodeData })
    }
  })

  if (busXMin !== Infinity) {
    const pad = 40 * zoom

    // Bus line (E4: 4px thickness)
    ctx.beginPath()
    ctx.moveTo(busXMin - pad, busScrY)
    ctx.lineTo(busXMax + pad, busScrY)
    ctx.strokeStyle = SIGNAL_CLR
    ctx.lineWidth = 4
    ctx.stroke()

    // Bus label — just inside the left end of the line, below it
    ctx.font = 'bold 11px "Inter, system-ui, sans-serif"'
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText('SBI', busXMin - pad + 8, busScrY + 10)
    ctx.textBaseline = 'alphabetic'

    // Connectors + interface labels
    ctx.setLineDash([Math.max(3, 4 * zoom), Math.max(2, 3 * zoom)])
    for (const c of connectors) {
      const connEnd = c.screenY
      ctx.beginPath()
      ctx.moveTo(c.screenX, connEnd)
      ctx.lineTo(c.screenX, busScrY)
      ctx.strokeStyle = SIGNAL_CLR
      ctx.globalAlpha = 0.7
      ctx.lineWidth = Math.max(1, 1.5 * zoom)
      ctx.stroke()
      ctx.globalAlpha = 1

      // Fix 7: Interface label — bold 12px, centered on connector, middle baseline
      if (c.label) {
        const midY = (connEnd + busScrY) / 2
        ctx.font = 'bold 12px Inter, system-ui, sans-serif'
        ctx.fillStyle = '#ffffff'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(c.label, c.screenX, midY)
        ctx.textBaseline = 'alphabetic'
      }
    }
    ctx.setLineDash([])
    ctx.textAlign = 'left'
  }

  // ── Status pulse ring ────────────────────────────────────────────────────
  cy.nodes().forEach(cn => {
    const p     = cn.renderedPosition()
    const color = badgeColor(cn.data('status') as string, (cn.data('restarts') as number) ?? 0)
    if (color !== BADGE_OK) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 3)
      ctx.beginPath()
      ctx.arc(p.x, p.y, 9 + pulse * 4, 0, Math.PI * 2)
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.35 * (1 - pulse)
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  })

  // ── Wireless chevrons N1 ──────────────────────────────────────────────────
  cy.edges().filter(e => e.data('iface') === 'n1').forEach(e => {
    const srcNode = e.source() as NodeSingular
    const dstNode = e.target() as NodeSingular
    const sp      = srcNode.renderedPosition()
    const dp      = dstNode.renderedPosition()
    const active  = traffic.has(e.id())
    // Cap chevron size against the smaller of the two endpoint nodes' own
    // rendered height, so it stays correct (and never overflows) under zoom.
    const maxHalfHeight = Math.min(srcNode.renderedHeight(), dstNode.renderedHeight()) / 2 - 2
    drawChevrons(ctx, sp, dp, (t * 0.8) % 1, active, maxHalfHeight)
    drawChevrons(ctx, dp, sp, (t * 0.65 + 0.5) % 1, active, maxHalfHeight)
  })

  // ── Traffic moving dots ────────────────────────────────────────────────────
  cy.edges().forEach(ce => {
    if (ce.data('iface') === 'n1') return
    if (!traffic.has(ce.id())) return
    const srcEp = toS(ce.sourceEndpoint())
    const dstEp = toS(ce.targetEndpoint())
    const lc    = ce.data('lineColor') as string
    for (let i = 0; i < 3; i++) {
      const ph = ((t * 0.55 + i / 3) % 1)
      const x  = srcEp.x + (dstEp.x - srcEp.x) * ph
      const y  = srcEp.y + (dstEp.y - srcEp.y) * ph
      const alpha = Math.max(0, 1 - Math.abs(ph - 0.5) * 2.5)
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fillStyle = lc
      ctx.globalAlpha = alpha
      ctx.fill()
    }
    ctx.globalAlpha = 1
  })

  // ── Endpoint dots ──────────────────────────────────────────────────────────
  const dots: EndpointDot[] = []

  cy.edges().forEach(ce => {
    const iface = ce.data('iface') as string
    if (iface === 'n1' || iface === 'sbi') return
    const edgeData = ce.data('_edge') as TopologyEdge
    if (!edgeData) return

    const srcEp = toS(ce.sourceEndpoint())
    const dstEp = toS(ce.targetEndpoint())
    const lc    = ce.data('lineColor') as string
    const active = traffic.has(ce.id())
    const color  = active ? lc : DOT_IDLE

    const srcN = nodeMap.get(edgeData.source)
    const dstN = nodeMap.get(edgeData.target)

    if (srcN) {
      drawEndDot(ctx, srcEp.x, srcEp.y, color, active, t)
      dots.push({ x: srcEp.x, y: srcEp.y, node: srcN, iface, edge: edgeData, isActive: active })
    }
    if (dstN) {
      drawEndDot(ctx, dstEp.x, dstEp.y, color, active, t)
      dots.push({ x: dstEp.x, y: dstEp.y, node: dstN, iface, edge: edgeData, isActive: active })
    }
  })

  // D8: eth0 dots at SBI bus connector node endpoints (one per NF on the bus)
  for (const c of connectors) {
    drawEndDot(ctx, c.screenX, c.screenY, DOT_IDLE, false, t)
    dots.push({
      x: c.screenX,
      y: c.screenY,
      node: c.node,
      iface: 'eth0',
      edge: {
        id: `sbi-eth0-${c.node.id}`,
        source: c.node.id,
        target: '',
        interface: 'eth0',
        label: 'eth0',
        plane: 'sbi',
        busEdge: true,
      } as TopologyEdge,
      isActive: false,
    })
  }

  dotsRef.current = dots
}

// ─── Tooltip components ───────────────────────────────────────────────────────

function condColor(c: string) {
  if (c === 'Running') return 'text-green-500'
  if (['CrashLoopBackOff', 'Error', 'OOMKilled'].includes(c)) return 'text-red-400'
  if (c === 'Pending') return 'text-yellow-400'
  return 'text-slate-400'
}

function NodeTipBox({ tip, onEnter, onLeave }: { tip: NodeTip; onEnter: () => void; onLeave: () => void }) {
  const n = tip.node
  const style: React.CSSProperties = {
    position: 'absolute',
    left: tip.pos.x,
    top: tip.pos.y,
    zIndex: 50,
    pointerEvents: 'auto',
    maxWidth: 280,
    background: '#161b22',
    border: `1px solid ${NODE_BORDER}`,
    transition: 'opacity 120ms ease',
    opacity: 1,
  }
  return (
    <div
      style={style}
      className="rounded-lg p-3 text-xs shadow-2xl"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onMouseMove={e => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="font-bold text-sm" style={{ color: '#e6edf3' }}>{n.displayName}</span>
        <span className={`font-medium ${condColor(n.status.condition)}`}>● {n.status.condition}</span>
      </div>
      <div className="font-mono mb-1.5" style={{ color: MUTED }}>Pod: {n.podName}</div>

      {n.interfaces.length > 0 && (
        <div className="space-y-0.5 mb-1.5">
          {n.interfaces.map(iface => (
            <div key={iface.interface} className="flex gap-2">
              <span className="w-20 shrink-0 font-mono" style={{ color: SIGNAL_CLR }}>{iface.interface}:</span>
              <span className="font-mono" style={{ color: '#e6edf3' }}>{iface.ips.join(', ')}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-4 pt-1.5" style={{ borderTop: `1px solid ${NODE_BORDER}`, color: MUTED }}>
        {n.status.restarts > 0 && <span style={{ color: BADGE_WARN }}>↺ {n.status.restarts} restarts</span>}
        <span>Age: {n.age}</span>
        {n.nodeName && <span>Node: {n.nodeName}</span>}
      </div>
      <div className="mt-1.5">
        <span style={{ color: '#abb2bf', fontSize: '11px' }}>Click to view logs &amp; metrics</span>
      </div>
    </div>
  )
}

interface IfaceMetrics { throughputMbps: number; packetsPerSec: number; dropRate: number; isCilium?: boolean }

function DotTipBox({
  tip, onCapture, onEnter, onLeave, metrics, metricsLoading, locked, onClose, primaryCNI, secondaryCNI,
}: {
  tip: DotTip
  onCapture: () => void
  onEnter: () => void
  onLeave: () => void
  metrics?: IfaceMetrics | null
  metricsLoading: boolean
  locked: boolean
  onClose: () => void
  primaryCNI: string
  secondaryCNI: string
}) {
  const cniLabel = getCNILabel(tip.node.interfaces.find(i => i.interface === tip.iface), primaryCNI, secondaryCNI)
  const style: React.CSSProperties = {
    position: 'absolute',
    left: tip.pos.x,
    top: tip.pos.y,
    zIndex: 50,
    maxWidth: 260,
    background: '#161b22',
    border: `1px solid ${locked ? SIGNAL_CLR : NODE_BORDER}`,
    pointerEvents: 'auto',
  }
  return (
    <div
      style={style}
      className="rounded-lg p-3 text-xs shadow-2xl"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {locked && (
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: 4, right: 4,
            background: 'none', border: 'none', color: MUTED,
            cursor: 'pointer', padding: '2px 5px', lineHeight: 1, fontSize: 14,
          }}
          title="Close"
        >✕</button>
      )}
      <div className="font-bold mb-0.5" style={{ color: '#e6edf3', paddingRight: locked ? 20 : 0 }}>
        {tip.node.displayName} : {tip.iface}
      </div>
      <div className="font-mono mb-1" style={{ color: MUTED }}>
        {tip.node.interfaces.find(i => i.interface === tip.iface)?.ips[0] ?? ''}
      </div>
      {cniLabel && <div className="mb-1.5" style={{ color: MUTED }}>CNI: {cniLabel}</div>}

      {/* Interface metrics — always show all three rows */}
      {metricsLoading && !metrics ? (
        <div className="text-[10px] mb-1.5 animate-pulse" style={{ color: MUTED }}>Loading metrics…</div>
      ) : (
        <div className="space-y-0.5 mb-1.5 text-[10px]" style={{ color: MUTED }}>
          <div>Throughput: <strong style={{ color: '#e6edf3' }}>{(metrics?.throughputMbps ?? 0).toFixed(2)} Mbps</strong></div>
          <div>Packets/s:  <strong style={{ color: '#e6edf3' }}>{(metrics?.packetsPerSec ?? 0).toFixed(2)} pkt/s</strong></div>
          {metrics?.isCilium && (
            <div>Drop:       <strong style={{ color: metrics.dropRate > 0 ? BADGE_WARN : '#e6edf3' }}>{metrics.dropRate.toFixed(2)}%</strong></div>
          )}
        </div>
      )}

      <button
        onClick={onCapture}
        className="mt-0.5 w-full text-center rounded py-1 text-xs font-medium"
        style={{ background: '#1f6feb', color: '#e6edf3', pointerEvents: 'auto' }}
      >
        ▶ Live Capture
      </button>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

function TopologyCanvas({
  graph,
  onNodeClick,
  onEdgeClick,
  selectedNodeId,
  trafficEdgeIds,
  namespace = 'free5gc',
  sidePanelOpen = false,
}: Props) {
  const containerRef   = useRef<HTMLDivElement>(null)
  const overlayRef     = useRef<HTMLCanvasElement>(null)
  const cyRef          = useRef<Core | null>(null)
  const dotsRef        = useRef<EndpointDot[]>([])
  const mousePos       = useRef({ x: 0, y: 0 })
  const nodeTipTimer   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dotHideTimer   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const metricsTimer   = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const dotLockedRef   = useRef(false)
  const trafficRef     = useRef(trafficEdgeIds ?? new Set<string>())
  const sbiLabelsRef   = useRef(new Map<string, string>())
  const nodeMapRef     = useRef(new Map<string, TopologyNode>())
  const rafRef         = useRef<number>(0)
  const rafLoopRef     = useRef<((time: number) => void) | null>(null)

  const [nodeTip,       setNodeTip]       = useState<NodeTip | null>(null)
  const [dotTip,        setDotTip]        = useState<DotTip | null>(null)
  const [dotLocked,     setDotLocked]     = useState(false)
  const [dotMetrics,    setDotMetrics]    = useState<IfaceMetrics | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(false)

  const navigate = useNavigate()
  const storageKey = `coach5g-positions-${namespace}`

  useEffect(() => { trafficRef.current = trafficEdgeIds ?? new Set() }, [trafficEdgeIds])

  // SBI label map: nodeId → label (e.g. AMF_id → "Namf")
  const sbiLabels = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of graph.edges) {
      if (e.busEdge) m.set(e.target, e.label)
    }
    return m
  }, [graph.edges])
  useEffect(() => { sbiLabelsRef.current = sbiLabels }, [sbiLabels])

  // Extract identity keys so the metrics effect only re-runs when the dot changes,
  // not when the tooltip position updates due to pan/zoom micro-movement.
  const dotPodName = dotTip?.node.podName ?? null
  const dotIface   = dotTip?.iface ?? null

  // ── Interface metrics fetch (refreshed every 1s while tooltip is visible) ──
  useEffect(() => {
    clearInterval(metricsTimer.current)
    setDotMetrics(null)
    if (!dotPodName || !dotIface) return

    const fetchM = () => {
      setMetricsLoading(true)
      fetch(`/api/metrics/interface?pod=${encodeURIComponent(dotPodName)}&interface=${encodeURIComponent(dotIface)}`)
        .then(r => r.json() as Promise<IfaceMetrics>)
        .then(m => { setDotMetrics(m); setMetricsLoading(false) })
        .catch(() => setMetricsLoading(false))
    }
    fetchM()
    metricsTimer.current = setInterval(fetchM, METRICS_REFRESH_MS)
    return () => clearInterval(metricsTimer.current)
  }, [dotPodName, dotIface])

  const nodeMap = useMemo(() => {
    const m = new Map<string, TopologyNode>()
    for (const n of graph.nodes) m.set(n.id, n)
    return m
  }, [graph.nodes])
  useEffect(() => { nodeMapRef.current = nodeMap }, [nodeMap])

  const savedPositions = useMemo<Record<string, { x: number; y: number }> | undefined>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? undefined }
    catch { return undefined }
  }, [storageKey])

  const positions = useMemo(
    () => computePositions(graph.nodes, savedPositions, graph.edges),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.nodes],
  )

  // ── Resize canvas overlay ────────────────────────────────────────────────
  useEffect(() => {
    const canvas    = overlayRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        const w = container.clientWidth
        const h = container.clientHeight
        // Only reassign if size actually changed — canvas.width/height assignment
        // clears the canvas immediately (HTML spec). Guard prevents a blank frame
        // on every resize event even when dimensions are unchanged.
        if (canvas.width !== w || canvas.height !== h) {
          cancelAnimationFrame(rafRef.current)
          canvas.width  = w
          canvas.height = h
          // Redraw synchronously so canvas is never blank after a resize
          runDraw(canvas, cyRef.current, performance.now() / 1000,
            trafficRef.current, dotsRef, nodeMapRef.current, sbiLabelsRef.current)
          if (rafLoopRef.current) rafRef.current = requestAnimationFrame(rafLoopRef.current)
        }
      }, 16)
    })
    ro.observe(container)
    canvas.width  = container.clientWidth
    canvas.height = container.clientHeight
    return () => { ro.disconnect(); clearTimeout(resizeTimer) }
  }, [])

  // ── RAF animation loop ───────────────────────────────────────────────────
  useEffect(() => {
    const loop = (time: number) => {
      runDraw(
        overlayRef.current, cyRef.current, time / 1000,
        trafficRef.current, dotsRef, nodeMapRef.current, sbiLabelsRef.current,
      )
      rafRef.current = requestAnimationFrame(loop)
    }
    rafLoopRef.current = loop
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  // ── Shared fit logic (used by init, sidePanelOpen effect, and Fit button) ─
  const fitGraph = useCallback(() => {
    cyRef.current?.fit(undefined, 60)
  }, [])

  // ── Init Cytoscape ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return

    const cy = cytoscape({
      container: containerRef.current,
      elements:  buildElements(graph, positions),
      style:     buildStylesheet(),
      layout:    { name: 'preset' },
      minZoom: 0.25,
      maxZoom: 4,
      wheelSensitivity: 0.3,
      boxSelectionEnabled: false,
      selectionType: 'single',
    })

    cyRef.current = cy
    fitGraph()

    const onMove = (e: MouseEvent) => {
      const r = containerRef.current?.getBoundingClientRect()
      if (r) mousePos.current = { x: e.clientX - r.left, y: e.clientY - r.top }

      if (dotLockedRef.current) return

      const mx = mousePos.current.x
      const my = mousePos.current.y
      // Read actual canvas width — excludes side panel (CSS flex already accounts for it)
      const cw = containerRef.current?.clientWidth  ?? window.innerWidth
      const ch = containerRef.current?.clientHeight ?? window.innerHeight

      // ── Step 1: dot hit test (3.5px tight radius) ──────────────────────
      let dotHit: EndpointDot | null = null
      for (const d of dotsRef.current) {
        const dx = mx - d.x, dy = my - d.y
        if (Math.sqrt(dx * dx + dy * dy) <= 3.5) { dotHit = d; break }
      }

      if (dotHit) {
        clearTimeout(dotHideTimer.current)
        clearTimeout(nodeTipTimer.current)
        setNodeTip(null)
        const h = dotHit
        const pos = {
          x: Math.min(h.x + 15, cw - 268),
          y: Math.max(4, Math.min(h.y - 10, ch - 168)),
        }
        setDotTip(prev =>
          prev?.node.id === h.node.id && prev?.iface === h.iface &&
          Math.abs(prev.pos.x - pos.x) < 2 && Math.abs(prev.pos.y - pos.y) < 2
            ? prev
            : { node: h.node, iface: h.iface, pos },
        )
        return
      }

      // Not on a dot — grace-period hide for dot tooltip
      dotHideTimer.current = setTimeout(() => setDotTip(null), 300)

      // ── Step 2: node box hit test (full rectangle, excluding dots) ──────
      const TW = 220, TH = 120, M = 12
      let nodeTipNext: NodeTip | null = null
      cy.nodes().forEach(cn => {
        if (nodeTipNext) return
        const sp = cn.renderedPosition()
        const nw = cn.renderedWidth()
        const nh = cn.renderedHeight()
        if (mx >= sp.x - nw / 2 && mx <= sp.x + nw / 2 &&
            my >= sp.y - nh / 2 && my <= sp.y + nh / 2) {
          const raw = cn.data('_node') as TopologyNode
          if (!raw) return
          let tx = sp.x + nw / 2 + M
          let ty = sp.y - TH / 2
          if (tx + TW > cw) tx = sp.x - nw / 2 - M - TW
          if (tx < 4) tx = 4
          if (ty + TH > ch - 10) ty = ch - TH - 10
          if (ty < 10) ty = 10
          nodeTipNext = { node: raw, pos: { x: tx, y: ty } }
        }
      })

      if (nodeTipNext) {
        clearTimeout(nodeTipTimer.current)
        setNodeTip(nodeTipNext)
      } else {
        clearTimeout(nodeTipTimer.current)
        setNodeTip(null)
      }
    }

    const onClick = (e: MouseEvent) => {
      const r = containerRef.current?.getBoundingClientRect()
      if (!r) return
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      const cw = containerRef.current?.clientWidth  ?? window.innerWidth
      const ch = containerRef.current?.clientHeight ?? window.innerHeight
      for (const d of dotsRef.current) {
        const dx = mx - d.x, dy = my - d.y
        if (Math.sqrt(dx * dx + dy * dy) < 8) {
          const pos = {
            x: Math.min(d.x + 15, cw - 268),
            y: Math.max(4, Math.min(d.y - 10, ch - 168)),
          }
          clearTimeout(dotHideTimer.current)
          setDotTip({ node: d.node, iface: d.iface, pos })
          setDotLocked(true)
          dotLockedRef.current = true
          return
        }
      }
    }

    containerRef.current.addEventListener('mousemove', onMove)
    containerRef.current.addEventListener('click', onClick)

    cy.on('tap', 'node', (e: EventObject) => {
      const raw = (e.target as NodeSingular).data('_node') as TopologyNode
      if (raw) onNodeClick(raw)
    })

    cy.on('mouseover', 'node', (e: EventObject) => {
      ;(e.target as NodeSingular).addClass('hover')
    })

    cy.on('mouseout', 'node', (e: EventObject) => {
      ;(e.target as NodeSingular).removeClass('hover')
      clearTimeout(nodeTipTimer.current)
      nodeTipTimer.current = setTimeout(() => setNodeTip(null), 150)
    })

    cy.on('tap', 'edge', (e: EventObject) => {
      const raw = (e.target as EdgeSingular).data('_edge') as TopologyEdge
      const src = graph.nodes.find(n => n.id === (e.target as EdgeSingular).data('source'))
      if (raw && src) onEdgeClick(raw, src)
    })

    cy.on('mouseover', 'edge', (e: EventObject) => { ;(e.target as EdgeSingular).addClass('hover') })
    cy.on('mouseout',  'edge', (e: EventObject) => { ;(e.target as EdgeSingular).removeClass('hover') })

    cy.on('tap', (e: EventObject) => {
      if (e.target === cy) { cy.elements().unselect(); setNodeTip(null) }
    })

    cy.on('dragfree', 'node', () => {
      const saved: Record<string, { x: number; y: number }> = {}
      cy.nodes().forEach(n => { saved[n.id()] = n.position() })
      try { localStorage.setItem(storageKey, JSON.stringify(saved)) } catch { /* quota */ }
    })

    return () => {
      clearTimeout(nodeTipTimer.current)
      clearTimeout(dotHideTimer.current)
      containerRef.current?.removeEventListener('mousemove', onMove)
      containerRef.current?.removeEventListener('click', onClick)
      cy.destroy()
      cyRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Update elements without destroying cy ────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    // Diff against Cytoscape's own current positions so a periodic refresh
    // never discards a manual drag -- only node IDs Cytoscape has never seen
    // before fall through to computePositions' own default-layout logic.
    const known    = Object.fromEntries(cy.nodes().map(n => [n.id(), n.position()]))
    const newPos   = computePositions(graph.nodes, known, graph.edges)
    const elements = buildElements(graph, newPos)

    cy.batch(() => {
      const newIds = new Set(elements.map(e => e.data.id as string))
      cy.elements().forEach(el => { if (!newIds.has(el.id())) el.remove() })
      for (const el of elements) {
        const ex = cy.getElementById(el.data.id as string)
        if (ex.length > 0) {
          ex.data(el.data)
          if (el.group === 'nodes') ex.classes(el.classes as string ?? '')
          if (el.group === 'nodes' && el.position && !ex.grabbed()) ex.position(el.position)
        } else {
          cy.add(el)
        }
      }
    })
  }, [graph])

  // ── Selected highlight ───────────────────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.elements().unselect()
    if (selectedNodeId) cy.getElementById(selectedNodeId).select()
  }, [selectedNodeId])

  // ── Re-fit when side panel opens/closes (canvas area changes) ────────────
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    const t = setTimeout(() => {
      cy.resize()
      fitGraph()
    }, 100)
    return () => clearTimeout(t)
  }, [sidePanelOpen, fitGraph])

  // ── Reset layout ─────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    try { localStorage.removeItem(storageKey) } catch { /* ok */ }
    const cy = cyRef.current
    if (!cy) return
    const newPos = computePositions(graph.nodes, undefined, graph.edges)
    cy.batch(() => {
      cy.nodes().forEach(n => {
        const p = newPos.get(n.id())
        if (p) n.animate({ position: p } as Parameters<typeof n.animate>[0], { duration: 300 })
      })
    })
  }, [graph.nodes, graph.edges, storageKey])

  const handleFit = fitGraph

  const isULCL = graph.nodes.some(n => n.nfType === 'iUPF')

  // D6: UE, gNB, DN are not NFs — count separately
  const nfCount  = graph.nodes.filter(n => !['UE','gNB','DN'].includes(n.nfType)).length
  const gnbCount = graph.nodes.filter(n => n.nfType === 'gNB').length
  const ueCount  = graph.nodes.filter(n => n.nfType === 'UE').length
  const dnCount  = graph.nodes.filter(n => n.nfType === 'DN').length
  const nonBusEdges = graph.edges.filter(e => !e.busEdge).length

  const primaryCNI   = graph.primaryCNI   ?? 'CNI'
  const secondaryCNI = graph.secondaryCNI ?? 'Secondary CNI'

  const handleCapture = useCallback((dot: DotTip) => {
    navigate(`/captures?pod=${dot.node.podName}&interface=${dot.iface}`)
  }, [navigate])

  return (
    <div className="relative w-full h-full" style={{ background: BG }}>
      <div ref={containerRef} className="w-full h-full" style={{ background: BG }} />

      {/* Canvas overlay — SBI bus, health badges, arcs, traffic dots, endpoint dots */}
      <canvas
        ref={overlayRef}
        className="absolute inset-0"
        style={{ pointerEvents: 'none', zIndex: 10 }}
      />

      {nodeTip && !dotTip && (
        <NodeTipBox
          tip={nodeTip}
          onEnter={() => clearTimeout(nodeTipTimer.current)}
          onLeave={() => setNodeTip(null)}
        />
      )}
      {dotTip && (
        <DotTipBox
          tip={dotTip}
          onCapture={() => handleCapture(dotTip)}
          onEnter={() => clearTimeout(dotHideTimer.current)}
          onLeave={() => { if (!dotLocked) setDotTip(null) }}
          metrics={dotMetrics}
          metricsLoading={metricsLoading}
          locked={dotLocked}
          onClose={() => { setDotLocked(false); dotLockedRef.current = false; setDotTip(null) }}
          primaryCNI={primaryCNI}
          secondaryCNI={secondaryCNI}
        />
      )}

      {/* Header info — D6: separate NF / gNB / UE / DN counts */}
      <div className="absolute top-3 left-3 flex items-center gap-2" style={{ zIndex: 20 }}>
        <span className="text-xs font-mono" style={{ color: MUTED }}>
          {nfCount} NFs
          {gnbCount > 0 && ` · ${gnbCount} gNB`}
          {ueCount  > 0 && ` · ${ueCount} UE`}
          {dnCount  > 0 && ` · ${dnCount} DN`}
          {` · ${nonBusEdges} links`}
        </span>
        {isULCL && (
          <span className="text-xs px-1.5 py-0.5 rounded font-medium"
            style={{ background: '#1f4d2e', color: UP_CLR, border: `1px solid #2d6a3f` }}>
            ULCL
          </span>
        )}
      </div>

      {/* Controls */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5" style={{ zIndex: 20 }}>
        <button
          onClick={handleReset}
          className="text-xs px-2 py-1 rounded border font-mono"
          style={{ background: '#161b22', border: `1px solid ${NODE_BORDER}`, color: MUTED }}
          title="Reset layout to default positions"
        >
          ⊟ Reset
        </button>
        <button
          onClick={handleFit}
          className="text-xs px-2 py-1 rounded border font-mono"
          style={{ background: '#161b22', border: `1px solid ${NODE_BORDER}`, color: MUTED }}
          title="Fit all nodes in view"
        >
          ⊞ Fit
        </button>
      </div>

      {/* Legend */}
      <div
        className="absolute bottom-4 left-4 rounded-lg p-2.5 text-xs"
        style={{ background: '#161b22', border: `1px solid ${NODE_BORDER}`, zIndex: 20 }}
      >
        <div className="mb-1 font-medium" style={{ color: MUTED }}>Interfaces</div>
        {([
          [SIGNAL_CLR, 'Signaling (N2, SBI)',      false],
          [SIGNAL_CLR, 'PFCP (N4)',               true],
          [UP_CLR,     'User plane (N3, N6, N9)', false],
          ['#f0f6fc',  'Wireless N1',             false],
        ] as [string, string, boolean][]).map(([color, label, dashed]) => (
          <div key={label} className="flex items-center gap-2 mb-0.5">
            <svg width="20" height="8">
              {dashed
                ? <line x1="0" y1="4" x2="20" y2="4" stroke={color} strokeWidth="2" strokeDasharray="4 3"/>
                : <line x1="0" y1="4" x2="20" y2="4" stroke={color} strokeWidth="2"/>
              }
            </svg>
            <span style={{ color: MUTED }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default memo(TopologyCanvas)
