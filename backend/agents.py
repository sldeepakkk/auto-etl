import json, re, logging, time
from difflib import SequenceMatcher
from typing import Dict, List, Any, Optional, Tuple
import httpx, sqlglot
from sqlglot import exp as sqlexp
from sqlglot.optimizer.qualify import qualify
from config import settings

log = logging.getLogger(__name__)
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

MODEL_STRONG          = "llama-3.3-70b-versatile"       # Blueprint + Ask — proven reliable, no 413 history
MODEL_STRONG_FALLBACK = "openai/gpt-oss-120b"           # fallback if/when Llama 3.3 is fully sunset
MODEL_FAST            = "llama-3.1-8b-instant"          # Tracer + DQ + Refine — proven reliable
MODEL_FAST_FALLBACK   = "openai/gpt-oss-20b"


# ── Groq caller ───────────────────────────────────────────────────────────────

async def _groq(
    prompt: str,
    system: str,
    model: str = MODEL_FAST,
    fallback_model: Optional[str] = None,
    json_mode: bool = False,
    temperature: float = 0.1,
    max_tokens: int = 4096,
    reasoning_effort: str = "low",
) -> str:
    if not settings.GROQ_API_KEY:
        raise RuntimeError("GROQ_API_KEY not set — get one at https://console.groq.com")

    headers = {"Authorization": f"Bearer {settings.GROQ_API_KEY}", "Content-Type": "application/json"}

    def _build_body(m: str) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "model": m,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "temperature": temperature,
            "max_completion_tokens": max_tokens,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        # reasoning_effort is only meaningful for gpt-oss models — harmless
        # no-op to include it for others, but skip if targeting a non-oss
        # fallback model to avoid any provider-side param rejection.
        if "gpt-oss" in m:
            body["reasoning_effort"] = reasoning_effort
        return body

    async def _call(m: str) -> httpx.Response:
        async with httpx.AsyncClient(timeout=90) as c:
            return await c.post(GROQ_URL, json=_build_body(m), headers=headers)

    r = await _call(model)

    # Retry once against the fallback model on ANY non-2xx response — not just
    # 400/404 "model unavailable" cases. A 413 (payload too large on the
    # primary model's route), a transient 500, or any other model-specific
    # quirk should all be worth one retry against a known-working alternative
    # rather than failing the whole /generate request outright.
    if r.status_code >= 400 and r.status_code not in (401, 429) and fallback_model and fallback_model != model:
        log.warning(
            "Model %s returned %s — retrying once with fallback model %s",
            model, r.status_code, fallback_model,
        )
        r = await _call(fallback_model)

    if r.status_code == 401:
        raise RuntimeError("Groq API key invalid (401)")
    if r.status_code == 429:
        raise RuntimeError("Groq rate limit (429). Wait 60s and retry.")
    if r.status_code == 413:
        raise RuntimeError(
            "Groq rejected the request as too large (413), even after trying the "
            "fallback model. Try selecting fewer source tables for this pipeline."
        )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


# ── Output cleaning ──────────────────────────────────────────────────────────

_HARMONY_TOKEN_RE = re.compile(r"<\|(?:start|end|return|channel|message|constrain)\|>")

def _clean(text: str) -> str:
    """Strip markdown fences, Harmony-format control tokens, and extract JSON."""
    text = _HARMONY_TOKEN_RE.sub("", text)
    text = re.sub(r"^```[a-z]*\n?", "", text.strip())
    text = re.sub(r"\n?```$", "", text.strip()).strip()
    for s, e in [("{", "}"), ("[", "]")]:
        si, ei = text.find(s), text.rfind(e)
        if si != -1 and ei > si:
            return text[si:ei + 1]
    return text


def _unwrap(raw, expected_type):
    if isinstance(raw, dict) and expected_type is list:
        for v in raw.values():
            if isinstance(v, list):
                return v
    return raw


# ═══════════════════════════════════════════════════════════════════════════════
# DIALECT NORMALIZER — deterministic T-SQL/MySQL → PostgreSQL syntax fixer
# ═══════════════════════════════════════════════════════════════════════════════

def normalize_sql_dialect(sql: str) -> Tuple[str, List[str]]:
    changes: List[str] = []
    fixed = sql

    pattern3 = re.compile(
        r'DATEDIFF\s*\(\s*(day|hour|minute|second|month|year)\s*,\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)',
        re.IGNORECASE
    )
    def repl3(m):
        unit = m.group(1).upper()
        start, end = m.group(2).strip(), m.group(3).strip()
        return f"(EXTRACT({unit} FROM (CAST({end} AS TIMESTAMP) - CAST({start} AS TIMESTAMP))))::integer"
    if pattern3.search(fixed):
        fixed = pattern3.sub(repl3, fixed)
        changes.append("DATEDIFF(unit, start, end) → EXTRACT(unit FROM (end - start))")

    pattern2 = re.compile(r'DATEDIFF\s*\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)', re.IGNORECASE)
    def repl2(m):
        end, start = m.group(1).strip(), m.group(2).strip()
        return f"(EXTRACT(DAY FROM (CAST({end} AS TIMESTAMP) - CAST({start} AS TIMESTAMP))))::integer"
    if pattern2.search(fixed):
        fixed = pattern2.sub(repl2, fixed)
        changes.append("DATEDIFF(end, start) → EXTRACT(DAY FROM (end - start))")

    if re.search(r'GETDATE\s*\(\s*\)', fixed, re.IGNORECASE):
        fixed = re.sub(r'GETDATE\s*\(\s*\)', 'CURRENT_TIMESTAMP', fixed, flags=re.IGNORECASE)
        changes.append("GETDATE() → CURRENT_TIMESTAMP")

    if re.search(r'GETUTCDATE\s*\(\s*\)', fixed, re.IGNORECASE):
        fixed = re.sub(r'GETUTCDATE\s*\(\s*\)', "(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')", fixed, flags=re.IGNORECASE)
        changes.append("GETUTCDATE() → CURRENT_TIMESTAMP AT TIME ZONE 'UTC'")

    if re.search(r'\bISNULL\s*\(', fixed, re.IGNORECASE):
        fixed = re.sub(r'\bISNULL\s*\(', 'COALESCE(', fixed, flags=re.IGNORECASE)
        changes.append("ISNULL(a,b) → COALESCE(a,b)")

    if re.search(r'\bLEN\s*\(', fixed, re.IGNORECASE):
        fixed = re.sub(r'\bLEN\s*\(', 'LENGTH(', fixed, flags=re.IGNORECASE)
        changes.append("LEN(x) → LENGTH(x)")

    top_match = re.search(r'\bSELECT\s+TOP\s+(\d+)\s+', fixed, re.IGNORECASE)
    if top_match:
        n = top_match.group(1)
        fixed = re.sub(r'\bSELECT\s+TOP\s+\d+\s+', 'SELECT ', fixed, count=1, flags=re.IGNORECASE)
        if not re.search(r'\bLIMIT\s+\d+\s*;?\s*$', fixed, re.IGNORECASE):
            fixed = fixed.rstrip().rstrip(';') + f"\nLIMIT {n};"
        changes.append(f"TOP {n} → LIMIT {n}")

    iif_pattern = re.compile(r'IIF\s*\(\s*(.+?)\s*,\s*(.+?)\s*,\s*(.+?)\s*\)', re.IGNORECASE)
    if iif_pattern.search(fixed):
        fixed = iif_pattern.sub(r'CASE WHEN \1 THEN \2 ELSE \3 END', fixed)
        changes.append("IIF(cond,a,b) → CASE WHEN cond THEN a ELSE b END")

    charindex_pattern = re.compile(r'CHARINDEX\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)', re.IGNORECASE)
    if charindex_pattern.search(fixed):
        fixed = charindex_pattern.sub(r'POSITION(\1 IN \2)', fixed)
        changes.append("CHARINDEX(sub,str) → POSITION(sub IN str)")

    if re.search(r'\[\w+\]', fixed):
        fixed = re.sub(r'\[(\w+)\]', r'"\1"', fixed)
        changes.append('[identifier] → "identifier"')

    return fixed, changes


# ═══════════════════════════════════════════════════════════════════════════════
# DETERMINISTIC COLUMN-NAME FIXER (sqlglot AST-based)
# ═══════════════════════════════════════════════════════════════════════════════

def _best_match(wrong: str, candidates: List[str], threshold: float = 0.35) -> Optional[str]:
    wrong_l = wrong.lower()
    best, best_score = None, 0.0
    for c in candidates:
        if c.lower() == wrong_l: return c
        score = SequenceMatcher(None, wrong_l, c.lower()).ratio()
        if wrong_l in c.lower() or c.lower() in wrong_l: score = max(score, 0.8)
        if score > best_score: best, best_score = c, score
    return best if best_score >= threshold else None


def _build_schema_dict(db_url: str, tables: List[str]) -> Dict[str, Dict[str, Dict[str, str]]]:
    from sqlalchemy import create_engine, inspect as sa_inspect
    engine = create_engine(db_url, pool_pre_ping=True)
    inspector = sa_inspect(engine)
    schema_dict: Dict[str, Dict[str, Dict[str, str]]] = {}
    for full_name in tables:
        parts = full_name.split(".", 1)
        schema_name = parts[0] if len(parts) > 1 else "public"
        table_name  = parts[1] if len(parts) > 1 else parts[0]
        try:
            cols = inspector.get_columns(table_name, schema=schema_name)
            col_map = {c["name"]: str(c["type"]).split("(")[0] for c in cols}
            schema_dict.setdefault(schema_name, {})[table_name] = col_map
        except Exception as exc:
            log.debug("Could not inspect %s.%s: %s", schema_name, table_name, exc)
    engine.dispose()
    return schema_dict


def _extract_real_tables(sql: str) -> List[str]:
    cte_names = set()
    try:
        for stmt in sqlglot.parse(sql, error_level=None):
            if stmt is None: continue
            for cte in stmt.find_all(sqlexp.CTE):
                cte_names.add(cte.alias_or_name.lower())
    except Exception:
        pass
    tables = []
    try:
        for stmt in sqlglot.parse(sql, error_level=None):
            if stmt is None: continue
            for t in stmt.find_all(sqlexp.Table):
                name = f"{t.db}.{t.name}" if t.db else t.name
                if name.lower() not in cte_names and name.lower() not in [x.lower() for x in tables]:
                    tables.append(name)
    except Exception:
        pass
    return tables


def _find_qualifier_for_bad_column(sql: str, bad_col: str) -> Optional[str]:
    m = re.search(rf'\b(\w+)\s*\.\s*{re.escape(bad_col)}\b', sql, re.IGNORECASE)
    return m.group(1) if m else None


def _resolve_qualifier_to_columns(sql: str, qualifier: str, schema_dict: Dict) -> List[str]:
    pattern = re.compile(rf'(?:FROM|JOIN)\s+([\w.]+)\s+(?:AS\s+)?{re.escape(qualifier)}\b', re.IGNORECASE)
    m = pattern.search(sql)
    if not m: return []
    table_name = m.group(1).split(".")[-1].lower()
    for schema_name, tables in schema_dict.items():
        for tname, cols in tables.items():
            if tname.lower() == table_name:
                return list(cols.keys())
    return []


def validate_sql(full_sql: str, db_url: str) -> Tuple[bool, Optional[str]]:
    tables = _extract_real_tables(full_sql)
    if not tables:
        return True, None
    schema_dict = _build_schema_dict(db_url, tables)
    if not schema_dict:
        return True, None
    try:
        tree = sqlglot.parse_one(full_sql, dialect="postgres")
        qualify(tree, schema=schema_dict, dialect="postgres")
        return True, None
    except Exception as e:
        return False, str(e)


def auto_fix_sql(full_sql: str, db_url: str, max_iters: int = 10) -> Tuple[str, List[str]]:
    current, dialect_changes = normalize_sql_dialect(full_sql)

    tables = _extract_real_tables(current)
    column_changes: List[str] = []
    if tables:
        schema_dict = _build_schema_dict(db_url, tables)
        if schema_dict:
            for _ in range(max_iters):
                try:
                    tree = sqlglot.parse_one(current, dialect="postgres")
                    qualify(tree, schema=schema_dict, dialect="postgres")
                    break
                except Exception as e:
                    msg = str(e)
                    m = re.search(r"Unknown column:\s*([\w.]+)", msg)
                    if not m: break
                    bad_col = m.group(1).split(".")[-1]
                    qualifier = _find_qualifier_for_bad_column(current, bad_col)
                    if not qualifier: break
                    candidates = _resolve_qualifier_to_columns(current, qualifier, schema_dict)
                    if not candidates: break
                    fix = _best_match(bad_col, candidates)
                    if not fix or fix.lower() == bad_col.lower(): break
                    old_ref, new_ref = f"{qualifier}.{bad_col}", f"{qualifier}.{fix}"
                    if old_ref not in current: break
                    current = current.replace(old_ref, new_ref)
                    change = f"{old_ref} → {new_ref}"
                    if change not in column_changes: column_changes.append(change)

    return current, dialect_changes + column_changes


# ═══════════════════════════════════════════════════════════════════════════════
# OUTPUT-CORRECTNESS CHECKER — catches the AVG(fraction) vs percentage bug
# and similarly common semantic mistakes, deterministically, no LLM needed.
# ═══════════════════════════════════════════════════════════════════════════════

def _find_binary_flag_columns(all_nodes: List[Dict]) -> set:
    """
    Find column names defined upstream as CASE WHEN ... THEN 1 ELSE 0 END —
    i.e. genuine 0/1 flags. Used to precisely target the AVG(fraction) bug
    without false-flagging AVG() of unrelated numeric columns (like a day
    count) just because the word 'percentage' appears somewhere in the
    requirement text.
    """
    flags = set()
    pattern = re.compile(
        r'CASE\s+WHEN\s+.+?\s+THEN\s+1\s+ELSE\s+0\s+END\s+AS\s+([a-zA-Z_]\w*)',
        re.IGNORECASE | re.DOTALL
    )
    for n in all_nodes:
        sql = n.get("sql_draft", "")
        for m in pattern.finditer(sql):
            flags.add(m.group(1).lower())
    return flags


def check_output_correctness(nodes: List[Dict], requirement: str) -> List[str]:
    """
    Lightweight deterministic heuristics that catch the most common class of
    'runs fine but answers the wrong question' bugs, without needing another
    LLM call. Returns a list of human-readable warnings (empty if none found).
    """
    warnings: List[str] = []
    req_lower = requirement.lower()
    wants_percentage = any(w in req_lower for w in ("percentage", "percent", "%", " rate "))

    binary_flags = _find_binary_flag_columns(nodes)

    agg_node = next((n for n in nodes if n.get("cte_name") == "aggregated"), None)
    if agg_node and wants_percentage and binary_flags:
        sql = agg_node.get("sql_draft", "")

        # Heuristic A — AVG() applied directly to a known 0/1 flag column
        avg_matches = re.finditer(r'AVG\s*\(\s*([a-zA-Z_][\w.]*)\s*\)', sql, re.IGNORECASE)
        for m in avg_matches:
            col = m.group(1).split(".")[-1].lower()
            if col not in binary_flags:
                continue  # not a 0/1 flag — AVG() here is legitimate (e.g. day counts)
            window_start = max(0, m.start() - 20)
            window = sql[window_start:m.end() + 10]
            if "100" not in window and "*" not in window:
                warnings.append(
                    f"The requirement asks for a percentage, but '{m.group(0)}' in the "
                    f"aggregate step averages a 0/1 flag directly — this returns a raw "
                    f"fraction (e.g. 0.83), not a percentage (83.0). Consider asking the "
                    f"Ask Agent: 'scale {m.group(1)} to a percentage using ROUND(100.0 * ..., 2)'."
                )

        # Heuristic B — the requested percentage is never actually computed at all.
        # A SUM(flag) and a COUNT(*) both appear (the raw ingredients), but the
        # aggregate never divides them into a scaled ratio anywhere. This matches
        # a real pattern seen in practice: the query stores on_time_orders and
        # total_orders separately and leaves the requested percentage undone.
        has_flag_sum = any(
            re.search(rf'SUM\s*\(\s*{re.escape(flag)}\s*\)', sql, re.IGNORECASE)
            or re.search(rf'SUM\s*\(\s*CASE\s+WHEN.+?{re.escape(flag)}.+?END\s*\)', sql, re.IGNORECASE | re.DOTALL)
            for flag in binary_flags
        )
        has_count = re.search(r'COUNT\s*\(', sql, re.IGNORECASE) is not None
        has_scaled_ratio = re.search(r'100(?:\.0)?\s*\*.*?/', sql, re.IGNORECASE | re.DOTALL) is not None

        if has_flag_sum and has_count and not has_scaled_ratio and not warnings:
            warnings.append(
                "The requirement asks for a percentage, but the aggregate step only "
                "computes the raw numerator (SUM of a flag) and denominator (COUNT) "
                "separately — the percentage itself is never calculated. Consider "
                "asking the Ask Agent: 'compute the percentage as ROUND(100.0 * "
                "SUM(...) / NULLIF(COUNT(*),0), 2)' instead of leaving the raw counts."
            )

    # Flag division without NULLIF/CASE guard (divide-by-zero risk)
    for n in nodes:
        sql = n.get("sql_draft", "")
        if not sql or sql.strip().startswith("--"):
            continue
        for m in re.finditer(r'/\s*([a-zA-Z_][\w.]*)\s*(?:\)|,|$)', sql):
            denom = m.group(1)
            if denom.upper() in ("NULLIF", "100", "100.0"):
                continue
            surrounding = sql[max(0, m.start()-40):m.start()]
            if "NULLIF" not in surrounding.upper() and "CASE" not in surrounding.upper():
                warnings.append(
                    f"Node '{n.get('label', n.get('id'))}' divides by '{denom}' without a "
                    f"NULLIF guard — this will error if {denom} is ever 0. Consider wrapping "
                    f"the denominator in NULLIF({denom}, 0)."
                )
                break  # one warning per node is enough signal

    return warnings


# ═══════════════════════════════════════════════════════════════════════════════
# 1. BLUEPRINT AGENT — gpt-oss-120b, high reasoning effort, generation-validated
# ═══════════════════════════════════════════════════════════════════════════════

BLUEPRINT_SYSTEM = """\
You are a PostgreSQL to MySQL ELT pipeline code generation engine.
Output ONLY a JSON object with a 5-node CTE pipeline.

CTE CHAIN:
- n1 (extracted):   SELECT from real source tables. No WITH, no outer parens.
- n2 (transformed): SELECT FROM extracted
- n3 (aggregated):  SELECT FROM transformed, with GROUP BY
- n4 (dq): "-- DQ assertions generated after profiling."
- n5 (output): "INSERT INTO <target>\\nSELECT * FROM aggregated;"

═══════════════════════════════════════════════════════════════════════════════
RULE 0 — RANKING AND LIMITING MUST LIVE IN THE AGGREGATED STEP, NEVER IN OUTPUT:
If the requirement asks for a "top N", "bottom N", "highest/lowest", or any
other ranked subset, the ORDER BY and LIMIT clauses MUST be written inside
n3 (aggregated)'s own sql_draft — never deferred to n5 (output).

This matters because n5's INSERT statement is never actually executed by
itself anywhere in this system — every preview, dry-run, and MySQL load
operation runs "SELECT * FROM aggregated" directly. If ranking/limiting
logic only exists in n5's text, it is silently ignored everywhere except
the downloaded .sql reference file, and the full unranked/unlimited result
set gets previewed and loaded instead of the requested subset.

  ✗ WRONG — ranking only in n5, aggregated has everything:
    n3 sql_draft: "SELECT customerid, SUM(revenue) AS total_revenue
                   FROM transformed GROUP BY customerid"
    n5 sql_draft: "INSERT INTO target
                   SELECT * FROM aggregated ORDER BY total_revenue DESC LIMIT 10;"

  ✓ RIGHT — ranking lives inside aggregated itself:
    n3 sql_draft: "SELECT customerid, SUM(revenue) AS total_revenue
                   FROM transformed GROUP BY customerid
                   ORDER BY total_revenue DESC LIMIT 10"
    n5 sql_draft: "INSERT INTO target
                   SELECT * FROM aggregated;"   -- always exactly this, no ORDER BY/LIMIT here

n5's sql_draft must ALWAYS be exactly "INSERT INTO <target>\\nSELECT * FROM
aggregated;" with nothing else added — no ORDER BY, no LIMIT, no WHERE.
Any filtering, ranking, or limiting the requirement asks for belongs in n3.

═══════════════════════════════════════════════════════════════════════════════
RULE 1 — COLUMN CARRYING (never break this):
Every column referenced in a later CTE MUST have been explicitly listed in
the SELECT clause of every CTE before it. Before writing transformed's SQL,
re-read extracted's SELECT list. Before writing aggregated's SQL, re-read
transformed's SELECT list. Every column used must appear in that list,
character-for-character.

RULE 2 — POSTGRESQL SYNTAX ONLY, NEVER T-SQL OR MYSQL:
This schema (AdventureWorks) originally comes from SQL Server. You must
ONLY use PostgreSQL syntax:
  ✗ FORBIDDEN              ✓ USE INSTEAD (PostgreSQL)
  DATEDIFF(unit,a,b)   →   EXTRACT(unit FROM (b - a))
  GETDATE()            →   CURRENT_TIMESTAMP
  ISNULL(a,b)          →   COALESCE(a,b)
  TOP N                →   ... LIMIT N   (LIMIT goes at the END of the query)
  LEN(x)               →   LENGTH(x)
  IIF(cond,a,b)         →   CASE WHEN cond THEN a ELSE b END
  [column_name]        →   column_name

RULE 3 — COLUMN NAMES:
Copy column names CHARACTER-FOR-CHARACTER from the schema provided. Never
invent or guess column names.

RULE 4 — PERCENTAGE AND RATE METRICS (this fixes a real recurring bug):
If the requirement asks for a "percentage", "percent", "%", or "rate" of
anything, you MUST scale the result to a 0-100 range. Returning a raw
fraction from AVG() of a 0/1 flag is WRONG even though it runs without
error — it silently answers the question incorrectly.
  ✗ WRONG:  AVG(on_time) AS on_time_pct              -- returns 0.83, not 83%
  ✓ RIGHT:  ROUND(100.0 * SUM(CASE WHEN on_time = 1 THEN 1 ELSE 0 END)
                  / NULLIF(COUNT(*), 0), 2) AS on_time_pct
Always protect the denominator with NULLIF(..., 0) to avoid divide-by-zero
errors when a group happens to have no qualifying rows.

RULE 5 — DATE DIFFERENCE SIGN CONVENTION:
When computing a "days early or late" or similar signed date difference,
use EXTRACT(DAY FROM (actual_date - expected_date)). This convention means:
  positive value → actual happened AFTER expected (late)
  negative value → actual happened BEFORE expected (early)
State this convention in the node's description so it's unambiguous to
whoever reads the output later.

DESCRIPTIONS: 3-5 sentences per node — input, operation, output, business
purpose. For any percentage/rate column, explicitly state it is scaled 0-100.

═══════════════════════════════════════════════════════════════════════════════
MANDATORY SELF-CHECK — perform this before writing your final answer:
  [ ] Every column in transformed's SELECT exists in extracted's SELECT list
  [ ] Every column in aggregated's SELECT exists in transformed's SELECT list
  [ ] No DATEDIFF, GETDATE, ISNULL, TOP, LEN, or IIF anywhere in the SQL
  [ ] Every "percentage"/"rate" metric is scaled ×100 with ROUND and NULLIF
  [ ] Every division has a NULLIF or CASE guard against a zero denominator
  [ ] Column names match the schema exactly, including case
If any check fails, fix it before responding. Do not explain the check —
just return the corrected JSON.
═══════════════════════════════════════════════════════════════════════════════

WORKED EXAMPLE (structure to follow, not literal content):
Requirement: "Calculate the percentage of orders shipped on time and average
days early or late per region, for orders in the last 90 days."
{
  "pipeline_name": "region_shipping_performance",
  "description": "Regional on-time shipping rate and average delay.",
  "nodes": [
    {"id":"n1","type":"source","cte_name":"extracted","label":"Extract Source Data",
     "description":"Reads order header rows joined to region lookup, filtered to the last 90 days by order date. Selects region, ship_date, and due_date — every column the later steps will need.",
     "sql_draft":"SELECT o.region_id, r.region_name, o.ship_date, o.due_date FROM sales.orders o JOIN sales.regions r ON o.region_id = r.region_id WHERE o.order_date >= CURRENT_TIMESTAMP - INTERVAL '90 days'",
     "editable":true},
    {"id":"n2","type":"transform","cte_name":"transformed","label":"Apply Transformations",
     "description":"Computes a per-row on-time flag (1 if shipped by the due date, else 0) and the signed day difference between ship_date and due_date, where positive means late and negative means early.",
     "sql_draft":"SELECT region_id, region_name, ship_date, due_date, CASE WHEN ship_date <= due_date THEN 1 ELSE 0 END AS on_time, EXTRACT(DAY FROM (ship_date - due_date)) AS days_early_late FROM extracted",
     "editable":true},
    {"id":"n3","type":"aggregate","cte_name":"aggregated","label":"Compute Business Metrics",
     "description":"Groups by region and computes the on-time percentage as a 0-100 scaled value using SUM/COUNT with NULLIF protection, plus the average signed day difference.",
     "sql_draft":"SELECT region_id, region_name, ROUND(100.0 * SUM(CASE WHEN on_time = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2) AS on_time_pct, ROUND(AVG(days_early_late), 2) AS avg_days_early_late FROM transformed GROUP BY region_id, region_name",
     "editable":true},
    {"id":"n4","type":"dq","cte_name":null,"label":"DQ Check",
     "description":"Runs data quality assertions against the aggregated output before loading into MySQL.",
     "sql_draft":"-- DQ assertions generated after profiling.","editable":false},
    {"id":"n5","type":"output","cte_name":null,"label":"Load to MySQL",
     "description":"Loads the regional shipping performance summary into MySQL.",
     "sql_draft":"INSERT INTO region_shipping_performance\\nSELECT * FROM aggregated;","editable":false}
  ],
  "edges":[{"source":"n1","target":"n2"},{"source":"n2","target":"n3"},{"source":"n3","target":"n4"},{"source":"n4","target":"n5"}]
}
Notice: on_time_pct uses ROUND(100.0 * SUM(...) / NULLIF(COUNT(*),0), 2) —
never a bare AVG() of a 0/1 flag. Follow this exact pattern whenever a
percentage or rate is requested.
═══════════════════════════════════════════════════════════════════════════════

OUTPUT JSON SHAPE (return exactly this, with your own content):
{
  "pipeline_name":"snake_case",
  "description":"One sentence.",
  "nodes":[
    {"id":"n1","type":"source","cte_name":"extracted","label":"Extract Source Data","description":"...","sql_draft":"SELECT ...","editable":true},
    {"id":"n2","type":"transform","cte_name":"transformed","label":"Apply Transformations","description":"...","sql_draft":"SELECT ... FROM extracted ...","editable":true},
    {"id":"n3","type":"aggregate","cte_name":"aggregated","label":"Compute Business Metrics","description":"...","sql_draft":"SELECT ... FROM transformed GROUP BY ...","editable":true},
    {"id":"n4","type":"dq","cte_name":null,"label":"DQ Check","description":"...","sql_draft":"-- DQ assertions generated after profiling.","editable":false},
    {"id":"n5","type":"output","cte_name":null,"label":"Load to MySQL","description":"...","sql_draft":"INSERT INTO target\\nSELECT * FROM aggregated;","editable":false}
  ],
  "edges":[{"source":"n1","target":"n2"},{"source":"n2","target":"n3"},{"source":"n3","target":"n4"},{"source":"n4","target":"n5"}]
}"""

BLUEPRINT_SELF_CORRECT_SYSTEM = """\
Your previous pipeline failed validation against the real database schema.
Fix ONLY the broken reference(s) — do not change structure or node count.

Common causes:
  1. A later CTE references a column an earlier CTE never selected — add
     the missing column to the earlier CTE's SELECT clause.
  2. T-SQL/MySQL syntax leaked in (DATEDIFF, GETDATE, ISNULL, TOP N, LEN,
     IIF) — rewrite using PostgreSQL syntax (EXTRACT, CURRENT_TIMESTAMP,
     COALESCE, LIMIT, LENGTH, CASE WHEN).

Return the complete corrected JSON object in the same shape as before."""

_FALLBACK = {
    "pipeline_name":"edit_required","description":"Edit nodes manually.","_fallback":True,
    "nodes":[
        {"id":"n1","type":"source","cte_name":"extracted","label":"Extract Source Data","description":"Edit SQL.","sql_draft":"SELECT * FROM your_table","editable":True},
        {"id":"n2","type":"transform","cte_name":"transformed","label":"Apply Transformations","description":"Edit SQL.","sql_draft":"SELECT * FROM extracted","editable":True},
        {"id":"n3","type":"aggregate","cte_name":"aggregated","label":"Compute Metrics","description":"Edit SQL.","sql_draft":"SELECT * FROM transformed","editable":True},
        {"id":"n4","type":"dq","cte_name":None,"label":"DQ Check","description":"DQ.","sql_draft":"-- DQ assertions generated after profiling.","editable":False},
        {"id":"n5","type":"output","cte_name":None,"label":"Load to MySQL","description":"Load.","sql_draft":"INSERT INTO target\nSELECT * FROM aggregated;","editable":False}],
    "edges":[{"source":"n1","target":"n2"},{"source":"n2","target":"n3"},{"source":"n3","target":"n4"},{"source":"n4","target":"n5"}],
}


def _assemble_full_sql(nodes: List[Dict]) -> str:
    cte_nodes = [n for n in nodes if n.get("cte_name")]
    if not cte_nodes:
        return ""
    parts = [f"  {n['cte_name']} AS (\n    {n['sql_draft']}\n  )" for n in cte_nodes]
    last = cte_nodes[-1]["cte_name"]
    joined_parts = ",\n".join(parts)
    return f"WITH\n{joined_parts}\nSELECT * FROM {last} LIMIT 1;"


def _apply_dialect_normalization_to_nodes(nodes: List[Dict]) -> List[str]:
    all_changes = []
    for node in nodes:
        sql = node.get("sql_draft", "")
        if not sql or sql.strip().startswith("--"):
            continue
        fixed, changes = normalize_sql_dialect(sql)
        if changes:
            node["sql_draft"] = fixed
            all_changes.extend(changes)
    return all_changes


# ── Schema size guard (safety net behind the table-count check in main.py) ─────

MAX_SCHEMA_CHARS = 12000  # ≈ 3000 tokens — keeps Blueprint prompt well under Groq's request limit

def _truncate_schema_text(schema_text: str, max_chars: int = MAX_SCHEMA_CHARS) -> Tuple[str, bool]:
    """
    If the formatted schema text is too large for a safe request payload,
    keep as many complete table lines as fit and drop the rest with a note,
    rather than sending an oversized request that Groq rejects with a raw
    413 the user can't self-diagnose. Prefers keeping Table lines over FK
    lines since column names matter more for correct SQL generation.
    """
    if len(schema_text) <= max_chars:
        return schema_text, False

    lines = schema_text.split("\n")
    table_lines = [l for l in lines if l.startswith("Table ")]
    fk_lines    = [l for l in lines if l.startswith("FK")]

    kept: List[str] = []
    budget = max_chars
    dropped = 0
    for line in table_lines:
        if len(line) + 1 <= budget:
            kept.append(line)
            budget -= len(line) + 1
        else:
            dropped += 1

    for line in fk_lines:
        if len(line) + 1 <= budget:
            kept.append(line)
            budget -= len(line) + 1

    if dropped:
        kept.append(
            f"-- NOTE: {dropped} additional table(s) omitted to fit the request "
            f"size limit. If this pipeline needs columns from those tables, "
            f"select fewer tables per pipeline."
        )
    return "\n".join(kept), dropped > 0


async def run_blueprint_agent(requirement: str, schema_text: str, source_db_url: str = "") -> Dict:
    schema_text, was_truncated = _truncate_schema_text(schema_text)
    if was_truncated:
        log.warning("Schema text truncated to %d chars to fit request size limit", MAX_SCHEMA_CHARS)

    prompt = f"REQUIREMENT:\n{requirement}\n\nSCHEMA (use ONLY these exact column names):\n{schema_text}"
    raw, err = "", ""
    dag = None

    for attempt in range(2):
        try:
            if attempt == 0:
                raw = await _groq(
                    prompt, BLUEPRINT_SYSTEM,
                    model=MODEL_STRONG, fallback_model=MODEL_STRONG_FALLBACK,
                    json_mode=True, temperature=0.0, max_tokens=6000,
                    reasoning_effort="high",
                )
            else:
                raw = await _groq(
                    f"Fix JSON error: {err}\nOriginal: {raw[:600]}\nReturn ONLY corrected JSON.",
                    "Return valid JSON only.",
                    model=MODEL_STRONG, fallback_model=MODEL_STRONG_FALLBACK,
                    json_mode=True, temperature=0.0, reasoning_effort="medium",
                )
            dag = json.loads(_clean(raw))
            if "nodes" in dag and len(dag["nodes"]) == 5:
                break
            err = f"Expected 5 nodes, got {len(dag.get('nodes', []))}"
            dag = None
        except json.JSONDecodeError as e:
            err = str(e)

    if dag is None:
        log.error("Blueprint: JSON generation failed after retries — using fallback")
        return dict(_FALLBACK)

    # ── ALWAYS run dialect normalization ────────────────────────────────────────
    dialect_changes = _apply_dialect_normalization_to_nodes(dag["nodes"])
    if dialect_changes:
        log.info("Dialect normalization applied at generation time: %s", dialect_changes)

    # ── Generation-time schema validation (needs DB) ────────────────────────────
    if source_db_url:
        for correction_attempt in range(2):
            full_sql = _assemble_full_sql(dag["nodes"])
            if not full_sql:
                break
            is_valid, val_error = validate_sql(full_sql, source_db_url)
            if is_valid:
                break

            log.warning("Generated SQL failed validation (attempt %d): %s", correction_attempt + 1, val_error)

            fixed_sql, changes = auto_fix_sql(full_sql, source_db_url)
            if changes:
                log.info("Deterministic fix resolved it: %s", changes)
                for node in dag["nodes"]:
                    if not node.get("cte_name"):
                        continue
                    for change in changes:
                        if " → " in change:
                            old, new = change.split(" → ", 1)
                            node["sql_draft"] = node["sql_draft"].replace(old, new)
                continue

            try:
                correction_prompt = (
                    f"ORIGINAL REQUIREMENT:\n{requirement}\n\n"
                    f"SCHEMA:\n{schema_text}\n\n"
                    f"YOUR PREVIOUS PIPELINE JSON:\n{json.dumps(dag)}\n\n"
                    f"VALIDATION ERROR:\n{val_error}\n\n"
                    "Fix the SELECT clauses so every column is carried through "
                    "properly, and ensure all SQL uses PostgreSQL syntax only."
                )
                raw = await _groq(
                    correction_prompt, BLUEPRINT_SELF_CORRECT_SYSTEM,
                    model=MODEL_STRONG, fallback_model=MODEL_STRONG_FALLBACK,
                    json_mode=True, temperature=0.0, max_tokens=6000,
                    reasoning_effort="medium",
                )
                corrected = json.loads(_clean(raw))
                if "nodes" in corrected and len(corrected["nodes"]) == 5:
                    dag = corrected
                    _apply_dialect_normalization_to_nodes(dag["nodes"])
                else:
                    break
            except Exception as e:
                log.warning("Self-correction request failed: %s", e)
                break

        full_sql = _assemble_full_sql(dag["nodes"])
        if full_sql:
            is_valid, val_error = validate_sql(full_sql, source_db_url)
            if not is_valid:
                dag["_validation_warning"] = (
                    f"Pipeline may have SQL errors: {val_error}. Review node SQL before running."
                )

    # ── Deterministic output-correctness heuristics (percentage/NULLIF checks) ──
    correctness_warnings = check_output_correctness(dag["nodes"], requirement)
    if correctness_warnings:
        existing = dag.get("_validation_warning", "")
        combined = " | ".join(correctness_warnings)
        dag["_validation_warning"] = (existing + " | " + combined).strip(" |") if existing else combined

    return dag


# ═══════════════════════════════════════════════════════════════════════════════
# 2. COLUMN TRACER — gpt-oss-20b, low reasoning effort
# ═══════════════════════════════════════════════════════════════════════════════

TRACER_SYSTEM = "Return JSON array. Each entry += derivation_logic (2-3 sentences: source, transform, business meaning)."

def _classify(e):
    if isinstance(e, sqlexp.Column): return "passthrough"
    if isinstance(e, sqlexp.Cast): return "cast"
    if isinstance(e, (sqlexp.Avg, sqlexp.Sum, sqlexp.Count, sqlexp.Max, sqlexp.Min)): return "aggregate"
    return "derive"

def _extract_lineage(nid, sql, cm):
    try: tree = sqlglot.parse_one(sql, dialect="postgres", error_level=None)
    except: return []
    als = {((t.alias or t.name).lower()): t.name for t in tree.find_all(sqlexp.Table)}
    out = []
    for sel in tree.find_all(sqlexp.Select):
        for expr in sel.expressions:
            if isinstance(expr, sqlexp.Star): continue
            if isinstance(expr, sqlexp.Alias): tgt, inner = expr.alias, expr.this
            else: tgt, inner = getattr(expr, "name", str(expr)[:30]), expr
            tt = _classify(inner)
            srcs = list(inner.find_all(sqlexp.Column))
            if not srcs:
                out.append({"node_id":nid,"target_column":tgt,"source_table":"derived","source_column":str(inner)[:40],"transform_type":"derive","derivation_logic":None})
                continue
            sc = srcs[0]
            st = als.get((sc.table or "").lower()) or cm.get(sc.name.lower(), "unknown")
            out.append({"node_id":nid,"target_column":tgt,"source_table":st,"source_column":sc.name,"transform_type":tt,"derivation_logic":None})
    return out

async def run_tracer_agent(nodes, schema_context):
    cm = {}
    for t in schema_context.get("tables", []):
        for c in t.get("columns", []): cm[c["name"].lower()] = t["name"]
    entries = []
    for n in nodes:
        sql = n.get("sql_draft", "")
        if sql and not sql.strip().startswith("--"):
            entries.extend(_extract_lineage(n["id"], sql, cm))
    if not entries: return []
    try:
        raw = await _groq(
            f"LINEAGE:\n{json.dumps(entries,indent=2)}\nFill derivation_logic.",
            TRACER_SYSTEM, model=MODEL_FAST, fallback_model=MODEL_FAST_FALLBACK,
            json_mode=True, reasoning_effort="low",
        )
        r = json.loads(_clean(raw)); r = _unwrap(r, list)
        if isinstance(r, list) and len(r) == len(entries): return r
    except Exception as e:
        log.warning("Tracer failed (non-blocking): %s", e)
    return entries


# ═══════════════════════════════════════════════════════════════════════════════
# 3. DQ AGENT — gpt-oss-20b, low reasoning effort
# ═══════════════════════════════════════════════════════════════════════════════

DQ_SYSTEM = 'Return JSON array. Max 5 rules: not_null|uniqueness. preliminary:true.\n[{"node_id":"n3","column":"c","rule":"not_null","severity":"error","preliminary":true,"params":{}}]'

async def run_dq_agent(lineage):
    if not lineage: return []
    try:
        raw = await _groq(
            f"LINEAGE:\n{json.dumps(lineage,indent=2)}", DQ_SYSTEM,
            model=MODEL_FAST, fallback_model=MODEL_FAST_FALLBACK,
            json_mode=True, temperature=0.0, max_tokens=1024, reasoning_effort="low",
        )
        r = json.loads(_clean(raw)); r = _unwrap(r, list)
        return r if isinstance(r, list) else []
    except Exception as e:
        log.warning("DQ failed (non-blocking): %s", e)
        return []


# ═══════════════════════════════════════════════════════════════════════════════
# 4. ASK AGENT — gpt-oss-120b, medium reasoning effort (edits need care too)
# ═══════════════════════════════════════════════════════════════════════════════

ASK_SYSTEM = """\
Apply ONLY the requested change. Use only schema columns.
IMPORTANT: Use PostgreSQL syntax ONLY — never T-SQL or MySQL functions.
  DATEDIFF → EXTRACT(unit FROM (b-a))   GETDATE() → CURRENT_TIMESTAMP
  ISNULL → COALESCE   TOP N → LIMIT N   LEN() → LENGTH()
If asked for a percentage/rate, use ROUND(100.0 * SUM(CASE WHEN ... THEN 1
ELSE 0 END) / NULLIF(COUNT(*),0), 2) — never a bare AVG() of a 0/1 flag.
Return JSON: {"revised_sql":"...","explanation":"...","changes":["..."]}"""

async def run_ask_agent(question, current_sql, schema_text):
    raw = await _groq(
        f"SQL:\n{current_sql}\nSCHEMA:\n{schema_text}\nREQUEST:\n{question}",
        ASK_SYSTEM, model=MODEL_STRONG, fallback_model=MODEL_STRONG_FALLBACK,
        json_mode=True, temperature=0.1, max_tokens=2048, reasoning_effort="medium",
    )
    r = json.loads(_clean(raw))
    revised = r.get("revised_sql", current_sql)
    revised, dialect_changes = normalize_sql_dialect(revised)
    changes = r.get("changes", []) + dialect_changes
    return {"revised_sql": revised, "explanation": r.get("explanation",""), "changes": changes}


# ═══════════════════════════════════════════════════════════════════════════════
# 5. REFINE AGENT — gpt-oss-20b, low reasoning effort
# ═══════════════════════════════════════════════════════════════════════════════

REFINE_SYSTEM = 'Return JSON: {"summary":"...","assumptions":["..."],"suggestions":["?"]}'

async def run_refine_agent(requirement, tables, schema_text):
    schema_text, _ = _truncate_schema_text(schema_text)
    raw = await _groq(
        f"REQUIREMENT:\n{requirement}\nTABLES:\n{json.dumps(tables)}\nSCHEMA:\n{schema_text}",
        REFINE_SYSTEM, model=MODEL_FAST, fallback_model=MODEL_FAST_FALLBACK,
        json_mode=True, temperature=0.2, max_tokens=1024, reasoning_effort="low",
    )
    return json.loads(_clean(raw))


# ═══════════════════════════════════════════════════════════════════════════════
# 6. NODE EXECUTION — dialect normalization + column fix, both proactive
# ═══════════════════════════════════════════════════════════════════════════════

def run_node_query(nodes: List[Dict], target_node_id: str, source_db_url: str,
                   node_configs: Dict[str, str] = {}, limit: int = 100) -> Dict:
    from sqlalchemy import create_engine, text

    ordered = sorted(nodes, key=lambda n: n.get("node_order", 0))
    cte_parts: List[Tuple[str, str]] = []
    for n in ordered:
        cn = n.get("cte_name")
        if not cn: continue
        sql = (node_configs.get(n["node_id"]) or n.get("sql_final") or n.get("sql_draft", "")).strip()
        if sql.startswith("--") or not sql:
            return {"error": f"Node '{n.get('label', n['node_id'])}' has no executable SQL. Edit it in the SQL tab.",
                    "columns": [], "rows": [], "row_count": 0, "duration_ms": 0}
        sql, _ = normalize_sql_dialect(sql)
        cte_parts.append((cn, sql))
        if n["node_id"] == target_node_id:
            break

    if not cte_parts:
        return {"error": "No CTE nodes found.", "columns": [], "rows": [], "row_count": 0, "duration_ms": 0}

    cte_sql   = ",\n".join(f"  {name} AS (\n    {sql}\n  )" for name, sql in cte_parts)
    last_name = cte_parts[-1][0]
    full_sql  = f"WITH\n{cte_sql}\nSELECT * FROM {last_name} LIMIT {limit};"

    fix_changes: List[str] = []
    try:
        fixed_sql, changes = auto_fix_sql(full_sql, source_db_url)
        if changes:
            log.info("Pre-execution auto-fix applied: %s", changes)
            full_sql = fixed_sql
            fix_changes = changes
    except Exception as e:
        log.warning("Pre-execution auto-fix failed: %s", e)

    engine = create_engine(source_db_url, pool_pre_ping=True)

    for attempt in range(2):
        t0 = time.time()
        try:
            with engine.connect() as conn:
                result = conn.execute(text(full_sql))
                cols = list(result.keys())
                rows = [[str(v) if v is not None else None for v in row] for row in result.fetchall()]
            dur = int((time.time() - t0) * 1000)
            ret: Dict[str, Any] = {"columns": cols, "rows": rows, "row_count": len(rows), "duration_ms": dur}
            if fix_changes:
                ret["auto_fixed"] = True
                ret["fix_changes"] = fix_changes
            engine.dispose()
            return ret
        except Exception as exc:
            err = str(exc)
            is_col_err = "UndefinedColumn" in err or ("column" in err.lower() and "does not exist" in err.lower())
            is_func_err = "does not exist" in err.lower() and ("function" in err.lower())

            if attempt == 0 and (is_col_err or is_func_err):
                try:
                    fixed_sql, changes = auto_fix_sql(full_sql, source_db_url)
                    if changes:
                        full_sql = fixed_sql
                        fix_changes.extend(c for c in changes if c not in fix_changes)
                        continue
                except Exception as fe:
                    log.warning("Reactive auto-fix failed: %s", fe)
            engine.dispose()

            if is_col_err:
                m = re.search(r'column "?([\w.]+)"? does not exist', err, re.IGNORECASE)
                bad = m.group(1) if m else "a column"
                return {
                    "error": (
                        f"{err}\n\nThis usually means '{bad}' was referenced in this step but "
                        f"never selected in an earlier step. Use the Ask Agent to say something "
                        f"like 'add {bad.split('.')[-1]} to the extracted CTE', or edit the SQL "
                        f"tab of the earlier node directly."
                    ),
                    "columns": [], "rows": [], "row_count": 0, "duration_ms": 0,
                }
            if is_func_err:
                return {
                    "error": (
                        f"{err}\n\nThis usually means a SQL Server or MySQL function was used "
                        f"instead of PostgreSQL syntax. Common culprits: DATEDIFF, GETDATE, "
                        f"ISNULL, TOP N, LEN. Ask the Ask Agent to 'convert to PostgreSQL syntax'."
                    ),
                    "columns": [], "rows": [], "row_count": 0, "duration_ms": 0,
                }
            return {"error": err, "columns": [], "rows": [], "row_count": 0, "duration_ms": 0}

    engine.dispose()
    return {"error": "Query failed after auto-fix attempts.", "columns": [], "rows": [], "row_count": 0, "duration_ms": 0}


# ═══════════════════════════════════════════════════════════════════════════════
# 7. DQ CHECK EXECUTION — turns DQ rules into real validation queries.
#
# Previously the "DQ Check" canvas node was purely cosmetic: its sql_draft
# was a literal comment ("-- DQ assertions generated after profiling."),
# its cte_name was None so run_node_query() always skipped it entirely,
# and the DQ Rules tab's toggle switches only flipped a CSS class with no
# backing state or execution. Rules were suggestions for a human to read,
# never actually run against real data.
#
# run_dq_checks() closes that gap: for every ENABLED rule, it builds a real
# SQL query against the pipeline's aggregated output (the exact data that
# would be loaded into MySQL) and executes it. No LLM involved — purely
# deterministic SQL generation from the rule's stored type/column/params.
# ═══════════════════════════════════════════════════════════════════════════════

_SAFE_IDENT_RE = re.compile(r'^[a-zA-Z_][a-zA-Z0-9_]*$')

def _safe_ident(name: str) -> str:
    """Reject anything that isn't a plain identifier — defence in depth,
    since rule column names originate from LLM output stored in SQLite,
    not directly from user input, but should never be trusted blindly
    when being spliced into SQL text."""
    if not _SAFE_IDENT_RE.match(name or ""):
        raise ValueError(f"Unsafe column identifier: {name!r}")
    return name


def _build_dq_check_sql(rule: Dict, base_select: str) -> Optional[str]:
    """
    Given one DQ rule and the base 'SELECT * FROM aggregated'-style query,
    build a single query that returns (total_rows, violation_count) for
    that rule. Returns None for unsupported rule types.
    """
    try:
        col = _safe_ident(rule["column"])
    except ValueError:
        return None

    rule_type = rule.get("rule", "")
    params    = rule.get("params") or {}

    if rule_type == "not_null":
        condition = f'"{col}" IS NULL'
        return (
            f"SELECT COUNT(*) AS total_rows, "
            f"COUNT(*) FILTER (WHERE {condition}) AS violations "
            f"FROM ({base_select}) dq_t"
        )

    if rule_type == "uniqueness":
        return (
            f"SELECT COUNT(*) AS total_rows, "
            f'(COUNT(*) - COUNT(DISTINCT "{col}")) AS violations '
            f"FROM ({base_select}) dq_t"
        )

    if rule_type == "range_bounds":
        lo = params.get("min")
        hi = params.get("max")
        conditions = []
        if lo is not None:
            conditions.append(f'"{col}" < {float(lo)}')
        if hi is not None:
            conditions.append(f'"{col}" > {float(hi)}')
        if not conditions:
            return None
        condition = " OR ".join(conditions)
        return (
            f"SELECT COUNT(*) AS total_rows, "
            f"COUNT(*) FILTER (WHERE {condition}) AS violations "
            f"FROM ({base_select}) dq_t"
        )

    if rule_type == "pattern_consistency":
        pattern = params.get("pattern")
        if not pattern:
            return None
        # Escape single quotes in the pattern to prevent breaking out of the literal
        safe_pattern = str(pattern).replace("'", "''")
        condition = f'"{col}" IS NOT NULL AND "{col}" !~ \'{safe_pattern}\''
        return (
            f"SELECT COUNT(*) AS total_rows, "
            f"COUNT(*) FILTER (WHERE {condition}) AS violations "
            f"FROM ({base_select}) dq_t"
        )

    return None  # unsupported rule type — skip rather than guess


def run_dq_checks(
    nodes: List[Dict],
    dq_rules: List[Dict],
    source_db_url: str,
    node_configs: Dict[str, str] = {},
) -> List[Dict]:
    """
    Execute every ENABLED DQ rule as a real query against the pipeline's
    'aggregated' CTE output.

    IMPORTANT: this deliberately does NOT pre-probe the aggregated output's
    columns before deciding whether a rule is "checkable". An earlier version
    did that as a courtesy filter, but a probe query can fail for reasons
    completely unrelated to whether the rule's own column exists (a stray
    dialect quirk, a transient connection issue, anything) — and when it
    failed, the whole batch silently returned an empty result set, which the
    UI then displayed as a calm "nothing was checkable" message. That made a
    genuine backend failure indistinguishable from "there's legitimately
    nothing to check," which is exactly the kind of silent failure this
    system is built to avoid everywhere else.

    Instead, every enabled rule is attempted directly. If a rule's column
    genuinely doesn't exist, THAT SPECIFIC rule's result carries the real
    Postgres error message (e.g. "column middlename does not exist") so the
    user sees precisely what's wrong, rule by rule, instead of one vague
    blanket message for the whole check.
    """
    from sqlalchemy import create_engine, text

    ordered = sorted(nodes, key=lambda n: n.get("node_order", 0))
    cte_parts: List[Tuple[str, str]] = []
    for n in ordered:
        cn = n.get("cte_name")
        if not cn:
            continue
        sql = (node_configs.get(n["node_id"]) or n.get("sql_final") or n.get("sql_draft", "")).strip()
        if sql.startswith("--") or not sql:
            continue
        sql, _ = normalize_sql_dialect(sql)
        cte_parts.append((cn, sql))

    if not cte_parts:
        return []

    cte_sql   = ",\n".join(f"  {name} AS (\n    {sql}\n  )" for name, sql in cte_parts)
    last_name = cte_parts[-1][0]
    base_select = f"WITH\n{cte_sql}\nSELECT * FROM {last_name}"

    engine = create_engine(source_db_url, pool_pre_ping=True)
    results: List[Dict] = []

    for idx, rule in enumerate(dq_rules):
        if not rule.get("enabled", True):
            continue  # user explicitly disabled this rule — skip entirely

        check_sql = _build_dq_check_sql(rule, base_select)
        if not check_sql:
            # Unsupported rule type, or a range_bounds/pattern_consistency
            # rule saved without the required params — report this clearly
            # rather than silently dropping it from the results.
            results.append({
                "rule_index":      idx,
                "node_id":         rule.get("node_id", ""),
                "column":          rule.get("column", ""),
                "rule":            rule.get("rule", ""),
                "severity":        rule.get("severity", "warn"),
                "passed":          False,
                "violation_count": 0,
                "checked_rows":    0,
                "error":           "Rule type not supported, or required params (min/max/pattern) are missing.",
            })
            continue

        try:
            with engine.connect() as conn:
                row = conn.execute(text(check_sql)).fetchone()
            total_rows  = int(row[0]) if row else 0
            violations  = int(row[1]) if row else 0
            results.append({
                "rule_index":      idx,
                "node_id":         rule.get("node_id", ""),
                "column":          rule.get("column", ""),
                "rule":            rule.get("rule", ""),
                "severity":        rule.get("severity", "warn"),
                "passed":          violations == 0,
                "violation_count": violations,
                "checked_rows":    total_rows,
                "error":           None,
            })
        except Exception as e:
            results.append({
                "rule_index":      idx,
                "node_id":         rule.get("node_id", ""),
                "column":          rule.get("column", ""),
                "rule":            rule.get("rule", ""),
                "severity":        rule.get("severity", "warn"),
                "passed":          False,
                "violation_count": 0,
                "checked_rows":    0,
                "error":           str(e),
            })

    engine.dispose()
    return results
