import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listPipelines } from '../../api/client'
import type { PipelineSummary } from '../../types/pipeline'

export default function PipelinesPage() {
  const nav = useNavigate()
  const [rows, setRows] = useState<PipelineSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(()=>{
    listPipelines().then(setRows).catch(()=>setRows([])).finally(()=>setLoading(false))
  },[])

  return (
    <div style={{flex:1,overflowY:'auto'}}>
      <div className="topbar"><div className="crumb"><b>Auto ETL</b> / <span className="cur">Pipelines</span></div></div>
      <div className="content">
        <div className="page-head"><div className="page-title">Pipelines</div><div className="page-sub">All pipelines in this workspace.</div></div>
        {loading ? <div style={{color:'var(--text-faint)',fontSize:12}}>Loading…</div>
        : rows.length===0 ? <div className="card" style={{textAlign:'center',padding:40,color:'var(--text-faint)',fontSize:13}}>No pipelines yet. Create one from the Dashboard.</div>
        : <div style={{border:'1px solid var(--border)',borderRadius:'var(--radius)',overflow:'hidden'}}>
            {rows.map(p=>(
              <div key={p.pipeline_id} onClick={()=>nav('/canvas')}
                style={{display:'flex',alignItems:'center',gap:14,padding:'13px 16px',borderBottom:'1px solid var(--border)',cursor:'pointer',transition:'.12s'}}
                onMouseEnter={e=>(e.currentTarget as HTMLElement).style.background='var(--surface2)'}
                onMouseLeave={e=>(e.currentTarget as HTMLElement).style.background=''}>
                <div style={{flex:1,fontWeight:600,fontSize:13,fontFamily:'var(--font-mono)'}}>{p.pipeline_name}</div>
                <div style={{fontSize:11.5,color:'var(--text-faint)',width:170}}>PostgreSQL → MySQL</div>
                <div style={{display:'flex',alignItems:'center',gap:6,fontSize:11.5,color:'var(--text-dim)',width:120}}><span className="status-dot status-dot-sage"/>Saved</div>
                <div style={{fontSize:11.5,color:'var(--text-faint)',width:60,fontFamily:'var(--font-mono)'}}>{p.node_count} nodes</div>
                <div style={{fontSize:11,color:'var(--text-faint)',width:80,textAlign:'right'}}>{new Date(p.created_at).toLocaleDateString()}</div>
              </div>
            ))}
          </div>}
      </div>
    </div>
  )
}
