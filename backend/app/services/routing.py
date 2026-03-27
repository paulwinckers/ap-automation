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
  6. PO# not validated in Aspire    → Exception queue
"""

import logging
from enum import Enum
from typing import Optional

from app.models.invoice import Invoice, InvoiceStatus, RoutingDecision
from app.models.vendor import VendorRule, VendorType
from app.services.aspire import AspireClient
from app.services.qbo import QBOClient
from app.core.database import Database

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
) -> RoutingOutcome:
    """
    Main entry point. Called after an invoice has been extracted.
    Returns a RoutingOutcome and mutates invoice.status in the DB.
    """
    logger.info(f"Routing invoice {invoice.id} — vendor: {invoice.vendor_name}")

    # ── Step 1: Vendor lookup ─────────────────────────────────────────────────
    vendor_rule = await db.get_vendor_rule_by_name(invoice.vendor_name)

    if vendor_rule is None:
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
        if not gl_account:
            logger.warning(f"No GL account for vendor '{invoice.vendor_name}' — queuing")
            await _queue(invoice, db, reason="no_gl_account")
            return RoutingOutcome.QUEUED
        return await _route_to_qbo(invoice, gl_account, db, qbo)

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


async def _route_to_qbo(
    invoice: Invoice,
    gl_account: str,
    db: Database,
    qbo: QBOClient,
) -> RoutingOutcome:
    """Post the bill to QBO against the resolved GL account."""

    try:
        bill_id = await qbo.post_bill(
            invoice,
            gl_account,
            file_bytes=invoice.file_bytes,
            filename=invoice.pdf_filename,
        )
        await db.mark_posted_qbo(invoice.id, bill_id, gl_account)
        await db.audit(invoice.id, "posted", "system", {
            "destination": "qbo",
            "bill_id": bill_id,
            "gl_account": gl_account,
        })
        logger.info(f"Invoice {invoice.id} posted to QBO — bill {bill_id}")
        return RoutingOutcome.POSTED_QBO

    except Exception as e:
        logger.error(f"QBO post failed for invoice {invoice.id}: {e}")
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
