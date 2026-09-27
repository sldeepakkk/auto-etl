from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from datetime import datetime
from enum import Enum


class NodeStatus(str, Enum):
    pending  = "pending_review"
    approved = "approved"
    blocked  = "blocked"


class DAGNode(BaseModel):
    id:          str
    type:        str
    label:       str
    description: str = ""
    cte_name:    Optional[str] = None
    sql_draft:   str
    editable:    bool = True
    status:      NodeStatus = NodeStatus.pending


class DAGEdge(BaseModel):
    source: str
    target: str


class LineageEntry(BaseModel):
    node_id:          str
    target_column:    str
    source_table:     str
    source_column:    str
    transform_type:   str
    derivation_logic: Optional[str] = None


class DQRule(BaseModel):
    node_id:     str
    column:      str
    rule:        str
    severity:    str = "warn"
    preliminary: bool = True
    params:      Dict[str, Any] = {}
    enabled:     bool = True


class NodeComment(BaseModel):
    node_id:    str
    author:     str = "user"
    text:       str
    created_at: Optional[datetime] = None


# ── Requests ──────────────────────────────────────────────────────────────────

class GenerateRequest(BaseModel):
    requirement:     str = Field(..., min_length=5)
    selected_tables: List[str] = Field(..., min_length=1)
    source_db_url:   str
    target_db_url:   str


class ExportRequest(BaseModel):
    pipeline_id:  str
    node_configs: Dict[str, str] = {}


class ValidateRequest(BaseModel):
    source_db_url: str
    target_db_url: str


class RunNodeRequest(BaseModel):
    pipeline_id:   str
    node_id:       str
    source_db_url: str
    sql_override:  Optional[str] = None
    limit:         int = 100


class AskAgentRequest(BaseModel):
    pipeline_id:   str
    node_id:       str
    question:      str
    current_sql:   str
    schema_text:   str = ""


class ApproveNodeRequest(BaseModel):
    pipeline_id: str
    node_id:     str
    status:      NodeStatus
    reason:      Optional[str] = None


class AddCommentRequest(BaseModel):
    pipeline_id: str
    node_id:     str
    text:        str
    author:      str = "user"


class RefineRequest(BaseModel):
    requirement:     str
    selected_tables: List[str]
    source_db_url:   str


class DryRunRequest(BaseModel):
    pipeline_id:   str
    source_db_url: str
    node_configs:  Dict[str, str] = {}
    limit:         int = 1000


class UpdateDQRuleRequest(BaseModel):
    pipeline_id: str
    rule_index:  int
    params:      Dict[str, Any]
    severity:    Optional[str] = None
    enabled:     Optional[bool] = None


class AddDQRuleRequest(BaseModel):
    pipeline_id: str
    node_id:     str
    column:      str
    rule:        str
    severity:    str = "warn"
    params:      Dict[str, Any] = {}


# ── Responses ─────────────────────────────────────────────────────────────────

class GenerateResponse(BaseModel):
    pipeline_id:   str
    pipeline_name: str
    nodes:         List[DAGNode]
    edges:         List[DAGEdge]
    lineage:       List[LineageEntry]
    dq_rules:      List[DQRule]
    warnings:      List[str] = []
    generated_at:  datetime


class ExportResponse(BaseModel):
    pipeline_id: str
    filename:    str
    sql:         str
    warnings:    List[str] = []


class ValidateResponse(BaseModel):
    source_ok:     bool
    source_error:  Optional[str] = None
    target_ok:     bool
    target_error:  Optional[str] = None
    source_tables: int = 0


class RunNodeResponse(BaseModel):
    node_id:  str
    columns:  List[str]
    rows:     List[List[Any]]
    row_count: int
    duration_ms: int


class AskAgentResponse(BaseModel):
    node_id:      str
    original_sql: str
    revised_sql:  str
    explanation:  str
    changes:      List[str] = []


class RefineResponse(BaseModel):
    summary:      str
    assumptions:  List[str]
    suggestions:  List[str]
    confirmed:    bool = False


class DryRunResponse(BaseModel):
    columns:     List[str]
    rows:        List[List[Any]]
    row_count:   int
    duration_ms: int
    dq_results:  List[Dict[str, Any]] = []


class VersionSnapshot(BaseModel):
    version_id:  str
    pipeline_id: str
    action:      str
    created_at:  datetime
    node_count:  int


class TableInfo(BaseModel):
    name:         str
    approx_rows:  int = -1
    column_count: int = 0


class TablesResponse(BaseModel):
    tables: List[TableInfo]
    total:  int


class PipelineSummary(BaseModel):
    pipeline_id:   str
    pipeline_name: str
    requirement:   str
    node_count:    int
    created_at:    datetime


class LoadToMySQLRequest(BaseModel):
    pipeline_id:      str
    source_db_url:    str
    target_db_url:    str
    node_configs:      Dict[str, str] = {}
    target_table_name: Optional[str] = None   # defaults to pipeline_name if not given
    mode:              str = "replace"        # "replace" | "append" | "fail_if_exists"


class LoadToMySQLResponse(BaseModel):
    table:         str
    rows_inserted: int
    columns:       List[str]
    mode:          str
    duration_ms:   int
    warning:       Optional[str] = None


class FixSqlRequest(BaseModel):
    pipeline_id:   str
    node_id:       str
    sql:           str
    error:         str
    source_db_url: str


class FixSqlResponse(BaseModel):
    fixed_sql: str
    changes:   List[str]


# ── DQ execution ─────────────────────────────────────────────────────────────

class DQCheckResult(BaseModel):
    rule_index:      int
    node_id:         str
    column:          str
    rule:            str
    severity:        str
    passed:          bool
    violation_count: int
    checked_rows:    int
    error:           Optional[str] = None


class RunDQCheckRequest(BaseModel):
    pipeline_id:   str
    source_db_url: str
    node_configs:  Dict[str, str] = {}


class RunDQCheckResponse(BaseModel):
    results:           List[DQCheckResult]
    all_passed:        bool
    error_failures:    int
    warning_failures:  int
    checked_at:        datetime
