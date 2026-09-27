import { useLocation, useNavigate } from 'react-router-dom'
import { LayoutGrid, List, BarChart3, Plus, Database, ChevronRight } from 'lucide-react'
import { usePipelineStore } from '../../stores/pipelineStore'
import './Rail.css'

const NAV = [
  { path: '/',          label: 'Dashboard',  icon: LayoutGrid },
  { path: '/pipelines', label: 'Pipelines',  icon: List },
  { path: '/analytics', label: 'Analytics',  icon: BarChart3 },
]

export default function Rail() {
  const loc = useLocation()
  const nav = useNavigate()
  const { pipelineName, status, sourceDsn, targetDsn, sourceDbType, targetDbType, reset } = usePipelineStore()

  const connected = !!(sourceDsn && targetDsn)

  return (
    <aside className="rail">
      <div className="rail-brand">
        <div className="rail-brand-mark">Σ</div>
        <span className="rail-brand-name">Auto ETL</span>
      </div>

      <button className="rail-new-btn" onClick={() => { reset(); nav('/') }}>
        <Plus size={14} /> New Pipeline
      </button>

      {/* Connection status strip */}
      <button
        className={`rail-conn-strip ${connected ? 'connected' : 'empty'}`}
        onClick={() => nav('/connect')}
        title="Change connections"
      >
        {connected ? (
          <>
            <span className="rail-conn-db">{sourceDbType}</span>
            <ChevronRight size={10} />
            <span className="rail-conn-db">{targetDbType}</span>
            <span className="status-dot status-dot-sage rail-conn-dot" />
          </>
        ) : (
          <>
            <Database size={12} />
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Connect databases</span>
          </>
        )}
      </button>

      <div className="rail-sec-label">Workspace</div>
      {NAV.map(n => (
        <button
          key={n.path}
          className={`rail-nav-item ${loc.pathname === n.path ? 'active' : ''}`}
          onClick={() => nav(n.path)}
        >
          <n.icon size={15} />{n.label}
        </button>
      ))}

      {pipelineName && (
        <>
          <div className="rail-sec-label">Current</div>
          <button className="rail-nav-item" onClick={() => nav('/canvas')}>
            <span className={`rail-dot ${status === 'exported' ? 'sage' : 'amber'}`} />
            <span className="rail-pipeline-name">{pipelineName}</span>
          </button>
        </>
      )}

      <div className="rail-spacer" />
    </aside>
  )
}
