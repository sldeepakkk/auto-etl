"""
schema_reader.py — pure SQLAlchemy, no LLM.
Handles databases with multiple schemas (not just public).
Table names are returned as schema.table for non-public schemas,
e.g.  production.product, sales.salesorderheader, hr.employee
"""
import logging
from typing import List, Dict, Any, Optional
from sqlalchemy import create_engine, inspect, text

log = logging.getLogger(__name__)

PG_TO_MYSQL = {
    "INTEGER":"INT","INT":"INT","BIGINT":"BIGINT","SMALLINT":"SMALLINT",
    "SERIAL":"INT","BIGSERIAL":"BIGINT","TEXT":"LONGTEXT","VARCHAR":"VARCHAR",
    "CHAR":"CHAR","BOOLEAN":"TINYINT(1)","FLOAT":"FLOAT","REAL":"FLOAT",
    "DOUBLE PRECISION":"DOUBLE","NUMERIC":"DECIMAL","DECIMAL":"DECIMAL",
    "DATE":"DATE","TIMESTAMP":"DATETIME","TIMESTAMPTZ":"DATETIME","TIME":"TIME",
    "UUID":"VARCHAR(36)","JSON":"JSON","JSONB":"JSON","ARRAY":"TEXT","BYTEA":"BLOB",
}
CAST_REQUIRED = {"UUID","JSONB","ARRAY","BYTEA"}

# PostgreSQL system schemas to always skip
_SYSTEM_SCHEMAS = {
    "information_schema", "pg_catalog", "pg_toast",
    "pg_temp_1", "pg_toast_temp_1",
}


def _get_user_schemas(inspector) -> List[str]:
    """Return all schemas that aren't PostgreSQL system schemas."""
    return [
        s for s in inspector.get_schema_names()
        if not s.startswith("pg_") and s not in _SYSTEM_SCHEMAS
    ]


def _display_name(schema: str, table: str) -> str:
    """schema.table — always include schema so names are unambiguous."""
    return f"{schema}.{table}"


def _parse_name(full_name: str):
    """Split 'schema.table' → (schema, table). Falls back to ('public', name)."""
    if "." in full_name:
        schema, table = full_name.split(".", 1)
        return schema, table
    return "public", full_name


# ── Public API ────────────────────────────────────────────────────────────────

def list_tables(db_url: str) -> List[Dict[str, Any]]:
    """
    Return every user table across all schemas, formatted as schema.table.
    Used by GET /schema/tables (Dashboard table picker).
    """
    engine    = create_engine(db_url, pool_pre_ping=True)
    inspector = inspect(engine)
    schemas   = _get_user_schemas(inspector)
    result    = []

    with engine.connect() as conn:
        for schema in sorted(schemas):
            try:
                tables = inspector.get_table_names(schema=schema)
            except Exception:
                continue

            for table_name in tables:
                # Approximate row count via pg_class (no sequential scan)
                try:
                    count = conn.execute(text(
                        "SELECT reltuples::bigint FROM pg_class c "
                        "JOIN pg_namespace n ON n.oid = c.relnamespace "
                        "WHERE c.relname = :t AND n.nspname = :s"
                    ), {"t": table_name, "s": schema}).scalar() or 0
                except Exception:
                    count = -1

                # Column count
                try:
                    cols = len(inspector.get_columns(table_name, schema=schema))
                except Exception:
                    cols = 0

                result.append({
                    "name":         _display_name(schema, table_name),
                    "approx_rows":  int(count),
                    "column_count": cols,
                })

    engine.dispose()
    return result


def inspect_selected(db_url: str, selected_tables: List[str]) -> Dict[str, Any]:
    """
    Deep inspection of user-selected tables.
    Accepts schema.table format (e.g. "production.product").
    Returns the schema_context dict consumed by the Blueprint Agent.
    """
    engine    = create_engine(db_url, pool_pre_ping=True)
    inspector = inspect(engine)

    tables_out: List[Dict] = []
    fks_out:    List[Dict] = []

    for full_name in selected_tables:
        schema, table_name = _parse_name(full_name)

        # ── Columns ──────────────────────────────────────────────────────────
        try:
            raw_cols = inspector.get_columns(table_name, schema=schema)
        except Exception as exc:
            log.warning("Cannot inspect %s: %s", full_name, exc)
            continue

        columns = []
        for c in raw_cols:
            pg_type    = str(c["type"]).upper().split("(")[0].strip()
            mysql_type = PG_TO_MYSQL.get(pg_type, "TEXT")
            columns.append({
                "name":          c["name"],
                "pg_type":       pg_type,
                "mysql_type":    mysql_type,
                "nullable":      bool(c.get("nullable", True)),
                "cast_required": pg_type in CAST_REQUIRED,
            })

        # ── Approximate row count ─────────────────────────────────────────────
        approx_rows = -1
        try:
            with engine.connect() as conn:
                approx_rows = int(conn.execute(text(
                    "SELECT reltuples::bigint FROM pg_class c "
                    "JOIN pg_namespace n ON n.oid = c.relnamespace "
                    "WHERE c.relname = :t AND n.nspname = :s"
                ), {"t": table_name, "s": schema}).scalar() or 0)
        except Exception:
            pass

        tables_out.append({
            "name":        full_name,           # keep schema.table as the key
            "columns":     columns,
            "approx_rows": approx_rows,
        })

        # ── Declared FK constraints ───────────────────────────────────────────
        try:
            for fk in inspector.get_foreign_keys(table_name, schema=schema):
                if fk.get("constrained_columns") and fk.get("referred_columns"):
                    ref_schema = fk.get("referred_schema") or schema
                    ref_table  = _display_name(ref_schema, fk["referred_table"])
                    fks_out.append({
                        "from":     f"{full_name}.{fk['constrained_columns'][0]}",
                        "to":       f"{ref_table}.{fk['referred_columns'][0]}",
                        "inferred": False,
                    })
        except Exception:
            pass

    # ── Inferred FK pass (naming conventions) ─────────────────────────────────
    declared_from = {fk["from"].rsplit(".", 1)[0] for fk in fks_out}

    for full_name in selected_tables:
        if full_name in declared_from:
            continue
        schema, table_name = _parse_name(full_name)
        try:
            raw_cols = inspector.get_columns(table_name, schema=schema)
            for c in raw_cols:
                col = c["name"]
                if not col.endswith("id") and not col.endswith("_id"):
                    continue
                # Try stem → look for matching table in same schema
                stem = col[:-2].rstrip("_")
                for candidate in [stem, stem + "s"]:
                    try:
                        inspector.get_columns(candidate, schema=schema)
                        pk   = inspector.get_pk_constraint(candidate, schema=schema)
                        pk_c = (pk.get("constrained_columns") or ["id"])[0]
                        fks_out.append({
                            "from":     f"{full_name}.{col}",
                            "to":       f"{_display_name(schema, candidate)}.{pk_c}",
                            "inferred": True,
                        })
                        break
                    except Exception:
                        pass
        except Exception:
            pass

    engine.dispose()

    return {
        "tables":          tables_out,
        "foreign_keys":    fks_out,
        "relevant_tables": selected_tables,
        "excluded_tables": [],
    }


def format_schema_for_llm(schema: Dict[str, Any]) -> str:
    """Compact text block for LLM prompts — includes schema prefix in table names."""
    lines = []
    for table in schema.get("tables", []):
        cols = ", ".join(
            f"{c['name']}:{c['mysql_type']}" + (" [CAST REQUIRED]" if c["cast_required"] else "")
            for c in table["columns"]
        )
        rows = f"  (~{table['approx_rows']:,} rows)" if table.get("approx_rows", -1) > 0 else ""
        lines.append(f"Table {table['name']}({cols}){rows}")
    for fk in schema.get("foreign_keys", []):
        star = "★ " if fk.get("inferred") else ""
        lines.append(f"FK{star}: {fk['from']} → {fk['to']}")
    return "\n".join(lines) if lines else "No schema available"


def validate_connection(db_url: str) -> Dict[str, Any]:
    """Quick connection test. Returns {ok, error, table_count}."""
    try:
        engine    = create_engine(db_url, connect_args={"connect_timeout": 5})
        inspector = inspect(engine)
        schemas   = _get_user_schemas(inspector)
        count = sum(len(inspector.get_table_names(schema=s)) for s in schemas)
        engine.dispose()
        return {"ok": True, "error": None, "table_count": count}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "table_count": 0}


def preview_table(db_url: str, full_name: str, limit: int = 10) -> Dict[str, Any]:
    """
    Fetch schema + first {limit} rows for a single table.
    Used by GET /schema/preview (Dashboard table click).
    """
    schema, table_name = _parse_name(full_name)
    engine    = create_engine(db_url, pool_pre_ping=True)
    inspector = inspect(engine)

    # ── Column definitions ────────────────────────────────────────────────────
    columns = []
    try:
        for c in inspector.get_columns(table_name, schema=schema):
            pg_type    = str(c["type"]).upper().split("(")[0].strip()
            mysql_type = PG_TO_MYSQL.get(pg_type, "TEXT")
            columns.append({
                "name":          c["name"],
                "pg_type":       pg_type,
                "mysql_type":    mysql_type,
                "nullable":      bool(c.get("nullable", True)),
                "cast_required": pg_type in CAST_REQUIRED,
            })
    except Exception as exc:
        engine.dispose()
        raise ValueError(f"Could not read columns for {full_name}: {exc}")

    # ── Sample rows ───────────────────────────────────────────────────────────
    col_names: List[str] = []
    rows: List[List[Optional[str]]] = []
    try:
        with engine.connect() as conn:
            result = conn.execute(
                text(f'SELECT * FROM "{schema}"."{table_name}" LIMIT :lim'),
                {"lim": limit},
            )
            col_names = list(result.keys())
            rows = [
                [str(v) if v is not None else None for v in row]
                for row in result.fetchall()
            ]
    except Exception as exc:
        log.warning("Could not fetch preview rows for %s: %s", full_name, exc)

    engine.dispose()
    return {
        "table":     full_name,
        "schema":    schema,
        "columns":   columns,
        "col_names": col_names,
        "rows":      rows,
        "row_count": len(rows),
    }
