"""
Database layer — wraps Cloudflare D1 (SQLite) queries.

For local development, uses a local SQLite file (local.db) via aiosqlite.
In production on Cloudflare, the D1 binding is used instead.

Usage:
    db = Database()
    await db.connect()
    vendor = await db.get_vendor_rule_by_name("Telus Business")
    await db.close()
"""

import json
import logging
import os
import sqlite3
from typing import Optional

import aiosqlite

from app.models.invoice import Invoice, InvoiceStatus
from app.models.vendor import VendorRule, VendorType

logger = logging.getLogger(__name__)

LOCAL_DB_PATH = "local.db"
SCHEMA_PATH   = os.path.join(os.path.dirname(__file__), "../../../infrastructure/schema.sql")


class Database:
    def __init__(self):
        self._db: Optional[aiosqlite.Connection] = None

    async def connect(self):
        """Open the local SQLite database, creating and seeding it if needed."""
        db_exists = os.path.exists(LOCAL_DB_PATH)
        self._db = await aiosqlite.connect(LOCAL_DB_PATH)
        self._db.row_factory = aiosqlite.Row

        # Enable foreign keys
        await self._db.execute("PRAGMA foreign_keys = ON")

        if not db_exists:
            logger.info("Creating local database from schema.sql")
            await self._apply_schema()

        logger.info(f"Database connected — {LOCAL_DB_PATH}")

    async def _apply_schema(self):
        """Apply schema.sql to the local database."""
        schema_path = os.path.abspath(SCHEMA_PATH)
        if not os.path.exists(schema_path):
            logger.warning(f"Schema file not found at {schema_path} — skipping")
            return
        with open(schema_path, "r") as f:
            schema = f.read()
        await self._db.executescript(schema)
        await self._db.commit()
        logger.info("Schema applied successfully")

    async def close(self):
        if self._db:
            await self._db.close()

    # ── Vendor rules ──────────────────────────────────────────────────────────

    async def get_vendor_rule_by_name(self, vendor_name: str) -> Optional[VendorRule]:
        """
        Look up a vendor rule by name.
        First tries exact match (case-insensitive),
        then falls back to fuzzy match — checks if any rule name
        is contained within the extracted vendor name.
        This handles cases where Claude extracts a longer name like
        "James Tirecraft, Traction, Truck Pro" when the rule is "James Tirecraft".
        """
        # Exact match first
        async with self._db.execute(
            "SELECT * FROM vendor_rules WHERE LOWER(vendor_name) = LOWER(?) AND active = 1",
            (vendor_name,),
        ) as cursor:
            row = await cursor.fetchone()

        if not row:
            # Fuzzy match — check if any rule name is a substring of the extracted name
            async with self._db.execute(
                "SELECT * FROM vendor_rules WHERE active = 1 ORDER BY LENGTH(vendor_name) DESC",
            ) as cursor:
                all_rules = await cursor.fetchall()

            vendor_lower = vendor_name.lower()
            for rule_row in all_rules:
                if rule_row["vendor_name"].lower() in vendor_lower:
                    row = rule_row
                    logger.info(
                        f"Fuzzy vendor match: '{vendor_name}' matched rule '{rule_row['vendor_name']}'"
                    )
                    break

        if not row:
            return None

        return VendorRule(
            id=row["id"],
            vendor_name=row["vendor_name"],
            vendor_id_aspire=row["vendor_id_aspire"],
            vendor_id_qbo=row["vendor_id_qbo"],
            type=VendorType(row["type"]),
            default_gl_account=row["default_gl_account"],
            default_gl_name=row["default_gl_name"],
            notes=row["notes"],
            active=bool(row["active"]),
        )

    async def get_all_vendor_rules(self) -> list[VendorRule]:
        async with self._db.execute(
            "SELECT * FROM vendor_rules ORDER BY vendor_name"
        ) as cursor:
            rows = await cursor.fetchall()
        return [
            VendorRule(
                id=r["id"],
                vendor_name=r["vendor_name"],
                vendor_id_aspire=r["vendor_id_aspire"],
                vendor_id_qbo=r["vendor_id_qbo"],
                type=VendorType(r["type"]),
                default_gl_account=r["default_gl_account"],
                default_gl_name=r["default_gl_name"],
                notes=r["notes"],
                active=bool(r["active"]),
            )
            for r in rows
        ]

    async def create_vendor_rule(
        self,
        vendor_name: str,
        vendor_type: str,
        default_gl_account: Optional[str] = None,
        default_gl_name: Optional[str] = None,
        vendor_id_aspire: Optional[str] = None,
        vendor_id_qbo: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> int:
        cursor = await self._db.execute(
            """INSERT INTO vendor_rules
               (vendor_name, type, default_gl_account, default_gl_name,
                vendor_id_aspire, vendor_id_qbo, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (vendor_name, vendor_type, default_gl_account, default_gl_name,
             vendor_id_aspire, vendor_id_qbo, notes),
        )
        await self._db.commit()
        return cursor.lastrowid

    async def update_vendor_rule(self, vendor_id: int, updates: dict) -> None:
        fields = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [vendor_id]
        await self._db.execute(
            f"UPDATE vendor_rules SET {fields}, updated_at = datetime('now') WHERE id = ?",
            values,
        )
        await self._db.commit()

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
    ) -> int:
        cursor = await self._db.execute(
            """INSERT INTO invoices
               (vendor_name, invoice_number, invoice_date, due_date,
                subtotal, tax_amount, total_amount, currency,
                po_number, pdf_filename, intake_source, intake_raw, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')""",
            (vendor_name, invoice_number, invoice_date, due_date,
             subtotal, tax_amount, total_amount, currency,
             po_number, pdf_filename, intake_source, json.dumps(intake_raw)),
        )
        await self._db.commit()
        invoice_id = cursor.lastrowid
        await self.audit(invoice_id, "received", "system", {"source": intake_source})
        return invoice_id

    async def get_invoice(self, invoice_id: int) -> Optional[dict]:
        async with self._db.execute(
            "SELECT * FROM invoices WHERE id = ?", (invoice_id,)
        ) as cursor:
            row = await cursor.fetchone()
        if not row:
            return None
        return dict(row)

    async def list_invoices(
        self,
        status: Optional[str] = None,
        destination: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        conditions = []
        params = []
        if status:
            conditions.append("status = ?")
            params.append(status)
        if destination:
            conditions.append("destination = ?")
            params.append(destination)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        params += [limit, offset]
        async with self._db.execute(
            f"SELECT * FROM invoices {where} ORDER BY received_at DESC LIMIT ? OFFSET ?",
            params,
        ) as cursor:
            rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def get_queue_counts(self) -> dict:
        async with self._db.execute(
            """SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) as queued,
                SUM(CASE WHEN status='posted' THEN 1 ELSE 0 END) as posted,
                SUM(CASE WHEN status='error'  THEN 1 ELSE 0 END) as errors,
                SUM(CASE WHEN destination='aspire' AND status='posted' THEN 1 ELSE 0 END) as aspire,
                SUM(CASE WHEN destination='qbo'    AND status='posted' THEN 1 ELSE 0 END) as qbo,
                SUM(CASE WHEN status='queued' THEN total_amount ELSE 0 END) as queued_value,
                SUM(CASE WHEN status='posted' AND date(received_at)=date('now') THEN total_amount ELSE 0 END) as posted_today_value
               FROM invoices"""
        ) as cursor:
            row = await cursor.fetchone()
        return dict(row) if row else {}

    # ── Invoice status transitions ────────────────────────────────────────────

    async def mark_queued(self, invoice_id: int, reason: str) -> None:
        await self._db.execute(
            """UPDATE invoices
               SET status='queued', queued_at=datetime('now'),
                   error_message=?
               WHERE id=?""",
            (reason, invoice_id),
        )
        await self._db.commit()

    async def mark_posted_aspire(
        self, invoice_id: int, receipt_id: str, aspire_po_id: str
    ) -> None:
        await self._db.execute(
            """UPDATE invoices
               SET status='posted', destination='aspire',
                   aspire_receipt_id=?, po_aspire_id=?,
                   posted_at=datetime('now'), error_message=NULL
               WHERE id=?""",
            (receipt_id, aspire_po_id, invoice_id),
        )
        await self._db.commit()

    async def mark_posted_qbo(
        self, invoice_id: int, bill_id: str, gl_account: str
    ) -> None:
        await self._db.execute(
            """UPDATE invoices
               SET status='posted', destination='qbo',
                   qbo_bill_id=?, gl_account=?,
                   posted_at=datetime('now'), error_message=NULL
               WHERE id=?""",
            (bill_id, gl_account, invoice_id),
        )
        await self._db.commit()

    async def mark_error(self, invoice_id: int, error_message: str) -> None:
        await self._db.execute(
            "UPDATE invoices SET status='error', error_message=? WHERE id=?",
            (error_message, invoice_id),
        )
        await self._db.commit()

    async def apply_po_override(
        self, invoice_id: int, po_number: str, reviewed_by: str
    ) -> None:
        await self._db.execute(
            """UPDATE invoices
               SET po_number_override=?, reviewed_by=?,
                   reviewed_at=datetime('now')
               WHERE id=?""",
            (po_number, reviewed_by, invoice_id),
        )
        await self._db.commit()
        await self.audit(invoice_id, "po_override", reviewed_by, {"po_number": po_number})

    # ── Audit log ─────────────────────────────────────────────────────────────

    async def audit(
        self,
        invoice_id: Optional[int],
        action: str,
        actor: str,
        detail: Optional[dict] = None,
    ) -> None:
        await self._db.execute(
            """INSERT INTO audit_log (invoice_id, action, actor, detail)
               VALUES (?, ?, ?, ?)""",
            (invoice_id, action, actor, json.dumps(detail or {})),
        )
        await self._db.commit()

    async def get_audit_log(
        self, invoice_id: Optional[int] = None, limit: int = 100
    ) -> list[dict]:
        if invoice_id:
            async with self._db.execute(
                "SELECT * FROM audit_log WHERE invoice_id=? ORDER BY created_at DESC LIMIT ?",
                (invoice_id, limit),
            ) as cursor:
                rows = await cursor.fetchall()
        else:
            async with self._db.execute(
                "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ) as cursor:
                rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    # ── PO cache ──────────────────────────────────────────────────────────────

    async def get_cached_po(self, po_number: str) -> Optional[dict]:
        async with self._db.execute(
            """SELECT aspire_data FROM po_cache
               WHERE po_number=?
               AND fetched_at > datetime('now', '-1 hour')""",
            (po_number,),
        ) as cursor:
            row = await cursor.fetchone()
        if not row:
            return None
        return json.loads(row["aspire_data"])

    async def cache_po(self, po_number: str, aspire_data: dict) -> None:
        await self._db.execute(
            """INSERT OR REPLACE INTO po_cache (po_number, aspire_data, fetched_at)
               VALUES (?, ?, datetime('now'))""",
            (po_number, json.dumps(aspire_data)),
        )
        await self._db.commit()
