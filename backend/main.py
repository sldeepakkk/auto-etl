"""Auto ETL Tool — FastAPI backend v2.1"""
import uuid, logging, json
from datetime import datetime, timezone
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from models import *
from schema_reader import (list_tables, inspect_selected, format_schema_for_llm,
    validate_connection, preview_table)
from agents import (run_blueprint_agent, run_tracer_agent, run_dq_agent,
    run_ask_agent, run_refine_agent, run_node_query)
from database import (init_db, save_pipeline, load_pipeline, list_all_pipelines,
    update_node_status, add_comment, get_comments, save_version, list_versions, get_version)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = FastAPI(title="Auto ETL Tool", version="2.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
    allow_methods=["*"], allow_headers=["*"], allow_credentials=True)

@app.on_event("startup")
def startup(): init_db(); log.info("DB ready")


# ── Health / API key check ─────────────────────────────────────────────────────
@app.get("/health")
def health():
    issues = []
    if not settings.GROQ_API_KEY: issues.append("GROQ_API_KEY not set in .env")
    return {
        "status":   "ok" if not issues else "degraded",
        "version":  "2.2.0",
        "groq_key": bool(settings.GROQ_API_KEY),
        "issues":   issues,
    }


# ── Validate connections ───────────────────────────────────────────────────────
@app.post("/validate", response_model=ValidateResponse)
def validate(req: ValidateRequest):
    src = validate_connection(req.source_db_url)
    tgt = validate_connection(req.target_db_url)
    return ValidateResponse(
        source_ok=src["ok"], source_error=src.get("error"),
        target_ok=tgt["ok"], target_error=tgt.get("error"),
        source_tables=src.get("table_count", 0),
    )


# ── Schema ────────────────────────────────────────────────────────────────────
@app.get("/schema/tables", response_model=TablesResponse)
def get_tables(source_db_url: str):
    try:
        t = list_tables(source_db_url)
        return TablesResponse(tables=[TableInfo(**x) for x in t], total=len(t))
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/schema/preview")
def get_preview(table: str, source_db_url: str, limit: int = 10):
    try:
        return preview_table(source_db_url, table, limit)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Refine requirement ─────────────────────────────────────────────────────────
@app.post("/refine", response_model=RefineResponse)
async def refine(req: RefineRequest):
    try:
        schema = inspect_selected(req.source_db_url, req.selected_tables)
        schema_text = format_schema_for_llm(schema)
        r = await run_refine_agent(req.requirement, req.selected_tables, schema_text)
        return RefineResponse(summary=r.get("summary",""), assumptions=r.get("assumptions",[]),
            suggestions=r.get("suggestions",[]))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


# ── Generate pipeline ──────────────────────────────────────────────────────────
MAX_TABLES_PER_PIPELINE = 20  # keeps the schema payload well under Groq's request size limit

@app.post("/generate", response_model=GenerateResponse, status_code=201)
async def generate(req: GenerateRequest):
    # 0. Guard against oversized table selections BEFORE any expensive work.
    #    A single ELT pipeline realistically needs a handful of tables — a
    #    large selection (e.g. "Select all" on a 68-table AdventureWorks
    #    schema) stringifies into a schema block that exceeds Groq's request
    #    body size limit and fails with a raw 413 the user can't self-diagnose.
    if len(req.selected_tables) > MAX_TABLES_PER_PIPELINE:
        raise HTTPException(
            400,
            f"You selected {len(req.selected_tables)} tables — a single pipeline "
            f"can use at most {MAX_TABLES_PER_PIPELINE}. Large table sets produce a "
            f"schema payload too large for the AI request. Narrow your selection to "
            f"just the tables this specific pipeline actually needs, or split this "
            f"into multiple smaller pipelines."
        )

    # 1. Inspect schema
    try:
        schema = inspect_selected(req.source_db_url, req.selected_tables)
    except Exception as e:
        raise HTTPException(400, f"Schema inspection failed: {e}")

    schema_text = format_schema_for_llm(schema)

    # 2. Blueprint Agent — raises RuntimeError on API failure (not caught here)
    try:
        dag = await run_blueprint_agent(req.requirement, schema_text)
    except RuntimeError as e:
        raise HTTPException(500, str(e))

    fallback_used = dag.pop("_fallback", False)

    # 3. Tracer + DQ (non-blocking, warn on failure)
    try:
        lineage = await run_tracer_agent(dag.get("nodes", []), schema)
    except Exception as e:
        log.warning("Tracer failed (non-blocking): %s", e)
        lineage = []
    try:
        dq_rules = await run_dq_agent(lineage)
    except Exception as e:
        log.warning("DQ Agent failed (non-blocking): %s", e)
        dq_rules = []

    pid = str(uuid.uuid4())
    warnings = []
    if fallback_used:
        warnings.append(
            "⚠ The AI could not generate SQL for your pipeline. "
            "This usually means the Groq API key is not set or is invalid. "
            "Check that GROQ_API_KEY is set correctly in backend/.env, then restart the backend."
        )

    save_pipeline(pid, dag.get("pipeline_name", "pipeline"), req.requirement,
        req.source_db_url, req.target_db_url, dag.get("nodes", []),
        dag.get("edges", []), lineage, dq_rules, schema_text)
    save_version(str(uuid.uuid4()), pid, "generated",
        {"nodes": dag.get("nodes", []), "fallback": fallback_used})

    return GenerateResponse(
        pipeline_id=pid,
        pipeline_name=dag.get("pipeline_name", "pipeline"),
        nodes=[DAGNode(**n) for n in dag.get("nodes", [])],
        edges=[DAGEdge(**e) for e in dag.get("edges", [])],
        lineage=[LineageEntry(**l) for l in lineage],
        dq_rules=[DQRule(**r) for r in dq_rules],
        warnings=warnings,
        generated_at=datetime.now(timezone.utc),
    )


# ── Run single node ────────────────────────────────────────────────────────────
@app.post("/run-node", response_model=RunNodeResponse)
def run_node(req: RunNodeRequest):
    spec = load_pipeline(req.pipeline_id)
    if not spec: raise HTTPException(404, "Pipeline not found")
    configs = {req.node_id: req.sql_override} if req.sql_override else {}
    r = run_node_query(spec["nodes"], req.node_id, req.source_db_url, configs, req.limit)
    if "error" in r: raise HTTPException(400, r["error"])
    return RunNodeResponse(node_id=req.node_id, columns=r["columns"],
        rows=r["rows"], row_count=r["row_count"], duration_ms=r["duration_ms"])


# ── Ask Agent ──────────────────────────────────────────────────────────────────
@app.post("/ask", response_model=AskAgentResponse)
async def ask_agent(req: AskAgentRequest):
    spec = load_pipeline(req.pipeline_id)
    if not spec: raise HTTPException(404)
    schema_text = req.schema_text or spec["pipeline"].get("schema_text", "")
    try:
        r = await run_ask_agent(req.question, req.current_sql, schema_text)
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return AskAgentResponse(node_id=req.node_id, original_sql=req.current_sql,
        revised_sql=r["revised_sql"], explanation=r["explanation"], changes=r.get("changes", []))


# ── Node approval ──────────────────────────────────────────────────────────────
@app.post("/approve-node")
def approve_node(req: ApproveNodeRequest):
    spec = load_pipeline(req.pipeline_id)
    if not spec: raise HTTPException(404)
    update_node_status(req.pipeline_id, req.node_id, req.status.value, req.reason)
    save_version(str(uuid.uuid4()), req.pipeline_id,
        f"node_{req.node_id}_{req.status.value}",
        {"node_id": req.node_id, "status": req.status.value})
    return {"ok": True, "node_id": req.node_id, "status": req.status.value}


# ── Comments ───────────────────────────────────────────────────────────────────
@app.post("/comment")
def post_comment(req: AddCommentRequest):
    return add_comment(req.pipeline_id, req.node_id, req.author, req.text)

@app.get("/comments/{pipeline_id}")
def get_all_comments(pipeline_id: str, node_id: Optional[str] = None):
    return get_comments(pipeline_id, node_id)


# ── DQ rule editing ────────────────────────────────────────────────────────────
@app.put("/dq-rule")
def update_dq_rule(req: UpdateDQRuleRequest):
    from database import get_db
    with get_db() as c:
        rules = c.execute("SELECT id FROM dq_rules WHERE pipeline_id=?",
            (req.pipeline_id,)).fetchall()
        if req.rule_index >= len(rules): raise HTTPException(404, "Rule not found")
        rid = rules[req.rule_index]["id"]
        updates, vals = ["params=?"], [json.dumps(req.params)]
        if req.severity: updates.append("severity=?"); vals.append(req.severity)
        if req.enabled is not None: updates.append("enabled=?"); vals.append(1 if req.enabled else 0)
        vals.append(rid)
        c.execute(f"UPDATE dq_rules SET {','.join(updates)} WHERE id=?", vals)
    return {"ok": True}

@app.post("/dq-rule")
def add_dq_rule(req: AddDQRuleRequest):
    from database import get_db
    with get_db() as c:
        c.execute("INSERT INTO dq_rules (pipeline_id,node_id,column_name,rule,severity,preliminary,params) VALUES (?,?,?,?,?,0,?)",
            (req.pipeline_id, req.node_id, req.column, req.rule, req.severity, json.dumps(req.params)))
    return {"ok": True}


# ── Run DQ checks (the actual validation queries) ───────────────────────────────
@app.post("/run-dq-check", response_model=RunDQCheckResponse)
def run_dq_check_endpoint(req: RunDQCheckRequest):
    """
    Executes every ENABLED DQ rule as a real SQL query against the pipeline's
    aggregated output. This is what the DQ Check canvas node conceptually
    represents but never actually did — its own sql_draft is just a comment
    and it's structurally skipped by every other execution path since it has
    no cte_name. This endpoint is the real implementation.
    """
    from agents import run_dq_checks

    spec = load_pipeline(req.pipeline_id)
    if not spec:
        raise HTTPException(404, "Pipeline not found")

    dq_rules = [
        {**r, "enabled": bool(r.get("enabled", 1))}
        for r in spec["dq_rules"]
    ]

    try:
        results = run_dq_checks(spec["nodes"], dq_rules, req.source_db_url, req.node_configs)
    except Exception as e:
        raise HTTPException(500, f"DQ check execution failed: {e}")

    error_failures   = sum(1 for r in results if not r["passed"] and r["severity"] == "error")
    warning_failures = sum(1 for r in results if not r["passed"] and r["severity"] != "error")

    return RunDQCheckResponse(
        results=[DQCheckResult(**r) for r in results],
        all_passed=(error_failures == 0 and warning_failures == 0),
        error_failures=error_failures,
        warning_failures=warning_failures,
        checked_at=datetime.now(timezone.utc),
    )


# ── Dry run ────────────────────────────────────────────────────────────────────
@app.post("/dry-run", response_model=DryRunResponse)
def dry_run(req: DryRunRequest):
    spec = load_pipeline(req.pipeline_id)
    if not spec: raise HTTPException(404)
    agg = next((n for n in spec["nodes"] if n.get("cte_name") == "aggregated"), None)
    if not agg: raise HTTPException(400, "No aggregate node found")
    r = run_node_query(spec["nodes"], agg["node_id"], req.source_db_url, req.node_configs, req.limit)
    if "error" in r: raise HTTPException(400, r["error"])
    return DryRunResponse(columns=r["columns"], rows=r["rows"],
        row_count=r["row_count"], duration_ms=r["duration_ms"])


# ── Load into MySQL (the actual data transfer) ──────────────────────────────────
@app.post("/load-to-mysql", response_model=LoadToMySQLResponse)
def load_to_mysql_endpoint(req: LoadToMySQLRequest):
    """
    Executes the real PostgreSQL → MySQL transfer:
      1. Runs the pipeline's aggregated-CTE SELECT against PostgreSQL
      2. Creates (or replaces/appends to) the target table in MySQL
      3. Batch-inserts every row

    This is what actually moves data — /export only produces a .sql
    text file for reference, it never executes anything.
    """
    from mysql_loader import run_full_load
    from agents import normalize_sql_dialect

    spec = load_pipeline(req.pipeline_id)
    if not spec:
        raise HTTPException(404, "Pipeline not found")

    nodes = sorted(spec["nodes"], key=lambda n: n["node_order"])
    cte_nodes = [n for n in nodes if n.get("cte_name")]
    if not cte_nodes:
        raise HTTPException(400, "Pipeline has no CTE nodes to load")

    # Build the full SELECT chain up through 'aggregated' (skip the literal
    # INSERT/DQ nodes — we run our own controlled load instead of trusting
    # the model's generated INSERT statement, which targets an unknown
    # MySQL schema the AI has never actually inspected)
    parts = []
    for n in cte_nodes:
        sql = req.node_configs.get(n["node_id"]) or n.get("sql_final") or n.get("sql_draft", "")
        sql, _ = normalize_sql_dialect(sql)  # safety net — same dialect fix as elsewhere
        parts.append(f"  {n['cte_name']} AS (\n    {sql}\n  )")
    last_cte = cte_nodes[-1]["cte_name"]
    full_select_sql = "WITH\n" + ",\n".join(parts) + f"\nSELECT * FROM {last_cte};"

    table_name = req.target_table_name or spec["pipeline"]["pipeline_name"]

    # ── DQ gate — block the load if any enabled error-severity rule fails ──────
    from agents import run_dq_checks
    dq_rules = [{**r, "enabled": bool(r.get("enabled", 1))} for r in spec["dq_rules"]]
    dq_results = run_dq_checks(spec["nodes"], dq_rules, req.source_db_url, req.node_configs)
    dq_error_failures = [r for r in dq_results if not r["passed"] and r["severity"] == "error"]
    if dq_error_failures:
        failure_summary = "; ".join(
            f"{r['rule']} on '{r['column']}' — {r['violation_count']} of {r['checked_rows']} rows fail"
            for r in dq_error_failures
        )
        raise HTTPException(
            422,
            f"Load blocked — {len(dq_error_failures)} error-severity DQ rule(s) failed: "
            f"{failure_summary}. Fix the underlying data or disable/adjust the rule in "
            f"the DQ Rules tab before loading."
        )
    dq_warning_failures = [r for r in dq_results if not r["passed"] and r["severity"] != "error"]

    try:
        result = run_full_load(
            source_db_url=req.source_db_url,
            target_db_url=req.target_db_url,
            full_select_sql=full_select_sql,
            target_table_name=table_name,
            mode=req.mode,
        )
    except ValueError as e:
        raise HTTPException(409, str(e))  # table exists conflict
    except Exception as e:
        raise HTTPException(500, f"Load failed: {e}")

    if dq_warning_failures:
        warn_summary = "; ".join(
            f"{r['rule']} on '{r['column']}' — {r['violation_count']} rows"
            for r in dq_warning_failures
        )
        result["warning"] = (
            (result.get("warning") + " | " if result.get("warning") else "")
            + f"{len(dq_warning_failures)} warning-severity DQ rule(s) did not fully pass: {warn_summary}"
        )

    # Record this as a version event
    save_version(str(uuid.uuid4()), req.pipeline_id, "loaded_to_mysql",
        {"table": result["table"], "rows": result["rows_inserted"], "mode": req.mode})

    return LoadToMySQLResponse(**result)


# ── Manual SQL fix (button in NodePanel's Preview error card) ──────────────────
@app.post("/fix-sql", response_model=FixSqlResponse)
def fix_sql_endpoint(req: FixSqlRequest):
    """
    Manual trigger for the same deterministic fixer (normalize_sql_dialect +
    auto_fix_sql) that already runs automatically on every node execution.
    Kept as an explicit endpoint so the "Fix SQL with AI" button in the
    Preview tab's error card has something to call — useful when a user
    wants to see exactly what would change before it's applied, or wants
    to re-trigger a fix after manually editing the SQL.
    """
    from agents import auto_fix_sql

    spec = load_pipeline(req.pipeline_id)
    if not spec:
        raise HTTPException(404, "Pipeline not found")

    try:
        fixed_sql, changes = auto_fix_sql(req.sql, req.source_db_url)
    except Exception as e:
        raise HTTPException(500, f"Fix attempt failed: {e}")

    if not changes:
        # Nothing the deterministic fixer could resolve — likely a structural
        # issue (column never selected upstream) rather than a naming/dialect one
        raise HTTPException(
            422,
            "Could not automatically fix this SQL. This usually means a column "
            "is referenced here but was never selected in an earlier pipeline "
            "step — edit the earlier node's SQL to include it, or rewrite this "
            "step manually."
        )

    return FixSqlResponse(fixed_sql=fixed_sql, changes=changes)


# ── Export ─────────────────────────────────────────────────────────────────────
@app.post("/export", response_model=ExportResponse)
def export_pipeline(req: ExportRequest):
    spec = load_pipeline(req.pipeline_id)
    if not spec: raise HTTPException(404)
    nodes = sorted(spec["nodes"], key=lambda n: n["node_order"])
    name  = spec["pipeline"]["pipeline_name"]
    warnings = []
    unapproved = [n["node_id"] for n in nodes if n.get("status") != "approved"]
    if unapproved:
        warnings.append(f"Nodes not yet approved: {', '.join(unapproved)}")
    def get_sql(n):
        s = req.node_configs.get(n["node_id"]) or n.get("sql_final") or n.get("sql_draft","")
        if "-- TODO" in s: warnings.append(f"'{n['label']}' has unresolved TODO.")
        return s
    cte_nodes = [n for n in nodes if n.get("cte_name")]
    out_node  = next((n for n in nodes if n["node_type"]=="output"), None)
    dq_node   = next((n for n in nodes if n["node_type"]=="dq"), None)
    lines = [f"-- Auto ETL Tool — {name}", "-- PostgreSQL → MySQL", ""]
    if cte_nodes:
        lines.append("WITH")
        for i, n in enumerate(cte_nodes):
            sql = get_sql(n).strip()
            lines += [f"  -- ── {n['label'].upper()} ──", f"  {n['cte_name']} AS ("]
            for ln in sql.split("\n"): lines.append(f"    {ln}")
            lines.append(f"  ){',' if i < len(cte_nodes)-1 else ''}")
            if i < len(cte_nodes)-1: lines.append("")
        lines.append("")
    if out_node: lines += ["-- ── OUTPUT ──", get_sql(out_node), ""]
    if dq_node:
        dq_sql = get_sql(dq_node).strip()
        if dq_sql and not dq_sql.startswith("--"):
            lines += ["", "-- ══ DQ ASSERTIONS ══", dq_sql]
    return ExportResponse(pipeline_id=req.pipeline_id,
        filename=f"{name}_mysql.sql", sql="\n".join(lines), warnings=warnings)


# ── Version history ────────────────────────────────────────────────────────────
@app.get("/versions/{pipeline_id}")
def get_versions(pipeline_id: str): return list_versions(pipeline_id)

@app.get("/version/{version_id}")
def get_version_detail(version_id: str):
    v = get_version(version_id)
    if not v: raise HTTPException(404)
    return v


# ── Analytics — pipeline-level data pointers ─────────────────────────────────────
@app.get("/analytics/{pipeline_id}")
def get_pipeline_analytics(pipeline_id: str):
    """
    Real per-pipeline analytics derived entirely from stored metadata —
    no fake numbers, nothing hardcoded. Includes column counts at each
    pipeline stage (extracted/transformed/aggregated), source table count,
    node approval status, DQ rule breakdown, and version history.
    """
    spec = load_pipeline(pipeline_id)
    if not spec:
        raise HTTPException(404, "Pipeline not found")

    pipeline = spec["pipeline"]
    nodes    = sorted(spec["nodes"], key=lambda n: n.get("node_order", 0))
    lineage  = spec["lineage"]
    dq_rules = spec["dq_rules"]
    comments = spec["comments"]
    versions = list_versions(pipeline_id)

    # ── Column counts per pipeline stage — derived from lineage rows ───────────
    # Each lineage entry represents one output column of one node's SELECT,
    # so counting lineage rows per node_id gives an accurate column count
    # at every stage without re-parsing SQL.
    def _cols_for_cte(cte_name: str) -> int:
        node = next((n for n in nodes if n.get("cte_name") == cte_name), None)
        if not node:
            return 0
        return len([l for l in lineage if l["node_id"] == node["node_id"]])

    extracted_columns   = _cols_for_cte("extracted")
    transformed_columns = _cols_for_cte("transformed")
    aggregated_columns  = _cols_for_cte("aggregated")

    # ── Source tables actually referenced (distinct, from extracted node) ──────
    source_tables = sorted({
        l["source_table"] for l in lineage
        if l.get("source_table") and l["source_table"] not in ("derived", "unknown")
    })

    # ── Column transformation type breakdown ────────────────────────────────────
    transform_counts: dict = {}
    for entry in lineage:
        t = entry.get("transform_type", "derive")
        transform_counts[t] = transform_counts.get(t, 0) + 1

    # ── DQ rule summary ──────────────────────────────────────────────────────────
    enabled_rules = [r for r in dq_rules if bool(r.get("enabled", 1))]
    dq_errors     = sum(1 for r in dq_rules if r.get("severity") == "error")
    dq_warnings   = sum(1 for r in dq_rules if r.get("severity") == "warn")
    dq_prelim     = sum(1 for r in dq_rules if r.get("preliminary", True))

    # ── Node approval status counts ─────────────────────────────────────────────
    approved = sum(1 for n in nodes if n.get("status") == "approved")
    blocked  = sum(1 for n in nodes if n.get("status") == "blocked")
    pending  = sum(1 for n in nodes if n.get("status") == "pending_review")

    return {
        "pipeline_id":   pipeline_id,
        "pipeline_name": pipeline["pipeline_name"],
        "requirement":   pipeline["requirement"],
        "created_at":    pipeline["created_at"],

        # Node-level counts
        "node_count":     len(nodes),
        "approved_count": approved,
        "blocked_count":  blocked,
        "pending_count":  pending,

        # Column pointers — what was asked for specifically
        "extracted_columns":   extracted_columns,
        "transformed_columns": transformed_columns,
        "aggregated_columns":  aggregated_columns,
        "lineage_count":       len(lineage),
        "source_table_count":  len(source_tables),
        "source_tables":       source_tables,

        # Column transformation breakdown
        "column_changes_by_type": transform_counts,

        # DQ summary
        "dq_summary": {
            "total":        len(dq_rules),
            "enabled":      len(enabled_rules),
            "disabled":     len(dq_rules) - len(enabled_rules),
            "errors":       dq_errors,
            "warnings":     dq_warnings,
            "preliminary":  dq_prelim,
            "statistical":  len(dq_rules) - dq_prelim,
        },

        "comment_count": len(comments),

        # Node status list
        "nodes": [
            {
                "node_id":  n["node_id"],
                "label":    n["label"],
                "type":     n["node_type"],
                "status":   n.get("status", "pending_review"),
                "cte_name": n.get("cte_name"),
                "editable": bool(n.get("editable", True)),
            }
            for n in nodes
        ],

        # Version / activity timeline
        "versions": versions,
    }


# ── Pipeline CRUD ──────────────────────────────────────────────────────────────
@app.get("/pipelines", response_model=list[PipelineSummary])
def get_pipelines():
    return [PipelineSummary(pipeline_id=r["pipeline_id"], pipeline_name=r["pipeline_name"],
        requirement=r["requirement"], node_count=r["node_count"],
        created_at=datetime.fromisoformat(r["created_at"])) for r in list_all_pipelines()]

@app.get("/pipeline/{pid}")
def get_pipeline(pid: str):
    s = load_pipeline(pid)
    if not s: raise HTTPException(404)
    return s
