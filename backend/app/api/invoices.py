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

import anthropic
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.models.invoice import Invoice, InvoiceStatus, LineItem, TaxLine
from app.services.aspire import AspireClient
from app.services.extractor import InvoiceExtractor
from app.services.qbo import QBOClient
from app.services.r2 import upload_invoice_pdf, get_file_bytes
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

class GLSuggestRequest(BaseModel):
    description: str   # "what was purchased" — free text from field crew
    vendor_name: Optional[str] = None

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


@router.post("/suggest-gl")
async def suggest_gl(body: GLSuggestRequest):
    """
    Given a description of what was purchased, ask Claude to pick the best
    GL account from the QBO chart of accounts.
    Called by the field crew when they reject the default GL.

    Returns { gl_account, gl_name, confidence } — or raises 422 on failure.
    """
    # Fetch live COA from QBO
    try:
        accounts = await _qbo.list_expense_accounts()
    except Exception as e:
        logger.warning(f"COA fetch failed — {e}. Using empty list.")
        accounts = []

    FALLBACK = {"gl_account": "6999", "gl_name": "General Overhead", "confidence": "low"}

    if not accounts:
        logger.warning("COA empty — returning fallback GL 6999")
        return FALLBACK

    coa_text = "\n".join(
        f"- {a.get('AcctNum', '')} | {a['Name']} ({a.get('AccountSubType', a.get('AccountType', ''))})"
        for a in accounts
    )

    vendor_hint = f" at {body.vendor_name}" if body.vendor_name else ""
    prompt = f"""You are an accounts payable assistant for a Canadian landscaping company.

A field crew member made a purchase{vendor_hint} and described it as:
"{body.description}"

Here are the available expense accounts in QuickBooks (format: AcctNum | Name | SubType):
{coa_text}

Pick the single best GL account for this purchase. If nothing fits well, use account 6999.
Return ONLY a JSON object: {{ "gl_account": "<AcctNum>", "gl_name": "<Name>", "confidence": "high|medium|low" }}
No explanation. No markdown."""

    try:
        client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        message = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=256,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1].lstrip("json").strip()
        result = json.loads(raw)
        return {
            "gl_account": result.get("gl_account") or "6999",
            "gl_name":    result.get("gl_name") or "General Overhead",
            "confidence": result.get("confidence", "medium"),
        }
    except Exception as e:
        logger.warning(f"GL suggestion failed — returning fallback 6999: {e}")
        return FALLBACK


@router.post("/upload")
async def upload_invoice(
    file:           UploadFile      = File(...),
    doc_type:       Optional[str]   = Form(None),
    cost_type:      Optional[str]   = Form(None),
    employee_name:  Optional[str]   = Form(None),
    po_number_hint: Optional[str]   = Form(None),
    gl_account:     Optional[str]   = Form(None),   # user-confirmed GL from frontend
    notes:          Optional[str]   = Form(None),
    is_return:      Optional[str]   = Form(None),   # 'true' when field crew submits a return/refund
    db:             Database        = Depends(get_db),
):
    """Upload a PDF or image, extract with Claude, store and route."""
    allowed_ext = (".pdf", ".jpg", ".jpeg", ".png", ".webp", ".heic")
    allowed_mime = ("image/", "application/pdf")
    filename_ok = (not file.filename) or file.filename.lower().endswith(allowed_ext)
    mime_ok = any((file.content_type or "").startswith(m) for m in allowed_mime)
    if not filename_ok and not mime_ok:
        raise HTTPException(status_code=400, detail="Only PDF or image files are accepted")

    pdf_bytes = await file.read()
    returning = is_return == "true"
    original_doc_type = doc_type  # preserve before overriding — needed for employee routing below
    logger.info(f"Invoice received — {file.filename} ({len(pdf_bytes)} bytes), doc_type={doc_type}, is_return={returning}")

    # Returns (any doc type) use credit memo extraction (negative amounts) and route as vendor credit
    if returning:
        doc_type = "credit_memo"
        try:
            extraction = await _extractor.extract_credit_memo(pdf_bytes, file.filename or "")
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Return receipt extraction failed: {e}")
    else:
        try:
            extraction = await _extractor.extract_from_pdf_bytes(pdf_bytes, file.filename or "")
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Extraction failed: {e}")

    # Duplicate check — reject if this invoice number was already processed
    if extraction.invoice_number and extraction.vendor_name:
        duplicate = await db.find_duplicate_invoice(extraction.vendor_name, extraction.invoice_number)
        if duplicate:
            raise HTTPException(
                status_code=409,
                detail=f"Invoice #{extraction.invoice_number} from '{extraction.vendor_name}' "
                       f"was already received (id={duplicate['id']}, status={duplicate['status']}). "
                       f"If this is a corrected invoice, contact AP."
            )

    # Employee expense: route under the employee's vendor rule (GL account)
    # MasterCard: route under the merchant name — employee is just the purchaser
    # Use original_doc_type so returns (which set doc_type='credit_memo') still route correctly.
    is_expense = original_doc_type == "expense" and employee_name
    routing_vendor = employee_name if is_expense else extraction.vendor_name
    if is_expense:
        logger.info(f"Employee expense return — routing under '{employee_name}' instead of '{extraction.vendor_name}'" if returning else f"Employee expense — routing under '{employee_name}' instead of '{extraction.vendor_name}'")
    if original_doc_type == "mastercard" and employee_name:
        logger.info(f"MasterCard {'return' if returning else 'purchase'} by '{employee_name}' at '{extraction.vendor_name}'")

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
        doc_type       = doc_type,   # persist so retry keeps credit_memo routing
    )

    await db.audit(invoice_id, "extracted", "claude", {
        "vendor": extraction.vendor_name,
        "total":  extraction.total_amount,
        "po":     extraction.po_number,
    })

    # Store file to R2 so retry can re-attach it to QBO
    try:
        r2_key = await upload_invoice_pdf(pdf_bytes, invoice_id, file.filename or "receipt.jpg")
        if r2_key:
            await db.save_invoice_r2_key(invoice_id, r2_key)
    except Exception as e:
        logger.warning(f"R2 upload failed for field invoice {invoice_id} — attachment may be missing on retry: {e}")

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
        doc_type       = doc_type,
        # User-confirmed GL from GL confirmation step (overrides vendor rule lookup)
        gl_account     = gl_account or None,
    )

    outcome = await route_invoice(invoice, db, _aspire, _qbo, employee_name=employee_name)

    return {
        "invoice_id": invoice_id,
        "vendor":     extraction.vendor_name,
        "total":      extraction.total_amount,
        "outcome":    outcome,
        "message":    _outcome_message(outcome),
    }


@router.get("/validate-po")
async def validate_po_endpoint(
    po_number: str = Query(..., description="PO number to validate against Aspire"),
):
    """
    Validate a PO number against Aspire.
    Looks for an open Receipt (New or Received) matching the PO number.
    """
    receipt = await _aspire.find_open_receipt(po_number)
    if receipt is None:
        raise HTTPException(
            status_code=422,
            detail=f"PO '{po_number}' not found in Aspire (no open receipt with that number)"
        )
    return {
        "valid": True,
        "receipt_id":     receipt.get("ReceiptID"),
        "receipt_number": receipt.get("ReceiptNumber"),
        "status":         receipt.get("ReceiptStatusName"),
        "vendor":         receipt.get("VendorName"),
        "work_ticket_id": receipt.get("WorkTicketID"),
    }


@router.get("/counts")
async def get_counts(db: Database = Depends(get_db)):
    return await db.get_queue_counts()


@router.get("/debug-receipt")
async def debug_receipt(po_number: str = Query(...)):
    """
    Debug endpoint — returns raw Aspire Receipt data for a PO number.
    Tries multiple filter strategies to diagnose OData issues.
    """
    # Force a fresh token — clears any cached token from before permission changes
    _aspire._token = None
    _aspire._token_expires_at = 0.0

    po_int = _aspire._extract_po_int(po_number)
    results = {}

    # Strategy 1: ReceiptNumber eq int, with status filter
    try:
        r1 = await _aspire._get("Receipts", params={
            "$filter": f"ReceiptNumber eq {po_int} and (ReceiptStatusName eq 'New' or ReceiptStatusName eq 'Received')",
            "$expand": "ReceiptItems",
            "$top": 3,
        })
        results["strategy_1_number_and_status"] = r1
    except Exception as e:
        results["strategy_1_error"] = str(e)

    # Strategy 2: ReceiptNumber only, no status filter
    try:
        r2 = await _aspire._get("Receipts", params={
            "$filter": f"ReceiptNumber eq {po_int}",
            "$top": 3,
        })
        results["strategy_2_number_only"] = r2
    except Exception as e:
        results["strategy_2_error"] = str(e)

    # Strategy 3: No filter at all — just grab first 5 to see field names
    try:
        r3 = await _aspire._get("Receipts", params={"$top": 5})
        results["strategy_3_no_filter_sample"] = r3
    except Exception as e:
        results["strategy_3_error"] = str(e)

    return results


@router.get("/debug-attachment")
async def debug_attachment(ticket_id: int = Query(...), type_id: int = Query(1), object_code: str = Query("WorkTicket")):
    """
    Debug endpoint — tries to upload a tiny test attachment to a WorkTicket.
    Try different type_id and object_code values to find what Aspire accepts.
    """
    import base64
    import httpx
    # 1x1 white pixel PNG
    test_bytes = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg=="
    )
    token = await _aspire._get_token()
    file_data = base64.b64encode(test_bytes).decode("utf-8")
    body = {
        "FileName":         "ap_test.png",
        "FileData":         file_data,
        "ObjectId":         ticket_id,
        "ObjectCode":       object_code,
        "AttachmentTypeId": type_id,
        "ExposeToCrew":     False,
    }
    try:
        resp = await _aspire._http.post(
            f"{_aspire.base_url}/Attachments",
            json=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        return {
            "success": resp.is_success,
            "status_code": resp.status_code,
            "response_body": resp.text[:2000],
            "request_body_keys": list(body.keys()),
            "object_code": object_code,
            "type_id": type_id,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.get("/feed")
async def get_invoice_feed(
    limit: int      = Query(100, le=500),
    db:    Database = Depends(get_db),
):
    """
    Live activity feed for the AP dashboard.
    Returns recent active (non-archived) invoices.
    Designed to be polled every 10 seconds.
    """
    entries = await db.get_invoice_feed(limit=limit)
    return {"entries": entries}


@router.get("/archived")
async def get_archived_feed(
    limit: int      = Query(200, le=500),
    db:    Database = Depends(get_db),
):
    """Archived invoices — hidden from the main feed."""
    entries = await db.get_archived_feed(limit=limit)
    return {"entries": entries}


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


@router.get("/{invoice_id}/pdf")
async def get_invoice_pdf_url(invoice_id: int, db: Database = Depends(get_db)):
    """Return a short-lived URL for the invoice PDF.
    Tries R2 first; falls back to QBO's TempDownloadUri if no R2 key stored."""
    from app.services.r2 import get_presigned_url
    invoice = await db.get_invoice(invoice_id)
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # ── Try R2 first ──────────────────────────────────────────────────────────
    r2_key = invoice.get("pdf_r2_key")
    if r2_key:
        url = await get_presigned_url(r2_key, expires_in=900)
        if url:
            return {"url": url}

    # ── Fall back to QBO attachment ───────────────────────────────────────────
    qbo_bill_id = invoice.get("qbo_bill_id")
    if qbo_bill_id:
        qbo = QBOClient()
        url = await qbo.get_attachment_url(qbo_bill_id, invoice.get("doc_type"))
        await qbo.close()
        if url:
            return {"url": url}

    raise HTTPException(status_code=404, detail="No PDF available for this invoice")


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

    # Validate against Aspire only if credentials are configured
    aspire_ready = bool(settings.ASPIRE_CLIENT_ID and settings.ASPIRE_CLIENT_SECRET)
    if aspire_ready:
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
    gl_name    = None
    if not gl_account:
        vendor_rule = await db.get_vendor_rule_by_name(row["vendor_name"])
        if vendor_rule:
            gl_account = vendor_rule.default_gl_account
            gl_name    = vendor_rule.default_gl_name
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
        bill_id, qbo_amount = await _qbo.post_bill(invoice, gl_account)
        await db.mark_posted_qbo(invoice_id, bill_id, gl_account, gl_name=gl_name, qbo_amount=qbo_amount)
        await db.audit(invoice_id, "posted", body.reviewed_by, {
            "destination": "qbo", "bill_id": bill_id, "gl_account": gl_account, "gl_name": gl_name, "qbo_amount": qbo_amount, "manual": True
        })
        return {"invoice_id": invoice_id, "outcome": "posted_qbo", "bill_id": bill_id, "gl_account": gl_account, "message": f"Posted to QBO — bill {bill_id}"}
    except Exception as e:
        await db.mark_error(invoice_id, str(e))
        raise HTTPException(status_code=500, detail=f"QBO posting failed: {e}")


@router.post("/archive-unknown")
async def archive_unknown_invoices(db: Database = Depends(get_db)):
    """Bulk archive all invoices with no vendor name (junk records)."""
    count = await db.archive_unknown_invoices()
    return {"archived": count}


@router.post("/{invoice_id}/archive")
async def archive_invoice(invoice_id: int, db: Database = Depends(get_db)):
    """Archive an invoice — hides it from the main feed."""
    row = await db.get_invoice(invoice_id)
    if not row:
        raise HTTPException(status_code=404, detail="Invoice not found")
    await db.archive_invoice(invoice_id)
    await db.audit(invoice_id, "archived", "dashboard", {})
    return {"invoice_id": invoice_id, "archived": True}


@router.post("/{invoice_id}/unarchive")
async def unarchive_invoice(invoice_id: int, db: Database = Depends(get_db)):
    """Restore an archived invoice to the main feed."""
    row = await db.get_invoice(invoice_id)
    if not row:
        raise HTTPException(status_code=404, detail="Invoice not found")
    await db.unarchive_invoice(invoice_id)
    await db.audit(invoice_id, "unarchived", "dashboard", {})
    return {"invoice_id": invoice_id, "archived": False}


@router.post("/backfill-qbo-amounts")
async def backfill_qbo_amounts(db: Database = Depends(get_db)):
    """
    One-time backfill: fetch TotalAmt from QBO for every posted invoice
    that has a qbo_bill_id but no qbo_amount stored.
    Safe to call multiple times — skips rows already populated.
    """
    rows = await db._q(
        """SELECT id, qbo_bill_id, doc_type FROM invoices
           WHERE destination = 'qbo'
             AND status = 'posted'
             AND qbo_bill_id IS NOT NULL
             AND (qbo_amount IS NULL)"""
    )
    if not rows:
        return {"updated": 0, "message": "Nothing to backfill"}

    updated = 0
    failed = 0
    for row in rows:
        amount = await _qbo.get_transaction_amount(row["qbo_bill_id"], row["doc_type"])
        if amount is not None:
            await db._x(
                "UPDATE invoices SET qbo_amount = ? WHERE id = ?",
                [amount, row["id"]],
            )
            updated += 1
        else:
            logger.warning(f"Could not fetch QBO amount for invoice {row['id']} bill {row['qbo_bill_id']}")
            failed += 1

    return {"updated": updated, "failed": failed, "total": len(rows)}


@router.post("/{invoice_id}/sync-qbo-amount")
async def sync_qbo_amount(invoice_id: int, db: Database = Depends(get_db)):
    """Re-fetch TotalAmt from QBO for a single invoice and update qbo_amount."""
    row = await db.get_invoice(invoice_id)
    if not row:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if not row.get("qbo_bill_id"):
        raise HTTPException(status_code=400, detail="Invoice has no QBO bill ID")
    amount = await _qbo.get_transaction_amount(row["qbo_bill_id"], row.get("doc_type"))
    if amount is None:
        raise HTTPException(status_code=502, detail="Could not fetch amount from QBO")
    await db._x("UPDATE invoices SET qbo_amount = ? WHERE id = ?", [amount, invoice_id])
    return {"invoice_id": invoice_id, "qbo_amount": amount}


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
    if row["status"] not in ("error", "queued", "pending"):
        raise HTTPException(status_code=400, detail="Only error, queued, or pending invoices can be retried")

    raw = json.loads(row.get("intake_raw") or "{}")

    # Fetch file from R2 so the attachment is included on retry
    r2_key = row.get("pdf_r2_key")
    file_bytes = await get_file_bytes(r2_key) if r2_key else None

    # Restore doc_type from DB; if missing, infer credit_memo from negative total
    # (handles entries saved before doc_type was persisted)
    doc_type = row.get("doc_type")
    if not doc_type and row.get("total_amount") is not None and float(row.get("total_amount") or 0) < 0:
        doc_type = "credit_memo"
        logger.info(f"Inferred doc_type=credit_memo from negative total_amount for invoice {invoice_id}")

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
        doc_type           = doc_type,
        file_bytes         = file_bytes,
        line_items         = [LineItem(**li) for li in raw.get("line_items", [])],
        tax_lines          = [TaxLine(**tl) for tl in raw.get("tax_lines", [])],
    )

    await db.audit(invoice_id, "retry", "system", {})
    outcome = await route_invoice(invoice, db, _aspire, _qbo)

    # On success, clean up any sibling error rows for the same invoice number
    if outcome in (RoutingOutcome.POSTED_QBO, RoutingOutcome.POSTED_ASPIRE):
        cleaned = await db.cleanup_sibling_errors(
            invoice_id, row["vendor_name"], row.get("invoice_number")
        )
        if cleaned:
            logger.info(f"Cleaned up {cleaned} sibling error row(s) for invoice {invoice_id}")

    return {"invoice_id": invoice_id, "outcome": outcome, "message": _outcome_message(outcome)}


def _outcome_message(outcome: RoutingOutcome) -> str:
    return {
        RoutingOutcome.POSTED_ASPIRE: "Posted to Aspire successfully",
        RoutingOutcome.POSTED_QBO:    "Posted to QBO successfully",
        RoutingOutcome.QUEUED:        "Added to exception queue — review required",
        RoutingOutcome.ERROR:         "Posting failed — check error queue",
    }.get(outcome, "Unknown outcome")
