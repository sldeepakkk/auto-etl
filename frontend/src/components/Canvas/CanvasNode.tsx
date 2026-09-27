import { Database, Filter, Shield, Lock, DatabaseZap, CheckCircle, XCircle, AlertTriangle } from 'lucide-react'
import { usePipelineStore } from '../../stores/pipelineStore'
import type { PipelineNode, NodePosition } from '../../types/pipeline'

const ICONS: Record<string, React.ReactNode> = {
  source:    <Database size={18} strokeWidth={1.8} />,
  transform: <Filter size={18} strokeWidth={1.8} />,
  aggregate: <span className="node-sig">Σ</span>,
  dq:        <Shield size={18} strokeWidth={1.8} />,
  output:    <DatabaseZap size={18} strokeWidth={1.8} />,
}

interface Props {
  node: PipelineNode
  pos: NodePosition
  selected: boolean
  onDragStart: (id: string, e: React.MouseEvent) => void
}

export default function CanvasNode({ node, pos, selected, onDragStart }: Props) {
  // Real DQ check results, read directly from the store — this is what makes
  // a failed check visible on the canvas itself instead of only inside one
  // tab of the side panel. Only meaningful on the DQ Check node.
  const dqCheckResults = usePipelineStore(s => s.dqCheckResults)

  const shortDesc = node.description
    ? node.description.split(/\.\s/)[0].trim() + '.'
    : `${node.type} step`

  // DQ status — only computed for the dq-type node, and only if a check has
  // actually been run this session (dqCheckResults is populated by clicking
  // "Run DQ Check" in the NodePanel; it's empty until then, which correctly
  // shows no DQ badge rather than a misleading "all clear").
  let dqStatus: 'error' | 'warn' | 'pass' | null = null
  if (node.type === 'dq' && dqCheckResults.length > 0) {
    const hasErrorFail = dqCheckResults.some((r: any) => !r.passed && r.severity === 'error')
    const hasWarnFail  = dqCheckResults.some((r: any) => !r.passed && r.severity !== 'error')
    dqStatus = hasErrorFail ? 'error' : hasWarnFail ? 'warn' : 'pass'
  }

  return (
    <div
      className={`canvas-node ${selected ? 'selected' : ''}`}
      style={{ left: pos.x, top: pos.y }}
      data-node-id={node.id}
      onMouseDown={e => onDragStart(node.id, e)}
    >
      <div className="canvas-node-icon">
        {ICONS[node.type]}

        {!node.editable && (
          <div className="canvas-node-lock">
            <Lock size={8} strokeWidth={2.5} />
          </div>
        )}

        {/* Approval status badge — top-right */}
        {node.status === 'approved' && (
          <div className="canvas-node-badge approved">
            <CheckCircle size={10} />
          </div>
        )}
        {node.status === 'blocked' && (
          <div className="canvas-node-badge blocked">
            <XCircle size={10} />
          </div>
        )}

        {/* DQ check result badge — bottom-left, independent of approval status.
            Only appears on the DQ node, only after a real check has been run. */}
        {dqStatus === 'error' && (
          <div className="canvas-node-dq-badge dq-error" title="DQ check found error-severity failures">
            <XCircle size={10} />
          </div>
        )}
        {dqStatus === 'warn' && (
          <div className="canvas-node-dq-badge dq-warn" title="DQ check found warning-severity issues">
            <AlertTriangle size={10} />
          </div>
        )}
        {dqStatus === 'pass' && (
          <div className="canvas-node-dq-badge dq-pass" title="All DQ rules passed">
            <CheckCircle size={10} />
          </div>
        )}
      </div>

      <div className="canvas-node-label">{node.label}</div>

      <div className="canvas-node-tooltip">
        <div className="tooltip-type">{node.type}</div>
        <div className="tooltip-desc">{shortDesc}</div>
        {node.cte_name && (
          <div className="tooltip-cte">cte: {node.cte_name}</div>
        )}
        {dqStatus && (
          <div className={`tooltip-dq-status tooltip-dq-${dqStatus}`}>
            {dqStatus === 'error' && '⚠ DQ error-severity failures — will block MySQL load'}
            {dqStatus === 'warn'  && '⚠ DQ warning-severity issues found'}
            {dqStatus === 'pass'  && '✓ All DQ rules passed'}
          </div>
        )}
        <div className="tooltip-hint">Click to inspect · drag to move</div>
      </div>
    </div>
  )
}
