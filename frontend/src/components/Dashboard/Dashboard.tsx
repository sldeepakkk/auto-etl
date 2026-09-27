import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, AlertTriangle } from 'lucide-react'
import { usePipelineStore } from '../../stores/pipelineStore'
import { fetchTables, generatePipeline } from '../../api/client'
import TablePreviewPanel from './TablePreviewPanel'
import type { TableInfo } from '../../types/pipeline'
import './Dashboard.css'

const EXAMPLES = [
  'Summarise total sales revenue by territory and salesperson per year',
  'Identify products below safety stock level with total inventory value',
  'Show headcount and monthly payroll per department',
]

function suggestTables(req: string, tables: TableInfo[]): Set<string> {
  if (!req.trim()) return new Set()
  const words = new Set(
    req.toLowerCase().replace(/[^a-z0-9\s_.]/g, ' ').split(/\s+/).filter(w => w.length > 2)
  )
  const out = new Set<string>()
  for (const t of tables) {
    const parts = t.name.toLowerCase().split('.').flatMap(p => p.split('_'))
    if (parts.some(p => words.has(p))) out.add(t.name)
  }
  return out
}

export default function Dashboard() {
  const nav = useNavigate()
  const {
    sourceDsn, targetDsn, requirement, setRequirement,
    tableList, selectedTables, tablesLoading,
    setTableList, setTablesLoading, toggleTable, selectAllTables, clearAllTables,
    setStatus, setPipeline,
  } = usePipelineStore()

  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState('')
  const [apiWarning,   setApiWarning]   = useState('')
  const [tableSearch,  setTableSearch]  = useState('')
  const [previewTable, setPreviewTable] = useState<string | null>(null)

  // Check API key health
  useEffect(() => {
    import('../../api/client').then(({ default: api }) => {
      api.get('/health').then(res => {
        const d = res.data
        if (d?.issues?.length > 0) setApiWarning(d.issues.join(' · '))
      }).catch(() => {})
    })
  }, [])

  // Fetch tables from live source DB
  useEffect(() => {
    if (!sourceDsn || tableList.length > 0) return
    setTablesLoading(true)
    fetchTables(sourceDsn)
      .then(r => setTableList(r.tables))
      .catch(e => setError(e?.response?.data?.detail || 'Failed to load tables'))
      .finally(() => setTablesLoading(false))
  }, [sourceDsn])

  const suggested = useMemo(() => suggestTables(requirement, tableList), [requirement, tableList])
  const filtered  = tableList.filter(t => t.name.toLowerCase().includes(tableSearch.toLowerCase()))

  const handleGenerate = async () => {
    if (!requirement.trim() || !selectedTables.length) return
    setLoading(true); setError(''); setStatus('generating')
    try {
      const res = await generatePipeline(requirement, selectedTables, sourceDsn, targetDsn)
      setPipeline({
        pipelineId:   res.pipeline_id,
        pipelineName: res.pipeline_name,
        nodes:        res.nodes,
        edges:        res.edges,
        lineage:      res.lineage,
        dqRules:      res.dq_rules,
        warnings:     res.warnings || [],
      })
      nav('/canvas')
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Generation failed — check API keys in backend/.env')
      setStatus('idle')
    } finally { setLoading(false) }
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div className="topbar">
        <div className="crumb"><b>Auto ETL</b> / <span className="cur">New Pipeline</span></div>
      </div>
      <div className="content">
        <div className="page-head">
          <div className="page-title">New Pipeline</div>
          <div className="page-sub">Select source tables, then describe what to build.</div>
        </div>

        {/* API key warning */}
        {apiWarning && (
          <div className="api-warning-banner">
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <strong>AI features unavailable:</strong> {apiWarning}<br />
              <span style={{ fontSize: 11 }}>
                Edit <code>backend/.env</code> and restart: <code>uvicorn main:app --reload</code>
              </span>
            </div>
          </div>
        )}

        {/* Table selector */}
        <div className="card table-selector">
          <div className="table-selector-head">
            <div>
              <span className="label">Source Tables</span>
              <span className="table-count">
                {tablesLoading
                  ? 'Loading…'
                  : selectedTables.length > 0
                    ? `${selectedTables.length} of ${tableList.length} selected`
                    : `${tableList.length} available`}
              </span>
            </div>
            <div className="table-sel-actions">
              <button className="btn btn-ghost btn-sm" onClick={clearAllTables}>Clear</button>
              <button className="btn btn-ghost btn-sm" onClick={selectAllTables}>Select all</button>
            </div>
          </div>

          <div className="table-search-bar">
            <Search size={13} color="var(--text-faint)" />
            <input value={tableSearch} onChange={e => setTableSearch(e.target.value)} placeholder="Filter tables…" />
          </div>

          <div className="table-list">
            {tablesLoading ? (
              <div className="table-empty">Connecting to source database…</div>
            ) : filtered.length === 0 && tableList.length === 0 ? (
              <div className="table-empty">No tables found — check source connection</div>
            ) : filtered.length === 0 ? (
              <div className="table-empty">No tables match "{tableSearch}"</div>
            ) : (
              filtered.map(t => {
                const sel = selectedTables.includes(t.name)
                const sug = suggested.has(t.name)
                return (
                  <div key={t.name} className={`table-row ${sel ? 'selected' : ''}`}>
                    <div
                      className={`table-cb ${sel ? 'checked' : ''}`}
                      onClick={e => { e.stopPropagation(); toggleTable(t.name) }}
                    />
                    <div className="table-name" onClick={() => setPreviewTable(t.name)} title="Click to preview">
                      {t.name}
                      {sug && !sel && <span className="table-sug-badge">suggested</span>}
                    </div>
                    <div className="table-meta-wrap">
                      <span className="table-meta">
                        {t.column_count} cols
                        {t.approx_rows > 0 && <span> · ~{t.approx_rows.toLocaleString()}</span>}
                      </span>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Requirement */}
        <div className="card prompt-card">
          <span className="label">Pipeline Requirement</span>
          <textarea
            className="prompt-box"
            value={requirement}
            onChange={e => setRequirement(e.target.value)}
            placeholder="Describe the pipeline you want to build in plain English…"
          />
          <div className="chip-row">
            {EXAMPLES.map(ex => <button key={ex} className="chip" onClick={() => setRequirement(ex)}>{ex}</button>)}
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="dash-foot">
          <div className="dash-foot-note">
            {selectedTables.length === 0
              ? 'Select at least one table to continue.'
              : `${selectedTables.length} table${selectedTables.length > 1 ? 's' : ''} selected — Schema Reader will inspect these only.`}
          </div>
          <button
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={loading || !requirement.trim() || !selectedTables.length}
          >
            {loading ? 'Generating…' : 'Generate Pipeline'}
          </button>
        </div>
      </div>

      {previewTable && (
        <TablePreviewPanel tableName={previewTable} sourceDsn={sourceDsn} onClose={() => setPreviewTable(null)} />
      )}
    </div>
  )
}
