"""
Routing engine — decides where each invoice goes (Aspire or QBO)
and orchestrates the posting.

Decision logic:
  1. Look up vendor in vendor_rules table
  2. If type == 'job_cost'  → Aspire (match PO, post bill)
  3. If type == 'overhead'  → QBO (use default GL from vendor rule)
  4. If type == 'mixed':
       - PO# on invoice or override → Aspire
       - No PO#                     → QBO
  5. Vendor not found               → Exception queue
       Exception: doc_type == 'mastercard' → use MASTERCARD_FALLBACK_GL
  6. PO# not validated in Aspire    → Exception queue

MasterCard receipts use post_purchase() instead of post_bill() in QBO.
"""

import logging
from enum import Enum
from typing import Optional

from app.models.invoice import Invoice, InvoiceStatus, RoutingDecision
from app.models.vendor import VendorRule, VendorType
from app.services.aspire import AspireClient
from app.services.qbo import QBOClient
from app.core.database import Database
from app.core.config import settings


def _aspire_configured() -> bool:
    """True only when Aspire credentials are fully set up and not default placeholders."""
    return bool(
        settings.ASPIRE_TOKEN_URL
        and settings.ASPIRE_CLIENT_ID
        and settings.ASPIRE_CLIENT_SECRET
        and "youraspire.com/token" not in settings.ASPIRE_TOKEN_URL
    )

# Fallback GL account when a MasterCard vendor is not in vendor_rules.
# This is the "General overhead" catch-all account — AP can recode later.
MASTERCARD_FALLBACK_GL = "6999"

logger = logging.getLogger(__name__)


class RoutingOutcome(str, Enum):
    POSTED_ASPIRE = "posted_aspire"
    POSTED_QBO    = "posted_qbo"
    QUEUED        = "queued"        # needs human input
    ERROR         = "error"


async def route_invoice(
    invoice: Invoice,
    db: Database,
    aspire: AspireClient,
    qbo: QBOClient,
    employee_name: Optional[str] = None,
) -> RoutingOutcome:
    """
    Main entry point. Called after an invoice has been extracted.
    Returns a RoutingOutcome and mutates invoice.status in the DB.
    employee_name: passed through to QBO private note for MC/expense receipts.
    """
    logger.info(f"Routing invoice {invoice.id} — vendor: {invoice.vendor_name}")

    # ── Credit memos are handled by email_intake._process_credit_memo_email ──
    # They should never reach the general router, but guard against it.
    if invoice.doc_type == "credit_memo":
        logger.warning(f"Credit memo {invoice.id} reached general router — queuing for review")
        await _queue(invoice, db, reason="credit_memo_unexpected")
        return RoutingOutcome.QUEUED

    # ── GL override from frontend confirmation step ───────────────────────────
    # If the user confirmed (or corrected) a GL account before submitting, use it
    # directly and skip vendor rule lookup for the GL.
    if invoice.gl_account:
        logger.info(f"Using user-confirmed GL '{invoice.gl_account}' for invoice {invoice.id}")
        if invoice.doc_type == "mastercard":
            return await _route_to_qbo_purchase(invoice, invoice.gl_account, db, qbo, employee_name, gl_name=None)
        return await _route_to_qbo(invoice, invoice.gl_account, db, qbo, employee_name, gl_name=None)

    # ── Step 1: Vendor lookup ─────────────────────────────────────────────────
    vendor_rule = await db.get_vendor_rule_by_name(invoice.vendor_name)

    if vendor_rule is None:
        # MasterCard receipts with unknown vendors get posted to a fallback GL
        # rather than going to the exception queue — AP can recode later.
        if invoice.doc_type == "mastercard":
            logger.info(
                f"Unknown MC vendor '{invoice.vendor_name}' — "
                f"posting to fallback GL {MASTERCARD_FALLBACK_GL}"
            )
            return await _route_to_qbo_purchase(
                invoice, MASTERCARD_FALLBACK_GL, db, qbo, employee_name
            )
        logger.warning(f"Unknown vendor '{invoice.vendor_name}' — queuing for review")
        await _queue(invoice, db, reason="vendor_unknown")
        return RoutingOutcome.QUEUED

    # ── Step 2: Resolve the effective PO number ───────────────────────────────
    # Manual override takes precedence over what was on the invoice.
    effective_po = invoice.po_number_override or invoice.po_number

    # ── Step 3: Apply routing rules ───────────────────────────────────────────
    decision = _decide(vendor_rule, effective_po)

    # ── Step 4: Execute the decision ──────────────────────────────────────────
    if decision == RoutingDecision.ASPIRE:
        return await _route_to_aspire(invoice, effective_po, db, aspire, vendor_rule=vendor_rule)

    elif decision == RoutingDecision.QBO:
        gl_account = vendor_rule.default_gl_account
        gl_name    = vendor_rule.default_gl_name
        if not gl_account:
            if invoice.doc_type == "mastercard":
                gl_account = MASTERCARD_FALLBACK_GL
                gl_name    = "General Overhead"
                logger.info(f"No GL for MC vendor '{invoice.vendor_name}' — using fallback {gl_account}")
            else:
                logger.warning(f"No GL account for vendor '{invoice.vendor_name}' — queuing")
                await _queue(invoice, db, reason="no_gl_account")
                return RoutingOutcome.QUEUED
        if invoice.doc_type == "mastercard":
            return await _route_to_qbo_purchase(invoice, gl_account, db, qbo, employee_name, gl_name=gl_name)
        return await _route_to_qbo(invoice, gl_account, db, qbo, employee_name, gl_name=gl_name)

    else:  # QUEUE
        # Use a meaningful reason depending on why we're queuing
        if vendor_rule.type == VendorType.JOB_COST or (
            vendor_rule.type == VendorType.MIXED and effective_po
        ):
            reason = "aspire_not_configured"
        else:
            reason = "mixed_vendor_no_po"
        await _queue(invoice, db, reason=reason)
        # Notify the assigned contact (e.g. Keeland) so they can enter it in Aspire
        await _notify_queued(invoice, vendor_rule, reason)
        return RoutingOutcome.QUEUED


def _decide(vendor_rule: VendorRule, effective_po: Optional[str]) -> RoutingDecision:
    """
    Pure function — no I/O. Makes the routing decision based on vendor
    type and whether a PO number is available.
    When Aspire is not configured, job_cost invoices queue for manual review.
    """
    aspire_up = _aspire_configured()

    if vendor_rule.type == VendorType.JOB_COST:
        return RoutingDecision.ASPIRE if aspire_up else RoutingDecision.QUEUE

    elif vendor_rule.type == VendorType.OVERHEAD:
        return RoutingDecision.QBO

    elif vendor_rule.type == VendorType.MIXED:
        if effective_po and aspire_up:
            return RoutingDecision.ASPIRE
        elif effective_po:
            return RoutingDecision.QUEUE  # has PO but Aspire not ready
        else:
            return RoutingDecision.QBO   # no PO → overhead GL

    # Fallback — should not reach here
    return RoutingDecision.QUEUE


async def _route_to_aspire(
    invoice: Invoice,
    po_number: Optional[str],
    db: Database,
    aspire: AspireClient,
    vendor_rule=None,
) -> RoutingOutcome:
    """Validate PO in Aspire, then post the bill."""

    if not po_number:
        # Job-cost vendor but no PO — queue for manual PO entry
        logger.warning(f"Job-cost vendor '{invoice.vendor_name}' has no PO — queuing")
        await _queue(invoice, db, reason="job_cost_no_po")
        return RoutingOutcome.QUEUED

    # Validate PO exists and is open in Aspire
    po_data = await aspire.get_purchase_order(po_number)

    if po_data is None:
        logger.warning(f"PO '{po_number}' not found in Aspire — queuing invoice {invoice.id}")
        await _queue(invoice, db, reason="po_not_found", detail={"po_number": po_number})
        return RoutingOutcome.QUEUED

    if po_data.get("status") == "Closed":
        logger.warning(f"PO '{po_number}' is closed in Aspire — queuing invoice {invoice.id}")
        await _queue(invoice, db, reason="po_closed", detail={"po_number": po_number})
        return RoutingOutcome.QUEUED

    # Post the bill
    try:
        receipt_id = await aspire.post_bill(invoice, po_data, vendor_rule=vendor_rule)
        await db.mark_posted_aspire(invoice.id, receipt_id, po_data["OpportunityID"])
        await db.audit(invoice.id, "posted", "system", {
            "destination": "aspire",
            "receipt_id": receipt_id,
            "po_number": po_number,
        })
        logger.info(f"Invoice {invoice.id} posted to Aspire — receipt {receipt_id}")
        return RoutingOutcome.POSTED_ASPIRE

    except Exception as e:
        logger.error(f"Aspire post failed for invoice {invoice.id}: {e}")
        await db.mark_error(invoice.id, str(e))
        return RoutingOutcome.ERROR


async def _resolve_gl_name(gl_account: str, gl_name: Optional[str], qbo: QBOClient) -> Optional[str]:
    """If gl_name is missing, look it up from the QBO chart of accounts."""
    if gl_name:
        return gl_name
    try:
        accounts = await qbo.list_expense_accounts()
        for acc in accounts:
            if acc.get("AcctNum") == gl_account:
                return acc.get("Name")
    except Exception as e:
        logger.debug(f"GL name lookup failed for {gl_account}: {e}")
    return None


async def _route_to_qbo(
    invoice: Invoice,
    gl_account: str,
    db: Database,
    qbo: QBOClient,
    employee_name: Optional[str] = None,
    gl_name: Optional[str] = None,
) -> RoutingOutcome:
    """Post the bill to QBO against the resolved GL account."""

    gl_name = await _resolve_gl_name(gl_account, gl_name, qbo)

    try:
        bill_id, qbo_amount = await qbo.post_bill(
            invoice,
            gl_account,
            file_bytes=invoice.file_bytes,
            filename=invoice.pdf_filename,
        )
        await db.mark_posted_qbo(invoice.id, bill_id, gl_account, gl_name=gl_name, qbo_amount=qbo_amount)
        await db.audit(invoice.id, "posted", "system", {
            "destination": "qbo",
            "bill_id": bill_id,
            "gl_account": gl_account,
            "gl_name": gl_name,
            "qbo_amount": qbo_amount,
        })
        logger.info(f"Invoice {invoice.id} posted to QBO — bill {bill_id}, GL {gl_account} ({gl_name}), TotalAmt: {qbo_amount}")

        # Send confirmation email if this was an employee/field submission
        if employee_name:
            emp_rule = await db.get_vendor_rule_by_name(employee_name)
            if emp_rule and emp_rule.forward_to:
                from app.services.email_intake import send_qbo_confirmation
                await send_qbo_confirmation(
                    to_address=emp_rule.forward_to,
                    vendor_name=invoice.vendor_name or "Unknown vendor",
                    total_amount=invoice.total_amount or 0,
                    gl_name=gl_name or gl_account,
                    qbo_id=bill_id,
                    txn_date=invoice.invoice_date,
                    file_bytes=invoice.file_bytes,
                    filename=invoice.pdf_filename,
                )

        return RoutingOutcome.POSTED_QBO

    except Exception as e:
        logger.error(f"QBO post failed for invoice {invoice.id}: {e}")
        await db.mark_error(invoice.id, str(e))
        return RoutingOutcome.ERROR


async def _route_to_qbo_purchase(
    invoice: Invoice,
    gl_account: str,
    db: Database,
    qbo: QBOClient,
    employee_name: Optional[str] = None,
    gl_name: Optional[str] = None,
) -> RoutingOutcome:
    """Post a MasterCard receipt to QBO as a Purchase (CreditCardCharge)."""
    gl_name = await _resolve_gl_name(gl_account, gl_name, qbo)
    try:
        purchase_id = await qbo.post_purchase(
            invoice,
            gl_account,
            employee_name=employee_name,
            file_bytes=invoice.file_bytes,
            filename=invoice.pdf_filename,
        )
        await db.mark_posted_qbo(invoice.id, purchase_id, gl_account, gl_name=gl_name)
        await db.audit(invoice.id, "posted", "system", {
            "destination": "qbo",
            "bill_id": purchase_id,
            "gl_account": gl_account,
            "gl_name": gl_name,
            "type": "purchase",
        })
        logger.info(f"Invoice {invoice.id} posted to QBO as purchase — id: {purchase_id}, GL {gl_account} ({gl_name})")

        # Send confirmation email to the employee who made the purchase
        if employee_name:
            emp_rule = await db.get_vendor_rule_by_name(employee_name)
            if emp_rule and emp_rule.forward_to:
                from app.services.email_intake import send_qbo_confirmation
                await send_qbo_confirmation(
                    to_address=emp_rule.forward_to,
                    vendor_name=invoice.vendor_name or "Unknown vendor",
                    total_amount=invoice.total_amount or 0,
                    gl_name=gl_name or gl_account,
                    qbo_id=purchase_id,
                    txn_date=invoice.invoice_date,
                    file_bytes=invoice.file_bytes,
                    filename=invoice.pdf_filename,
                )

        return RoutingOutcome.POSTED_QBO

    except Exception as e:
        logger.error(f"QBO purchase post failed for invoice {invoice.id}: {e}")
        await db.mark_error(invoice.id, str(e))
        return RoutingOutcome.ERROR


async def _notify_queued(invoice: Invoice, vendor_rule, reason: str) -> None:
    """
    Email the vendor's assigned contact when a job-cost invoice queues for Aspire.
    Silently swallows failures so a missed email never blocks the queue write.
    """
    if not vendor_rule or not vendor_rule.forward_to:
        return
    try:
        from app.services.email_intake import GraphClient
        if not settings.MS_AP_INBOX:
            logger.warning("MS_AP_INBOX not set — skipping queue notification email")
            return

        po_info = invoice.po_number_override or invoice.po_number or "none on file"
        amount  = f"${invoice.total_amount:,.2f}" if invoice.total_amount else "unknown"
        reason_label = {
            "aspire_not_configured": "Aspire not yet connected — manual entry required",
            "mixed_vendor_no_po":    "No PO number found on invoice",
            "job_cost_no_po":        "No PO number — cannot post to Aspire",
        }.get(reason, reason.replace("_", " ").title())

        graph = GraphClient()
        try:
            await graph.send_email(
                mailbox=settings.MS_AP_INBOX,
                to_addresses=[vendor_rule.forward_to],
                subject=f"Invoice queued for review — {invoice.vendor_name or 'Unknown vendor'} {amount}",
                body_html=f"""
<html><body style="font-family:Arial,sans-serif;color:#1a1d23;max-width:600px">
<div style="background:#1e3a2f;padding:20px 24px;border-radius:8px 8px 0 0">
  <h2 style="color:#fff;margin:0;font-size:18px">📋 Invoice Pending — Action Required</h2>
</div>
<div style="background:#fff;border:1px solid #e2e6ed;border-top:none;padding:24px;border-radius:0 0 8px 8px">
  <p style="margin:0 0 16px;color:#374151">
    An invoice has been received and is waiting for manual entry into Aspire.
    The original invoice is attached.
  </p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr><td style="padding:8px 0;color:#6b7280;width:140px">Vendor</td>
        <td style="padding:8px 0;font-weight:600">{invoice.vendor_name or '—'}</td></tr>
    <tr style="border-top:1px solid #f0f0f0">
        <td style="padding:8px 0;color:#6b7280">Amount</td>
        <td style="padding:8px 0;font-weight:600">{amount}</td></tr>
    <tr style="border-top:1px solid #f0f0f0">
        <td style="padding:8px 0;color:#6b7280">PO Number</td>
        <td style="padding:8px 0">{po_info}</td></tr>
    <tr style="border-top:1px solid #f0f0f0">
        <td style="padding:8px 0;color:#6b7280">Invoice #</td>
        <td style="padding:8px 0">{invoice.invoice_number or '—'}</td></tr>
    <tr style="border-top:1px solid #f0f0f0">
        <td style="padding:8px 0;color:#6b7280">Invoice Date</td>
        <td style="padding:8px 0">{invoice.invoice_date or '—'}</td></tr>
    <tr style="border-top:1px solid #f0f0f0">
        <td style="padding:8px 0;color:#6b7280">Status</td>
        <td style="padding:8px 0;color:#b45309;font-weight:600">{reason_label}</td></tr>
  </table>
  <p style="margin:24px 0 0">
    <a href="https://darios-ap.pages.dev/ap"
       style="background:#1e3a2f;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">
      Open AP Dashboard
    </a>
  </p>
  <p style="margin:16px 0 0;font-size:12px;color:#9ca3af">
    AP Automation · Dario's Landscape Services
  </p>
</div>
</body></html>""",
                attachment_bytes=invoice.file_bytes,
                attachment_filename=invoice.pdf_filename or f"invoice_{invoice.id}.pdf",
            )
            logger.info(f"Queue notification sent to {vendor_rule.forward_to} for invoice {invoice.id}")
        finally:
            await graph.close()
    except Exception as e:
        logger.warning(f"Queue notification failed (non-fatal): {e}")


async def _queue(
    invoice: Invoice,
    db: Database,
    reason: str,
    detail: Optional[dict] = None,
) -> None:
    """Park the invoice in the exception queue with a reason."""
    await db.mark_queued(invoice.id, reason)
    await db.audit(invoice.id, "queued", "system", {
        "reason": reason,
        **(detail or {}),
    })
