import { create } from 'zustand'
import type {
  PipelineNode, PipelineEdge, LineageEntry, DQRule,
  NodePositions, TableInfo, NodeComment, NodeStatus, VersionSnapshot,
} from '../types/pipeline'

// Cascade positions by node index (0-based order from backend)
// Keys are set dynamically from actual node IDs — not hardcoded type names
const POSITION_BY_INDEX = [
  { x: 220, y: 110 },   // node 0 — source
  { x: 440, y: 250 },   // node 1 — transform
  { x: 660, y: 100 },   // node 2 — aggregate
  { x: 860, y: 250 },   // node 3 — dq
  { x: 1060, y: 110 },  // node 4 — output
]

function buildPositions(nodes: PipelineNode[]): NodePositions {
  const pos: NodePositions = {}
  nodes.forEach((node, i) => {
    pos[node.id] = POSITION_BY_INDEX[i] ?? { x: 220 + i * 220, y: 150 }
  })
  return pos
}

interface PipelineState {
  // Connection
  sourceDsn: string; targetDsn: string
  sourceDbType: string; targetDbType: string; connectionTested: boolean

  // Pipeline
  pipelineId: string | null; pipelineName: string
  status: 'idle'|'generating'|'ready'|'exported'
  requirement: string
  nodes: PipelineNode[]; edges: PipelineEdge[]
  lineage: LineageEntry[]; dqRules: DQRule[]; warnings: string[]
  dqCheckResults: any[]
  nodeConfigs: Record<string, string>
  nodePositions: NodePositions
  selectedNodeId: string | null

  // Table selection
  tableList: TableInfo[]; selectedTables: string[]; tablesLoading: boolean

  // HITL
  comments: NodeComment[]; versions: VersionSnapshot[]

  // Actions — connection
  setSourceDsn: (d: string, t?: string) => void
  setTargetDsn: (d: string, t?: string) => void
  setConnectionTested: (v: boolean) => void

  // Actions — pipeline
  setRequirement: (r: string) => void
  setStatus: (s: PipelineState['status']) => void
  setPipeline: (data: {
    pipelineId: string; pipelineName: string
    nodes: PipelineNode[]; edges: PipelineEdge[]
    lineage: LineageEntry[]; dqRules: DQRule[]; warnings: string[]
  }) => void
  selectNode: (id: string | null) => void
  updateNodeSQL: (id: string, sql: string) => void
  setNodePosition: (id: string, x: number, y: number) => void

  // Actions — tables
  setTableList: (t: TableInfo[]) => void
  setTablesLoading: (v: boolean) => void
  toggleTable: (n: string) => void
  selectAllTables: () => void
  clearAllTables: () => void

  // Actions — HITL
  updateNodeStatus: (nodeId: string, status: NodeStatus) => void
  addComment: (c: NodeComment) => void
  setComments: (c: NodeComment[]) => void
  setVersions: (v: VersionSnapshot[]) => void
  updateDQRule: (idx: number, params: Record<string, any>, enabled?: boolean) => void
  setDQRuleResults: (results: any[]) => void
  addDQRuleLocal: (r: DQRule) => void

  reset: () => void
}

export const usePipelineStore = create<PipelineState>((set) => ({
  sourceDsn: '', targetDsn: '', sourceDbType: 'postgresql',
  targetDbType: 'mysql', connectionTested: false,

  pipelineId: null, pipelineName: '', status: 'idle', requirement: '',
  nodes: [], edges: [], lineage: [], dqRules: [], warnings: [],
  nodeConfigs: {}, nodePositions: {}, selectedNodeId: null,

  tableList: [], selectedTables: [], tablesLoading: false,
  comments: [], versions: [], dqCheckResults: [],

  setSourceDsn: (d, t = 'postgresql') =>
    set({ sourceDsn: d, sourceDbType: t, connectionTested: false }),
  setTargetDsn: (d, t = 'mysql') =>
    set({ targetDsn: d, targetDbType: t, connectionTested: false }),
  setConnectionTested: (v) => set({ connectionTested: v }),

  setRequirement: (r) => set({ requirement: r }),
  setStatus: (s) => set({ status: s }),

  setPipeline: (data) => set({
    pipelineId:    data.pipelineId,
    pipelineName:  data.pipelineName,
    nodes:         data.nodes,
    edges:         data.edges,
    lineage:       data.lineage,
    dqRules:       data.dqRules,
    warnings:      data.warnings,
    nodeConfigs:   {},
    // Positions derived from actual node IDs returned by the backend
    nodePositions: buildPositions(data.nodes),
    status:        'ready',
    selectedNodeId: null,
    comments:      [],
    versions:      [],
  }),

  selectNode: (id) => set({ selectedNodeId: id }),

  updateNodeSQL: (id, sql) =>
    set((s) => ({ nodeConfigs: { ...s.nodeConfigs, [id]: sql } })),

  setNodePosition: (id, x, y) =>
    set((s) => ({ nodePositions: { ...s.nodePositions, [id]: { x, y } } })),

  setTableList:    (t) => set({ tableList: t }),
  setTablesLoading:(v) => set({ tablesLoading: v }),

  toggleTable: (n) => set((s) => ({
    selectedTables: s.selectedTables.includes(n)
      ? s.selectedTables.filter(t => t !== n)
      : [...s.selectedTables, n],
  })),
  selectAllTables: () => set((s) => ({ selectedTables: s.tableList.map(t => t.name) })),
  clearAllTables:  () => set({ selectedTables: [] }),

  updateNodeStatus: (nodeId, status) =>
    set((s) => ({ nodes: s.nodes.map(n => n.id === nodeId ? { ...n, status } : n) })),

  addComment:  (c) => set((s) => ({ comments: [...s.comments, c] })),
  setComments: (c) => set({ comments: c }),
  setVersions: (v) => set({ versions: v }),

  updateDQRule: (idx, params, enabled) =>
    set((s) => ({ dqRules: s.dqRules.map((r, i) => i === idx ? { ...r, params, ...(enabled !== undefined ? { enabled } : {}) } : r) })),
  setDQRuleResults: (results) => set({ dqCheckResults: results }),

  addDQRuleLocal: (r) => set((s) => ({ dqRules: [...s.dqRules, r] })),

  reset: () => set({
    pipelineId: null, pipelineName: '', status: 'idle', requirement: '',
    nodes: [], edges: [], lineage: [], dqRules: [], warnings: [],
    nodeConfigs: {}, nodePositions: {}, selectedNodeId: null,
    selectedTables: [], comments: [], versions: [],
  }),
}))
