"""
Invoice API endpoints.

POST /invoices/upload        — Upload a PDF invoice for processing
GET  /invoices/              — List invoices (filterable by status/destination)
GET  /invoices/counts        — Queue counts for the dashboard stats bar
GET  /invoices/{id}          — Get a single invoice with line items
POST /invoices/{id}/override — Apply a manual PO number override
POST /invoices/{id}/overhead — Mark invoice as overhead → route to QBO
POST /invoices/{id}/retry    — Retry a failed posting
GET  /invoices/audit         — Recent audit log entries
"""

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.models.invoice import Invoice, InvoiceStatus, LineItem, TaxLine
from app.services.aspire import AspireClient
from app.services.extractor import InvoiceExtractor
from app.services.qbo import QBOClient
from app.services.routing import RoutingOutcome, route_invoice

logger = logging.getLogger(__name__)
router = APIRouter()

# ── Shared service instances ──────────────────────────────────────────────────
_db        = Database()
_extractor = InvoiceExtractor()
_aspire    = AspireClient(sandbox=settings.ASPIRE_SANDBOX)
_qbo       = QBOClient()


async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


# ── Request models ────────────────────────────────────────────────────────────

class POOverrideRequest(BaseModel):
    po_number:   str
    reviewed_by: str = "ap_user"

class OverheadRequest(BaseModel):
    gl_account:  Optional[str] = None
    reviewed_by: str = "ap_user"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/quick-extract")
async def quick_extract(
    file: UploadFile = File(...),
):
    """
    Fast extraction endpoint for the mobile app.
    Called immediately after photo capture to pre-fill the PO field.
    Does NOT store the invoice or run routing — just returns extracted fields.
    Returns within ~3 seconds so the crew sees results by the time they reach step 3.
    """
    allowed_ext = (".pdf", ".jpg", ".jpeg", ".png", ".webp", ".heic")
    allowed_mime = ("image/", "application/pdf")
    filename_ok = (not file.filename) or file.filename.lower().endswith(allowed_ext)
    mime_ok = any((file.content_type or "").startswith(m) for m in allowed_mime)
    if not filename_ok and not mime_ok:
        raise HTTPException(status_code=400, detail="Only PDF or image files are accepted")

    file_bytes = await file.read()

    try:
        extraction = await _extractor.extract_from_pdf_bytes(file_bytes, file.filename or "")
        return {
            "success":       True,
            "vendor_name":   extraction.vendor_name,
            "invoice_number": extraction.invoice_number,
            "invoice_date":  extraction.invoice_date,
            "total_amount":  extraction.total_amount,
            "po_number":     extraction.po_number,
            "currency":      extraction.currency,
        }
    except Exception as e:
        logger.warning(f"Quick extract failed — {e}")
        return {
            "success":    False,
            "po_number":  None,
            "error":      str(e),
        }


@router.post("/upload")
async def upload_invoice(
    file:          UploadFile      = File(...),
    doc_type:      Optional[str]   = None,
    employee_name: Optional[str]   = None,
    po_number_hint: Optional[str]  = None,
    notes:         Optional[str]   = None,
    db:            Database        = Depends(get_db),
):
    """Upload a PDF or image, extract with Claude, store and route."""
    allowed_ext = (".pdf", ".jpg", ".jpeg", ".png", ".webp", ".heic")
    allowed_mime = ("image/", "application/pdf")
    filename_ok = (not file.filename) or file.filename.lower().endswith(allowed_ext)
    mime_ok = any((file.content_type or "").startswith(m) for m in allowed_mime)
    if not filename_ok and not mime_ok:
        raise HTTPException(status_code=400, detail="Only PDF or image files are accepted")

    pdf_bytes = await file.read()
    logger.info(f"Invoice received — {file.filename} ({len(pdf_bytes)} bytes)")

    try:
        extraction = await _extractor.extract_from_pdf_bytes(pdf_bytes, file.filename or "")
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Extraction failed: {e}")

    # For employee expense submissions, route under the employee's name
    # so it hits their vendor rule (GL account) instead of the store's rule
    is_expense = doc_type == "expense" and employee_name
    routing_vendor = employee_name if is_expense else extraction.vendor_name
    if is_expense:
        logger.info(f"Employee expense — routing under '{employee_name}' instead of '{extraction.vendor_name}'")

    invoice_id = await db.create_invoice(
        vendor_name    = routing_vendor,
        invoice_number = extraction.invoice_number,
        invoice_date   = extraction.invoice_date,
        due_date       = extraction.due_date,
        subtotal       = extraction.subtotal,
        tax_amount     = extraction.tax_amount,
        total_amount   = extraction.total_amount,
        currency       = extraction.currency,
        po_number      = extraction.po_number,
        pdf_filename   = file.filename,
        intake_source  = "upload",
        intake_raw     = extraction.model_dump(),
    )

    await db.audit(invoice_id, "extracted", "claude", {
        "vendor": extraction.vendor_name,
        "total":  extraction.total_amount,
        "po":     extraction.po_number,
    })

    invoice = Invoice(
        id             = invoice_id,
        status         = InvoiceStatus.PENDING,
        vendor_name    = routing_vendor,
        invoice_number = extraction.invoice_number,
        invoice_date   = extraction.invoice_date,
        due_date       = extraction.due_date,
        subtotal       = extraction.subtotal,
        tax_amount     = extraction.tax_amount,
        total_amount   = extraction.total_amount,
        currency       = extraction.currency,
        po_number      = extraction.po_number,
        pdf_filename   = file.filename,
        intake_source  = "upload",
        line_items     = [LineItem(**li.model_dump()) for li in extraction.line_items],
        tax_lines      = [TaxLine(**tl.model_dump()) for tl in extraction.tax_lines],
        file_bytes     = pdf_bytes,
    )

    outcome = await route_invoice(invoice, db, _aspire, _qbo)

    return {
        "invoice_id": invoice_id,
        "vendor":     extraction.vendor_name,
        "total":      extraction.total_amount,
        "outcome":    outcome,
        "message":    _outcome_message(outcome),
    }


@router.get("/validate-po")
async def validate_po(po_number: str):
    """
    Validate a PO number against Aspire.
    Used by the field crew mobile app before submission.
    Returns job name and address if found.
    """
    is_valid, error_msg = await _aspire.validate_po(po_number)
    if not is_valid:
        raise HTTPException(status_code=422, detail=error_msg)
    po_data = await _aspire.get_purchase_order(po_number)
    return {
        "found":           True,
        "OpportunityName": po_data.get("OpportunityName"),
        "BillingAddressLine1": po_data.get("BillingAddressLine1"),
        "BillingAddressCity":  po_data.get("BillingAddressCity"),
        "OpportunityStatusName": po_data.get("OpportunityStatusName"),
    }


@router.get("/counts")
async def get_counts(db: Database = Depends(get_db)):
    return await db.get_queue_counts()


@router.get("/validate-po")
async def validate_po_endpoint(
    po_number: str = Query(..., description="PO number to validate against Aspire"),
    db: Database = Depends(get_db),
):
    """
    Validate a PO number against Aspire.
    Used by the field crew mobile app before submission.
    """
    cached = await db.get_cached_po(po_number)
    if cached:
        return {"valid": True, "job": cached, "cached": True}

    po_data = await _aspire.get_purchase_order(po_number)

    if po_data is None:
        return {"valid": False, "error": f"PO '{po_number}' not found in Aspire"}

    status = po_data.get("OpportunityStatusName", "")
    if "cancel" in status.lower() or "closed" in status.lower():
        return {"valid": False, "error": f"PO '{po_number}' is {status}"}

    await db.cache_po(po_number, po_data)
    return {"valid": True, "job": po_data, "cached": False}


@router.get("/audit")
async def get_audit_log(
    limit: int      = Query(100, le=500),
    db:    Database = Depends(get_db),
):
    entries = await db.get_audit_log(limit=limit)
    return {"entries": entries}


@router.get("/")
async def list_invoices(
    status:      Optional[str] = Query(None),
    destination: Optional[str] = Query(None),
    limit:       int           = Query(50, le=200),
    offset:      int           = Query(0),
    db:          Database      = Depends(get_db),
):
    invoices = await db.list_invoices(
        status=status, destination=destination, limit=limit, offset=offset
    )
    return {"invoices": invoices, "count": len(invoices)}


@router.get("/{invoice_id}")
async def get_invoice(invoice_id: int, db: Database = Depends(get_db)):
    invoice = await db.get_invoice(invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return invoice


@router.post("/{invoice_id}/override")
async def apply_po_override(
    invoice_id: int,
    body:       POOverrideRequest,
    db:         Database = Depends(get_db),
):
    """Enter a PO number for a queued invoice and re-run routing."""
    row = await db.get_invoice(invoice_id)
    if not row:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if row["status"] not in ("queued", "error"):
        raise HTTPException(status_code=400, detail=f"Invoice status is '{row['status']}' — cannot override")

    is_valid, error_msg = await _aspire.validate_po(body.po_number)
    if not is_valid:
        raise HTTPException(status_code=422, detail=error_msg)

    await db.apply_po_override(invoice_id, body.po_number, body.reviewed_by)

    raw = json.loads(row.get("intake_raw") or "{}")
    invoice = Invoice(
        id                 = invoice_id,
        status             = InvoiceStatus.QUEUED,
        vendor_name        = row["vendor_name"],
        invoice_number     = row["invoice_number"],
        invoice_date       = row["invoice_date"],
        due_date           = row["due_date"],
        subtotal           = row["subtotal"],
        tax_amount         = row["tax_amount"],
        total_amount       = row["total_amount"],
        currency           = row.get("currency") or "CAD",
        po_number          = row["po_number"],
        po_number_override = body.po_number,
        pdf_filename       = row["pdf_filename"],
        intake_source      = row["intake_source"],
        line_items         = [LineItem(**li) for li in raw.get("line_items", [])],
        tax_lines          = [TaxLine(**tl) for tl in raw.get("tax_lines", [])],
    )

    outcome = await route_invoice(invoice, db, _aspire, _qbo)
    return {"invoice_id": invoice_id, "po_number": body.po_number, "outcome": outcome, "message": _outcome_message(outcome)}


@router.post("/{invoice_id}/overhead")
async def mark_as_overhead(
    invoice_id: int,
    body:       OverheadRequest,
    db:         Database = Depends(get_db),
):
    """Mark a queued invoice as overhead and post to QBO."""
    row = await db.get_invoice(invoice_id)
    if not row:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if row["status"] not in ("queued", "error"):
        raise HTTPException(status_code=400, detail="Invoice is not in the queue")

    gl_account = body.gl_account
    if not gl_account:
        vendor_rule = await db.get_vendor_rule_by_name(row["vendor_name"])
        if vendor_rule:
            gl_account = vendor_rule.default_gl_account
    if not gl_account:
        raise HTTPException(status_code=422, detail="No GL account available — provide one or add it to the vendor rule")

    raw = json.loads(row.get("intake_raw") or "{}")
    invoice = Invoice(
        id             = invoice_id,
        status         = InvoiceStatus.QUEUED,
        vendor_name    = row["vendor_name"],
        invoice_number = row["invoice_number"],
        invoice_date   = row["invoice_date"],
        due_date       = row["due_date"],
        subtotal       = row["subtotal"],
        tax_amount     = row["tax_amount"],
        total_amount   = row["total_amount"],
        currency       = row.get("currency") or "CAD",
        pdf_filename   = row["pdf_filename"],
        line_items     = [LineItem(**li) for li in raw.get("line_items", [])],
        tax_lines      = [TaxLine(**tl) for tl in raw.get("tax_lines", [])],
    )

    try:
        bill_id = await _qbo.post_bill(invoice, gl_account)
        await db.mark_posted_qbo(invoice_id, bill_id, gl_account)
        await db.audit(invoice_id, "posted", body.reviewed_by, {
            "destination": "qbo", "bill_id": bill_id, "gl_account": gl_account, "manual": True
        })
        return {"invoice_id": invoice_id, "outcome": "posted_qbo", "bill_id": bill_id, "gl_account": gl_account, "message": f"Posted to QBO — bill {bill_id}"}
    except Exception as e:
        await db.mark_error(invoice_id, str(e))
        raise HTTPException(status_code=500, detail=f"QBO posting failed: {e}")


@router.delete("/{invoice_id}")
async def delete_invoice(invoice_id: int, db: Database = Depends(get_db)):
    """Delete an invoice and its audit log entries."""
    deleted = await db.delete_invoice(invoice_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return {"invoice_id": invoice_id, "deleted": True}


@router.post("/{invoice_id}/retry")
async def retry_invoice(invoice_id: int, db: Database = Depends(get_db)):
    """Retry a failed invoice."""
    row = await db.get_invoice(invoice_id)
    if not row:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if row["status"] != "error":
        raise HTTPException(status_code=400, detail="Only error invoices can be retried")

    raw = json.loads(row.get("intake_raw") or "{}")
    invoice = Invoice(
        id                 = invoice_id,
        status             = InvoiceStatus.ERROR,
        vendor_name        = row["vendor_name"],
        invoice_number     = row["invoice_number"],
        invoice_date       = row["invoice_date"],
        due_date           = row["due_date"],
        subtotal           = row["subtotal"],
        tax_amount         = row["tax_amount"],
        total_amount       = row["total_amount"],
        currency           = row.get("currency") or "CAD",
        po_number          = row["po_number"],
        po_number_override = row["po_number_override"],
        pdf_filename       = row["pdf_filename"],
        intake_source      = row["intake_source"],
        line_items         = [LineItem(**li) for li in raw.get("line_items", [])],
        tax_lines          = [TaxLine(**tl) for tl in raw.get("tax_lines", [])],
    )

    await db.audit(invoice_id, "retry", "system", {})
    outcome = await route_invoice(invoice, db, _aspire, _qbo)
    return {"invoice_id": invoice_id, "outcome": outcome, "message": _outcome_message(outcome)}


def _outcome_message(outcome: RoutingOutcome) -> str:
    return {
        RoutingOutcome.POSTED_ASPIRE: "Posted to Aspire successfully",
        RoutingOutcome.POSTED_QBO:    "Posted to QBO successfully",
        RoutingOutcome.QUEUED:        "Added to exception queue — review required",
        RoutingOutcome.ERROR:         "Posting failed — check error queue",
    }.get(outcome, "Unknown outcome")
