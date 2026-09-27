import axios from 'axios'
import type { GenerateResponse, ExportResponse, PipelineSummary, TablesResponse,
  RunNodeResult, AskAgentResult, RefineResult, DryRunResult, VersionSnapshot, NodeComment, NodeStatus } from '../types/pipeline'

const api = axios.create({ baseURL: '/api' })

export const validateConnections = async (s: string, t: string) =>
  (await api.post('/validate', { source_db_url: s, target_db_url: t })).data
export const fetchTables = async (dsn: string): Promise<TablesResponse> =>
  (await api.get('/schema/tables', { params: { source_db_url: dsn } })).data
export const generatePipeline = async (req: string, tables: string[], src: string, tgt: string): Promise<GenerateResponse> =>
  (await api.post('/generate', { requirement: req, selected_tables: tables, source_db_url: src, target_db_url: tgt })).data
export const exportPipeline = async (pid: string, configs: Record<string, string>): Promise<ExportResponse> =>
  (await api.post('/export', { pipeline_id: pid, node_configs: configs })).data
export const listPipelines = async (): Promise<PipelineSummary[]> => (await api.get('/pipelines')).data
export const getPipeline = async (id: string) => (await api.get(`/pipeline/${id}`)).data

// HITL endpoints
export const runNode = async (pid: string, nodeId: string, srcDsn: string, sqlOverride?: string, limit = 100): Promise<RunNodeResult> =>
  (await api.post('/run-node', { pipeline_id: pid, node_id: nodeId, source_db_url: srcDsn, sql_override: sqlOverride, limit })).data
export const askAgent = async (pid: string, nodeId: string, question: string, currentSql: string, schemaText = ''): Promise<AskAgentResult> =>
  (await api.post('/ask', { pipeline_id: pid, node_id: nodeId, question, current_sql: currentSql, schema_text: schemaText })).data
export const approveNode = async (pid: string, nodeId: string, status: NodeStatus, reason?: string) =>
  (await api.post('/approve-node', { pipeline_id: pid, node_id: nodeId, status, reason })).data
export const addComment = async (pid: string, nodeId: string, text: string, author = 'user'): Promise<NodeComment> =>
  (await api.post('/comment', { pipeline_id: pid, node_id: nodeId, text, author })).data
export const getComments = async (pid: string, nodeId?: string): Promise<NodeComment[]> =>
  (await api.get(`/comments/${pid}`, { params: nodeId ? { node_id: nodeId } : {} })).data
export const refineRequirement = async (req: string, tables: string[], srcDsn: string): Promise<RefineResult> =>
  (await api.post('/refine', { requirement: req, selected_tables: tables, source_db_url: srcDsn })).data
export const dryRun = async (pid: string, srcDsn: string, configs: Record<string, string> = {}, limit = 1000): Promise<DryRunResult> =>
  (await api.post('/dry-run', { pipeline_id: pid, source_db_url: srcDsn, node_configs: configs, limit })).data
export const updateDQRule = async (
  pid: string, idx: number, params: Record<string,any>,
  severity?: string, enabled?: boolean
) =>
  (await api.put('/dq-rule', { pipeline_id: pid, rule_index: idx, params, severity, enabled })).data
export const addDQRule = async (pid: string, nodeId: string, column: string, rule: string, severity: string, params: Record<string,any> = {}) =>
  (await api.post('/dq-rule', { pipeline_id: pid, node_id: nodeId, column, rule, severity, params })).data

export interface DQCheckResult {
  rule_index: number; node_id: string; column: string; rule: string
  severity: string; passed: boolean; violation_count: number
  checked_rows: number; error?: string | null
}
export interface DQCheckRunResult {
  results: DQCheckResult[]; all_passed: boolean
  error_failures: number; warning_failures: number; checked_at: string
}
export const runDqCheck = async (
  pipelineId: string, sourceDsn: string, configs: Record<string,string> = {}
): Promise<DQCheckRunResult> =>
  (await api.post('/run-dq-check', {
    pipeline_id: pipelineId, source_db_url: sourceDsn, node_configs: configs,
  })).data
export const getVersions = async (pid: string): Promise<VersionSnapshot[]> => (await api.get(`/versions/${pid}`)).data
export const getVersion = async (vid: string) => (await api.get(`/version/${vid}`)).data

export default api

export interface TablePreview {
  table: string; schema: string
  columns: { name:string; pg_type:string; mysql_type:string; nullable:boolean; cast_required:boolean }[]
  col_names: string[]; rows: (string|null)[][]; row_count: number
}
export const fetchTablePreview = async (table: string, sourceDsn: string, limit = 10): Promise<TablePreview> =>
  (await api.get('/schema/preview', { params: { table, source_db_url: sourceDsn, limit } })).data

export interface LoadToMySQLResult {
  table: string; rows_inserted: number; columns: string[]
  mode: string; duration_ms: number; warning?: string
}
export const loadToMySQL = async (
  pipelineId: string, sourceDsn: string, targetDsn: string,
  configs: Record<string, string> = {}, tableName?: string,
  mode: 'replace' | 'append' | 'fail_if_exists' = 'replace'
): Promise<LoadToMySQLResult> =>
  (await api.post('/load-to-mysql', {
    pipeline_id: pipelineId, source_db_url: sourceDsn, target_db_url: targetDsn,
    node_configs: configs, target_table_name: tableName, mode,
  })).data

// Kept for backward compatibility with NodePanel.tsx's "Fix SQL with AI" button.
// Column/dialect errors are now fixed automatically and deterministically on
// the backend (agents.py: normalize_sql_dialect + auto_fix_sql) every time a
// node runs, so this manual trigger is rarely needed — but the endpoint still
// exists server-side and this keeps older NodePanel.tsx builds working.
export const fixSql = async (
  pipelineId: string, nodeId: string, sql: string,
  error: string, sourceDsn: string
): Promise<{ fixed_sql: string; changes: string[] }> =>
  (await api.post('/fix-sql', {
    pipeline_id: pipelineId, node_id: nodeId,
    sql, error, source_db_url: sourceDsn,
  })).data
