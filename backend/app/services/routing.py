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
        return await _route_to_aspire(invoice, effective_po, db, aspire)

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
        await _queue(invoice, db, reason="mixed_vendor_no_po")
        return RoutingOutcome.QUEUED


def _decide(vendor_rule: VendorRule, effective_po: Optional[str]) -> RoutingDecision:
    """
    Pure function — no I/O. Makes the routing decision based on vendor
    type and whether a PO number is available.
    """
    if vendor_rule.type == VendorType.JOB_COST:
        return RoutingDecision.ASPIRE

    elif vendor_rule.type == VendorType.OVERHEAD:
        return RoutingDecision.QBO

    elif vendor_rule.type == VendorType.MIXED:
        if effective_po:
            return RoutingDecision.ASPIRE
        else:
            return RoutingDecision.QUEUE

    # Fallback — should not reach here
    return RoutingDecision.QUEUE


async def _route_to_aspire(
    invoice: Invoice,
    po_number: Optional[str],
    db: Database,
    aspire: AspireClient,
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
        receipt_id = await aspire.post_bill(invoice, po_data)
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
        bill_id = await qbo.post_bill(
            invoice,
            gl_account,
            file_bytes=invoice.file_bytes,
            filename=invoice.pdf_filename,
        )
        await db.mark_posted_qbo(invoice.id, bill_id, gl_account, gl_name=gl_name)
        await db.audit(invoice.id, "posted", "system", {
            "destination": "qbo",
            "bill_id": bill_id,
            "gl_account": gl_account,
            "gl_name": gl_name,
        })
        logger.info(f"Invoice {invoice.id} posted to QBO — bill {bill_id}, GL {gl_account} ({gl_name})")

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
