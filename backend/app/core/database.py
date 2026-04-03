"""
Database layer — Cloudflare D1 in production, local SQLite in development.

In production (Railway): uses D1 REST API when CF credentials are set.
In development (local):  falls back to local SQLite via aiosqlite.

All public methods are identical regardless of backend — nothing else needs
to know which one is in use.

Usage:
    db = Database()
    await db.connect()
    vendor = await db.get_vendor_rule_by_name("Telus Business")
    await db.close()
"""

import json
import logging
import os
from typing import Optional

import httpx

from app.models.invoice import Invoice, InvoiceStatus
from app.models.vendor import VendorRule, VendorType

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

LOCAL_DB_PATH = os.environ.get("DB_PATH", "local.db")
SCHEMA_PATH   = os.path.join(os.path.dirname(__file__), "../../infrastructure/schema.sql")

CF_D1_URL = (
    "https://api.cloudflare.com/client/v4/accounts/{account_id}"
    "/d1/database/{db_id}/query"
)


def _d1_configured() -> bool:
    return bool(
        os.environ.get("CF_ACCOUNT_ID")
        and os.environ.get("CF_D1_DATABASE_ID")
        and os.environ.get("CF_API_TOKEN")
    )


# ── D1 backend ────────────────────────────────────────────────────────────────

class _D1Backend:
    """Executes SQL against Cloudflare D1 via REST API."""

    def __init__(self):
        account_id = os.environ["CF_ACCOUNT_ID"]
        db_id      = os.environ["CF_D1_DATABASE_ID"]
        self._url  = CF_D1_URL.format(account_id=account_id, db_id=db_id)
        self._token = os.environ["CF_API_TOKEN"]
        self._http  = httpx.AsyncClient(timeout=30.0)

    async def connect(self):
        await self._ensure_schema()
        logger.info("D1 database connected")

    async def close(self):
        await self._http.aclose()

    async def _run(self, sql: str, params: list = None) -> dict:
        """Execute one SQL statement. Returns the full result block."""
        resp = await self._http.post(
            self._url,
            headers={"Authorization": f"Bearer {self._token}"},
            json={"sql": sql, "params": params or []},
        )
        if not resp.is_success:
            # Demote "duplicate column" errors to debug — these are expected
            # on every startup when ALTER TABLE migrations have already run
            body = resp.text[:500]
            if "duplicate column" in body.lower():
                logger.debug(f"D1 migration already applied (skipping): {body[:120]}")
            else:
                logger.warning(f"D1 HTTP {resp.status_code} — body: {body}")
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            errors = data.get("errors", [])
            raise RuntimeError(f"D1 query failed: {errors}")
        return data["result"][0]

    async def query(self, sql: str, params: list = None) -> list[dict]:
        """SELECT — returns list of row dicts."""
        result = await self._run(sql, params)
        return result.get("results", [])

    async def execute(self, sql: str, params: list = None) -> int:
        """INSERT/UPDATE/DELETE — returns last_row_id (0 if not applicable)."""
        result = await self._run(sql, params)
        return result.get("meta", {}).get("last_row_id", 0)

    async def _ensure_schema(self):
        """Run CREATE TABLE IF NOT EXISTS for every table in schema.sql."""
        schema_path = os.path.abspath(SCHEMA_PATH)
        if not os.path.exists(schema_path):
            logger.warning(f"Schema file not found at {schema_path}")
            return
        with open(schema_path, "r") as f:
            schema = f.read()
        # Split on semicolons and run each non-empty statement individually
        statements = [s.strip() for s in schema.split(";") if s.strip()]
        for stmt in statements:
            # Strip leading SQL comment lines to find the real statement type
            code = "\n".join(
                line for line in stmt.splitlines()
                if not line.strip().startswith("--")
            ).strip().upper()
            if code.startswith(("CREATE TABLE", "CREATE INDEX")):
                try:
                    await self._run(stmt)
                except Exception as e:
                    logger.debug(f"Schema stmt skipped: {e}")
            elif code.startswith("ALTER TABLE"):
                # Migrations — safe to run every time; ignore "already exists" errors
                try:
                    await self._run(stmt)
                    logger.info(f"Migration applied: {stmt[:60]}")
                except Exception as e:
                    logger.debug(f"Migration skipped (already applied): {e}")
        logger.info("D1 schema ensured")


# ── SQLite backend (local dev fallback) ───────────────────────────────────────

class _SQLiteBackend:
    """Executes SQL against a local SQLite file via aiosqlite."""

    def __init__(self):
        self._db = None

    async def connect(self):
        import aiosqlite
        os.makedirs(os.path.dirname(os.path.abspath(LOCAL_DB_PATH)), exist_ok=True)
        db_exists = os.path.exists(LOCAL_DB_PATH)
        self._db = await aiosqlite.connect(LOCAL_DB_PATH)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA foreign_keys = ON")
        if not db_exists:
            await self._apply_schema()
        logger.info(f"SQLite database connected — {LOCAL_DB_PATH}")

    async def close(self):
        if self._db:
            await self._db.close()

    async def _apply_schema(self):
        schema_path = os.path.abspath(SCHEMA_PATH)
        if not os.path.exists(schema_path):
            return
        with open(schema_path, "r") as f:
            schema = f.read()
        statements = [s.strip() for s in schema.split(";") if s.strip()]
        for stmt in statements:
            # Strip leading SQL comment lines to find the real statement type
            code = "\n".join(
                line for line in stmt.splitlines()
                if not line.strip().startswith("--")
            ).strip().upper()
            if code.startswith(("CREATE TABLE", "CREATE INDEX")):
                await self._db.execute(stmt)
            elif code.startswith("ALTER TABLE"):
                # Migration — ignore if column already exists
                try:
                    await self._db.execute(stmt)
                except Exception as e:
                    logger.debug(f"SQLite migration skipped (already applied): {e}")
            # Skip INSERT seed data — seeded from CSV on startup
        await self._db.commit()

    async def query(self, sql: str, params: list = None) -> list[dict]:
        async with self._db.execute(sql, params or []) as cursor:
            rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def execute(self, sql: str, params: list = None) -> int:
        cursor = await self._db.execute(sql, params or [])
        await self._db.commit()
        return cursor.lastrowid or 0


# ── Public Database class ─────────────────────────────────────────────────────

class Database:
    """
    Public database interface. Delegates to D1 in production, SQLite in dev.
    The _db attribute is kept for legacy compatibility checks (is not None = connected).
    """

    def __init__(self):
        self._backend: Optional[_D1Backend | _SQLiteBackend] = None
        self._db = None  # legacy compat — set to True when connected

    async def connect(self):
        if _d1_configured():
            logger.warning("DATABASE: Using Cloudflare D1")
            self._backend = _D1Backend()
        else:
            logger.warning("DATABASE: D1 not configured — using local SQLite (data will not persist)")
            self._backend = _SQLiteBackend()
        await self._backend.connect()
        self._db = True

    async def close(self):
        if self._backend:
            await self._backend.close()
        self._db = None

    async def _q(self, sql: str, params: list = None) -> list[dict]:
        return await self._backend.query(sql, params)

    async def _x(self, sql: str, params: list = None) -> int:
        return await self._backend.execute(sql, params)

    # ── Vendor rules ──────────────────────────────────────────────────────────

    async def get_vendor_rule_by_name(self, vendor_name: str) -> Optional[VendorRule]:
        """
        Exact match first (case-insensitive), then fuzzy match —
        checks if any rule name is contained within the extracted vendor name.
        """
        rows = await self._q(
            "SELECT * FROM vendor_rules WHERE LOWER(vendor_name) = LOWER(?) AND active = 1",
            [vendor_name],
        )
        row = rows[0] if rows else None

        if not row:
            all_rules = await self._q(
                "SELECT * FROM vendor_rules WHERE active = 1 ORDER BY LENGTH(vendor_name) DESC"
            )
            vendor_lower = vendor_name.lower()

            # ── Tier 0: match_keyword override ────────────────────────────────
            # Most reliable — user explicitly defined the keyword to look for
            for r in all_rules:
                kw = (r.get("match_keyword") or "").strip().lower()
                if kw and kw in vendor_lower:
                    row = r
                    logger.info(f"Keyword vendor match: '{vendor_name}' → '{r['vendor_name']}' (keyword: '{kw}')")
                    break

            if not row:
                # Strip common legal suffixes that add noise
                _noise = (" inc", " inc.", " ltd", " ltd.", " llc", " corp",
                          " co.", " co,", " company", " of canada", " canada")
                vendor_stripped = vendor_lower
                for n in _noise:
                    vendor_stripped = vendor_stripped.replace(n, "")
                vendor_stripped = vendor_stripped.strip()

                for r in all_rules:
                    rule_lower = r["vendor_name"].lower()
                    rule_stripped = rule_lower
                    for n in _noise:
                        rule_stripped = rule_stripped.replace(n, "")
                    rule_stripped = rule_stripped.strip()

                    # 1. Bidirectional full-string contains
                    if rule_lower in vendor_lower or vendor_lower in rule_lower:
                        row = r
                        logger.info(f"Fuzzy vendor match (contains): '{vendor_name}' → '{r['vendor_name']}'")
                        break
                    # 2. Strip legal suffixes and try again
                    if rule_stripped and (rule_stripped in vendor_stripped or vendor_stripped in rule_stripped):
                        row = r
                        logger.info(f"Fuzzy vendor match (stripped): '{vendor_name}' → '{r['vendor_name']}'")
                        break
                    # 3. First significant word match (min 5 chars to avoid false positives)
                    rule_words = [w for w in rule_stripped.split() if len(w) >= 5]
                    vendor_words = [w for w in vendor_stripped.split() if len(w) >= 5]
                    if rule_words and vendor_words and rule_words[0] == vendor_words[0]:
                        row = r
                        logger.info(f"Fuzzy vendor match (first word): '{vendor_name}' → '{r['vendor_name']}'")
                        break

        if not row:
            return None
        return self._row_to_vendor_rule(row)

    async def get_all_vendor_rules(self) -> list[VendorRule]:
        rows = await self._q("SELECT * FROM vendor_rules ORDER BY vendor_name")
        return [self._row_to_vendor_rule(r) for r in rows]

    async def create_vendor_rule(
        self,
        vendor_name: str,
        vendor_type: str,
        default_gl_account: Optional[str] = None,
        default_gl_name: Optional[str] = None,
        vendor_id_aspire: Optional[str] = None,
        vendor_id_qbo: Optional[str] = None,
        notes: Optional[str] = None,
        forward_to: Optional[str] = None,
        match_keyword: Optional[str] = None,
        is_employee: bool = False,
    ) -> int:
        return await self._x(
            """INSERT INTO vendor_rules
               (vendor_name, type, default_gl_account, default_gl_name,
                vendor_id_aspire, vendor_id_qbo, notes, forward_to, match_keyword, is_employee)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [vendor_name, vendor_type, default_gl_account, default_gl_name,
             vendor_id_aspire, vendor_id_qbo, notes, forward_to, match_keyword, int(is_employee)],
        )

    async def get_employees(self) -> list[str]:
        rows = await self._q(
            """SELECT vendor_name FROM vendor_rules
               WHERE active = 1
               AND (is_employee = 1
                    OR LOWER(vendor_name) LIKE '%expense%'
                    OR LOWER(vendor_name) LIKE '%expenses%')
               ORDER BY vendor_name"""
        )
        return [r["vendor_name"] for r in rows]

    async def update_vendor_rule(self, vendor_id: int, updates: dict) -> None:
        # D1 stores booleans as JSON true/false which doesn't match integer comparisons.
        # Convert is_employee and active to int explicitly.
        if "is_employee" in updates and isinstance(updates["is_employee"], bool):
            updates["is_employee"] = int(updates["is_employee"])
        if "active" in updates and isinstance(updates["active"], bool):
            updates["active"] = int(updates["active"])
        fields = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [vendor_id]
        await self._x(
            f"UPDATE vendor_rules SET {fields}, updated_at = datetime('now') WHERE id = ?",
            values,
        )

    # ── Invoice CRUD ──────────────────────────────────────────────────────────

    async def create_invoice(
        self,
        vendor_name: str,
        invoice_number: Optional[str],
        invoice_date: Optional[str],
        due_date: Optional[str],
        subtotal: Optional[float],
        tax_amount: Optional[float],
        total_amount: float,
        currency: str,
        po_number: Optional[str],
        pdf_filename: Optional[str],
        intake_source: str,
        intake_raw: dict,
        doc_type: Optional[str] = None,
    ) -> int:
        invoice_id = await self._x(
            """INSERT INTO invoices
               (vendor_name, invoice_number, invoice_date, due_date,
                subtotal, tax_amount, total_amount, currency,
                po_number, pdf_filename, intake_source, intake_raw, status, doc_type)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)""",
            [vendor_name, invoice_number, invoice_date, due_date,
             subtotal, tax_amount, total_amount, currency,
             po_number, pdf_filename, intake_source, json.dumps(intake_raw), doc_type],
        )
        await self.audit(invoice_id, "received", "system", {"source": intake_source})
        return invoice_id

    async def find_duplicate_invoice(
        self, vendor_name: str, invoice_number: str
    ) -> Optional[dict]:
        rows = await self._q(
            """SELECT id, status, qbo_bill_id, aspire_receipt_id, received_at
               FROM invoices
               WHERE LOWER(vendor_name) = LOWER(?)
               AND invoice_number = ?
               AND status IN ('posted', 'queued', 'pending')
               ORDER BY received_at DESC
               LIMIT 1""",
            [vendor_name, invoice_number],
        )
        return rows[0] if rows else None

    async def find_duplicate_by_vendor_amount(
        self, vendor_name: str, total_amount: float
    ) -> Optional[dict]:
        """Fallback duplicate check for invoices with no invoice number.
        Matches vendor + amount received within the last 24 hours."""
        rows = await self._q(
            """SELECT id, status, qbo_bill_id, aspire_receipt_id, received_at
               FROM invoices
               WHERE LOWER(vendor_name) = LOWER(?)
               AND total_amount = ?
               AND (invoice_number IS NULL OR invoice_number = '')
               AND status IN ('posted', 'queued', 'pending')
               AND received_at >= datetime('now', '-24 hours')
               ORDER BY received_at DESC
               LIMIT 1""",
            [vendor_name, total_amount],
        )
        return rows[0] if rows else None

    async def get_invoice(self, invoice_id: int) -> Optional[dict]:
        rows = await self._q("SELECT * FROM invoices WHERE id = ?", [invoice_id])
        return rows[0] if rows else None

    async def list_invoices(
        self,
        status: Optional[str] = None,
        destination: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        conditions, params = [], []
        if status:
            conditions.append("status = ?")
            params.append(status)
        if destination:
            conditions.append("destination = ?")
            params.append(destination)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        params += [limit, offset]
        return await self._q(
            f"SELECT * FROM invoices {where} ORDER BY received_at DESC LIMIT ? OFFSET ?",
            params,
        )

    async def get_queue_counts(self) -> dict:
        rows = await self._q(
            """SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) as queued,
                SUM(CASE WHEN status='posted' AND date(received_at)=date('now') THEN 1 ELSE 0 END) as posted,
                SUM(CASE WHEN status='error'  THEN 1 ELSE 0 END) as errors,
                SUM(CASE WHEN destination='aspire' AND status='posted' THEN 1 ELSE 0 END) as aspire,
                SUM(CASE WHEN destination='qbo'    AND status='posted' THEN 1 ELSE 0 END) as qbo,
                SUM(CASE WHEN status='queued' THEN total_amount ELSE 0 END) as queued_value,
                SUM(CASE WHEN status='posted' AND date(received_at)=date('now') THEN total_amount ELSE 0 END) as posted_today_value
               FROM invoices
               WHERE (archived IS NULL OR archived = 0)"""
        )
        return rows[0] if rows else {}

    # ── Invoice status transitions ────────────────────────────────────────────

    async def mark_queued(self, invoice_id: int, reason: str) -> None:
        await self._x(
            """UPDATE invoices
               SET status='queued', queued_at=datetime('now'), error_message=?
               WHERE id=?""",
            [reason, invoice_id],
        )

    async def mark_posted_aspire(self, invoice_id: int, receipt_id: str, aspire_po_id: str) -> None:
        await self._x(
            """UPDATE invoices
               SET status='posted', destination='aspire',
                   aspire_receipt_id=?, po_aspire_id=?,
                   posted_at=datetime('now'), error_message=NULL
               WHERE id=?""",
            [receipt_id, aspire_po_id, invoice_id],
        )

    async def mark_posted_qbo(
        self, invoice_id: int, bill_id: str, gl_account: str,
        gl_name: Optional[str] = None, qbo_amount: Optional[float] = None
    ) -> None:
        await self._x(
            """UPDATE invoices
               SET status='posted', destination='qbo',
                   qbo_bill_id=?, gl_account=?, gl_name=?, qbo_amount=?,
                   posted_at=datetime('now'), error_message=NULL
               WHERE id=?""",
            [bill_id, gl_account, gl_name, qbo_amount, invoice_id],
        )

    async def mark_error(self, invoice_id: int, error_message: str) -> None:
        await self._x(
            "UPDATE invoices SET status='error', error_message=? WHERE id=?",
            [error_message, invoice_id],
        )

    async def apply_po_override(self, invoice_id: int, po_number: str, reviewed_by: str) -> None:
        await self._x(
            """UPDATE invoices
               SET po_number_override=?, reviewed_by=?, reviewed_at=datetime('now')
               WHERE id=?""",
            [po_number, reviewed_by, invoice_id],
        )
        await self.audit(invoice_id, "po_override", reviewed_by, {"po_number": po_number})

    # ── Audit log ─────────────────────────────────────────────────────────────

    async def audit(
        self,
        invoice_id: Optional[int],
        action: str,
        actor: str,
        detail: Optional[dict] = None,
    ) -> None:
        await self._x(
            "INSERT INTO audit_log (invoice_id, action, actor, detail) VALUES (?, ?, ?, ?)",
            [invoice_id, action, actor, json.dumps(detail or {})],
        )

    async def get_audit_log(self, invoice_id: Optional[int] = None, limit: int = 100) -> list[dict]:
        if invoice_id:
            return await self._q(
                "SELECT * FROM audit_log WHERE invoice_id=? ORDER BY created_at DESC LIMIT ?",
                [invoice_id, limit],
            )
        return await self._q(
            "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?",
            [limit],
        )

    # ── PO cache ──────────────────────────────────────────────────────────────

    async def get_cached_po(self, po_number: str) -> Optional[dict]:
        rows = await self._q(
            """SELECT aspire_data FROM po_cache
               WHERE po_number=? AND fetched_at > datetime('now', '-1 hour')""",
            [po_number],
        )
        if not rows:
            return None
        return json.loads(rows[0]["aspire_data"])

    async def cache_po(self, po_number: str, aspire_data: dict) -> None:
        await self._x(
            """INSERT OR REPLACE INTO po_cache (po_number, aspire_data, fetched_at)
               VALUES (?, ?, datetime('now'))""",
            [po_number, json.dumps(aspire_data)],
        )

    async def get_invoice_feed(self, limit: int = 100) -> list[dict]:
        """Return recent active (non-archived) invoices for the AP live feed, newest first."""
        return await self._q(
            """SELECT id, status, destination, vendor_name,
                      invoice_number, total_amount, tax_amount, subtotal,
                      gl_account, gl_name, qbo_amount,
                      qbo_bill_id, aspire_receipt_id,
                      received_at, posted_at, error_message,
                      intake_source, archived, forwarded_to, pdf_r2_key, doc_type
               FROM invoices
               WHERE (archived IS NULL OR archived = 0)
               ORDER BY received_at DESC
               LIMIT ?""",
            [limit],
        )

    async def get_archived_feed(self, limit: int = 200) -> list[dict]:
        """Return archived invoices, newest first."""
        return await self._q(
            """SELECT id, status, destination, vendor_name,
                      invoice_number, total_amount, tax_amount, subtotal,
                      gl_account, gl_name, qbo_amount,
                      qbo_bill_id, aspire_receipt_id,
                      received_at, posted_at, error_message,
                      intake_source, archived, forwarded_to, pdf_r2_key, doc_type
               FROM invoices
               WHERE archived = 1
               ORDER BY received_at DESC
               LIMIT ?""",
            [limit],
        )

    async def archive_unknown_invoices(self) -> int:
        """Bulk archive all invoices with no vendor name (junk records)."""
        rows = await self._q(
            "SELECT id FROM invoices WHERE (vendor_name IS NULL OR vendor_name = '') AND archived = 0"
        )
        ids = [r["id"] for r in rows]
        if ids:
            placeholders = ",".join("?" * len(ids))
            await self._x(
                f"UPDATE invoices SET archived = 1 WHERE id IN ({placeholders})", ids
            )
        return len(ids)

    async def archive_invoice(self, invoice_id: int) -> None:
        """Mark an invoice as archived (hidden from main feed)."""
        await self._x(
            "UPDATE invoices SET archived = 1 WHERE id = ?",
            [invoice_id],
        )

    async def unarchive_invoice(self, invoice_id: int) -> None:
        """Restore an archived invoice to the main feed."""
        await self._x(
            "UPDATE invoices SET archived = 0 WHERE id = ?",
            [invoice_id],
        )

    # ── Reconciliation ────────────────────────────────────────────────────────

    async def get_or_create_period(self, period: str, label: str) -> dict:
        """Get or create a reconciliation period (e.g. '2026-03', 'March 2026')."""
        rows = await self._q("SELECT * FROM reconciliation_periods WHERE period = ?", [period])
        if rows:
            return rows[0]
        row_id = await self._x(
            "INSERT INTO reconciliation_periods (period, label) VALUES (?, ?)",
            [period, label],
        )
        return {"id": row_id, "period": period, "label": label, "status": "open"}

    async def list_periods(self) -> list[dict]:
        return await self._q("SELECT * FROM reconciliation_periods ORDER BY period DESC")

    async def get_period(self, period: str) -> Optional[dict]:
        rows = await self._q("SELECT * FROM reconciliation_periods WHERE period = ?", [period])
        return rows[0] if rows else None

    async def close_period(self, period: str) -> None:
        await self._x(
            "UPDATE reconciliation_periods SET status = 'closed', closed_at = datetime('now') WHERE period = ?",
            [period],
        )

    async def create_vendor_statement(
        self,
        period_id: int,
        vendor_name: str,
        statement_date: Optional[str],
        closing_balance: Optional[float],
        currency: str,
        aging: dict,
        pdf_filename: Optional[str],
        intake_source: str = "upload",
    ) -> int:
        return await self._x(
            """INSERT INTO vendor_statements
               (period_id, vendor_name, statement_date, closing_balance, currency,
                aging_current, aging_1_30, aging_31_60, aging_61_90, aging_over_90,
                pdf_filename, intake_source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                period_id, vendor_name, statement_date, closing_balance, currency,
                aging.get("current", 0), aging.get("days_1_30", 0),
                aging.get("days_31_60", 0), aging.get("days_61_90", 0),
                aging.get("over_90", 0), pdf_filename, intake_source,
            ],
        )

    async def create_statement_lines(self, statement_id: int, lines: list[dict]) -> None:
        for line in lines:
            await self._x(
                """INSERT INTO statement_lines
                   (statement_id, line_date, invoice_number, raw_description, amount, running_balance)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                [
                    statement_id,
                    line.get("line_date"),
                    line.get("invoice_number"),
                    line.get("raw_description"),
                    line.get("amount"),
                    line.get("running_balance"),
                ],
            )

    async def get_statements_for_period(self, period_id: int) -> list[dict]:
        return await self._q(
            "SELECT * FROM vendor_statements WHERE period_id = ? ORDER BY vendor_name",
            [period_id],
        )

    async def get_statement(self, statement_id: int) -> Optional[dict]:
        rows = await self._q("SELECT * FROM vendor_statements WHERE id = ?", [statement_id])
        return rows[0] if rows else None

    async def get_statement_lines(self, statement_id: int) -> list[dict]:
        return await self._q(
            "SELECT * FROM statement_lines WHERE statement_id = ? ORDER BY line_date, id",
            [statement_id],
        )

    async def mark_forwarded(self, invoice_id: int, forwarded_to: str) -> None:
        """Record that a job-cost invoice was emailed to a recipient for manual processing."""
        await self._x(
            "UPDATE invoices SET forwarded_to = ? WHERE id = ?",
            [forwarded_to, invoice_id],
        )

    async def save_invoice_r2_key(self, invoice_id: int, r2_key: str) -> None:
        await self._x(
            "UPDATE invoices SET pdf_r2_key = ? WHERE id = ?",
            [r2_key, invoice_id],
        )

    async def save_pdf_r2_key(self, statement_id: int, r2_key: str) -> None:
        await self._x(
            "UPDATE vendor_statements SET pdf_r2_key = ? WHERE id = ?",
            [r2_key, statement_id],
        )

    async def save_qbo_snapshot(self, statement_id: int, snapshot: dict) -> None:
        await self._x(
            "UPDATE vendor_statements SET qbo_snapshot = ? WHERE id = ?",
            [json.dumps(snapshot), statement_id],
        )

    async def delete_statement(self, statement_id: int) -> None:
        await self._x("DELETE FROM statement_lines WHERE statement_id = ?", [statement_id])
        await self._x("DELETE FROM vendor_statements WHERE id = ?", [statement_id])

    # ── Vendor QBO links ──────────────────────────────────────────────────────

    async def get_vendor_qbo_link(self, statement_name: str) -> Optional[dict]:
        rows = await self._q(
            "SELECT * FROM vendor_qbo_links WHERE LOWER(statement_name) = LOWER(?)",
            [statement_name],
        )
        return rows[0] if rows else None

    async def save_vendor_qbo_link(self, statement_name: str, qbo_vendor_id: str, qbo_vendor_name: str) -> None:
        await self._x(
            """INSERT INTO vendor_qbo_links (statement_name, qbo_vendor_id, qbo_vendor_name)
               VALUES (?, ?, ?)
               ON CONFLICT(statement_name) DO UPDATE SET
                 qbo_vendor_id = excluded.qbo_vendor_id,
                 qbo_vendor_name = excluded.qbo_vendor_name""",
            [statement_name, qbo_vendor_id, qbo_vendor_name],
        )

    async def delete_vendor_qbo_link(self, statement_name: str) -> None:
        await self._x(
            "DELETE FROM vendor_qbo_links WHERE LOWER(statement_name) = LOWER(?)",
            [statement_name],
        )

    async def cleanup_sibling_errors(
        self, current_invoice_id: int, vendor_name: str, invoice_number: Optional[str]
    ) -> int:
        """
        After a successful retry, delete other error rows for the same
        vendor + invoice number so the log doesn't show stale failures.
        Returns the number of rows deleted.
        """
        if not vendor_name or not invoice_number:
            return 0
        # Delete audit trail for siblings first
        sibling_rows = await self._q(
            """SELECT id FROM invoices
               WHERE LOWER(vendor_name) = LOWER(?)
               AND invoice_number = ?
               AND status = 'error'
               AND id != ?""",
            [vendor_name, invoice_number, current_invoice_id],
        )
        for r in sibling_rows:
            await self._x("DELETE FROM audit_log WHERE invoice_id = ?", [r["id"]])
            await self._x("DELETE FROM invoice_line_items WHERE invoice_id = ?", [r["id"]])
        deleted = await self._x(
            """DELETE FROM invoices
               WHERE LOWER(vendor_name) = LOWER(?)
               AND invoice_number = ?
               AND status = 'error'
               AND id != ?""",
            [vendor_name, invoice_number, current_invoice_id],
        )
        return len(sibling_rows)

    async def delete_invoice(self, invoice_id: int) -> bool:
        await self._x("DELETE FROM audit_log WHERE invoice_id=?", [invoice_id])
        await self._x("DELETE FROM invoice_line_items WHERE invoice_id=?", [invoice_id])
        changes = await self._x("DELETE FROM invoices WHERE id=?", [invoice_id])
        return changes > 0

    # ── Helper ────────────────────────────────────────────────────────────────

    @staticmethod
    def _row_to_vendor_rule(r: dict) -> VendorRule:
        return VendorRule(
            id=r["id"],
            vendor_name=r["vendor_name"],
            vendor_id_aspire=r.get("vendor_id_aspire"),
            vendor_id_qbo=r.get("vendor_id_qbo"),
            type=VendorType(r["type"]),
            default_gl_account=r.get("default_gl_account"),
            default_gl_name=r.get("default_gl_name"),
            forward_to=r.get("forward_to"),
            match_keyword=r.get("match_keyword"),
            notes=r.get("notes"),
            is_employee=bool(r.get("is_employee", 0)),
            active=bool(r.get("active", 1)),
        )
