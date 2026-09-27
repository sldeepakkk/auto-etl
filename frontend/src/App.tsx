import React from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Rail from './components/Rail/Rail'
import Dashboard from './components/Dashboard/Dashboard'
import CanvasPage from './components/Canvas/CanvasPage'
import ExportPage from './components/Export/ExportPage'
import PipelinesPage from './components/Pipelines/PipelinesPage'
import AnalyticsPage from './components/Analytics/AnalyticsPage'
import ConnectPage from './components/Connect/ConnectPage'
import { usePipelineStore } from './stores/pipelineStore'
import './styles/global.css'

// ── Error boundary — catches render crashes and shows a readable message ──────
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '100vh', flexDirection: 'column', gap: 16,
          fontFamily: 'IBM Plex Sans, sans-serif', color: '#1A1C20',
          background: '#F4F5F7', padding: 40,
        }}>
          <div style={{ fontSize: 32 }}>⚠</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Something went wrong</div>
          <div style={{
            fontFamily: 'IBM Plex Mono, monospace', fontSize: 12,
            background: '#fff', border: '1px solid #DDE0E5',
            borderRadius: 7, padding: 16, maxWidth: 600, color: '#C04438',
            wordBreak: 'break-all',
          }}>
            {(this.state.error as Error).message}
          </div>
          <button
            onClick={() => window.location.href = '/connect'}
            style={{
              padding: '8px 16px', borderRadius: 6, border: 'none',
              background: '#B87333', color: '#fff', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
            }}
          >
            Go to Connect page
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// ── Route guards ───────────────────────────────────────────────────────────────
function RequireConnection({ children }: { children: React.ReactNode }) {
  const { sourceDsn, targetDsn } = usePipelineStore()
  const loc = useLocation()
  if (!sourceDsn || !targetDsn) {
    return <Navigate to="/connect" state={{ from: loc }} replace />
  }
  return <>{children}</>
}

function RequirePipeline({ children }: { children: React.ReactNode }) {
  const { sourceDsn, targetDsn, pipelineId } = usePipelineStore()
  if (!sourceDsn || !targetDsn) return <Navigate to="/connect" replace />
  if (!pipelineId) return <Navigate to="/" replace />
  return <>{children}</>
}

// ── App ────────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <ErrorBoundary>
      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
        <Rail />
        <main style={{
          flex: 1, overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}>
          <ErrorBoundary>
            <Routes>
              <Route path="/connect"   element={<ConnectPage />} />
              <Route path="/pipelines" element={<PipelinesPage />} />
              <Route path="/" element={
                <RequireConnection><Dashboard /></RequireConnection>
              } />
              <Route path="/canvas" element={
                <RequirePipeline><CanvasPage /></RequirePipeline>
              } />
              <Route path="/export" element={
                <RequirePipeline><ExportPage /></RequirePipeline>
              } />
              <Route path="/analytics" element={
                <RequirePipeline><AnalyticsPage /></RequirePipeline>
              } />
              <Route path="*" element={<Navigate to="/connect" />} />
            </Routes>
          </ErrorBoundary>
        </main>
      </div>
    </ErrorBoundary>
  )
}
