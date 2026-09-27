import { usePipelineStore } from '../../stores/pipelineStore'
import { X, GitBranch } from 'lucide-react'

export default function VersionHistory({ onClose }: { onClose: () => void }) {
  const { versions } = usePipelineStore()

  return (
    <div style={{
      width: 260, borderLeft: '1px solid var(--border)', background: 'var(--surface)',
      display: 'flex', flexDirection: 'column', flexShrink: 0,
    }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 13 }}>
          <GitBranch size={14} /> Version History
        </div>
        <button onClick={onClose} style={{ color: 'var(--text-faint)', cursor: 'pointer', background: 'none', border: 'none' }}><X size={14} /></button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        {versions.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '20px 0', textAlign: 'center' }}>
            No versions yet. Versions are created when you approve nodes or regenerate.
          </div>
        ) : (
          versions.map((v, i) => (
            <div key={v.version_id} style={{
              padding: '10px 8px', borderLeft: '2px solid ' + (i === 0 ? 'var(--amber)' : 'var(--border)'),
              marginBottom: 4, marginLeft: 6,
            }}>
              <div style={{ fontSize: '11.5px', fontWeight: 500, color: i === 0 ? 'var(--text)' : 'var(--text-dim)' }}>
                {v.action.replace(/_/g, ' ')}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>
                {v.created_at?.split('T')[0] || ''} {v.created_at?.split('T')[1]?.slice(0, 5) || ''}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
