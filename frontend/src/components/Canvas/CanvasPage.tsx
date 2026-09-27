import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePipelineStore } from '../../stores/pipelineStore'
import { getVersions } from '../../api/client'
import CanvasArea from './CanvasArea'
import NodePanel from '../NodePanel/NodePanel'
import VersionHistory from '../Shared/VersionHistory'
import { Undo2, Redo2, History } from 'lucide-react'

export default function CanvasPage() {
  const nav = useNavigate()
  const { pipelineName, pipelineId, nodes, setVersions, selectedNodeId } = usePipelineStore()
  const [showHistory, setShowHistory] = useState(false)

  const approvedCount = nodes.filter(n => n.status === 'approved').length
  const allApproved   = nodes.length > 0 && approvedCount === nodes.length

  useEffect(() => {
    if (!pipelineId) return
    getVersions(pipelineId).then(setVersions).catch(() => {})
  }, [pipelineId])

  return (
    <>
      <div className="topbar">
        <div className="crumb">
          <b>Pipelines</b> / <span className="cur">{pipelineName}</span>
        </div>
        <button className="icon-btn" disabled><Undo2 size={14}/></button>
        <button className="icon-btn"><Redo2 size={14}/></button>
        <div className="div-v"/>
        <div className="status-ind">
          <span className={`status-dot ${allApproved ? 'status-dot-sage' : 'status-dot-amber'}`}/>
          {allApproved ? 'All Approved' : `${approvedCount} / ${nodes.length} Approved`}
        </div>
        <div className="topbar-spacer"/>
        <button className="btn btn-sm" onClick={() => setShowHistory(!showHistory)}>
          <History size={13}/> History
        </button>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => nav('/export')}
          disabled={!allApproved}
          title={allApproved ? '' : 'Approve all nodes before exporting'}
        >
          {allApproved ? 'Review & Export' : 'Approve all nodes first'}
        </button>
      </div>

      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
        <CanvasArea/>

        {/* Fix: only render NodePanel when a node is actually selected */}
        {selectedNodeId && <NodePanel/>}

        {showHistory && <VersionHistory onClose={() => setShowHistory(false)}/>}
      </div>
    </>
  )
}
