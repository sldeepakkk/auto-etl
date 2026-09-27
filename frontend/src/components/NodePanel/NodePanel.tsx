import { useState, useEffect } from 'react'
import { Database, Filter, Shield, ShieldCheck, Lock, Sparkles, ArrowRight, Info,
  CheckCircle, XCircle, Play, Plus, Send, Loader2, X,
  GitBranch, BarChart2, Layers, ArrowRight as FlowArrow } from 'lucide-react'
import { usePipelineStore } from '../../stores/pipelineStore'
import { runNode, askAgent, approveNode, addComment, getComments, fixSql,
  runDqCheck, updateDQRule as apiUpdateDQRule, addDQRule as apiAddDQRule } from '../../api/client'
import type { NodeStatus } from '../../types/pipeline'
import './NodePanel.css'

const ICONS: Record<string, React.ReactNode> = {
  source:    <Database size={14} />,
  transform: <Filter size={14} />,
  aggregate: <span style={{ fontFamily:'var(--font-mono)', fontWeight:600, fontSize:13 }}>Σ</span>,
  dq:        <Shield size={14} />,
  output:    <Database size={14} />,
}
const TYPE_LABELS: Record<string, string> = {
  source:    'Source Extraction',
  transform: 'Data Transformation',
  aggregate: 'Metric Aggregation',
  dq:        'Quality Assertion',
  output:    'Target Load',
}
const TYPE_ICONS: Record<string, React.ReactNode> = {
  source:    <Database size={12} />,
  transform: <GitBranch size={12} />,
  aggregate: <BarChart2 size={12} />,
  dq:        <Shield size={12} />,
  output:    <Layers size={12} />,
}
const TRANSFORM_COLORS: Record<string, string> = {
  passthrough: '#8C9099',
  cast:        '#B87333',
  aggregate:   '#4A8C6A',
  derive:      '#9A5E28',
}

type TabKey = 'explain' | 'sql' | 'preview' | 'lineage' | 'dq' | 'comments'

export default function NodePanel() {
  const {
    nodes, edges, selectedNodeId, lineage, dqRules, nodeConfigs, updateNodeSQL,
    pipelineId, sourceDsn, comments, addComment: addCommentStore,
    setComments, updateNodeStatus, updateDQRule, addDQRuleLocal, selectNode,
    dqCheckResults, setDQRuleResults,
  } = usePipelineStore()

  const [tab,            setTab]            = useState<TabKey>('explain')
  const [askInput,       setAskInput]       = useState('')
  const [askLoading,     setAskLoading]     = useState(false)
  const [askResult,      setAskResult]      = useState<{ revised_sql:string; explanation:string; changes:string[] } | null>(null)
  const [previewData,    setPreviewData]    = useState<{ columns:string[]; rows:(string|null)[][]; duration_ms:number } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError,   setPreviewError]   = useState('')
  const [fixLoading,    setFixLoading]    = useState(false)
  const [fixResult,     setFixResult]     = useState<{fixed_sql:string;changes:string[]}|null>(null)
  const [commentText,    setCommentText]    = useState('')
  const [commentsLoading,setCommentsLoading]= useState(false)
  const [blockReason,    setBlockReason]    = useState('')
  const [showBlockInput, setShowBlockInput] = useState(false)
  const [showAddDQ,      setShowAddDQ]      = useState(false)
  const [dqCheckLoading, setDqCheckLoading] = useState(false)
  const [dqCheckError,   setDqCheckError]   = useState('')
  const [hasRunDqCheck,  setHasRunDqCheck]  = useState(false)
  const [newDQ,          setNewDQ]          = useState({ column:'', rule:'not_null', severity:'warn', min:'', max:'', pattern:'' })
  const [addRuleLoading, setAddRuleLoading] = useState(false)
  const [addRuleError,   setAddRuleError]   = useState('')

  const node         = nodes.find(n => n.id === selectedNodeId)
  const nodeLineage  = lineage.filter(l => l.node_id === selectedNodeId)
  // The DQ Check node conceptually validates the pipeline's final output —
  // its rules are tagged with whichever upstream node (typically the
  // aggregate step) their source column came from, never with the DQ
  // node's own id. So on the DQ node specifically, show ALL pipeline
  // rules rather than filtering by node_id (which would always be empty).
  const nodeRules = node?.type === 'dq'
    ? dqRules
    : dqRules.filter(r => r.node_id === selectedNodeId)
  const nodeComments = comments.filter(c => c.node_id === selectedNodeId)
  const sql          = nodeConfigs[node?.id || ''] ?? node?.sql_draft ?? ''

  const upstreamEdge   = edges.find(e => e.target === selectedNodeId)
  const downstreamEdge = edges.find(e => e.source === selectedNodeId)
  const upstreamNode   = upstreamEdge   ? nodes.find(n => n.id === upstreamEdge.source)   : null
  const downstreamNode = downstreamEdge ? nodes.find(n => n.id === downstreamEdge.target) : null

  useEffect(() => {
    setAskResult(null); setPreviewData(null); setPreviewError(''); setFixResult(null)
    setShowBlockInput(false); setShowAddDQ(false); setTab('explain'); setDqCheckError(''); setHasRunDqCheck(false)
    if (!pipelineId || !selectedNodeId) return
    setCommentsLoading(true)
    getComments(pipelineId, selectedNodeId).then(setComments).catch(() => {}).finally(() => setCommentsLoading(false))
  }, [selectedNodeId, pipelineId])

  if (!node) {
    return (
      <div className="node-panel empty">
        <Info size={18} color="var(--text-faint)" />
        <span>Click a node to inspect it</span>
      </div>
    )
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleRunNode = async () => {
    if (!pipelineId || !sourceDsn) {
      setPreviewError('No pipeline or source connection.'); setTab('preview'); return
    }
    setPreviewLoading(true); setPreviewError('')
    try {
      const res = await runNode(pipelineId, node.id, sourceDsn, nodeConfigs[node.id], 100)
      setPreviewData({ columns: res.columns, rows: res.rows, duration_ms: res.duration_ms })
      setTab('preview')
    } catch (e: any) {
      setPreviewError(e?.response?.data?.detail || 'Query failed — check the SQL in the SQL tab')
      setTab('preview')
    } finally { setPreviewLoading(false) }
  }

  // ── SQL Auto-fix ────────────────────────────────────────────────────────────
  const handleFixSql = async () => {
    if (!pipelineId || !sourceDsn || !previewError) return
    setFixLoading(true); setFixResult(null)
    try {
      const result = await fixSql(pipelineId, node.id, sql, previewError, sourceDsn)
      setFixResult(result)
    } catch (e: any) { console.error('Fix SQL failed:', e) }
    finally { setFixLoading(false) }
  }

  const acceptFix = () => {
    if (!fixResult || !node) return
    updateNodeSQL(node.id, fixResult.fixed_sql)
    setFixResult(null); setPreviewError('')
    setTimeout(() => handleRunNode(), 150)
  }

  const handleAsk = async () => {
    if (!askInput.trim() || !pipelineId) return
    setAskLoading(true)
    try {
      const res = await askAgent(pipelineId, node.id, askInput, sql)
      setAskResult(res)
      setAskInput('')
      setTab('sql')          // ← Fix 4: auto-switch to SQL tab to show diff
    } catch (e: any) { console.error('Ask Agent:', e) }
    finally { setAskLoading(false) }
  }

  const acceptAsk = () => { if (askResult) { updateNodeSQL(node.id, askResult.revised_sql); setAskResult(null) } }

  const handleApprove = async () => {
    updateNodeStatus(node.id, 'approved')
    if (pipelineId) approveNode(pipelineId, node.id, 'approved').catch(console.error)
  }
  const handleBlock = async () => {
    updateNodeStatus(node.id, 'blocked')
    if (pipelineId) approveNode(pipelineId, node.id, 'blocked', blockReason).catch(console.error)
    setShowBlockInput(false); setBlockReason('')
  }
  const handleReset = async () => {
    updateNodeStatus(node.id, 'pending_review')
    if (pipelineId) approveNode(pipelineId, node.id, 'pending_review').catch(console.error)
  }
  const handleComment = async () => {
    if (!commentText.trim() || !pipelineId) return
    const c = { node_id: node.id, author:'user', text: commentText, created_at: new Date().toISOString() }
    addCommentStore(c); setCommentText('')
    addComment(pipelineId, node.id, commentText).catch(console.error)
  }

  // ── DQ Check execution — runs real validation queries, not just suggestions ──
  const handleRunDqCheck = async () => {
    if (!pipelineId || !sourceDsn) { setDqCheckError('No pipeline or source connection.'); return }
    setDqCheckLoading(true); setDqCheckError('')
    try {
      const res = await runDqCheck(pipelineId, sourceDsn, nodeConfigs)
      setDQRuleResults(res.results.map(r => ({ ...r, checked_at: res.checked_at })))
      setHasRunDqCheck(true)
    } catch (e: any) {
      setDqCheckError(e?.response?.data?.detail || 'DQ check failed to run')
    } finally { setDqCheckLoading(false) }
  }

  const handleToggleRule = (rule: typeof dqRules[number], globalIdx: number) => {
    const newEnabled = !(rule.enabled !== false)
    updateDQRule(globalIdx, rule.params, newEnabled)
    if (pipelineId) apiUpdateDQRule(pipelineId, globalIdx, rule.params, undefined, newEnabled).catch(console.error)
  }

  // ── Add custom rule — persists to the backend, not just local state ─────────
  const handleAddCustomRule = async () => {
    if (!newDQ.column.trim()) { setAddRuleError('Column name is required.'); return }
    if (!pipelineId) { setAddRuleError('No pipeline loaded.'); return }

    const params: Record<string, any> = {}
    if (newDQ.rule === 'range_bounds') {
      if (newDQ.min !== '') params.min = Number(newDQ.min)
      if (newDQ.max !== '') params.max = Number(newDQ.max)
      if (params.min === undefined && params.max === undefined) {
        setAddRuleError('Provide at least a min or max value.'); return
      }
    }
    if (newDQ.rule === 'pattern_consistency') {
      if (!newDQ.pattern.trim()) { setAddRuleError('Provide a regex pattern.'); return }
      params.pattern = newDQ.pattern.trim()
    }

    setAddRuleLoading(true); setAddRuleError('')
    try {
      await apiAddDQRule(pipelineId, node.id, newDQ.column.trim(), newDQ.rule, newDQ.severity, params)
      addDQRuleLocal({ node_id: node.id, column: newDQ.column.trim(), rule: newDQ.rule,
        severity: newDQ.severity, preliminary: false, params, enabled: true })
      setNewDQ({ column:'', rule:'not_null', severity:'warn', min:'', max:'', pattern:'' })
      setShowAddDQ(false)
    } catch (e: any) {
      setAddRuleError(e?.response?.data?.detail || 'Failed to save rule — try again.')
    } finally { setAddRuleLoading(false) }
  }

  const transformTypeCounts = nodeLineage.reduce((acc, l) => {
    acc[l.transform_type] = (acc[l.transform_type] || 0) + 1; return acc
  }, {} as Record<string, number>)

  const tabs: { key:TabKey; label:string }[] = [
    { key:'explain',  label:'Explain' },
    { key:'sql',      label:'SQL' },
    { key:'preview',  label:'Preview' },
    ...(nodeLineage.length ? [{ key:'lineage' as TabKey, label:'Lineage' }] : []),
    ...(nodeRules.length || node.type === 'dq'
        ? [{ key:'dq' as TabKey, label: nodeRules.length ? `DQ (${nodeRules.length})` : 'DQ Rules' }]
        : []),
    { key:'comments', label:`Comments${nodeComments.length ? ` (${nodeComments.length})` : ''}` },
  ]

  return (
    <div className="node-panel">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="panel-head">
        <div className="panel-title-row">
          <div className="panel-icon">{ICONS[node.type]}</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div className="panel-title">{node.label}</div>
            <div className="panel-meta">
              {TYPE_LABELS[node.type] || node.type}
              {!node.editable && ' · locked'}
              {node.cte_name && <span className="panel-cte-tag">cte: {node.cte_name}</span>}
            </div>
          </div>
          {/* Fix 3 — Close button */}
          <button className="panel-close-btn" onClick={() => selectNode(null)} title="Close panel">
            <X size={15} />
          </button>
        </div>

        {/* Approval bar */}
        <div className="approval-bar">
          {node.status === 'pending_review' && <>
            <button className="btn btn-sm approve-btn" onClick={handleApprove}><CheckCircle size={13}/> Approve</button>
            {showBlockInput ? (
              <div className="block-input-row">
                <input value={blockReason} onChange={e => setBlockReason(e.target.value)}
                  placeholder="Reason for blocking…" className="block-input"/>
                <button className="btn btn-sm" onClick={handleBlock}>Confirm</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowBlockInput(false)}>Cancel</button>
              </div>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowBlockInput(true)}><XCircle size={13}/> Block</button>
            )}
          </>}
          {node.status === 'approved' && (
            <div className="status-badge approved"><CheckCircle size={12}/> Approved <button className="btn btn-ghost btn-sm" onClick={handleReset}>Reset</button></div>
          )}
          {node.status === 'blocked' && (
            <div className="status-badge blocked"><XCircle size={12}/> Blocked <button className="btn btn-ghost btn-sm" onClick={handleReset}>Reset</button></div>
          )}
        </div>
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────────── */}
      <div className="panel-tabs">
        {tabs.map(t => (
          <button key={t.key} className={`panel-tab ${tab===t.key?'active':''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="panel-body">

        {/* ══ EXPLAIN ════════════════════════════════════════════════════ */}
        {tab === 'explain' && (
          <div className="explain-tab">

            {/* Description card */}
            <div className="explain-card">
              <div className="explain-card-header">
                <span className="explain-card-icon">{TYPE_ICONS[node.type]}</span>
                <span className="explain-card-title">What this step does</span>
              </div>
              <div className="explain-card-body">
                {node.description
                  ? node.description
                      .split(/(?<=\.)\s+/)
                      .filter(Boolean)
                      .map((s, i) => <p key={i}>{s.trim().endsWith('.') ? s.trim() : s.trim() + '.'}</p>)
                  : <p style={{ color:'var(--text-faint)' }}>No description generated.</p>
                }
              </div>
            </div>

            {/* Data flow card — vertical timeline (works in narrow panel) */}
            {(upstreamNode || downstreamNode) && (
              <div className="explain-card">
                <div className="explain-card-header">
                  <span className="explain-card-icon"><FlowArrow size={12}/></span>
                  <span className="explain-card-title">Data flow</span>
                </div>
                <div className="flow-timeline">
                  {upstreamNode && (
                    <div className="flow-row">
                      <div className="flow-dot upstream" />
                      <div className="flow-content">
                        <div className="flow-label">From</div>
                        <div className="flow-name">{upstreamNode.label}</div>
                        {upstreamNode.cte_name && <div className="flow-cte">{upstreamNode.cte_name}</div>}
                      </div>
                    </div>
                  )}
                  {!upstreamNode && (
                    <div className="flow-row">
                      <div className="flow-dot upstream" />
                      <div className="flow-content">
                        <div className="flow-label">From</div>
                        <div className="flow-name">Raw source tables</div>
                      </div>
                    </div>
                  )}
                  <div className="flow-connector" />
                  <div className="flow-row">
                    <div className="flow-dot current" />
                    <div className="flow-content">
                      <div className="flow-label">This step</div>
                      <div className="flow-name current">{node.label}</div>
                      {node.cte_name && <div className="flow-cte">{node.cte_name}</div>}
                    </div>
                  </div>
                  {downstreamNode && <>
                    <div className="flow-connector" />
                    <div className="flow-row">
                      <div className="flow-dot downstream" />
                      <div className="flow-content">
                        <div className="flow-label">To</div>
                        <div className="flow-name">{downstreamNode.label}</div>
                        {downstreamNode.cte_name && <div className="flow-cte">{downstreamNode.cte_name}</div>}
                      </div>
                    </div>
                  </>}
                </div>
              </div>
            )}

            {/* Column mapping cards */}
            {nodeLineage.length > 0 && (
              <div className="explain-card">
                <div className="explain-card-header">
                  <span className="explain-card-icon">
                    <span style={{ fontFamily:'var(--font-mono)', fontWeight:700, fontSize:10 }}>{'{}'}</span>
                  </span>
                  <span className="explain-card-title">
                    {nodeLineage.length} column mapping{nodeLineage.length!==1?'s':''}
                  </span>
                  {/* Type summary pills */}
                  <div className="col-type-pills">
                    {Object.entries(transformTypeCounts).map(([type, count]) => (
                      <span key={type} className="col-type-pill"
                        style={{ background: TRANSFORM_COLORS[type]+'18', color: TRANSFORM_COLORS[type], borderColor: TRANSFORM_COLORS[type]+'44' }}>
                        {count} {type}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="col-cards">
                  {nodeLineage.map((l, i) => (
                    <div key={i} className="col-card">
                      <div className="col-card-head">
                        <span className="col-card-name">{l.target_column}</span>
                        <span className={`tag ${l.transform_type==='cast'||l.transform_type==='aggregate'?'tag-amber':''}`} style={{ color: TRANSFORM_COLORS[l.transform_type] }}>
                          {l.transform_type}
                        </span>
                      </div>
                      {l.derivation_logic ? (
                        <p className="col-card-logic">{l.derivation_logic}</p>
                      ) : (
                        <p className="col-card-logic" style={{ color:'var(--text-faint)', fontStyle:'italic' }}>
                          Narration unavailable — see Lineage tab for source mapping.
                        </p>
                      )}
                      <div className="col-card-trace">
                        <span className="trace-src">{l.source_table}.<wbr/>{l.source_column}</span>
                        <FlowArrow size={10} color="var(--text-faint)" style={{ flexShrink:0 }}/>
                        <span className="trace-tgt">{l.target_column}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* DQ rules preview card */}
            {nodeRules.length > 0 && (
              <div className="explain-card">
                <div className="explain-card-header">
                  <span className="explain-card-icon"><Shield size={12}/></span>
                  <span className="explain-card-title">{nodeRules.length} DQ rule{nodeRules.length!==1?'s':''}</span>
                </div>
                {nodeRules.map((r, i) => (
                  <div key={i} className="dq-mini-row">
                    <span className="dq-mini-rule">{r.rule}</span>
                    <span className="dq-mini-on">on</span>
                    <span className="dq-mini-col">{r.column}</span>
                    <span className={`tag ${r.severity==='error'?'tag-amber':''}`} style={{ marginLeft:'auto' }}>{r.severity}</span>
                  </div>
                ))}
              </div>
            )}

            <button className="btn btn-sm run-btn" onClick={handleRunNode} disabled={previewLoading}>
              {previewLoading ? <Loader2 size={12} className="spin"/> : <Play size={12}/>}
              {previewLoading ? 'Running…' : 'Test this step'}
            </button>
          </div>
        )}

        {/* ══ SQL ════════════════════════════════════════════════════════ */}
        {tab === 'sql' && (
          <div>
            {node.cte_name && (
              <div className="cte-header">
                <span className="cte-kw">WITH</span> <span className="cte-name">{node.cte_name}</span> <span className="cte-kw">AS</span> {' ('}
              </div>
            )}
            <textarea className={`sql-editor ${node.cte_name?'indented':''}`}
              value={sql}
              onChange={e => node.editable && updateNodeSQL(node.id, e.target.value)}
              readOnly={!node.editable} spellCheck={false}/>
            {node.cte_name && <div className="cte-footer">)</div>}
            {!node.editable && (
              <div className="readonly-note"><Lock size={11}/> Structural step — generated automatically</div>
            )}

            {/* Fix 4 — Ask Agent diff now visible here after handleAsk sets tab */}
            {askResult && (
              <div className="ask-diff">
                <div className="ask-diff-header">
                  <Sparkles size={12}/> Agent suggestion
                </div>
                <div className="ask-diff-explanation">{askResult.explanation}</div>
                {askResult.changes.length > 0 && (
                  <div className="ask-diff-changes">
                    {askResult.changes.map((c, i) => <div key={i} className="ask-diff-change">• {c}</div>)}
                  </div>
                )}
                <pre className="ask-diff-sql">{askResult.revised_sql}</pre>
                <div className="ask-diff-actions">
                  <button className="btn btn-sm approve-btn" onClick={acceptAsk}><CheckCircle size={12}/> Accept changes</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setAskResult(null)}><XCircle size={12}/> Reject</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══ PREVIEW ════════════════════════════════════════════════════ */}
        {tab === 'preview' && (
          <div>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
              <span className="preview-note">
                {previewData
                  ? `${previewData.rows.length} rows · ${previewData.duration_ms}ms`
                  : 'Execute this step against the source database.'}
              </span>
              <button className="btn btn-sm" onClick={handleRunNode} disabled={previewLoading}>
                {previewLoading ? <Loader2 size={12} className="spin"/> : <Play size={12}/>}
                {previewLoading ? 'Running…' : 'Run'}
              </button>
            </div>
            {previewError && !fixResult && (
              <div className="preview-error-card">
                <div className="preview-error-title">Query error</div>
                <div className="preview-error-msg">{previewError}</div>
                <div className="preview-error-actions">
                  <button className="btn btn-sm fix-sql-btn" onClick={handleFixSql} disabled={fixLoading}>
                    {fixLoading
                      ? <><Loader2 size={12} className="spin"/> Fixing with AI…</>
                      : <><Sparkles size={12}/> Fix SQL with AI</>}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setTab('sql')}>
                    Edit manually →
                  </button>
                </div>
              </div>
            )}

            {fixResult && (
              <div className="ask-diff">
                <div className="ask-diff-header">
                  <Sparkles size={12}/> AI-corrected SQL
                </div>
                {fixResult.changes.length > 0 && (
                  <div className="ask-diff-changes">
                    {fixResult.changes.map((c, i) => <div key={i} className="ask-diff-change">• {c}</div>)}
                  </div>
                )}
                <pre className="ask-diff-sql">{fixResult.fixed_sql}</pre>
                <div className="ask-diff-actions">
                  <button className="btn btn-sm approve-btn" onClick={acceptFix}>
                    <CheckCircle size={12}/> Accept &amp; re-run
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setFixResult(null)}>
                    <XCircle size={12}/> Dismiss
                  </button>
                </div>
              </div>
            )}
            {previewData && previewData.columns.length > 0 && (
              <div style={{ overflowX:'auto' }}>
                <table className="preview-table">
                  <thead><tr>{previewData.columns.map((c,i) => <th key={i}>{c}</th>)}</tr></thead>
                  <tbody>{previewData.rows.slice(0,100).map((row,ri) => (
                    <tr key={ri}>{row.map((v,ci) => (
                      <td key={ci} className={v===null?'null-val':''}>{v===null?'null':v.length>80?v.slice(0,80)+'…':v}</td>
                    ))}</tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══ LINEAGE ════════════════════════════════════════════════════ */}
        {tab === 'lineage' && (
          nodeLineage.length === 0
            ? <div className="explain-empty">No lineage data for this node.</div>
            : nodeLineage.map((l, i) => (
              <div key={i} className="lineage-entry">
                <div className="lineage-entry-header">
                  <span className="lineage-target">{l.target_column}</span>
                  <span className={`tag ${l.transform_type==='cast'||l.transform_type==='aggregate'?'tag-amber':''}`}>{l.transform_type}</span>
                </div>
                {l.derivation_logic && <div className="lineage-logic">{l.derivation_logic}</div>}
                <div className="lineage-trace">
                  <span className="trace-src">{l.source_table}.{l.source_column}</span>
                  <span className="trace-arrow"> → </span>
                  <span className="trace-tgt">{l.target_column}</span>
                </div>
              </div>
            ))
        )}

        {/* ══ DQ RULES ═══════════════════════════════════════════════════ */}
        {tab === 'dq' && (
          <div>
            {nodeRules.some(r => r.preliminary) && (
              <div className="dq-prelim-banner">⚠ Preliminary rules — profiling generates statistical thresholds.</div>
            )}

            {nodeRules.length === 0 && (
              <div style={{ fontSize:12, color:'var(--text-faint)', marginBottom:12, padding:'10px 12px',
                background:'var(--surface2)', borderRadius:7, border:'1px solid var(--border)' }}>
                No DQ rules exist for this pipeline yet. Add one below, then Run DQ Check
                becomes available.
              </div>
            )}

            {/* Run DQ Check — executes real validation queries against the aggregated output */}
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
              <span style={{ fontSize:11.5, color:'var(--text-faint)' }}>
                {hasRunDqCheck
                  ? (dqCheckResults.length > 0
                      ? `Checked ${dqCheckResults.length} rule${dqCheckResults.length!==1?'s':''} at ${dqCheckResults[0]?.checked_at ? new Date(dqCheckResults[0].checked_at).toLocaleTimeString() : ''}`
                      : 'Checked — no rules were checkable (columns may not exist in the output, or all rules are disabled).')
                  : 'Rules are suggestions until run against real data.'}
              </span>
              <button className="btn btn-sm" onClick={handleRunDqCheck} disabled={dqCheckLoading || nodeRules.length===0}>
                {dqCheckLoading ? <Loader2 size={12} className="spin"/> : <ShieldCheck size={12}/>}
                {dqCheckLoading ? 'Checking…' : 'Run DQ Check'}
              </button>
            </div>
            {dqCheckError && <div className="error-banner" style={{ marginBottom:10 }}>{dqCheckError}</div>}

            {nodeRules.map((r, i) => {
              const globalIdx = dqRules.indexOf(r)
              const result = dqCheckResults.find((res:any) => res.rule_index === globalIdx)
              return (
                <div key={i} className="rule-row">
                  <div className={`rule-toggle ${r.enabled !== false ? 'on' : ''}`}
                    onClick={() => handleToggleRule(r, globalIdx)}/>
                  <div className="rule-info">
                    <div className="rule-name">{r.rule}</div>
                    <div className="rule-col">{r.column}</div>
                    {r.params && Object.keys(r.params).length > 0 && (
                      <div className="rule-params">
                        {Object.entries(r.params).map(([k,v]) => (
                          <span key={k} className="rule-param">
                            {k}: <input className="param-input" defaultValue={String(v)}
                              onBlur={e => {
                                const parsed = isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value)
                                updateDQRule(globalIdx, { ...r.params, [k]: parsed })
                                if (pipelineId) apiUpdateDQRule(pipelineId, globalIdx, { ...r.params, [k]: parsed }).catch(console.error)
                              }}/>
                          </span>
                        ))}
                      </div>
                    )}
                    {result && (
                      <div className={`rule-result ${result.passed ? 'pass' : 'fail'}`}>
                        {result.passed
                          ? <><CheckCircle size={11}/> Passed — 0 of {result.checked_rows} rows violate this rule</>
                          : <><XCircle size={11}/> Failed — {result.violation_count} of {result.checked_rows} rows violate this rule</>}
                      </div>
                    )}
                  </div>
                  <span className={`tag ${r.severity==='error'?'tag-amber':''}`}>{r.severity}</span>
                </div>
              )
            })}
            {showAddDQ ? (
              <div className="add-dq-form">
                <input placeholder="Column name" value={newDQ.column} onChange={e => setNewDQ({...newDQ,column:e.target.value})} className="block-input"/>
                <select value={newDQ.rule} onChange={e => setNewDQ({...newDQ,rule:e.target.value})} className="block-input">
                  <option value="not_null">not_null</option><option value="range_bounds">range_bounds</option>
                  <option value="uniqueness">uniqueness</option><option value="pattern_consistency">pattern_consistency</option>
                </select>
                <select value={newDQ.severity} onChange={e => setNewDQ({...newDQ,severity:e.target.value})} className="block-input">
                  <option value="warn">warn</option><option value="error">error</option>
                </select>
                {newDQ.rule === 'range_bounds' && (
                  <div style={{ display:'flex', gap:6 }}>
                    <input placeholder="Min" type="number" value={newDQ.min}
                      onChange={e => setNewDQ({...newDQ, min:e.target.value})} className="block-input"/>
                    <input placeholder="Max" type="number" value={newDQ.max}
                      onChange={e => setNewDQ({...newDQ, max:e.target.value})} className="block-input"/>
                  </div>
                )}
                {newDQ.rule === 'pattern_consistency' && (
                  <input placeholder="Regex pattern, e.g. ^[^@]+@[^@]+$" value={newDQ.pattern}
                    onChange={e => setNewDQ({...newDQ, pattern:e.target.value})} className="block-input"/>
                )}
                {addRuleError && <div style={{ fontSize:11, color:'var(--rust)' }}>{addRuleError}</div>}
                <div style={{ display:'flex', gap:6, marginTop:6 }}>
                  <button className="btn btn-sm" onClick={handleAddCustomRule} disabled={addRuleLoading}>
                    {addRuleLoading ? <Loader2 size={12} className="spin"/> : null}
                    {addRuleLoading ? 'Saving…' : 'Add rule'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setShowAddDQ(false); setAddRuleError('') }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="btn btn-ghost btn-sm" style={{marginTop:10}} onClick={() => setShowAddDQ(true)}>
                <Plus size={12}/> Add custom rule
              </button>
            )}
          </div>
        )}

        {/* ══ COMMENTS ═══════════════════════════════════════════════════ */}
        {tab === 'comments' && (
          <div>
            {commentsLoading
              ? <div className="explain-empty"><Loader2 size={16} className="spin"/> Loading…</div>
              : nodeComments.length === 0
                ? <div className="empty-comments">No comments yet.</div>
                : nodeComments.map((c,i) => (
                  <div key={i} className="comment-row">
                    <div className="comment-header">
                      <span className="comment-author">{c.author}</span>
                      <span className="comment-time">{c.created_at?.slice(0,10)}</span>
                    </div>
                    <div className="comment-text">{c.text}</div>
                  </div>
                ))
            }
            <div className="comment-input-row">
              <input value={commentText} onChange={e => setCommentText(e.target.value)}
                placeholder="Add a comment…" className="comment-input"
                onKeyDown={e => { if (e.key==='Enter') handleComment() }}/>
              <button className="ask-send" onClick={handleComment}><Send size={13}/></button>
            </div>
          </div>
        )}
      </div>

      {/* ── Footer — Ask Agent ─────────────────────────────────────────── */}
      <div className="panel-foot">
        {node.editable ? (
          <>
            <div className="ask-label"><Sparkles size={11}/> Ask Agent — scoped to this node</div>
            <div className="ask-row">
              <input value={askInput} onChange={e => setAskInput(e.target.value)}
                placeholder="e.g. fix the duedate column alias"
                onKeyDown={e => { if (e.key==='Enter') handleAsk() }} disabled={askLoading}/>
              <button className="ask-send" onClick={handleAsk} disabled={askLoading}>
                {askLoading ? <Loader2 size={14} className="spin"/> : <ArrowRight size={14}/>}
              </button>
            </div>
            {askLoading && <div className="ask-loading-note">Asking Groq/LLaMA…</div>}
          </>
        ) : (
          <div className="locked-note"><Lock size={12}/> Structural step — not available for editing</div>
        )}
      </div>
    </div>
  )
}
