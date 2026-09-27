import { useEffect, useState } from 'react'
import { X, Database, Loader2 } from 'lucide-react'
import { fetchTablePreview, type TablePreview } from '../../api/client'
import './TablePreviewPanel.css'

interface Props {
  tableName:  string
  sourceDsn:  string
  onClose:    () => void
}

export default function TablePreviewPanel({ tableName, sourceDsn, onClose }: Props) {
  const [data,    setData]    = useState<TablePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    setData(null); setLoading(true); setError('')
    fetchTablePreview(tableName, sourceDsn, 10)
      .then(setData)
      .catch(e => setError(e?.response?.data?.detail || 'Could not load preview'))
      .finally(() => setLoading(false))
  }, [tableName, sourceDsn])

  return (
    <div className="tpp-overlay" onClick={onClose}>
      <div className="tpp-panel" onClick={e => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className="tpp-header">
          <div className="tpp-title">
            <Database size={15} color="var(--amber)" />
            <span>{tableName}</span>
          </div>
          <button className="tpp-close" onClick={onClose}><X size={15} /></button>
        </div>

        {loading && (
          <div className="tpp-loading">
            <Loader2 size={18} className="tpp-spin" />
            <span>Loading preview…</span>
          </div>
        )}

        {error && !loading && (
          <div className="tpp-error">{error}</div>
        )}

        {data && !loading && (
          <div className="tpp-body">

            {/* ── Schema section ── */}
            <div className="tpp-section-label">Schema — {data.columns.length} columns</div>
            <div className="tpp-schema-wrap">
              <table className="tpp-table">
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>PostgreSQL type</th>
                    <th>MySQL type</th>
                    <th>Nullable</th>
                    <th>Cast required</th>
                  </tr>
                </thead>
                <tbody>
                  {data.columns.map((col, i) => (
                    <tr key={i}>
                      <td className="tpp-col-name">{col.name}</td>
                      <td><span className="tpp-type-badge">{col.pg_type}</span></td>
                      <td><span className="tpp-type-badge mysql">{col.mysql_type}</span></td>
                      <td><span className={`tpp-bool ${col.nullable ? 'yes' : 'no'}`}>{col.nullable ? 'yes' : 'no'}</span></td>
                      <td>{col.cast_required && <span className="tpp-cast-badge">CAST</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ── Data section ── */}
            <div className="tpp-section-label" style={{ marginTop: 20 }}>
              Data preview — first {data.row_count} rows
            </div>

            {data.rows.length === 0 ? (
              <div className="tpp-empty">Table is empty</div>
            ) : (
              <div className="tpp-data-wrap">
                <table className="tpp-table">
                  <thead>
                    <tr>{data.col_names.map((c, i) => <th key={i}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((v, ci) => (
                          <td key={ci} className={v === null ? 'tpp-null' : ''}>
                            {v === null ? 'null' : v.length > 60 ? v.slice(0, 60) + '…' : v}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

          </div>
        )}

      </div>
    </div>
  )
}
