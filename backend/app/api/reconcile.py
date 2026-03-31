"""
Vendor Statement Reconciliation API

Endpoints:
  GET  /reconcile/periods                    — list all periods
  POST /reconcile/periods/{period}           — create or get a period (e.g. '2026-03')
  GET  /reconcile/periods/{period}/statements — list statements for a period
  POST /reconcile/periods/{period}/close      — freeze a period (snapshot QBO)
  POST /reconcile/upload                     — upload statement PDF → extract → store
  GET  /reconcile/statements/{id}            — get a statement + lines
  GET  /reconcile/statements/{id}/diff       — get live QBO diff (open periods) or snapshot (closed)
  DELETE /reconcile/statements/{id}          — delete a statement
"""

import base64
import json
import logging
from calendar import month_name
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.core.database import Database
from app.core.config import settings
from app.services.reconciliation import ReconciliationService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/reconcile", tags=["reconcile"])


def get_db():
    return Database()


def _period_label(period: str) -> str:
    """'2026-03' → 'March 2026'"""
    try:
        y, m = period.split("-")
        return f"{month_name[int(m)]} {y}"
    except Exception:
        return period


def _period_date_range(period: str) -> tuple[str, str]:
    """'2026-03' → ('2026-03-01', '2026-03-31')"""
    import calendar
    y, m = int(period.split("-")[0]), int(period.split("-")[1])
    last_day = calendar.monthrange(y, m)[1]
    return f"{period}-01", f"{period}-{last_day:02d}"


# ── Periods ───────────────────────────────────────────────────────────────────

@router.get("/periods")
async def list_periods(db: Database = Depends(get_db)):
    await db.connect()
    try:
        periods = await db.list_periods()
        return {"periods": periods}
    finally:
        await db.close()


@router.post("/periods/{period}")
async def get_or_create_period(period: str, db: Database = Depends(get_db)):
    """Get or create a reconciliation period. period format: YYYY-MM"""
    if not period or len(period) != 7 or period[4] != "-":
        raise HTTPException(status_code=400, detail="period must be YYYY-MM format")
    await db.connect()
    try:
        label = _period_label(period)
        row = await db.get_or_create_period(period, label)
        return row
    finally:
        await db.close()


@router.get("/periods/{period}/statements")
async def get_period_statements(period: str, db: Database = Depends(get_db)):
    await db.connect()
    try:
        period_row = await db.get_period(period)
        if not period_row:
            raise HTTPException(status_code=404, detail="Period not found")
        statements = await db.get_statements_for_period(period_row["id"])
        return {"period": period_row, "statements": statements}
    finally:
        await db.close()


@router.post("/periods/{period}/close")
async def close_period(period: str, db: Database = Depends(get_db)):
    """
    Freeze a period — snapshots QBO data for all statements so the view is static.
    """
    await db.connect()
    svc = ReconciliationService()
    try:
        period_row = await db.get_period(period)
        if not period_row:
            raise HTTPException(status_code=404, detail="Period not found")
        if period_row["status"] == "closed":
            raise HTTPException(status_code=400, detail="Period already closed")

        from_date, to_date = _period_date_range(period)
        statements = await db.get_statements_for_period(period_row["id"])

        for stmt in statements:
            lines = await db.get_statement_lines(stmt["id"])
            extraction = {
                "vendor_name": stmt["vendor_name"],
                "statement_date": stmt["statement_date"],
                "closing_balance": stmt["closing_balance"],
                "currency": stmt["currency"],
                "aging": {
                    "current": stmt["aging_current"],
                    "days_1_30": stmt["aging_1_30"],
                    "days_31_60": stmt["aging_31_60"],
                    "days_61_90": stmt["aging_61_90"],
                    "over_90": stmt["aging_over_90"],
                },
                "lines": [dict(l) for l in lines],
            }
            result = await svc.reconcile(extraction, from_date, to_date)
            await db.save_qbo_snapshot(stmt["id"], result)

        await db.close_period(period)
        return {"period": period, "status": "closed", "statements_snapshotted": len(statements)}
    finally:
        await db.close()
        await svc.close()


# ── Statement upload ──────────────────────────────────────────────────────────

@router.post("/upload")
async def upload_statement(
    period: str = Form(...),
    file: UploadFile = File(...),
    db: Database = Depends(get_db),
):
    """
    Upload a vendor statement PDF.
    Extracts data with Claude, stores in D1, returns initial QBO diff.
    """
    file_bytes = await file.read()
    filename = file.filename or "statement.pdf"

    await db.connect()
    svc = ReconciliationService()
    try:
        # Ensure period exists
        label = _period_label(period)
        period_row = await db.get_or_create_period(period, label)

        if period_row.get("status") == "closed":
            raise HTTPException(status_code=400, detail=f"Period {period} is closed — cannot add statements")

        # Extract with Claude
        logger.info(f"Extracting vendor statement: {filename}")
        extraction = await svc.extract_statement(file_bytes, filename)

        vendor_name = extraction.get("vendor_name")
        if not vendor_name:
            raise HTTPException(status_code=422, detail="Could not extract vendor name from statement")

        # Save statement to D1
        statement_id = await db.create_vendor_statement(
            period_id=period_row["id"],
            vendor_name=vendor_name,
            statement_date=extraction.get("statement_date"),
            closing_balance=extraction.get("closing_balance"),
            currency=extraction.get("currency", "CAD"),
            aging=extraction.get("aging") or {},
            pdf_filename=filename,
            intake_source="upload",
        )
        await db.create_statement_lines(statement_id, extraction.get("lines", []))

        # Run live QBO diff
        from_date, to_date = _period_date_range(period)
        diff_result = await svc.reconcile(extraction, from_date, to_date)

        return {
            "statement_id": statement_id,
            "vendor_name": vendor_name,
            "statement_date": extraction.get("statement_date"),
            "closing_balance": extraction.get("closing_balance"),
            "currency": extraction.get("currency", "CAD"),
            "aging": extraction.get("aging"),
            "lines": extraction.get("lines", []),
            "diff": diff_result,
        }

    finally:
        await db.close()
        await svc.close()


# ── Statement detail & refresh ────────────────────────────────────────────────

@router.get("/statements/{statement_id}")
async def get_statement(statement_id: int, db: Database = Depends(get_db)):
    await db.connect()
    try:
        stmt = await db.get_statement(statement_id)
        if not stmt:
            raise HTTPException(status_code=404, detail="Statement not found")
        lines = await db.get_statement_lines(statement_id)
        return {**dict(stmt), "lines": [dict(l) for l in lines]}
    finally:
        await db.close()


@router.get("/statements/{statement_id}/diff")
async def get_statement_diff(statement_id: int, db: Database = Depends(get_db)):
    """
    Returns the reconciliation diff.
    - Open period  → live QBO query
    - Closed period → returns frozen snapshot
    """
    await db.connect()
    svc = ReconciliationService()
    try:
        stmt = await db.get_statement(statement_id)
        if not stmt:
            raise HTTPException(status_code=404, detail="Statement not found")

        # Check period status
        period_rows = await db._q(
            "SELECT * FROM reconciliation_periods WHERE id = ?", [stmt["period_id"]]
        )
        period_row = period_rows[0] if period_rows else None

        # Closed period — return snapshot
        if period_row and period_row.get("status") == "closed" and stmt.get("qbo_snapshot"):
            return {"source": "snapshot", "data": json.loads(stmt["qbo_snapshot"])}

        # Open period — live QBO diff
        lines = await db.get_statement_lines(statement_id)
        extraction = {
            "vendor_name": stmt["vendor_name"],
            "statement_date": stmt["statement_date"],
            "closing_balance": stmt["closing_balance"],
            "currency": stmt["currency"],
            "aging": {
                "current": stmt["aging_current"],
                "days_1_30": stmt["aging_1_30"],
                "days_31_60": stmt["aging_31_60"],
                "days_61_90": stmt["aging_61_90"],
                "over_90": stmt["aging_over_90"],
            },
            "lines": [dict(l) for l in lines],
        }

        if period_row:
            from_date, to_date = _period_date_range(period_row["period"])
        else:
            # Fallback: use statement date month
            stmt_date = stmt.get("statement_date") or date.today().isoformat()
            period = stmt_date[:7]
            from_date, to_date = _period_date_range(period)

        diff_result = await svc.reconcile(extraction, from_date, to_date)
        return {"source": "live", "data": diff_result}

    finally:
        await db.close()
        await svc.close()


@router.delete("/statements/{statement_id}")
async def delete_statement(statement_id: int, db: Database = Depends(get_db)):
    await db.connect()
    try:
        stmt = await db.get_statement(statement_id)
        if not stmt:
            raise HTTPException(status_code=404, detail="Statement not found")
        await db.delete_statement(statement_id)
        return {"deleted": statement_id}
    finally:
        await db.close()
