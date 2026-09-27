import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Database, CheckCircle, XCircle, ChevronRight } from 'lucide-react'
import { usePipelineStore } from '../../stores/pipelineStore'
import { validateConnections } from '../../api/client'
import './Connect.css'

const PG_PLACEHOLDER  = 'postgresql://user:password@host:5432/database'
const MY_PLACEHOLDER  = 'mysql+mysqlconnector://user:password@host:3306/database'

type Step = 'source-config' | 'target-config'

export default function ConnectPage() {
  const nav = useNavigate()
  const { setSourceDsn, setTargetDsn, setConnectionTested } = usePipelineStore()

  const [step,      setStep]      = useState<Step>('source-config')
  const [srcDsn,    setSrcDsn]    = useState('')
  const [tgtDsn,    setTgtDsn]    = useState('')
  const [testing,   setTesting]   = useState(false)
  const [srcStatus, setSrcStatus] = useState<'idle'|'ok'|'err'>('idle')
  const [tgtStatus, setTgtStatus] = useState<'idle'|'ok'|'err'>('idle')
  const [srcError,  setSrcError]  = useState('')
  const [tgtError,  setTgtError]  = useState('')

  const testSource = async () => {
    if (!srcDsn.trim()) return
    setTesting(true); setSrcStatus('idle'); setSrcError('')
    try {
      const res = await validateConnections(srcDsn, 'mysql://x:x@localhost/x')
      if (res.source_ok) {
        setSourceDsn(srcDsn, 'postgresql')
        setSrcStatus('ok')
        setStep('target-config')
      } else {
        setSrcStatus('err')
        setSrcError(res.source_error || 'Connection failed — check the connection string')
      }
    } catch (e: any) {
      setSrcStatus('err')
      setSrcError(e?.response?.data?.detail || 'Could not reach the backend. Is it running on port 8000?')
    } finally { setTesting(false) }
  }

  const testTarget = async () => {
    if (!tgtDsn.trim()) return
    setTesting(true); setTgtStatus('idle'); setTgtError('')
    try {
      const res = await validateConnections(srcDsn, tgtDsn)
      if (res.target_ok) {
        setTargetDsn(tgtDsn, 'mysql')
        setConnectionTested(true)
        setTgtStatus('ok')
        Promise.resolve().then(() => nav('/'))
      } else {
        setTgtStatus('err')
        setTgtError(res.target_error || 'Connection failed — check the connection string')
      }
    } catch (e: any) {
      setTgtStatus('err')
      setTgtError(e?.response?.data?.detail || 'Could not reach the backend. Is it running on port 8000?')
    } finally { setTesting(false) }
  }

  return (
    <div className="connect-page">
      {/* Breadcrumb */}
      <div className="connect-breadcrumb">
        <span className="crumb-root">Workspace</span>
        <ChevronRight size={13} />
        <span className="crumb-cur">{step === 'source-config' ? 'Connect Source' : 'Connect Target'}</span>
      </div>

      {/* Step indicator */}
      <div className="connect-steps">
        {[{key:'source-config', label:'Source Database'}, {key:'target-config', label:'Target Database'}].map((s, i) => {
          const done    = s.key === 'source-config' && step === 'target-config'
          const current = step === s.key
          return (
            <div key={s.key} className={`cstep ${done ? 'done' : ''} ${current ? 'active' : ''}`}>
              <div className="csn">{done ? '✓' : i + 1}</div>
              <div className="csl">{s.label}</div>
              {i < 1 && <div className="cstep-line" />}
            </div>
          )
        })}
      </div>

      {/* ── Source: PostgreSQL ──────────────────────────────────────────── */}
      {step === 'source-config' && (
        <>
          <div className="connect-title">Connect your PostgreSQL source</div>
          <div className="connect-subtitle">Enter the connection string for the database where your raw data lives.</div>

          {/* Single available option card */}
          <div className="single-db-card">
            <div className="single-db-icon" style={{ background: 'rgba(51,103,145,.12)' }}>
              <Database size={28} color="#336791" strokeWidth={1.8} />
            </div>
            <div>
              <div className="single-db-name">PostgreSQL</div>
              <div className="single-db-desc">Open-source relational database</div>
            </div>
            <span className="single-db-badge">Source</span>
          </div>

          <div className="conn-form">
            <div className="field">
              <label>Connection String</label>
              <input
                className="finput"
                value={srcDsn}
                onChange={e => { setSrcDsn(e.target.value); setSrcStatus('idle') }}
                placeholder={PG_PLACEHOLDER}
                autoFocus
                onKeyDown={e => e.key === 'Enter' && testSource()}
              />
              <div className="field-hint">
                Format: <code>postgresql://user:password@host:5432/database</code>
              </div>
            </div>
            {srcStatus === 'err' && (
              <div className="conn-error"><XCircle size={13} /> {srcError}</div>
            )}
            {srcStatus === 'ok' && (
              <div className="conn-success"><CheckCircle size={13} /> Connected — proceed to target database</div>
            )}
            <div className="conn-form-foot">
              <button className="btn btn-primary" onClick={testSource}
                disabled={testing || !srcDsn.trim()}>
                {testing ? 'Testing connection…' : 'Test & Continue →'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Target: MySQL ───────────────────────────────────────────────── */}
      {step === 'target-config' && (
        <>
          <div className="connect-title">Connect your MySQL target</div>
          <div className="connect-subtitle">Enter the connection string for the database where transformed data will be loaded.</div>

          <div className="conn-source-badge">
            <CheckCircle size={13} color="var(--sage)" />
            <span>Source connected: PostgreSQL</span>
          </div>

          <div className="single-db-card">
            <div className="single-db-icon" style={{ background: 'rgba(228,142,0,.12)' }}>
              <Database size={28} color="#E48E00" strokeWidth={1.8} />
            </div>
            <div>
              <div className="single-db-name">MySQL</div>
              <div className="single-db-desc">Popular open-source relational database</div>
            </div>
            <span className="single-db-badge">Target</span>
          </div>

          <div className="conn-form">
            <div className="field">
              <label>Connection String</label>
              <input
                className="finput"
                value={tgtDsn}
                onChange={e => { setTgtDsn(e.target.value); setTgtStatus('idle') }}
                placeholder={MY_PLACEHOLDER}
                autoFocus
                onKeyDown={e => e.key === 'Enter' && testTarget()}
              />
              <div className="field-hint">
                Format: <code>mysql+mysqlconnector://user:password@host:3306/database</code>
              </div>
            </div>
            {tgtStatus === 'err' && (
              <div className="conn-error"><XCircle size={13} /> {tgtError}</div>
            )}
            {tgtStatus === 'ok' && (
              <div className="conn-success"><CheckCircle size={13} /> Connected — loading dashboard…</div>
            )}
            <div className="conn-form-foot">
              <button className="btn btn-ghost" onClick={() => setStep('source-config')}>← Back</button>
              <button className="btn btn-primary" onClick={testTarget}
                disabled={testing || !tgtDsn.trim()}>
                {testing ? 'Testing connection…' : 'Connect & Start Building →'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
