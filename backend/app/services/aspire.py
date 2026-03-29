"""
Aspire API client — wraps the Aspire External REST API (OData v4).

Docs: https://guide.youraspire.com/apidocs
Base URL: https://cloud-api.youraspire.com
Auth: Bearer token (OAuth2 client credentials)

Receipt workflow:
  1. Look up VendorID from /Vendors by vendor name
  2. Look up WorkTicketID via Opportunity → OpportunityServices → WorkTickets
  3. POST to /Receipts with status "Received"
     - Received  = job cost recorded, waiting for approval
     - Approved  = triggers QBO export (handled by Aspire, not us)
"""

import logging
import re
from typing import Optional

import httpx

from app.core.config import settings
from app.models.invoice import Invoice

logger = logging.getLogger(__name__)

PRODUCTION_BASE = "https://cloud-api.youraspire.com"
SANDBOX_BASE    = "https://cloudsandbox-api.youraspire.com"


def _normalize_date(date_str: Optional[str]) -> Optional[str]:
    """Normalize any date format to YYYY-MM-DD for Aspire."""
    if not date_str:
        return None
    # MM/DD/YYYY → YYYY-MM-DD
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})$', date_str.strip())
    if m:
        return f"{m.group(3)}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"
    return date_str


class AspireClient:
    def __init__(self, sandbox: bool = False):
        self.base_url = SANDBOX_BASE if sandbox else PRODUCTION_BASE
        self._token: Optional[str] = None
        self._http = httpx.AsyncClient(timeout=30.0)

    async def _get_token(self) -> str:
        """Fetch a Bearer token using client credentials."""
        if self._token:
            return self._token

        resp = await self._http.post(
            settings.ASPIRE_TOKEN_URL,
            data={
                "grant_type":    "client_credentials",
                "client_id":     settings.ASPIRE_CLIENT_ID,
                "client_secret": settings.ASPIRE_CLIENT_SECRET,
            },
        )
        resp.raise_for_status()
        self._token = resp.json()["access_token"]
        return self._token

    async def _get(self, path: str, params: dict = None) -> dict:
        token = await self._get_token()
        resp = await self._http.get(
            f"{self.base_url}/{path.lstrip('/')}",
            params=params,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json;odata.metadata=minimal",
            },
        )
        resp.raise_for_status()
        return resp.json()

    async def _post(self, path: str, body: dict) -> dict:
        token = await self._get_token()
        resp = await self._http.post(
            f"{self.base_url}/{path.lstrip('/')}",
            json=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        if not resp.is_success:
            logger.error(
                f"Aspire POST {path} failed {resp.status_code}: {resp.text[:500]}"
            )
        resp.raise_for_status()
        return resp.json()

    # ── PO / Opportunity lookup ───────────────────────────────────────────────

    async def get_purchase_order(self, po_number: str) -> Optional[dict]:
        """
        Look up a PO/Opportunity in Aspire by CustomerPONum.
        Expands OpportunityServices and their WorkTickets in the same call
        so post_bill doesn't need extra round-trips.
        Returns the first matching record, or None if not found.
        """
        logger.info(f"Looking up PO '{po_number}' in Aspire")
        try:
            result = await self._get(
                "Opportunities",
                params={
                    "$filter": f"CustomerPONum eq '{po_number}'",
                    "$top": 1,
                    "$expand": "OpportunityServices($expand=WorkTickets)",
                },
            )
            records = result.get("value", result if isinstance(result, list) else [])
            if records:
                opp_id = records[0].get("OpportunityID")
                svc_count = len(records[0].get("OpportunityServices") or [])
                logger.info(
                    f"PO '{po_number}' found — OpportunityID {opp_id}, "
                    f"{svc_count} service(s) expanded"
                )
                return records[0]
            logger.warning(f"PO '{po_number}' not found in Aspire")
            return None
        except httpx.HTTPStatusError as e:
            logger.error(f"Aspire PO lookup failed: {e}")
            return None

    async def validate_po(self, po_number: str) -> tuple[bool, Optional[str]]:
        """
        Validate a PO number. Returns (is_valid, error_message).
        Checks: exists, not closed/cancelled.
        """
        po = await self.get_purchase_order(po_number)
        if po is None:
            return False, f"PO '{po_number}' not found in Aspire"
        status = po.get("OpportunityStatusName", "")
        if "cancel" in status.lower() or "closed" in status.lower():
            return False, f"PO '{po_number}' is {status}"
        return True, None

    # ── Vendor lookup ─────────────────────────────────────────────────────────

    async def get_vendor_id(self, vendor_name: str) -> Optional[int]:
        """
        Look up a vendor in Aspire /Vendors by name.
        Returns the integer VendorID, or None if not found.
        """
        if not vendor_name:
            return None
        escaped = vendor_name.replace("'", "''")
        try:
            result = await self._get(
                "Vendors",
                params={
                    "$filter": f"contains(VendorName, '{escaped}')",
                    "$top": 5,
                },
            )
            records = result.get("value", result if isinstance(result, list) else [])
            if records:
                vid = (
                    records[0].get("VendorID")
                    or records[0].get("Id")
                    or records[0].get("id")
                )
                logger.info(f"Aspire vendor '{vendor_name}' → VendorID {vid}")
                return int(vid) if vid is not None else None
            logger.warning(f"Aspire vendor '{vendor_name}' not found in /Vendors")
            return None
        except Exception as e:
            logger.error(f"Aspire vendor lookup failed for '{vendor_name}': {e}")
            return None

    # ── Work ticket lookup ────────────────────────────────────────────────────

    async def get_work_tickets_for_opportunity(
        self, opportunity_id, po_data: dict = None
    ) -> list[dict]:
        """
        Get work tickets for an Opportunity.

        Aspire data model:
          Opportunity → OpportunityServices → WorkTickets

        Resolution order:
          1. Extract from already-expanded po_data (zero extra API calls)
          2. Direct WorkTickets $filter on OpportunityID
          3. OpportunityServices chain with $expand=WorkTickets
        """
        opp_id = str(opportunity_id)

        # ── Attempt 1: extract from expanded po_data ──────────────────────────
        if po_data:
            services = po_data.get("OpportunityServices") or []
            if services:
                tickets = []
                for svc in services:
                    tickets.extend(svc.get("WorkTickets") or [])
                if tickets:
                    logger.info(
                        f"Got {len(tickets)} work tickets from expanded po_data "
                        f"(OpportunityID={opp_id})"
                    )
                    return tickets

        # ── Attempt 2: direct $filter on WorkTickets ──────────────────────────
        try:
            wt_result = await self._get(
                "WorkTickets",
                params={
                    "$filter": f"OpportunityID eq {opp_id}",
                    "$top": 50,
                },
            )
            tickets = wt_result.get("value", wt_result if isinstance(wt_result, list) else [])
            if tickets:
                logger.info(
                    f"Got {len(tickets)} work tickets via direct "
                    f"OpportunityID={opp_id} filter"
                )
                return tickets
        except Exception as e:
            logger.debug(f"Direct WorkTicket filter failed (will try via services): {e}")

        # ── Attempt 3: OpportunityServices $expand WorkTickets ────────────────
        try:
            svc_result = await self._get(
                "OpportunityServices",
                params={
                    "$filter": f"OpportunityID eq {opp_id}",
                    "$top": 50,
                    "$expand": "WorkTickets",
                },
            )
            services = svc_result.get("value", svc_result if isinstance(svc_result, list) else [])
            if not services:
                logger.warning(f"No OpportunityServices found for OpportunityID {opp_id}")
                return []

            tickets = []
            for svc in services:
                tickets.extend(svc.get("WorkTickets") or [])

            if tickets:
                logger.info(
                    f"Got {len(tickets)} work tickets via OpportunityServices "
                    f"$expand for OpportunityID={opp_id}"
                )
                return tickets

            # Last resort: fetch WorkTickets by ServiceID with proper OData grouping
            svc_ids = [
                s.get("OpportunityServiceID")
                for s in services
                if s.get("OpportunityServiceID")
            ]
            if not svc_ids:
                return []

            # OData OR — group in parentheses per spec
            or_clauses = " or ".join(
                f"OpportunityServiceID eq {sid}" for sid in svc_ids[:10]
            )
            wt_result = await self._get(
                "WorkTickets",
                params={"$filter": f"({or_clauses})", "$top": 50},
            )
            tickets = wt_result.get("value", wt_result if isinstance(wt_result, list) else [])
            logger.info(
                f"Got {len(tickets)} work tickets via ServiceID OR filter "
                f"for OpportunityID={opp_id}"
            )
            return tickets

        except Exception as e:
            logger.error(f"Work ticket lookup failed for OpportunityID {opp_id}: {e}")
            return []

    # ── Bill / Receipt creation ───────────────────────────────────────────────

    async def post_bill(self, invoice: Invoice, po_data: dict, vendor_rule=None) -> str:
        """
        Create a Receipt (AP bill) in Aspire matched to the given Opportunity/PO.
        Sets status to "Received" — Aspire will export to QBO when Approved.
        Returns the Aspire ReceiptID as a string.

        Raises ValueError if BranchID is not configured or no work ticket found.
        Raises httpx.HTTPStatusError on API failure.
        """
        opportunity_id = po_data.get("OpportunityID")
        if not opportunity_id:
            raise ValueError(f"po_data missing OpportunityID: {po_data}")

        # ── Guard: BranchID must be configured ────────────────────────────────
        branch_id = settings.ASPIRE_BRANCH_ID
        if not branch_id:
            raise ValueError(
                "ASPIRE_BRANCH_ID is not set. Add it as a Railway env var. "
                "Find it in Aspire: Settings → Branches — it's the integer ID "
                "(e.g. 1, 2, 3 — not the UUID company ID)."
            )

        # ── Vendor lookup ──────────────────────────────────────────────────────
        # Use cached Aspire VendorID from vendor_rules table if available.
        # Fall back to searching /Vendors by name (vendors sync from QBO).
        vendor_id: Optional[int] = None
        if vendor_rule and vendor_rule.vendor_id_aspire:
            try:
                vendor_id = int(vendor_rule.vendor_id_aspire)
                logger.info(
                    f"Using cached Aspire VendorID {vendor_id} "
                    f"for '{invoice.vendor_name}'"
                )
            except (ValueError, TypeError):
                pass

        if vendor_id is None:
            vendor_id = await self.get_vendor_id(invoice.vendor_name or "")
            if vendor_id is None:
                raise ValueError(
                    f"Vendor '{invoice.vendor_name}' not found in Aspire /Vendors. "
                    "The vendor should be present if it was synced from QBO — "
                    "check the vendor name matches exactly, or set vendor_id_aspire "
                    "in the /vendors page."
                )

        # ── Work ticket lookup ─────────────────────────────────────────────────
        # Pass po_data so expanded services/tickets are used without extra calls
        work_tickets = await self.get_work_tickets_for_opportunity(
            opportunity_id, po_data=po_data
        )
        if not work_tickets:
            raise ValueError(
                f"No work tickets found for OpportunityID {opportunity_id}. "
                "Ensure the opportunity has active work tickets in Aspire."
            )

        # Prefer a "Subs" or "Other" type work ticket; fall back to first open one
        def ticket_priority(t: dict) -> int:
            wt_type = (t.get("WorkTicketType") or t.get("TicketType") or "").lower()
            if wt_type in ("subs", "sub"):       return 0
            if wt_type in ("other",):             return 1
            if wt_type in ("material", "materials"): return 2
            return 9

        work_tickets_sorted = sorted(work_tickets, key=ticket_priority)
        chosen_ticket = work_tickets_sorted[0]
        work_ticket_id = (
            chosen_ticket.get("WorkTicketID")
            or chosen_ticket.get("Id")
            or chosen_ticket.get("id")
        )
        logger.info(
            f"Using WorkTicketID {work_ticket_id} "
            f"(type={chosen_ticket.get('WorkTicketType') or chosen_ticket.get('TicketType')}) "
            f"for OpportunityID {opportunity_id}"
        )

        # ── Build receipt items ────────────────────────────────────────────────
        # If the invoice has extracted line items, post them individually.
        # Otherwise create a single summary line from the total.
        if invoice.line_items:
            receipt_items = [
                {
                    "ItemName":     li.description or "Invoice line",
                    "ItemQuantity": li.quantity if li.quantity is not None else 1,
                    "ItemUnitCost": li.unit_price if li.unit_price is not None else li.amount,
                    "ItemType":     "other",
                    "ItemAllocations": [
                        {
                            "WorkTicketID":      work_ticket_id,
                            "AllocationPercent": 100,
                        }
                    ],
                }
                for li in invoice.line_items
            ]
        else:
            receipt_items = [
                {
                    "ItemName":     f"Invoice {invoice.invoice_number or '—'}",
                    "ItemQuantity": 1,
                    "ItemUnitCost": float(invoice.total_amount or 0),
                    "ItemType":     "other",
                    "ItemAllocations": [
                        {
                            "WorkTicketID":      work_ticket_id,
                            "AllocationPercent": 100,
                        }
                    ],
                }
            ]

        # ── Build the POST body ────────────────────────────────────────────────
        body = {
            "BranchID":           branch_id,
            "VendorID":           vendor_id,
            "VendorInvoiceNum":   invoice.invoice_number or "",
            "VendorInvoiceDate":  _normalize_date(invoice.invoice_date),
            "ReceiptStatusName":  "Received",
            "Notes": (
                f"Auto-posted by AP Automation | "
                f"PO: {invoice.po_number or po_data.get('CustomerPONum') or '—'} | "
                f"File: {invoice.pdf_filename or '—'}"
            ),
            "ReceiptItems": receipt_items,
        }

        logger.info(
            f"Posting receipt to Aspire — "
            f"OpportunityID {opportunity_id}, VendorID {vendor_id}, "
            f"WorkTicketID {work_ticket_id}, "
            f"total ${invoice.total_amount}"
        )

        result = await self._post("Receipts", body)

        receipt_id = (
            result.get("ReceiptID")
            or result.get("receiptId")
            or result.get("Id")
            or result.get("id")
            or result.get("value")
        )
        if receipt_id is None:
            logger.warning(f"Aspire Receipts POST returned no ID — full response: {result}")
            receipt_id = "unknown"

        return str(receipt_id)

    async def close(self):
        await self._http.aclose()
