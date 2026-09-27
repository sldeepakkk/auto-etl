import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePipelineStore } from '../../stores/pipelineStore'
import { CheckCircle, XCircle, Clock, Loader2, ArrowLeft, Database, GitBranch, Layers } from 'lucide-react'
import api from '../../api/client'

interface NodeStatus { node_id:string; label:string; type:string; status:string; cte_name:string|null; editable:boolean }
interface Version     { version_id:string; pipeline_id:string; action:string; created_at:string }
interface Analytics {
  pipeline_id:string; pipeline_name:string; requirement:string; created_at:string
  node_count:number; approved_count:number; blocked_count:number; pending_count:number
  extracted_columns:number; transformed_columns:number; aggregated_columns:number
  lineage_count:number; source_table_count:number; source_tables:string[]
  column_changes_by_type: Record<string,number>
  dq_summary: { total:number; enabled:number; disabled:number; errors:number; warnings:number; preliminary:number; statistical:number }
  comment_count:number
  nodes: NodeStatus[]
  versions: Version[]
}

const STATUS_COLORS: Record<string, string> = { approved:'var(--sage)', blocked:'var(--rust)', pending_review:'var(--amber)' }
const STATUS_ICONS: Record<string, React.ReactNode> = {
  approved: <CheckCircle size={12}/>, blocked: <XCircle size={12}/>, pending_review: <Clock size={12}/>,
}
const STATUS_LABEL: Record<string, string> = { approved:'Approved', blocked:'Blocked', pending_review:'Pending Review' }
const TYPE_COLORS: Record<string, string> = {
  passthrough: '#B87333', cast: '#9A5E28', aggregate: '#6B4520', derive: '#C49060',
}

export default function AnalyticsPage() {
  const nav = useNavigate()
  const { pipelineId, pipelineName } = usePipelineStore()
  const [data,    setData]    = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    if (!pipelineId) { setError('No pipeline selected — go to Canvas first.'); setLoading(false); return }
    setLoading(true); setError('')
    api.get(`/analytics/${pipelineId}`)
      .then(r => setData(r.data))
      .catch(e => setError(e?.response?.data?.detail || 'Failed to load analytics'))
      .finally(() => setLoading(false))
  }, [pipelineId])

  const name = data?.pipeline_name || pipelineName || 'Pipeline'

  return (
    <div style={{ flex:1, overflowY:'auto' }}>
      <div className="topbar">
        <div className="crumb">
          <b>Pipelines</b> / <span className="cur">{name}</span> / <span style={{color:'var(--text-dim)'}}>Analytics</span>
        </div>
        <div className="topbar-spacer"/>
        <button className="btn btn-ghost btn-sm" onClick={() => nav('/canvas')}>
          <ArrowLeft size={13}/> Back to Canvas
        </button>
      </div>

      <div className="content">
        <div className="page-head">
          <div className="page-title">Pipeline Analytics</div>
          <div className="page-sub">
            {data ? `${name} · Created ${data.created_at?.slice(0,10)}` : 'Loading pipeline data…'}
          </div>
        </div>

        {loading && (
          <div style={{display:'flex',alignItems:'center',gap:10,color:'var(--text-faint)',fontSize:13,padding:'40px 0'}}>
            <Loader2 size={18} style={{animation:'spin .8s linear infinite'}}/>
            Loading analytics…
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        {data && !loading && (
          <>
            {/* ── Column pointers — the primary ask: how many columns at each stage ── */}
            <span className="label" style={{display:'block',marginBottom:8}}>Pipeline structure</span>
            <div style={{display:'flex',gap:1,marginBottom:22,border:'1px solid var(--border)',borderRadius:'var(--radius)',overflow:'hidden'}}>
              {[
                {n: data.source_table_count,  l: 'Source Tables', icon: <Database size={13}/>},
                {n: data.extracted_columns,   l: 'Extracted Columns'},
                {n: data.transformed_columns, l: 'Transformed Columns'},
                {n: data.aggregated_columns,  l: 'Aggregated Columns'},
                {n: data.dq_summary.total,    l: 'DQ Rules', icon: <Layers size={13}/>},
              ].map(s => (
                <div key={s.l} style={{flex:1,background:'var(--surface)',padding:'14px 16px'}}>
                  <div style={{fontFamily:'var(--font-mono)',fontSize:20,fontWeight:600}}>{s.n}</div>
                  <div style={{fontSize:10.5,color:'var(--text-faint)',marginTop:2}}>{s.l}</div>
                </div>
              ))}
            </div>

            {/* ── Node approval summary ─────────────────────────────────────── */}
            <div style={{display:'flex',gap:1,marginBottom:22,border:'1px solid var(--border)',borderRadius:'var(--radius)',overflow:'hidden'}}>
              {[
                {n: data.node_count,     l: 'Total Nodes'},
                {n: data.approved_count, l: 'Approved',  color: 'var(--sage)'},
                {n: data.pending_count,  l: 'Pending',   color: 'var(--amber)'},
                {n: data.blocked_count,  l: 'Blocked',   color: 'var(--rust)'},
                {n: data.comment_count,  l: 'Comments'},
              ].map(s => (
                <div key={s.l} style={{flex:1,background:'var(--surface)',padding:'14px 16px'}}>
                  <div style={{fontFamily:'var(--font-mono)',fontSize:20,fontWeight:600,color:s.color||'inherit'}}>{s.n}</div>
                  <div style={{fontSize:10.5,color:'var(--text-faint)',marginTop:2}}>{s.l}</div>
                </div>
              ))}
            </div>

            {/* ── Source tables list ─────────────────────────────────────────── */}
            {data.source_tables.length > 0 && (
              <div className="card" style={{marginBottom:18}}>
                <span className="label" style={{display:'block',marginBottom:10}}>Source tables referenced</span>
                <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                  {data.source_tables.map(t => (
                    <span key={t} style={{
                      fontFamily:'var(--font-mono)',fontSize:11,padding:'4px 10px',borderRadius:14,
                      background:'var(--surface2)',border:'1px solid var(--border)',color:'var(--text-dim)',
                    }}>{t}</span>
                  ))}
                </div>
              </div>
            )}

            {/* ── Column changes by type ─────────────────────────────────────── */}
            {Object.keys(data.column_changes_by_type).length > 0 && (
              <div className="card" style={{marginBottom:18}}>
                <span className="label" style={{display:'block',marginBottom:12}}>Column changes by type</span>
                {(() => {
                  const total = Object.values(data.column_changes_by_type).reduce((a,b)=>a+b,0)
                  return Object.entries(data.column_changes_by_type).map(([type, count]) => (
                    <div key={type} style={{display:'flex',alignItems:'center',gap:10,fontSize:11.5,marginBottom:9}}>
                      <div style={{width:90,color:'var(--text-dim)',fontFamily:'var(--font-mono)'}}>{type}</div>
                      <div style={{flex:1,height:6,background:'var(--surface3)',borderRadius:3,overflow:'hidden'}}>
                        <div style={{height:'100%',width:`${Math.round((count/total)*100)}%`,
                          background:TYPE_COLORS[type]||'var(--amber-dim)',borderRadius:3,transition:'.3s'}}/>
                      </div>
                      <div style={{width:60,textAlign:'right',color:'var(--text-faint)',fontFamily:'var(--font-mono)'}}>
                        {count} col{count!==1?'s':''}
                      </div>
                    </div>
                  ))
                })()}
              </div>
            )}

            {/* ── DQ rule summary ────────────────────────────────────────────── */}
            <div className="card" style={{marginBottom:18}}>
              <span className="label" style={{display:'block',marginBottom:12}}>Data quality rules</span>
              <div style={{display:'flex',gap:1,border:'1px solid var(--border)',borderRadius:'var(--radius)',overflow:'hidden'}}>
                {[
                  {n:data.dq_summary.total,      l:'Total',       c:'var(--text)'},
                  {n:data.dq_summary.enabled,    l:'Enabled',     c:'var(--sage)'},
                  {n:data.dq_summary.disabled,   l:'Disabled',    c:'var(--text-faint)'},
                  {n:data.dq_summary.errors,     l:'Error rules', c:'var(--rust)'},
                  {n:data.dq_summary.warnings,   l:'Warn rules',  c:'var(--amber)'},
                ].map(s => (
                  <div key={s.l} style={{flex:1,background:'var(--surface)',padding:'11px 13px'}}>
                    <div style={{fontFamily:'var(--font-mono)',fontSize:17,fontWeight:600,color:s.c}}>{s.n}</div>
                    <div style={{fontSize:10,color:'var(--text-faint)',marginTop:2}}>{s.l}</div>
                  </div>
                ))}
              </div>
              <div style={{fontSize:11,color:'var(--text-faint)',marginTop:10}}>
                Run rules against real data from the DQ Rules tab on any node in the Canvas.
              </div>
            </div>

            {/* ── Node approval status ───────────────────────────────────────── */}
            <span className="label" style={{display:'block',marginBottom:8}}>Node approval status</span>
            <div className="card" style={{padding:0,overflow:'hidden',marginBottom:18}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead>
                  <tr>
                    {['Node','Type','CTE alias','Editable','Status'].map(h => (
                      <th key={h} style={{textAlign:'left',color:'var(--text-faint)',fontWeight:500,
                        padding:'8px 12px',borderBottom:'1px solid var(--border)',
                        fontSize:10,textTransform:'uppercase',letterSpacing:'.03em'}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.nodes.map(n => (
                    <tr key={n.node_id} style={{borderBottom:'1px solid var(--border)'}}>
                      <td style={{padding:'9px 12px',fontWeight:500,color:'var(--text)'}}>{n.label}</td>
                      <td style={{padding:'9px 12px',fontFamily:'var(--font-mono)',fontSize:11,color:'var(--text-dim)'}}>{n.type}</td>
                      <td style={{padding:'9px 12px',fontFamily:'var(--font-mono)',fontSize:11,color:'var(--amber-dim)'}}>
                        {n.cte_name || <span style={{color:'var(--text-faint)'}}>—</span>}
                      </td>
                      <td style={{padding:'9px 12px',fontSize:11,color:'var(--text-faint)'}}>{n.editable ? 'yes' : 'locked'}</td>
                      <td style={{padding:'9px 12px'}}>
                        <div style={{display:'flex',alignItems:'center',gap:5,fontSize:11,
                          color:STATUS_COLORS[n.status]||'var(--text-faint)'}}>
                          {STATUS_ICONS[n.status]}
                          {STATUS_LABEL[n.status] || n.status}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ── Version / activity timeline ────────────────────────────────── */}
            <span className="label" style={{display:'block',marginBottom:8}}>Pipeline activity</span>
            <div className="card" style={{marginBottom:18}}>
              {data.versions.length === 0 ? (
                <div style={{fontSize:12,color:'var(--text-faint)',padding:'8px 0'}}>
                  No activity recorded yet. Versions are saved when nodes are approved, the pipeline
                  is regenerated, or data is loaded into MySQL.
                </div>
              ) : (
                data.versions.map((v, i) => (
                  <div key={v.version_id} style={{
                    display:'flex',alignItems:'flex-start',gap:14,
                    padding:'10px 0',
                    borderBottom:i<data.versions.length-1?'1px solid var(--border)':'none',
                  }}>
                    <div style={{
                      width:7,height:7,borderRadius:'50%',marginTop:4,flexShrink:0,
                      background:i===0?'var(--amber)':'var(--border2)',
                    }}/>
                    <div style={{flex:1}}>
                      <div style={{fontSize:12,color:'var(--text)',fontWeight:500}}>
                        {v.action.replace(/_/g,' ')}
                      </div>
                      <div style={{fontSize:10.5,color:'var(--text-faint)',fontFamily:'var(--font-mono)',marginTop:2}}>
                        {v.created_at?.slice(0,10)} · {v.created_at?.slice(11,16)}
                      </div>
                    </div>
                    {i===0 && (
                      <span style={{fontSize:10,color:'var(--amber)',background:'var(--amber-faint)',
                        padding:'2px 8px',borderRadius:10,border:'1px solid rgba(184,115,51,.2)'}}>
                        latest
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* ── Requirement reminder ───────────────────────────────────────── */}
            <span className="label" style={{display:'block',marginBottom:8}}>Pipeline requirement</span>
            <div className="card" style={{fontSize:12.5,color:'var(--text-dim)',lineHeight:1.65}}>
              {data.requirement}
            </div>
          </>
        )}
      </div>

      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </div>
  )
}
