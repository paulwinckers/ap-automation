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
import time
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
        self._token_expires_at: float = 0.0
        self._http = httpx.AsyncClient(timeout=30.0)

    async def _get_token(self) -> str:
        """Fetch a Bearer token via POST /Authorization (valid 24 hours)."""
        if self._token and time.time() < self._token_expires_at:
            return self._token

        resp = await self._http.post(
            f"{self.base_url}/Authorization",
            json={
                "ClientId": settings.ASPIRE_CLIENT_ID,
                "Secret":   settings.ASPIRE_CLIENT_SECRET,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        self._token = data["Token"]
        # Tokens are valid 24 hours; refresh after 23 to be safe
        self._token_expires_at = time.time() + 23 * 3600
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

    @staticmethod
    def _extract_list(result) -> list:
        """
        Normalise Aspire API responses — handles both:
          - OData wrapper: {"value": [...], "@odata.count": N}
          - Raw list:      [...]
        """
        if isinstance(result, list):
            return result
        return result.get("value", [])

    async def _patch(self, path: str, body: dict) -> dict:
        """PATCH (partial update) an Aspire resource."""
        token = await self._get_token()
        resp = await self._http.patch(
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
                f"Aspire PATCH {path} failed {resp.status_code}: {resp.text[:500]}"
            )
        resp.raise_for_status()
        # 204 No Content is a valid success response
        return resp.json() if resp.content else {}

    async def _put(self, path: str, body: dict) -> dict:
        """PUT (full replace) an Aspire resource."""
        token = await self._get_token()
        resp = await self._http.put(
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
                f"Aspire PUT {path} failed {resp.status_code}: {resp.text[:500]}"
            )
        resp.raise_for_status()
        return resp.json() if resp.content else {}

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
        Look up an Opportunity in Aspire by PO number.

        Search order:
          1. Opportunities.CustomerPONum  (contract-level PO)
          2. Jobs.CustomerPO              (job-level PO) → resolves to its Opportunity

        Expands OpportunityServices → WorkTickets in the same call so
        post_bill doesn't need extra round-trips.
        Returns the Opportunity record, or None if not found.
        """
        logger.info(f"Looking up PO '{po_number}' in Aspire")

        # ── 1. Opportunity-level PO ────────────────────────────────────────────
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
                    f"PO '{po_number}' found on Opportunity — "
                    f"OpportunityID {opp_id}, {svc_count} service(s) expanded"
                )
                return records[0]
        except httpx.HTTPStatusError as e:
            logger.error(f"Aspire Opportunity PO lookup failed: {e}")
            return None

        # ── 2. Job-level PO → resolve to Opportunity ──────────────────────────
        logger.info(
            f"PO '{po_number}' not on Opportunity — trying Jobs.CustomerPO"
        )
        try:
            job_result = await self._get(
                "Jobs",
                params={
                    "$filter": f"CustomerPO eq '{po_number}'",
                    "$top": 1,
                },
            )
            jobs = job_result.get("value", job_result if isinstance(job_result, list) else [])
            if not jobs:
                logger.warning(f"PO '{po_number}' not found in Opportunities or Jobs")
                return None

            job = jobs[0]
            opportunity_id = job.get("OpportunityID")
            if not opportunity_id:
                logger.warning(
                    f"Job found for PO '{po_number}' but has no OpportunityID"
                )
                return None

            # Check job isn't cancelled
            if job.get("CancelDate"):
                logger.warning(
                    f"Job for PO '{po_number}' was cancelled on {job['CancelDate']}"
                )
                return None

            logger.info(
                f"PO '{po_number}' found on Job — "
                f"JobID {job.get('JobID')}, OpportunityID {opportunity_id}"
            )

            # Fetch the full Opportunity with expanded services/tickets
            opp_result = await self._get(
                "Opportunities",
                params={
                    "$filter": f"OpportunityID eq {opportunity_id}",
                    "$top": 1,
                    "$expand": "OpportunityServices($expand=WorkTickets)",
                },
            )
            opp_records = opp_result.get("value", opp_result if isinstance(opp_result, list) else [])
            if opp_records:
                # Preserve the CustomerPO so routing.py can log it
                opp_records[0].setdefault("CustomerPONum", po_number)
                return opp_records[0]

            logger.warning(
                f"Could not fetch Opportunity {opportunity_id} for Job PO '{po_number}'"
            )
            return None

        except httpx.HTTPStatusError as e:
            logger.error(f"Aspire Job PO lookup failed: {e}")
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

    # ── Work ticket items ─────────────────────────────────────────────────────

    async def get_work_ticket_items(self, work_ticket_id: int) -> list[dict]:
        """
        Fetch WorkTicketItems for a given WorkTicketID.
        These are the budgeted line items (Sub, Material, Equipment, Other, Labor, Kit).
        Linking receipts to a WorkTicketItemID lets Aspire track budget vs. actual.
        """
        try:
            result = await self._get(
                "WorkTicketItems",
                params={
                    "$filter": f"WorkTicketID eq {work_ticket_id}",
                    "$top": 50,
                },
            )
            items = result.get("value", result if isinstance(result, list) else [])
            logger.info(
                f"Got {len(items)} WorkTicketItems for WorkTicketID={work_ticket_id}"
            )
            return items
        except Exception as e:
            logger.warning(
                f"WorkTicketItems lookup failed for WorkTicketID={work_ticket_id}: {e}"
            )
            return []

    def _pick_work_ticket_item(
        self, items: list[dict], preferred_type: str
    ) -> Optional[dict]:
        """
        Pick the best WorkTicketItem to allocate a receipt line to.
        Matches on ItemType first, then falls back to first non-labor item.
        preferred_type: 'Sub', 'Other', 'Material', 'Equipment'
        """
        preferred_lower = preferred_type.lower()
        # Exact type match
        for item in items:
            if (item.get("ItemType") or "").lower() == preferred_lower:
                return item
        # Any non-labor, non-kit item as fallback
        for item in items:
            t = (item.get("ItemType") or "").lower()
            if t not in ("labor", "kit"):
                return item
        return items[0] if items else None

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

        # ── Filter out closed work tickets ────────────────────────────────────
        # Posting a cost to a closed work ticket is treated as warranty in Aspire.
        # Only post to open/active tickets.
        def _is_closed(t: dict) -> bool:
            status = (
                t.get("WorkTicketStatusName")
                or t.get("StatusName")
                or t.get("Status")
                or ""
            ).lower()
            return "closed" in status or "complete" in status or "cancelled" in status

        open_tickets = [t for t in work_tickets if not _is_closed(t)]

        if not open_tickets:
            closed_statuses = [
                t.get("WorkTicketStatusName") or t.get("Status") or "unknown"
                for t in work_tickets
            ]
            raise ValueError(
                f"All work tickets for OpportunityID {opportunity_id} are closed "
                f"(statuses: {closed_statuses}). Posting to a closed work ticket "
                "creates a warranty entry — queuing for manual review."
            )

        # Prefer a "Subs" or "Other" type work ticket; fall back to first open one
        def ticket_priority(t: dict) -> int:
            wt_type = (t.get("WorkTicketType") or t.get("TicketType") or "").lower()
            if wt_type in ("subs", "sub"):          return 0
            if wt_type in ("other",):               return 1
            if wt_type in ("material", "materials"): return 2
            return 9

        work_tickets_sorted = sorted(open_tickets, key=ticket_priority)
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

        # ── Work ticket item lookup ────────────────────────────────────────────
        # Determine preferred item type based on vendor rule type
        vendor_type = getattr(vendor_rule, "type", None)
        preferred_item_type = "Sub" if str(vendor_type) in ("job_cost", "VendorType.JOB_COST") else "Other"

        wt_items = await self.get_work_ticket_items(work_ticket_id)
        chosen_item = self._pick_work_ticket_item(wt_items, preferred_item_type)
        work_ticket_item_id = (
            chosen_item.get("WorkTicketItemID") if chosen_item else None
        )
        if work_ticket_item_id:
            logger.info(
                f"Using WorkTicketItemID {work_ticket_item_id} "
                f"(ItemType={chosen_item.get('ItemType')}, "
                f"ItemName='{chosen_item.get('ItemName')}')"
            )
        else:
            logger.warning(
                f"No WorkTicketItems found for WorkTicketID={work_ticket_id} — "
                "allocating to WorkTicket only"
            )

        def _allocation(wt_id, wti_id) -> dict:
            alloc = {"WorkTicketID": wt_id, "AllocationPercent": 100}
            if wti_id:
                alloc["WorkTicketItemID"] = wti_id
            return alloc

        # ── Build receipt items ────────────────────────────────────────────────
        # If the invoice has extracted line items, post them individually.
        # Otherwise create a single summary line from the total.
        if invoice.line_items:
            receipt_items = [
                {
                    "ItemName":     li.description or "Invoice line",
                    "ItemQuantity": li.quantity if li.quantity is not None else 1,
                    "ItemUnitCost": li.unit_price if li.unit_price is not None else li.amount,
                    "ItemType":     preferred_item_type,
                    "ItemAllocations": [_allocation(work_ticket_id, work_ticket_item_id)],
                }
                for li in invoice.line_items
            ]
        else:
            receipt_items = [
                {
                    "ItemName":     f"Invoice {invoice.invoice_number or '—'}",
                    "ItemQuantity": 1,
                    "ItemUnitCost": float(invoice.total_amount or 0),
                    "ItemType":     preferred_item_type,
                    "ItemAllocations": [_allocation(work_ticket_id, work_ticket_item_id)],
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

    # ── Construction dashboard ────────────────────────────────────────────────

    async def get_construction_opportunities(self, year: int = 2026) -> list[dict]:
        """
        Fetch all active Construction division opportunities.
        Fetches all Won + Complete opps with no $select (so Aspire returns all
        fields including DivisionName/DivisionID), then filters to Construction
        in Python. Avoids OData combined-filter parser bugs.
        """
        # Single $top=500 request with $select to keep payload small.
        # Probe confirmed this works. No $filter or $skip — both cause issues.
        # All filtering (division + status + year) done in Python.
        select_fields = ",".join([
            "OpportunityID", "OpportunityName", "OpportunityNumber",
            "OpportunityStatusName", "JobStatusName",
            "DivisionName", "DivisionID",
            "WonDollars", "ActualEarnedRevenue",
            "ActualGrossMarginDollars", "ActualGrossMarginPercent",
            "EstimatedDollars", "EstimatedGrossMarginDollars", "EstimatedGrossMarginPercent",
            "ActualCostDollars",
            "EstimatedLaborHours", "ActualLaborHours",
            "PercentComplete",
            "StartDate", "EndDate", "CompleteDate", "WonDate",
            "SalesRepContactName", "OperationsManagerContactName",
            "PropertyName", "BranchName",
        ])
        try:
            result = await self._get("Opportunities", {
                "$top":     "1000",
                "$orderby": "WonDate desc",
                "$select":  select_fields,
            })
            all_opps = self._extract_list(result)
        except Exception as e:
            logger.error(f"Opportunities fetch failed: {e}", exc_info=True)
            return []

        logger.info(f"Fetched {len(all_opps)} total opps from Aspire")

        # Log unique statuses and divisions for diagnostics
        seen_statuses  = {o.get("OpportunityStatusName") for o in all_opps}
        seen_divisions = {o.get("DivisionName") for o in all_opps}
        logger.info(f"Statuses: {seen_statuses}")
        logger.info(f"Divisions: {seen_divisions}")

        # Filter to Construction division only — return ALL statuses so
        # dashboard.py can see every status name and filter appropriately.
        construction = [
            o for o in all_opps
            if (o.get("DivisionName") or "").lower() == "construction"
            or o.get("DivisionID") == 8
        ]
        logger.info(
            f"{len(all_opps)} total opps → {len(construction)} Construction "
            f"(statuses: { {o.get('OpportunityStatusName') for o in construction} })"
        )
        return construction

    async def get_work_tickets_summary(self, opportunity_id: int) -> list[dict]:
        """
        Fetch work tickets for an opportunity with hours and cost fields
        for the construction dashboard.
        """
        select_fields = ",".join([
            "WorkTicketID", "OpportunityID", "WorkTicketTitle",
            "WorkTicketStatusName", "WorkTicketType",
            "EstimatedLaborHours", "ActualLaborHours",
            "BudgetedLaborCost", "ActualLaborCost",
            "BudgetedCost", "ActualCost",
            "CompleteDate", "ScheduledDate",
        ])
        try:
            result = await self._get("WorkTickets", {
                "$filter": f"OpportunityID eq {opportunity_id}",
                "$select": select_fields,
                "$top":    "50",
            })
            return self._extract_list(result)
        except Exception as e:
            logger.warning(f"WorkTickets fetch failed for OpportunityID={opportunity_id}: {e}")
            return []

    # ── Field write operations ────────────────────────────────────────────────

    async def get_aspire_employees(self) -> list[dict]:
        """
        Build an employee list from Opportunities (SalesRep + OpsManager) and
        WorkTickets (CrewLeader).  Contacts endpoint is 403 for this account.
        Returns list of {ContactID, FullName, Email} dicts sorted by name.
        """
        import asyncio

        people: dict[str, int] = {}  # name → ContactID (non-zero wins)

        def _add(name: str | None, cid: int | None) -> None:
            name = (name or "").strip()
            cid  = cid or 0
            if not name:
                return
            if name not in people or (cid and not people[name]):
                people[name] = cid

        async def _fetch_opps() -> None:
            try:
                result = await self._get("Opportunities", {
                    "$select": (
                        "SalesRepContactID,SalesRepContactName,"
                        "OperationsManagerContactID,OperationsManagerContactName"
                    ),
                    "$top": "5000",
                })
                for o in self._extract_list(result):
                    _add(o.get("SalesRepContactName"),          o.get("SalesRepContactID"))
                    _add(o.get("OperationsManagerContactName"), o.get("OperationsManagerContactID"))
                logger.info(f"Employees: {len(people)} unique names from Opportunities")
            except Exception as e:
                logger.warning(f"Aspire Opportunities employee fetch failed: {e}")

        async def _fetch_tickets() -> None:
            try:
                result = await self._get("WorkTickets", {
                    "$select": "CrewLeaderContactID,CrewLeaderName",
                    "$top": "2000",
                    "$orderby": "ScheduledStartDate desc",
                })
                before = len(people)
                for t in self._extract_list(result):
                    _add(t.get("CrewLeaderName"), t.get("CrewLeaderContactID"))
                logger.info(f"Employees: +{len(people)-before} from WorkTickets crew leaders")
            except Exception as e:
                logger.info(f"WorkTickets crew leader fetch skipped: {e}")

        await asyncio.gather(_fetch_opps(), _fetch_tickets())

        out = [
            {"ContactID": cid, "FullName": name, "Email": ""}
            for name, cid in sorted(people.items())
            if cid  # only include people with a real ContactID
        ]
        logger.info(f"Employee list final: {len(out)} with ContactIDs")
        return out

    async def _get_aspire_employees_contacts(self) -> list[dict]:
        """Original Contacts-based fetch — kept for reference (403 on this account)."""
        try:
            result = await self._get("Contacts", {
                "$filter": "ContactType eq 'Employee'",
                "$select": "ContactID,FirstName,LastName,ContactType,IsActive,Email,EmailAddress,PrimaryEmail",
                "$top": "500",
                "$orderby": "LastName asc",
            })
            contacts = self._extract_list(result)
            out = []
            for c in contacts:
                if c.get("IsActive") is False:
                    continue
                first = (c.get("FirstName") or "").strip()
                last  = (c.get("LastName") or "").strip()
                if not first and not last:
                    continue
                full  = f"{first} {last}".strip()
                email = (
                    c.get("Email")
                    or c.get("EmailAddress")
                    or c.get("PrimaryEmail")
                    or ""
                )
                out.append({
                    "ContactID": c.get("ContactID"),
                    "FullName":  full,
                    "Email":     email,
                })
            return out
        except Exception as e:
            logger.warning(f"Aspire employees fetch failed: {e}")
            return []

    async def probe_work_ticket_fields(self) -> dict:
        """Return all fields present on a sample WorkTicket — used to discover the route field name."""
        try:
            result = await self._get("WorkTickets", {"$top": "1"})
            tickets = self._extract_list(result)
            if tickets:
                return {"fields": sorted(tickets[0].keys()), "sample": tickets[0]}
            return {"fields": [], "sample": {}}
        except Exception as e:
            return {"error": str(e)}

    async def _get_crew_leader_route_map(self) -> dict[int, str]:
        """
        Fetch all Routes from Aspire and return a map of
        CrewLeaderContactID -> RouteName.
        Falls back to empty dict if the endpoint is unavailable.
        """
        try:
            result = await self._get("Routes", {
                "$select": "RouteID,RouteName,CrewLeaderContactID",
                "$top": "200",
            })
            route_map: dict[int, str] = {}
            for r in self._extract_list(result):
                crew_id = r.get("CrewLeaderContactID")
                name    = r.get("RouteName") or ""
                if crew_id and name:
                    route_map[int(crew_id)] = name
            logger.info(f"Loaded {len(route_map)} routes from Aspire")
            return route_map
        except Exception as e:
            logger.warning(f"Routes endpoint unavailable, will group by crew leader: {e}")
            return {}

    async def get_scheduled_work_tickets(self, date_range: str = "today") -> list[dict]:
        """
        Fetch work tickets filtered by ScheduledStartDate.
        date_range: 'today' | 'past' (last 14 days) | 'upcoming' (next 30 days)

        Uses full ISO-8601 datetime strings in the filter (Aspire stores
        ScheduledStartDate as datetime, not plain date).

        Enriches each ticket with OpportunityName + PropertyName, and groups
        by RouteName (fetched from /Routes via CrewLeaderContactID).
        """
        from datetime import date as _date, timedelta
        today = _date.today()

        # Aspire OData date filter: plain YYYY-MM-DD, no quotes, no timezone suffix
        # e.g. Date(ScheduledStartDate) eq 2026-04-08   OR
        #      ScheduledStartDate ge 2026-03-25 and ScheduledStartDate lt 2026-04-08
        if date_range == "past":
            since = (today - timedelta(days=14)).strftime("%Y-%m-%d")
            until = today.strftime("%Y-%m-%d")
            filter_str = f"ScheduledStartDate ge {since} and ScheduledStartDate lt {until}"
            orderby = "ScheduledStartDate desc"
        elif date_range == "upcoming":
            tomorrow = (today + timedelta(days=1)).strftime("%Y-%m-%d")
            end      = (today + timedelta(days=30)).strftime("%Y-%m-%d")
            filter_str = f"ScheduledStartDate ge {tomorrow} and ScheduledStartDate le {end}"
            orderby = "ScheduledStartDate asc"
        else:  # today
            filter_str = f"Date(ScheduledStartDate) eq {today.strftime('%Y-%m-%d')}"
            orderby = "ScheduledStartDate asc"

        select_fields = ",".join([
            "WorkTicketID", "WorkTicketNumber", "OpportunityID",
            "WorkTicketStatusName",
            "ScheduledStartDate", "CompleteDate",
            "HoursAct", "HoursEst",
            "CrewLeaderContactID", "CrewLeaderName",
        ])

        # Fetch tickets and route map concurrently
        import asyncio
        try:
            tickets_result, route_map = await asyncio.gather(
                self._get("WorkTickets", {
                    "$filter": filter_str,
                    "$select": select_fields,
                    "$orderby": orderby,
                    "$top": "200",
                }),
                self._get_crew_leader_route_map(),
            )
            tickets = self._extract_list(tickets_result)
        except Exception as e:
            logger.error(f"Scheduled work tickets fetch failed: {e}")
            return []

        if not tickets:
            logger.info(f"No work tickets found for range={date_range}, filter: {filter_str}")
            return []

        logger.info(f"Fetched {len(tickets)} work tickets for range={date_range}")

        # Enrich with OpportunityName + PropertyName
        opp_ids = list({t.get("OpportunityID") for t in tickets if t.get("OpportunityID")})
        opp_map: dict = {}
        for chunk_start in range(0, len(opp_ids), 15):
            chunk = opp_ids[chunk_start:chunk_start + 15]
            or_filter = " or ".join(f"OpportunityID eq {oid}" for oid in chunk)
            try:
                opp_result = await self._get("Opportunities", {
                    "$filter": f"({or_filter})",
                    "$select": "OpportunityID,OpportunityName,PropertyName",
                    "$top": "50",
                })
                for opp in self._extract_list(opp_result):
                    opp_map[opp.get("OpportunityID")] = {
                        "name":     opp.get("OpportunityName") or "",
                        "property": opp.get("PropertyName") or "",
                    }
            except Exception as e:
                logger.warning(f"Opportunity name enrichment failed: {e}")

        for t in tickets:
            info = opp_map.get(t.get("OpportunityID"), {})
            t["OpportunityName"]  = info.get("name", "")
            t["PropertyName"]     = info.get("property", "")
            t["PropertyAddress"]  = ""
            # Resolve route name: prefer Routes lookup, fall back to crew leader name
            crew_id = t.get("CrewLeaderContactID")
            t["_RouteName"] = (
                (route_map.get(int(crew_id)) if crew_id else None)
                or t.get("CrewLeaderName")
                or "Unassigned"
            )
            # Normalise field names for frontend compatibility
            t["ScheduledDate"]       = t.get("ScheduledStartDate")
            t["ActualLaborHours"]    = t.get("HoursAct")
            t["EstimatedLaborHours"] = t.get("HoursEst")
            t["WorkTicketTitle"]     = f"Ticket #{t.get('WorkTicketNumber') or t.get('WorkTicketID')}"

        return tickets

    async def get_lead_sources(self) -> list[dict]:
        """Fetch all lead sources from Aspire."""
        try:
            result = await self._get("LeadSources", {"$orderby": "LeadSourceName"})
            return self._extract_list(result)
        except Exception as e:
            logger.warning(f"LeadSources fetch failed: {e}")
            return []

    async def get_sales_types(self) -> list[dict]:
        """Fetch all sales types from Aspire."""
        try:
            result = await self._get("SalesTypes", {"$orderby": "SalesTypeName"})
            return self._extract_list(result)
        except Exception as e:
            logger.warning(f"SalesTypes fetch failed: {e}")
            return []

    async def get_opportunity_statuses(self) -> list[dict]:
        """Fetch all opportunity statuses from Aspire."""
        try:
            result = await self._get("OpportunityStatuses", {})
            return self._extract_list(result)
        except Exception as e:
            logger.warning(f"OpportunityStatuses fetch failed: {e}")
            return []

    async def search_opportunities_field(
        self, query: str, limit: int = 15
    ) -> list[dict]:
        """
        Search Won opportunities by name for field crew selection.
        Returns enough fields to identify a job and find its work tickets.
        """
        escaped = query.replace("'", "''")
        select_fields = ",".join([
            "OpportunityID", "OpportunityName", "OpportunityNumber",
            "OpportunityStatusName", "JobStatusName",
            "PropertyName", "DivisionName",
            "PropertyID", "BillingContactID",
            "StartDate", "EndDate",
        ])
        try:
            result = await self._get("Opportunities", {
                "$filter": f"contains(OpportunityName, '{escaped}')",
                "$select": select_fields,
                "$top": str(limit),
            })
            opps = self._extract_list(result)
            # Include only active Won jobs for work ticket completion
            return [
                o for o in opps
                if (o.get("OpportunityStatusName") or "").lower() == "won"
            ]
        except Exception as e:
            logger.warning(f"Field opportunity search failed: {e}")
            return []

    async def search_all_opportunities_field(
        self, query: str, limit: int = 15
    ) -> list[dict]:
        """
        Search all opportunities (any status) by name — for new opportunity creation
        flow where we need to find an existing PropertyID.
        """
        escaped = query.replace("'", "''")
        select_fields = ",".join([
            "OpportunityID", "OpportunityName", "PropertyName",
            "PropertyID", "BillingContactID", "DivisionName",
        ])
        try:
            result = await self._get("Opportunities", {
                "$filter": f"contains(PropertyName, '{escaped}')",
                "$select": select_fields,
                "$top": str(limit),
            })
            opps = self._extract_list(result)
            # Deduplicate by PropertyID
            seen: set = set()
            unique = []
            for o in opps:
                pid = o.get("PropertyID")
                if pid and pid not in seen:
                    seen.add(pid)
                    unique.append(o)
            return unique
        except Exception as e:
            logger.warning(f"Property search failed: {e}")
            return []

    async def patch_work_ticket_notes(
        self, ticket_id: int, notes: str
    ) -> dict:
        """
        Write Notes to a WorkTicket. Tries multiple approaches:
        1. PATCH WorkTickets(id)
        2. PUT  WorkTickets(id)
        3. POST WorkTickets with WorkTicketID in body (upsert)
        4. Fetch full ticket then POST it back with Notes added
        """
        body_minimal = {"WorkTicketID": ticket_id, "Notes": notes}

        # 1. PATCH WorkTickets(id)
        try:
            return await self._patch(f"WorkTickets({ticket_id})", {"Notes": notes})
        except Exception as e:
            logger.info(f"PATCH WorkTickets({ticket_id}) failed ({getattr(getattr(e,'response',None),'status_code',None)}), trying PUT")

        # 2. PUT WorkTickets(id)
        try:
            return await self._put(f"WorkTickets({ticket_id})", {"Notes": notes})
        except Exception as e:
            logger.info(f"PUT WorkTickets({ticket_id}) failed ({getattr(getattr(e,'response',None),'status_code',None)}), trying POST upsert")

        # 3. POST WorkTickets with WorkTicketID in body
        try:
            return await self._post("WorkTickets", body_minimal)
        except Exception as e:
            logger.info(f"POST WorkTickets (upsert) failed ({getattr(getattr(e,'response',None),'status_code',None)}), trying full ticket fetch+post")

        # 4. Fetch full ticket then POST back with Notes
        try:
            result = await self._get("WorkTickets", {
                "$filter": f"WorkTicketID eq {ticket_id}",
                "$top": "1",
            })
            tickets = self._extract_list(result)
            if tickets:
                full_body = {**tickets[0], "Notes": notes}
                return await self._post("WorkTickets", full_body)
        except Exception as e:
            logger.info(f"Full fetch+POST failed ({getattr(getattr(e,'response',None),'status_code',None)})")

        raise RuntimeError(f"All write attempts failed for WorkTicket {ticket_id}")

    async def create_opportunity(self, body: dict) -> dict:
        """POST a new Opportunity to Aspire."""
        return await self._post("Opportunities", body)

    async def close(self):
        await self._http.aclose()
