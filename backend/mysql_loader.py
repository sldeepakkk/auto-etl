"""
mysql_loader.py — Executes the real PostgreSQL → MySQL data transfer.

This is the piece that was previously missing entirely. Export only
generated a .sql text file; nothing actually moved data between the
two databases. This module:

  1. Runs the pipeline's full SELECT (the 'aggregated' CTE output)
     against the PostgreSQL source to get the result rows in memory.
  2. Infers a MySQL-compatible CREATE TABLE statement from the result
     column types (using the same PG_TO_MYSQL map schema_reader.py
     already uses for preview type badges).
  3. Creates the target table in MySQL (CREATE TABLE IF NOT EXISTS,
     or DROP+CREATE if the user chose "replace").
  4. Batch-inserts the rows into MySQL using executemany for speed.

This does NOT try to run a single cross-database SQL statement —
that's not possible since PostgreSQL and MySQL are different engines
with no native federation between them. The two-phase SELECT-then-
INSERT approach is the standard pattern for cross-database ETL.
"""
import logging
import re
from typing import Dict, List, Any, Tuple, Optional
from sqlalchemy import create_engine, text, inspect as sa_inspect

log = logging.getLogger(__name__)

# Reuse the same PG→MySQL type map used elsewhere in the app for consistency
PG_TO_MYSQL_TYPE = {
    "INTEGER": "INT", "INT": "INT", "BIGINT": "BIGINT", "SMALLINT": "SMALLINT",
    "SERIAL": "INT", "BIGSERIAL": "BIGINT", "TEXT": "LONGTEXT", "VARCHAR": "VARCHAR(255)",
    "CHAR": "CHAR(50)", "BOOLEAN": "TINYINT(1)", "FLOAT": "FLOAT", "REAL": "FLOAT",
    "DOUBLE PRECISION": "DOUBLE", "NUMERIC": "DECIMAL(18,4)", "DECIMAL": "DECIMAL(18,4)",
    "DATE": "DATE", "TIMESTAMP": "DATETIME", "TIMESTAMPTZ": "DATETIME", "TIME": "TIME",
    "UUID": "VARCHAR(36)", "JSON": "JSON", "JSONB": "JSON", "ARRAY": "TEXT", "BYTEA": "BLOB",
}


def _sanitize_table_name(name: str) -> str:
    """Strip anything unsafe from a user-provided target table name."""
    clean = re.sub(r'[^a-zA-Z0-9_]', '_', name.strip())
    if not clean or not clean[0].isalpha():
        clean = f"t_{clean}"
    return clean[:64]  # MySQL identifier length limit


def _mysql_type_for_value(sample_values: List[Any], pg_type_hint: Optional[str] = None) -> str:
    """
    Infer a MySQL column type. Prefers the PostgreSQL type hint from the
    cursor description if available; falls back to Python-value sniffing.
    """
    if pg_type_hint:
        base = pg_type_hint.upper().split("(")[0].strip()
        if base in PG_TO_MYSQL_TYPE:
            return PG_TO_MYSQL_TYPE[base]

    # Fallback: sniff from actual values
    non_null = [v for v in sample_values if v is not None]
    if not non_null:
        return "TEXT"

    sample = non_null[0]
    if isinstance(sample, bool):
        return "TINYINT(1)"
    if isinstance(sample, int):
        return "BIGINT"
    if isinstance(sample, float):
        return "DECIMAL(18,4)"

    # String — pick VARCHAR vs LONGTEXT based on observed length
    max_len = max((len(str(v)) for v in non_null), default=50)
    if max_len <= 255:
        return f"VARCHAR({max(max_len, 20)})"
    return "LONGTEXT"


def fetch_pipeline_output(
    source_db_url: str,
    full_select_sql: str,
) -> Tuple[List[str], List[List[Any]], Dict[str, str]]:
    """
    Execute the pipeline's SELECT against PostgreSQL and return
    (column_names, rows, pg_type_hints).
    pg_type_hints maps column_name -> PostgreSQL type name, extracted
    from the DBAPI cursor description where available.
    """
    engine = create_engine(source_db_url, pool_pre_ping=True)
    try:
        with engine.connect() as conn:
            result = conn.execute(text(full_select_sql))
            columns = list(result.keys())
            rows = [list(row) for row in result.fetchall()]

            # Try to get PostgreSQL type OIDs from the raw cursor for better typing
            type_hints: Dict[str, str] = {}
            try:
                cursor = result.cursor
                if cursor and cursor.description:
                    # psycopg2 cursor.description gives (name, type_code, ...)
                    # Map common OIDs to friendly names — best-effort only
                    OID_MAP = {
                        23: "INTEGER", 20: "BIGINT", 21: "SMALLINT",
                        1700: "NUMERIC", 700: "REAL", 701: "DOUBLE PRECISION",
                        16: "BOOLEAN", 1082: "DATE", 1114: "TIMESTAMP",
                        1184: "TIMESTAMPTZ", 25: "TEXT", 1043: "VARCHAR",
                    }
                    for desc in cursor.description:
                        col_name, type_oid = desc[0], desc[1]
                        if type_oid in OID_MAP:
                            type_hints[col_name] = OID_MAP[type_oid]
            except Exception as e:
                log.debug("Could not extract PG type hints from cursor: %s", e)

            return columns, rows, type_hints
    finally:
        engine.dispose()


def load_into_mysql(
    target_db_url: str,
    table_name: str,
    columns: List[str],
    rows: List[List[Any]],
    pg_type_hints: Dict[str, str],
    mode: str = "replace",   # "replace" | "append" | "fail_if_exists"
    batch_size: int = 1000,
) -> Dict[str, Any]:
    """
    Create the target table in MySQL (if needed) and insert all rows.
    Returns a summary dict: {table, rows_inserted, columns, mode, duration_ms}.
    """
    import time
    t0 = time.time()

    safe_table = _sanitize_table_name(table_name)
    engine = create_engine(target_db_url, pool_pre_ping=True)

    try:
        inspector = sa_inspect(engine)
        table_exists = safe_table in inspector.get_table_names()

        if table_exists and mode == "fail_if_exists":
            raise ValueError(
                f"Table '{safe_table}' already exists in the target database. "
                f"Choose 'replace' to overwrite it or 'append' to add rows to it."
            )

        with engine.begin() as conn:
            if table_exists and mode == "replace":
                conn.execute(text(f"DROP TABLE `{safe_table}`"))
                table_exists = False

            if not table_exists:
                col_defs = []
                for i, col in enumerate(columns):
                    sample_vals = [row[i] for row in rows[:50]]  # sample first 50 rows for type inference
                    pg_hint = pg_type_hints.get(col)
                    mysql_type = _mysql_type_for_value(sample_vals, pg_hint)
                    safe_col = re.sub(r'[^a-zA-Z0-9_]', '_', col)
                    col_defs.append(f"`{safe_col}` {mysql_type}")

                create_sql = f"CREATE TABLE `{safe_table}` (\n  " + ",\n  ".join(col_defs) + "\n)"
                conn.execute(text(create_sql))
                log.info("Created MySQL table %s with %d columns", safe_table, len(columns))

            # Batch insert
            safe_cols = [re.sub(r'[^a-zA-Z0-9_]', '_', c) for c in columns]
            placeholders = ", ".join([f":{c}" for c in safe_cols])
            col_list = ", ".join([f"`{c}`" for c in safe_cols])
            insert_sql = text(f"INSERT INTO `{safe_table}` ({col_list}) VALUES ({placeholders})")

            inserted = 0
            for batch_start in range(0, len(rows), batch_size):
                batch = rows[batch_start:batch_start + batch_size]
                batch_dicts = [dict(zip(safe_cols, row)) for row in batch]
                if batch_dicts:
                    conn.execute(insert_sql, batch_dicts)
                    inserted += len(batch_dicts)

        duration_ms = int((time.time() - t0) * 1000)
        return {
            "table": safe_table,
            "rows_inserted": inserted,
            "columns": columns,
            "mode": mode,
            "duration_ms": duration_ms,
        }
    finally:
        engine.dispose()


def run_full_load(
    source_db_url: str,
    target_db_url: str,
    full_select_sql: str,
    target_table_name: str,
    mode: str = "replace",
) -> Dict[str, Any]:
    """
    Top-level orchestration: SELECT from PostgreSQL, then INSERT into MySQL.
    This is the single function main.py calls for the /load-to-mysql endpoint.
    """
    columns, rows, type_hints = fetch_pipeline_output(source_db_url, full_select_sql)

    if not rows:
        return {
            "table": target_table_name, "rows_inserted": 0,
            "columns": columns, "mode": mode, "duration_ms": 0,
            "warning": "The source query returned 0 rows. No data was loaded into MySQL.",
        }

    result = load_into_mysql(target_db_url, target_table_name, columns, rows, type_hints, mode)
    return result
