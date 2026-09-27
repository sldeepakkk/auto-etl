import { useRef, useCallback, useEffect, useState } from 'react'
import { Database, ZoomIn, ZoomOut, Maximize } from 'lucide-react'
import { usePipelineStore } from '../../stores/pipelineStore'
import CanvasNode from './CanvasNode'
import './Canvas.css'

const ICON_R        = 18   // half of 36px node
const TABLE_R       = 11   // half of satellite
const TABLE_SPACING = 42
const TABLE_LEFT    = 130
const ZOOM_MIN      = 0.25
const ZOOM_MAX      = 2.5
const ZOOM_STEP     = 0.15

export default function CanvasArea() {
  const { nodes, edges, nodePositions, setNodePosition, selectedNodeId, selectedTables } = usePipelineStore()
  const svgRef  = useRef<SVGSVGElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)

  // ── Zoom & pan state ─────────────────────────────────────────────────────
  const [zoom,   setZoom]   = useState(1)
  const [offset, setOffset] = useState({ x: 40, y: 40 })
  const panRef = useRef<{ active:boolean; startX:number; startY:number; ox:number; oy:number }>({
    active:false, startX:0, startY:0, ox:0, oy:0,
  })

  // ── Satellite positions (canvas-space) ───────────────────────────────────
  const tablePositions = useCallback(() => {
    const src = nodePositions['n1'] || nodePositions['source'] || { x:200, y:110 }
    const count = selectedTables.length
    if (!count) return []
    const centerY = src.y + ICON_R
    const startY  = centerY - ((count - 1) * TABLE_SPACING) / 2 - TABLE_R
    return selectedTables.map((name, i) => ({
      name,
      x: src.x - TABLE_LEFT,
      y: startY + i * TABLE_SPACING,
    }))
  }, [selectedTables, nodePositions])

  // ── Edge drawing ─────────────────────────────────────────────────────────
  const drawEdges = useCallback(() => {
    if (!svgRef.current) return
    let html = ''

    for (const edge of edges) {
      const a = nodePositions[edge.source], b = nodePositions[edge.target]
      if (!a || !b) continue
      const x1 = a.x + ICON_R, y1 = a.y + ICON_R
      const x2 = b.x + ICON_R, y2 = b.y + ICON_R
      const dx  = (x2 - x1) * 0.45
      const active = edge.source === selectedNodeId || edge.target === selectedNodeId
      html += `<path d="M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}" class="${active?'edge-active':''}"/>`
    }

    // Satellite → source dashed edges
    const srcPos = nodePositions['n1'] || nodePositions['source']
    if (srcPos) {
      const sx = srcPos.x, sy = srcPos.y + ICON_R
      for (const tp of tablePositions()) {
        const tx = tp.x + TABLE_R * 2, ty = tp.y + TABLE_R
        const dx = (sx - tx) * 0.4
        html += `<path d="M${tx},${ty} C${tx+dx},${ty} ${sx-dx},${sy} ${sx},${sy}" class="edge-table"/>`
      }
    }
    svgRef.current.innerHTML = html
  }, [edges, nodePositions, selectedNodeId, tablePositions])

  useEffect(drawEdges, [drawEdges])

  // ── Node drag ─────────────────────────────────────────────────────────────
  const dragRef = useRef<{
    nodeId:string; offX:number; offY:number
    startX:number; startY:number; moved:boolean
  } | null>(null)

  const handleDragStart = useCallback((nodeId: string, e: React.MouseEvent) => {
    const el  = e.currentTarget as HTMLElement
    const r   = el.getBoundingClientRect()
    // Convert screen offset to canvas-space offset
    dragRef.current = {
      nodeId, moved:false,
      offX: (e.clientX - r.left) / zoom,
      offY: (e.clientY - r.top)  / zoom,
      startX: e.clientX, startY: e.clientY,
    }
    el.style.zIndex = '20'
    e.preventDefault()
    e.stopPropagation()   // prevent canvas pan from triggering
  }, [zoom])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d || !areaRef.current) return
      if (Math.abs(e.clientX - d.startX) > 3 || Math.abs(e.clientY - d.startY) > 3) d.moved = true
      if (!d.moved) return

      const rect = areaRef.current.getBoundingClientRect()
      // Convert screen coords to canvas-space
      const cx = (e.clientX - rect.left - offset.x) / zoom - d.offX
      const cy = (e.clientY - rect.top  - offset.y) / zoom - d.offY
      setNodePosition(d.nodeId, Math.max(4, cx), Math.max(4, cy))
    }
    const onUp = () => {
      const d = dragRef.current
      if (!d) return
      const el = document.querySelector(`[data-node-id="${d.nodeId}"]`) as HTMLElement
      if (el) el.style.zIndex = '2'
      if (!d.moved) usePipelineStore.getState().selectNode(d.nodeId)
      dragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [setNodePosition, zoom, offset])

  // ── Canvas pan (drag on background) ──────────────────────────────────────
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    // Only pan on background — not when clicking a node or satellite
    const target = e.target as HTMLElement
    if (target.closest('.canvas-node') || target.closest('.table-satellite')) return
    panRef.current = { active:true, startX:e.clientX, startY:e.clientY, ox:offset.x, oy:offset.y }
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const p = panRef.current
      if (!p.active) return
      setOffset({ x: p.ox + e.clientX - p.startX, y: p.oy + e.clientY - p.startY })
    }
    const onUp = () => { panRef.current.active = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [])

  // ── Wheel zoom (centred on cursor) ────────────────────────────────────────
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    if (!areaRef.current) return
    const rect = areaRef.current.getBoundingClientRect()
    const mx   = e.clientX - rect.left
    const my   = e.clientY - rect.top
    const dir  = e.deltaY < 0 ? 1 : -1
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + dir * ZOOM_STEP * zoom))
    const scale   = newZoom / zoom
    setOffset(prev => ({
      x: mx - scale * (mx - prev.x),
      y: my - scale * (my - prev.y),
    }))
    setZoom(newZoom)
  }, [zoom])

  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // ── Zoom button helpers ───────────────────────────────────────────────────
  const zoomBy = (delta: number) => {
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + delta * zoom))
    if (!areaRef.current) return
    const rect = areaRef.current.getBoundingClientRect()
    const cx = rect.width / 2, cy = rect.height / 2
    const scale = newZoom / zoom
    setOffset(prev => ({ x: cx - scale * (cx - prev.x), y: cy - scale * (cy - prev.y) }))
    setZoom(newZoom)
  }
  const resetView = () => { setZoom(1); setOffset({ x: 40, y: 40 }) }

  return (
    <div
      className="canvas-area"
      ref={areaRef}
      onMouseDown={handleCanvasMouseDown}
      style={{ cursor: panRef.current.active ? 'grabbing' : 'default' }}
    >
      {/* Transform layer — everything inside zooms + pans together */}
      <div
        className="canvas-transform"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`, transformOrigin:'0 0' }}
      >
        <svg className="canvas-svg" ref={svgRef}
          style={{ position:'absolute', left:0, top:0, width:'6000px', height:'4000px', pointerEvents:'none' }}/>

        {/* Table satellites */}
        {tablePositions().map(tp => (
          <div key={tp.name} className="table-satellite" style={{ left:tp.x, top:tp.y }} title={tp.name}>
            <div className="table-satellite-icon"><Database size={10} strokeWidth={1.8}/></div>
            <div className="table-satellite-label">{tp.name}</div>
          </div>
        ))}

        {/* Pipeline nodes */}
        {nodes.map(node => (
          <CanvasNode
            key={node.id}
            node={node}
            pos={nodePositions[node.id] || { x:100, y:100 }}
            selected={selectedNodeId === node.id}
            onDragStart={handleDragStart}
          />
        ))}
      </div>

      {/* ── Zoom controls (fixed to canvas corner) ── */}
      <div className="canvas-zoom-controls">
        <button className="zoom-btn" onClick={() => zoomBy(ZOOM_STEP)} title="Zoom in"><ZoomIn size={13}/></button>
        <span className="zoom-label">{Math.round(zoom * 100)}%</span>
        <button className="zoom-btn" onClick={() => zoomBy(-ZOOM_STEP)} title="Zoom out"><ZoomOut size={13}/></button>
        <button className="zoom-btn zoom-reset" onClick={resetView} title="Reset view"><Maximize size={12}/></button>
      </div>

      <div className="canvas-hint">Scroll to zoom · drag canvas to pan · drag nodes to move</div>
    </div>
  )
}
