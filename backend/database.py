"""SQLite metadata store — includes comments, versions, approval status."""
import sqlite3, json
from pathlib import Path
from datetime import datetime, timezone

DB_PATH = Path("pipelines.db")

def get_db():
    conn = sqlite3.connect(DB_PATH); conn.row_factory = sqlite3.Row; return conn

def init_db():
    with get_db() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS pipelines (
                pipeline_id TEXT PRIMARY KEY, pipeline_name TEXT, requirement TEXT,
                source_db_url TEXT, target_db_url TEXT, schema_text TEXT DEFAULT '',
                created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS pipeline_nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pipeline_id TEXT REFERENCES pipelines(pipeline_id),
                node_id TEXT, node_order INTEGER, node_type TEXT, label TEXT,
                description TEXT DEFAULT '', cte_name TEXT, sql_draft TEXT,
                sql_final TEXT, editable INTEGER DEFAULT 1,
                status TEXT DEFAULT 'pending_review'
            );
            CREATE TABLE IF NOT EXISTS pipeline_edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pipeline_id TEXT REFERENCES pipelines(pipeline_id),
                source_node TEXT, target_node TEXT
            );
            CREATE TABLE IF NOT EXISTS lineage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pipeline_id TEXT REFERENCES pipelines(pipeline_id),
                node_id TEXT, target_column TEXT, source_table TEXT,
                source_column TEXT, transform_type TEXT, derivation_logic TEXT
            );
            CREATE TABLE IF NOT EXISTS dq_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pipeline_id TEXT REFERENCES pipelines(pipeline_id),
                node_id TEXT, column_name TEXT, rule TEXT,
                severity TEXT DEFAULT 'warn', preliminary INTEGER DEFAULT 1,
                params TEXT DEFAULT '{}', enabled INTEGER DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS node_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pipeline_id TEXT REFERENCES pipelines(pipeline_id),
                node_id TEXT, author TEXT DEFAULT 'user',
                text TEXT, created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS versions (
                version_id TEXT PRIMARY KEY,
                pipeline_id TEXT REFERENCES pipelines(pipeline_id),
                action TEXT, created_at TEXT,
                snapshot TEXT
            );
        """)

def save_pipeline(pipeline_id, pipeline_name, requirement,
                  source_db_url, target_db_url, nodes, edges,
                  lineage, dq_rules, schema_text=""):
    now = datetime.now(timezone.utc).isoformat()
    with get_db() as c:
        c.execute("INSERT OR REPLACE INTO pipelines VALUES (?,?,?,?,?,?,?)",
            (pipeline_id, pipeline_name, requirement, source_db_url, target_db_url, schema_text, now))
        for i, n in enumerate(nodes):
            c.execute("INSERT INTO pipeline_nodes (pipeline_id,node_id,node_order,node_type,label,description,cte_name,sql_draft,editable,status) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (pipeline_id, n["id"], i, n["type"], n["label"], n.get("description",""),
                 n.get("cte_name"), n.get("sql_draft",""), 1 if n.get("editable",True) else 0,
                 n.get("status", "pending_review")))
        for e in edges:
            c.execute("INSERT INTO pipeline_edges (pipeline_id,source_node,target_node) VALUES (?,?,?)",
                (pipeline_id, e["source"], e["target"]))
        for l in lineage:
            c.execute("INSERT INTO lineage (pipeline_id,node_id,target_column,source_table,source_column,transform_type,derivation_logic) VALUES (?,?,?,?,?,?,?)",
                (pipeline_id, l.get("node_id"), l.get("target_column"), l.get("source_table"),
                 l.get("source_column"), l.get("transform_type"), l.get("derivation_logic")))
        for r in dq_rules:
            c.execute("INSERT INTO dq_rules (pipeline_id,node_id,column_name,rule,severity,preliminary,params) VALUES (?,?,?,?,?,?,?)",
                (pipeline_id, r.get("node_id"), r.get("column"), r.get("rule"),
                 r.get("severity","warn"), 1 if r.get("preliminary",True) else 0,
                 json.dumps(r.get("params",{}))))

def _normalize_dq_rule(r: dict) -> dict:
    """
    Raw SQLite rows use column_name (the actual DB column) and store params
    as a JSON text string. Every consumer downstream — agents.py's DQ check
    builder, the Pydantic DQRule model, the frontend TS type — expects the
    key to be named "column" (matching what run_dq_agent's LLM output uses
    at generation time) and params to be an actual dict, not a string.

    Without this normalization, agents.py's _build_dq_check_sql() does
    rule["column"] (bracket access) against a dict that only has
    "column_name", raising an uncaught KeyError('column') the instant a
    rule is reloaded from the database — which is every rule except the
    ones still sitting in the in-memory response right after /generate.
    This bug doesn't appear at generation time because that path never
    round-trips through SQLite before being used.
    """
    d = dict(r)
    if "column_name" in d and "column" not in d:
        d["column"] = d.pop("column_name")
    if isinstance(d.get("params"), str):
        try:
            d["params"] = json.loads(d["params"]) if d["params"] else {}
        except (json.JSONDecodeError, TypeError):
            d["params"] = {}
    d["enabled"]     = bool(d.get("enabled", 1))
    d["preliminary"] = bool(d.get("preliminary", 1))
    return d


def load_pipeline(pid):
    with get_db() as c:
        row = c.execute("SELECT * FROM pipelines WHERE pipeline_id=?", (pid,)).fetchone()
        if not row: return None
        return {
            "pipeline": dict(row),
            "nodes": [dict(n) for n in c.execute("SELECT * FROM pipeline_nodes WHERE pipeline_id=? ORDER BY node_order", (pid,)).fetchall()],
            "edges": [dict(e) for e in c.execute("SELECT * FROM pipeline_edges WHERE pipeline_id=?", (pid,)).fetchall()],
            "lineage": [dict(l) for l in c.execute("SELECT * FROM lineage WHERE pipeline_id=?", (pid,)).fetchall()],
            "dq_rules": [_normalize_dq_rule(r) for r in c.execute("SELECT * FROM dq_rules WHERE pipeline_id=?", (pid,)).fetchall()],
            "comments": [dict(c2) for c2 in c.execute("SELECT * FROM node_comments WHERE pipeline_id=? ORDER BY created_at", (pid,)).fetchall()],
        }

def list_all_pipelines():
    with get_db() as c:
        return [dict(r) for r in c.execute("""
            SELECT p.pipeline_id, p.pipeline_name, p.requirement, p.created_at,
                   COUNT(n.id) as node_count
            FROM pipelines p LEFT JOIN pipeline_nodes n ON n.pipeline_id=p.pipeline_id
            GROUP BY p.pipeline_id ORDER BY p.created_at DESC
        """).fetchall()]

def update_node_status(pid, node_id, status, reason=None):
    with get_db() as c:
        c.execute("UPDATE pipeline_nodes SET status=? WHERE pipeline_id=? AND node_id=?", (status, pid, node_id))
        if reason:
            now = datetime.now(timezone.utc).isoformat()
            c.execute("INSERT INTO node_comments (pipeline_id,node_id,author,text,created_at) VALUES (?,?,?,?,?)",
                (pid, node_id, "system", f"Status → {status}: {reason}", now))

def add_comment(pid, node_id, author, text):
    now = datetime.now(timezone.utc).isoformat()
    with get_db() as c:
        c.execute("INSERT INTO node_comments (pipeline_id,node_id,author,text,created_at) VALUES (?,?,?,?,?)",
            (pid, node_id, author, text, now))
    return {"node_id": node_id, "author": author, "text": text, "created_at": now}

def get_comments(pid, node_id=None):
    with get_db() as c:
        if node_id:
            rows = c.execute("SELECT * FROM node_comments WHERE pipeline_id=? AND node_id=? ORDER BY created_at", (pid, node_id)).fetchall()
        else:
            rows = c.execute("SELECT * FROM node_comments WHERE pipeline_id=? ORDER BY created_at", (pid,)).fetchall()
        return [dict(r) for r in rows]

def save_version(version_id, pid, action, snapshot):
    now = datetime.now(timezone.utc).isoformat()
    with get_db() as c:
        c.execute("INSERT INTO versions (version_id,pipeline_id,action,created_at,snapshot) VALUES (?,?,?,?,?)",
            (version_id, pid, action, now, json.dumps(snapshot)))

def list_versions(pid):
    with get_db() as c:
        return [dict(r) for r in c.execute(
            "SELECT version_id, pipeline_id, action, created_at FROM versions WHERE pipeline_id=? ORDER BY created_at DESC",
            (pid,)).fetchall()]

def get_version(version_id):
    with get_db() as c:
        row = c.execute("SELECT * FROM versions WHERE version_id=?", (version_id,)).fetchone()
        return dict(row) if row else None
