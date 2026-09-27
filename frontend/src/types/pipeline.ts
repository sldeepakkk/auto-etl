export type NodeStatus = 'pending_review' | 'approved' | 'blocked'

export interface PipelineNode {
  id: string; type: string; label: string; description: string
  cte_name?: string | null; sql_draft: string; editable: boolean
  status: NodeStatus
}
export interface PipelineEdge { source: string; target: string }
export interface LineageEntry {
  node_id: string; target_column: string; source_table: string
  source_column: string; transform_type: string; derivation_logic: string | null
}
export interface DQRule {
  node_id: string; column: string; rule: string; severity: string
  preliminary: boolean; params: Record<string, any>; enabled: boolean
}
export interface NodeComment {
  node_id: string; author: string; text: string; created_at: string
}
export interface GenerateResponse {
  pipeline_id: string; pipeline_name: string
  nodes: PipelineNode[]; edges: PipelineEdge[]
  lineage: LineageEntry[]; dq_rules: DQRule[]
  warnings: string[]; generated_at: string
}
export interface ExportResponse { pipeline_id: string; filename: string; sql: string; warnings: string[] }
export interface PipelineSummary { pipeline_id: string; pipeline_name: string; requirement: string; node_count: number; created_at: string }
export interface TableInfo { name: string; approx_rows: number; column_count: number }
export interface TablesResponse { tables: TableInfo[]; total: number }
export interface NodePosition { x: number; y: number }
export type NodePositions = Record<string, NodePosition>
export interface RunNodeResult { node_id: string; columns: string[]; rows: (string | null)[][]; row_count: number; duration_ms: number }
export interface AskAgentResult { node_id: string; original_sql: string; revised_sql: string; explanation: string; changes: string[] }
export interface RefineResult { summary: string; assumptions: string[]; suggestions: string[] }
export interface DryRunResult { columns: string[]; rows: (string | null)[][]; row_count: number; duration_ms: number; dq_results: Record<string, any>[] }
export interface VersionSnapshot { version_id: string; pipeline_id: string; action: string; created_at: string }
