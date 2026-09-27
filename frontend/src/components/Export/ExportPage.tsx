import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Copy, Play, Database, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react'
import { usePipelineStore } from '../../stores/pipelineStore'
import { exportPipeline, dryRun, loadToMySQL } from '../../api/client'

const STEPS = ['Review Pipeline', 'Dry Run', 'Preview SQL', 'Load to MySQL']

type LoadMode = 'replace' | 'append' | 'fail_if_exists'

export default function ExportPage() {
  const nav = useNavigate()
  const { pipelineId, pipelineName, nodes, dqRules, dqCheckResults, nodeConfigs, warnings, sourceDsn, targetDsn, setStatus } = usePipelineStore()

  const [step,        setStep]        = useState(0)
  const [exportData,  setExportData]  = useState<{ sql: string; filename: string; warnings: string[] } | null>(null)
  const [dryRunData,  setDryRunData]  = useState<{ columns: string[]; rows: (string|null)[][]; row_count: number; duration_ms: number } | null>(null)
  const [loading,     setLoading]     = useState(false)
  const [copied,      setCopied]      = useState(false)

  // ── Load-to-MySQL state ─────────────────────────────────────────────────────
  const [tableName,   setTableName]   = useState(pipelineName || 'pipeline_output')
  const [loadMode,     setLoadMode]    = useState<LoadMode>('replace')
  const [loading2,     setLoading2]    = useState(false)
  const [loadResult,   setLoadResult]  = useState<{ table:string; rows_inserted:number; mode:string; duration_ms:number; warning?:string } | null>(null)
  const [loadError,    setLoadError]   = useState('')

  const warnRules   = dqRules.filter(r => r.severity === 'warn')
  const unapproved  = nodes.filter(n => n.status !== 'approved')

  const handleDryRun = async () => {
    if (!pipelineId) return
    setLoading(true)
    try {
      const res = await dryRun(pipelineId, sourceDsn, nodeConfigs)
      setDryRunData(res); setStep(1)
    } catch (e: any) {
      setDryRunData({ columns:['error'], rows:[[e?.response?.data?.detail || 'Failed']], row_count:0, duration_ms:0 })
    } finally { setLoading(false) }
  }

  const handlePreviewSql = async () => {
    if (!pipelineId) return
    setLoading(true)
    try {
      const res = await exportPipeline(pipelineId, nodeConfigs)
      setExportData(res); setStep(2)
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  const handleCopy = () => {
    if (exportData) {
      navigator.clipboard.writeText(exportData.sql)
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleDownload = () => {
    if (!exportData) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([exportData.sql], { type: 'text/sql' }))
    a.download = exportData.filename; a.click()
  }

  // ── The actual data transfer ────────────────────────────────────────────────
  const handleLoadToMySQL = async () => {
    if (!pipelineId || !tableName.trim()) return
    setLoading2(true); setLoadError(''); setLoadResult(null)
    try {
      const res = await loadToMySQL(pipelineId, sourceDsn, targetDsn, nodeConfigs, tableName.trim(), loadMode)
      setLoadResult(res)
      setStatus('exported')
    } catch (e: any) {
      setLoadError(e?.response?.data?.detail || 'Load failed — check both database connections')
    } finally { setLoading2(false) }
  }

  return (
    <div style={{ flex:1, overflowY:'auto' }}>
      <div className="topbar">
        <div className="crumb"><b>Pipelines</b> / <span className="cur">{pipelineName}</span> / <span style={{ color:'var(--text-dim)' }}>Export</span></div>
      </div>
      <div className="content">

        {/* Stepper */}
        <div style={{ display:'flex', alignItems:'center', marginBottom:24 }}>
          {STEPS.map((s, i) => (
            <div key={s} style={{ display:'flex', alignItems:'center' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <div style={{
                  width:22, height:22, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center',
                  fontFamily:'var(--font-mono)', fontSize:11, fontWeight:600,
                  background: i===step ? 'var(--amber)' : i<step ? 'transparent' : 'transparent',
                  color: i===step ? '#fff' : i<step ? 'var(--sage)' : 'var(--text-faint)',
                  border: `1px solid ${i===step ? 'var(--amber)' : i<step ? 'var(--sage)' : 'var(--border2)'}`,
                }}>{i<step ? <Check size={11} strokeWidth={2.5}/> : i+1}</div>
                <span style={{ fontSize:12, color: i===step?'var(--text)':i<step?'var(--text-dim)':'var(--text-faint)', fontWeight: i===step?600:400 }}>{s}</span>
              </div>
              {i < STEPS.length-1 && <div style={{ width:44, height:1, background:'var(--border2)', margin:'0 10px' }}/>}
            </div>
          ))}
        </div>

        {/* Step 0: Review */}
        {step === 0 && (<>
          {unapproved.length > 0 && (
            <div style={{ background:'var(--amber-faint)', border:'1px solid rgba(184,115,51,.2)', borderRadius:7, padding:'10px 14px', marginBottom:14, fontSize:12, color:'var(--amber)' }}>
              ⚠ {unapproved.length} node{unapproved.length>1?'s':''} not yet approved: {unapproved.map(n=>n.label).join(', ')}
            </div>
          )}

          {/* Real DQ status — was previously hardcoded fake numbers (Passing
              always equalled Total Rules, Critical was always literal 0,
              regardless of whether any check had ever actually run). */}
          {dqCheckResults.length === 0 ? (
            dqRules.length > 0 && (
              <div style={{ background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:7, padding:'12px 14px', marginBottom:14, fontSize:12, color:'var(--text-dim)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
                <span>{dqRules.length} DQ rule{dqRules.length!==1?'s':''} defined but never run against real data — go to the DQ Check node in Canvas and click "Run DQ Check" before exporting.</span>
                <button className="btn btn-ghost btn-sm" onClick={() => nav('/canvas')} style={{ flexShrink:0 }}>Go check →</button>
              </div>
            )
          ) : (
            (() => {
              const failedError = dqCheckResults.filter((r:any) => !r.passed && r.severity === 'error')
              const failedWarn  = dqCheckResults.filter((r:any) => !r.passed && r.severity !== 'error')
              const passed      = dqCheckResults.filter((r:any) => r.passed)
              return (failedError.length > 0 || failedWarn.length > 0) && (
                <div style={{
                  background: failedError.length > 0 ? 'var(--rust-faint)' : 'var(--amber-faint)',
                  border: `1px solid ${failedError.length > 0 ? 'rgba(192,68,56,.2)' : 'rgba(184,115,51,.2)'}`,
                  borderRadius:7, padding:'10px 14px', marginBottom:14, fontSize:12,
                  color: failedError.length > 0 ? 'var(--rust)' : 'var(--amber)',
                }}>
                  ⚠ {failedError.length > 0
                    ? `${failedError.length} error-severity DQ rule(s) failed — this will BLOCK the MySQL load until fixed.`
                    : `${failedWarn.length} warning-severity DQ rule(s) failed — the load will proceed but this will be logged as a warning.`}
                </div>
              )
            })()
          )}

          <div style={{ display:'flex', gap:1, marginBottom:18, border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
            {(() => {
              const checked     = dqCheckResults.length > 0
              const passedCount = checked ? dqCheckResults.filter((r:any) => r.passed).length : 0
              const warnCount   = checked ? dqCheckResults.filter((r:any) => !r.passed && r.severity !== 'error').length : 0
              const errorCount  = checked ? dqCheckResults.filter((r:any) => !r.passed && r.severity === 'error').length : 0
              return [
                { n: dqRules.length, l:'Total Rules', d:'faint' },
                { n: checked ? passedCount : '—', l:'Passing',  d:'sage' },
                { n: checked ? warnCount   : '—', l:'Warnings', d:'amber' },
                { n: checked ? errorCount  : '—', l:'Critical', d:'rust' },
              ]
            })().map(s => (
              <div key={s.l} style={{ flex:1, background:'var(--surface)', padding:'14px 16px' }}>
                <div style={{ fontFamily:'var(--font-mono)', fontSize:19, fontWeight:600 }}>{s.n}</div>
                <div style={{ fontSize:10.5, color:'var(--text-faint)', display:'flex', alignItems:'center', gap:5, marginTop:2 }}><span className={`status-dot status-dot-${s.d}`}/>{s.l}</div>
              </div>
            ))}
          </div>
          <div style={{ display:'flex', justifyContent:'space-between' }}>
            <button className="btn btn-ghost" onClick={() => nav('/canvas')}>← Canvas</button>
            <button className="btn btn-primary" onClick={handleDryRun} disabled={loading}><Play size={13}/> {loading?'Running…':'Dry Run'}</button>
          </div>
        </>)}

        {/* Step 1: Dry Run Results */}
        {step === 1 && dryRunData && (<>
          <div className="card" style={{ marginBottom:16 }}>
            <div style={{ fontWeight:600, fontSize:13, marginBottom:8 }}>Dry Run Results</div>
            <div style={{ fontSize:12, color:'var(--text-dim)', marginBottom:10 }}>
              {dryRunData.row_count} rows returned in {dryRunData.duration_ms}ms — this is what would be loaded into MySQL.
            </div>
            {dryRunData.columns.length > 0 && (
              <div style={{ overflowX:'auto', maxHeight:300 }}>
                <table className="preview-table">
                  <thead><tr>{dryRunData.columns.map((c,i) => <th key={i}>{c}</th>)}</tr></thead>
                  <tbody>{dryRunData.rows.slice(0,20).map((row,ri) => <tr key={ri}>{row.map((v,ci) => <td key={ci}>{v ?? 'null'}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
          <div style={{ display:'flex', justifyContent:'space-between' }}>
            <button className="btn btn-ghost" onClick={() => setStep(0)}>← Back</button>
            <button className="btn btn-primary" onClick={handlePreviewSql} disabled={loading}>{loading?'Generating…':'Looks good — Preview SQL →'}</button>
          </div>
        </>)}

        {/* Step 2: SQL Preview */}
        {step === 2 && exportData && (<>
          <div className="card" style={{ padding:0, overflow:'hidden', marginBottom:16 }}>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'10px 14px', borderBottom:'1px solid var(--border)', background:'var(--surface2)' }}>
              <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-dim)' }}>{exportData.filename}</span>
              <button className="btn btn-ghost btn-sm" onClick={handleCopy}><Copy size={12}/>{copied?'Copied':'Copy'}</button>
            </div>
            <pre style={{ padding:14, fontFamily:'var(--font-mono)', fontSize:11.5, lineHeight:1.7, color:'var(--text-dim)', overflow:'auto', background:'var(--surface2)', margin:0, maxHeight:400 }}>{exportData.sql}</pre>
          </div>
          {exportData.warnings.map((w,i) => <div key={i} style={{ fontSize:12, color:'var(--amber)', marginBottom:6 }}>⚠ {w}</div>)}
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:12 }}>
            <button className="btn btn-ghost" onClick={() => setStep(1)}>← Back</button>
            <div style={{ display:'flex', gap:10 }}>
              <button className="btn" onClick={handleDownload}><Copy size={12}/> Download .sql (reference only)</button>
              <button className="btn btn-primary" onClick={() => setStep(3)}>Load into MySQL →</button>
            </div>
          </div>
        </>)}

        {/* Step 3: Load to MySQL — the actual data transfer */}
        {step === 3 && (<>
          {!loadResult && (
            <div className="card" style={{ marginBottom:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14 }}>
                <Database size={16} color="var(--amber)"/>
                <div style={{ fontWeight:600, fontSize:13 }}>Load pipeline output into MySQL</div>
              </div>
              <div style={{ fontSize:12, color:'var(--text-dim)', marginBottom:16, lineHeight:1.6 }}>
                This runs the pipeline's SELECT against PostgreSQL, then creates the target
                table in MySQL (if needed) and inserts every row. This is the step that
                actually moves data — the SQL preview earlier is reference only.
              </div>

              <div style={{ marginBottom:14 }}>
                <label style={{ fontSize:11.5, color:'var(--text-dim)', fontWeight:500, display:'block', marginBottom:6 }}>
                  Target table name (in MySQL)
                </label>
                <input
                  value={tableName}
                  onChange={e => setTableName(e.target.value)}
                  className="finput"
                  style={{ width:'100%', maxWidth:360 }}
                  placeholder="e.g. inventory_reorder_status"
                />
              </div>

              <div style={{ marginBottom:16 }}>
                <label style={{ fontSize:11.5, color:'var(--text-dim)', fontWeight:500, display:'block', marginBottom:6 }}>
                  If the table already exists
                </label>
                <div style={{ display:'flex', gap:8 }}>
                  {([
                    { key:'replace', label:'Replace', desc:'Drop and recreate' },
                    { key:'append',  label:'Append',  desc:'Add rows to existing table' },
                    { key:'fail_if_exists', label:'Fail', desc:'Stop if table exists' },
                  ] as { key:LoadMode; label:string; desc:string }[]).map(opt => (
                    <button
                      key={opt.key}
                      onClick={() => setLoadMode(opt.key)}
                      style={{
                        flex:1, textAlign:'left', padding:'10px 12px', borderRadius:7,
                        border: `1.5px solid ${loadMode===opt.key ? 'var(--amber)' : 'var(--border)'}`,
                        background: loadMode===opt.key ? 'var(--amber-faint)' : 'var(--surface)',
                        cursor:'pointer',
                      }}
                    >
                      <div style={{ fontSize:12, fontWeight:600, color: loadMode===opt.key ? 'var(--amber)' : 'var(--text)' }}>{opt.label}</div>
                      <div style={{ fontSize:10.5, color:'var(--text-faint)', marginTop:2 }}>{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {loadError && (
                <div style={{ display:'flex', alignItems:'flex-start', gap:8, background:'var(--rust-faint)', border:'1px solid rgba(192,68,56,.2)', borderRadius:7, padding:'10px 13px', marginBottom:14, fontSize:12, color:'var(--rust)', lineHeight:1.55 }}>
                  <AlertTriangle size={14} style={{ flexShrink:0, marginTop:1 }}/>
                  {loadError}
                </div>
              )}

              <button className="btn btn-primary" onClick={handleLoadToMySQL} disabled={loading2 || !tableName.trim()}>
                {loading2 ? <><Loader2 size={13} style={{ animation:'spin .8s linear infinite' }}/> Loading into MySQL…</> : <><Database size={13}/> Load Now</>}
              </button>
            </div>
          )}

          {loadResult && (
            <div className="card" style={{ padding:0, overflow:'hidden' }}>
              <div style={{ padding:'20px 24px', background:'var(--sage-faint)', borderBottom:'1px solid rgba(74,140,106,.2)' }}>
                <div style={{ display:'flex', alignItems:'center', gap:9 }}>
                  <CheckCircle size={20} color="var(--sage)"/>
                  <div>
                    <div style={{ fontWeight:600, fontSize:14, color:'var(--sage)' }}>Load complete</div>
                    <div style={{ fontSize:12, color:'var(--text-dim)', marginTop:2 }}>
                      {loadResult.rows_inserted.toLocaleString()} rows inserted into MySQL table
                      {' '}<code style={{ fontFamily:'var(--font-mono)', background:'var(--surface2)', padding:'1px 6px', borderRadius:4 }}>{loadResult.table}</code>
                      {' '}in {loadResult.duration_ms}ms
                    </div>
                  </div>
                </div>
              </div>
              {loadResult.warning && (
                <div style={{ padding:'12px 24px', fontSize:12, color:'var(--amber)' }}>⚠ {loadResult.warning}</div>
              )}
              <div style={{ padding:'16px 24px', display:'flex', gap:10 }}>
                <button className="btn btn-ghost" onClick={() => nav('/canvas')}>Back to Canvas</button>
                <button className="btn btn-ghost" onClick={() => nav('/analytics')}>View Analytics</button>
                <button className="btn" onClick={() => { setLoadResult(null); setLoadMode('append') }}>Load again</button>
              </div>
            </div>
          )}

          <div style={{ marginTop:16 }}>
            <button className="btn btn-ghost" onClick={() => setStep(2)}>← Back to SQL Preview</button>
          </div>
        </>)}

      </div>
    </div>
  )
}
