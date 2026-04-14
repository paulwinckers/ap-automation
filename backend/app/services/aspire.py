"""
Aspire API client — wraps the Aspire External REST API (OData v4).

Docs: https://guide.youraspire.com/apidocs
Base URL: https://cloud-api.youraspire.com
Auth: Bearer token (OAuth2 client credentials)

Receipt workflow:
  1. Find an open Receipt by PO number (ReceiptStatusName eq 'New' or 'Received')
  2. POST /Receipts with ReceiptID included — upsert (updates existing when ReceiptID is provided)
     - Received  = job cost recorded, waiting for approval
     - Approved  = triggers QBO export (handled by Aspire, not us)
"""

import logging
import re
import time
from datetime import date
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


def _to_aspire_datetime(date_str: Optional[str]) -> Optional[str]:
    """Convert YYYY-MM-DD to the ISO datetime format Aspire expects: YYYY-MM-DDT00:00:00Z."""
    if not date_str:
        return None
    if re.match(r'^\d{4}-\d{2}-\d{2}$', date_str):
        return f"{date_str}T00:00:00Z"
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

    async def _get_all(self, path: str, params: dict = None, max_pages: int = 20) -> list:
        """
        Fetch ALL records by following OData @odata.nextLink pagination.
        Aspire caps $top at ~500; this iterates until no next link remains.
        """
        token = await self._get_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json;odata.metadata=minimal",
        }
        url = f"{self.base_url}/{path.lstrip('/')}"
        all_records: list = []
        page = 0

        while url and page < max_pages:
            resp = await self._http.get(url, params=params if page == 0 else None, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            all_records.extend(self._extract_list(data))
            url = data.get("@odata.nextLink") if isinstance(data, dict) else None
            page += 1
            logger.debug(f"_get_all page {page}: {len(all_records)} records so far, next={bool(url)}")

        return all_records

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

    # ── PO / Receipt lookup ───────────────────────────────────────────────────

    @staticmethod
    def _extract_po_int(po_number: str) -> Optional[int]:
        """
        Extract trailing integer from a PO number string.
        Handles: "1627" → 1627, "#1627" → 1627,
                 "DLS-1627" → 1627, "DLS1627" → 1627.
        Returns None if no integer found.
        """
        if not po_number:
            return None
        m = re.search(r'(\d+)\s*$', po_number.strip())
        if m:
            return int(m.group(1))
        return None

    async def find_open_receipt(self, po_number: str) -> Optional[dict]:
        """
        Find an open Purchase Receipt in Aspire by PO/Receipt number.

        Aspire OData does not support compound filters like:
          ReceiptNumber eq X and (Status eq 'New' or Status eq 'Received')
        So we filter by ReceiptNumber only, then check status in Python.

        Returns the receipt dict (status New or Received) or None.
        """
        po_int = self._extract_po_int(po_number)
        if po_int is None:
            logger.warning(f"Cannot extract integer from PO number '{po_number}'")
            return None

        logger.info(f"Looking up open Receipt for PO '{po_number}' (ReceiptNumber={po_int})")
        try:
            result = await self._get(
                "Receipts",
                params={
                    "$filter": f"ReceiptNumber eq {po_int}",
                    "$top": 5,
                },
            )
            records = self._extract_list(result)

            # Filter to open statuses in Python — Aspire OData rejects compound filters
            open_statuses = {"new", "received"}
            open_records = [
                r for r in records
                if (r.get("ReceiptStatusName") or "").lower() in open_statuses
            ]

            if not open_records:
                statuses = [r.get("ReceiptStatusName") for r in records]
                logger.warning(
                    f"No open Receipt found for ReceiptNumber={po_int} "
                    f"(PO '{po_number}') — found statuses: {statuses}"
                )
                return None

            receipt = open_records[0]
            logger.info(
                f"Receipt found — ReceiptID={receipt.get('ReceiptID')}, "
                f"Status={receipt.get('ReceiptStatusName')}, "
                f"WorkTicketID={receipt.get('WorkTicketID')}"
            )
            return receipt
        except Exception as e:
            logger.error(f"Aspire Receipt lookup failed for PO '{po_number}': {e}")
            return None

    async def validate_po(self, po_number: str) -> tuple[bool, Optional[str]]:
        """
        Validate a PO number. Returns (is_valid, error_message).
        Checks that an open Receipt exists with that number.
        """
        receipt = await self.find_open_receipt(po_number)
        if receipt is None:
            return False, f"PO '{po_number}' not found in Aspire (no open receipt with that number)"
        return True, None

    # ── Receipt fill ─────────────────────────────────────────────────────────

    @staticmethod
    def _strip_receipt_items(existing_items: list[dict]) -> list[dict]:
        """
        Return existing ReceiptItems with ItemAllocations stripped.
        Aspire returns 400 if ItemAllocations are included in the POST body.
        All other fields (ReceiptItemID, CatalogItemID, costs, etc.) are preserved.
        """
        return [
            {k: v for k, v in item.items() if k != "ItemAllocations" and v is not None}
            for item in existing_items
        ]

    @staticmethod
    def _strip_extra_costs(existing_costs: list[dict]) -> list[dict]:
        """
        Return existing ReceiptExtraCosts with read-only metadata stripped.
        Preserves ReceiptExtraCostID so Aspire treats these as updates, not inserts.
        """
        allowed = {"ReceiptExtraCostID", "ExtraCostType", "ExtraCost"}
        return [
            {k: v for k, v in cost.items() if k in allowed and v is not None}
            for cost in existing_costs
        ]

    async def fill_receipt_from_invoice(self, invoice: Invoice, receipt: dict) -> str:
        """
        Create a new Aspire Purchase Receipt for this invoice, linked to the
        same WorkTicket as the matched PO receipt.

        Aspire's REST API has no update endpoint — POST /Receipts is create-only
        and rejects any existing ReceiptID. We therefore create a fresh receipt
        with the invoice's actual line items and prices, allocated to the same
        WorkTicket. The original PO receipt is left unchanged.

        Returns the new ReceiptID as a string.
        """
        receipt_number = receipt.get("ReceiptNumber")
        work_ticket_id = receipt.get("WorkTicketID")

        logger.info(
            f"Creating Aspire invoice receipt for PO #{receipt_number} "
            f"(WorkTicket {work_ticket_id}) — "
            f"invoice {invoice.invoice_number}, total ${invoice.total_amount}"
        )

        # Build ReceiptItems from invoice line items with WorkTicket allocations.
        # ItemAllocations must sum to ItemQuantity — Aspire validates this.
        receipt_items = []
        for li in (invoice.line_items or []):
            qty  = float(li.quantity or 1)
            cost = float(li.unit_price or 0)
            item: dict = {
                "ItemName":     (li.description or "")[:100],
                "ItemQuantity": qty,
                "ItemUnitCost": cost,
                "ItemType":     "Material",
            }
            if work_ticket_id:
                item["ItemAllocations"] = [{
                    "WorkTicketID":    work_ticket_id,
                    "ItemQuantity":    qty,
                    "ReceiptItemPrice": round(cost * qty, 4),
                    "ItemEstUnitCost":  cost,
                }]
            receipt_items.append(item)

        # Build ReceiptExtraCosts from invoice tax lines.
        # GST → "Tax", PST/HST → "Other"
        extra_costs = []
        for tl in (invoice.tax_lines or []):
            tax_name  = (tl.tax_name or "").lower()
            cost_type = "Tax" if "gst" in tax_name else "Other"
            extra_costs.append({
                "ExtraCostType": cost_type,
                "ExtraCost":     float(tl.tax_amount or 0),
            })

        body = {
            "BranchID":          receipt.get("BranchID"),
            "VendorID":          receipt.get("VendorID"),
            "VendorInvoiceNum":  invoice.invoice_number or "",
            "VendorInvoiceDate": _to_aspire_datetime(_normalize_date(invoice.invoice_date)),
            "ReceivedDate":      (
                _to_aspire_datetime(_normalize_date(invoice.invoice_date))
                or f"{date.today().isoformat()}T00:00:00Z"
            ),
            "WorkTicketID":      work_ticket_id,
            "ReceiptNote":       (
                f"AP Automation: Invoice {invoice.invoice_number} | "
                f"${invoice.total_amount:.2f} | {date.today().isoformat()}"
            ),
            "ReceiptTotalCost":  float(invoice.total_amount or 0),
            "ReceiptItems":      receipt_items,
            "ReceiptExtraCosts": extra_costs,
        }
        body = {k: v for k, v in body.items() if v is not None}

        result = await self._post("Receipts", body)

        new_id = (
            result.get("ReceiptID")
            or result.get("receiptId")
            or result.get("Id")
            or result.get("id")
            or result.get("value")
        )
        logger.info(f"New Aspire receipt created — ReceiptID={new_id} for invoice {invoice.invoice_number}")
        return str(new_id)

    async def create_unmatched_receipt(self, invoice: Invoice) -> str:
        """
        Create a new Aspire receipt with no WorkTicket assignment.
        Used when aspire_post=True but no PO was found.
        The user opens Aspire and manually drags it to the correct work ticket.

        Items are posted without ItemAllocations since there is no WorkTicket yet.
        Returns the new ReceiptID as a string.
        """
        # Look up the VendorID in Aspire by name
        vendor_id = await self.get_vendor_id(invoice.vendor_name or "")

        # Build items without ItemAllocations — no WorkTicket to allocate to yet
        receipt_items = []
        for li in (invoice.line_items or []):
            item = {
                "ItemName":     (li.description or "")[:100],
                "ItemQuantity": float(li.quantity or 1),
                "ItemUnitCost": float(li.unit_price or 0),
                "ItemType":     "Material",
            }
            receipt_items.append(item)

        # Tax lines → ReceiptExtraCosts
        extra_costs = []
        for tl in (invoice.tax_lines or []):
            tax_name  = (tl.tax_name or "").lower()
            cost_type = "Tax" if "gst" in tax_name else "Other"
            extra_costs.append({
                "ExtraCostType": cost_type,
                "ExtraCost":     float(tl.tax_amount or 0),
            })

        body: dict = {
            "BranchID":          settings.ASPIRE_BRANCH_ID or 2,
            "VendorInvoiceNum":  invoice.invoice_number or "",
            "VendorInvoiceDate": _to_aspire_datetime(_normalize_date(invoice.invoice_date)),
            "ReceivedDate":      _to_aspire_datetime(_normalize_date(invoice.invoice_date)) or f"{date.today().isoformat()}T00:00:00Z",
            "ReceiptNote":       (
                f"AP Automation: Invoice {invoice.invoice_number} | "
                f"${invoice.total_amount:.2f} | {date.today().isoformat()} — assign work ticket"
            ),
            "ReceiptTotalCost":  float(invoice.total_amount or 0),
            "ReceiptItems":      receipt_items,
            "ReceiptExtraCosts": extra_costs,
        }
        if vendor_id:
            body["VendorID"] = vendor_id

        body = {k: v for k, v in body.items() if v is not None}

        logger.info(
            f"Creating unmatched Aspire receipt for '{invoice.vendor_name}' "
            f"invoice {invoice.invoice_number}, total ${invoice.total_amount}"
        )
        result = await self._post("Receipts", body)

        new_id = (
            result.get("ReceiptID")
            or result.get("receiptId")
            or result.get("Id")
            or result.get("id")
        )
        logger.info(f"Unmatched Aspire receipt created — ReceiptID={new_id}")
        return str(new_id)

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
        Return active employees with their ContactIDs for the salesperson dropdown.
        Primary: Contacts endpoint filtered to Active employees.
        Fallback: derive from Opportunities SalesRep/OpsManager names.
        """
        # Try Contacts endpoint first (correct field is 'Active', not 'IsActive')
        try:
            result = await self._get("Contacts", {
                "$select": "ContactID,UserID,FirstName,LastName,Email,Active,ContactTypeName",
                "$filter": "Active eq true and ContactTypeName eq 'Employee'",
                "$top":    "500",
                "$orderby": "LastName asc",
            })
            contacts = self._extract_list(result)
            out = []
            for c in contacts:
                cid    = c.get("ContactID")
                uid    = c.get("UserID")
                first  = (c.get("FirstName") or "").strip()
                last   = (c.get("LastName")  or "").strip()
                name   = f"{first} {last}".strip()
                if cid and name:
                    out.append({
                        "ContactID": cid,
                        "UserID":    uid,   # used for AssignedTo in Issues
                        "FullName":  name,
                        "Email":     c.get("Email") or "",
                    })
            logger.info(f"Employee list from Contacts: {len(out)}")
            return out
        except Exception as e:
            logger.info(f"Contacts endpoint unavailable ({e}), falling back to Opportunities")

        # Fallback: derive from Opportunities (SalesRep and OpsManager names)
        people: dict[str, int] = {}  # name → ContactID

        def _add(name: str | None, cid: int | None) -> None:
            name = (name or "").strip()
            cid  = cid or 0
            if not name:
                return
            if name not in people or (cid and not people[name]):
                people[name] = cid

        try:
            result = await self._get("Opportunities", {
                "$select": (
                    "SalesRepContactID,SalesRepContactName,"
                    "OperationsManagerContactID,OperationsManagerContactName"
                ),
                "$top":     "1000",
                "$orderby": "WonDate desc",
            })
            for o in self._extract_list(result):
                _add(o.get("SalesRepContactName"),          o.get("SalesRepContactID"))
                _add(o.get("OperationsManagerContactName"), o.get("OperationsManagerContactID"))
            logger.info(f"Employee list from Opportunities fallback: {len(people)} names")
        except Exception as e:
            logger.warning(f"Aspire Opportunities employee fetch failed: {e}")

        out = [
            {"ContactID": cid, "FullName": name, "Email": ""}
            for name, cid in sorted(people.items())
            if cid
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

    async def get_scheduled_work_tickets(
        self, date_range: str = "today", specific_date: Optional[str] = None
    ) -> list[dict]:
        """
        Fetch work tickets filtered by ScheduledStartDate.
        date_range: 'today' | 'past' (last 14 days) | 'upcoming' (next 30 days)
        specific_date: optional YYYY-MM-DD override — ignores date_range entirely.

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
        if specific_date:
            filter_str = f"Date(ScheduledStartDate) eq {specific_date}"
            orderby    = "ScheduledStartDate asc"
        elif date_range == "past":
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
            "WorkTicketID", "WorkTicketNumber", "OpportunityID", "OpportunityServiceID",
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

        # Enrich with OpportunityName, PropertyName, and address (all on Opportunity directly)
        opp_ids = list({t.get("OpportunityID") for t in tickets if t.get("OpportunityID")})
        opp_map: dict = {}
        for chunk_start in range(0, len(opp_ids), 15):
            chunk = opp_ids[chunk_start:chunk_start + 15]
            or_filter = " or ".join(f"OpportunityID eq {oid}" for oid in chunk)
            try:
                opp_result = await self._get("Opportunities", {
                    "$filter": f"({or_filter})",
                    "$select": (
                        "OpportunityID,OpportunityName,PropertyID,PropertyName,"
                        "BillingAddressLine1,BillingAddressLine2,"
                        "BillingAddressCity,BillingAddressStateProvinceCode,BillingAddressZipCode"
                    ),
                    "$top": "50",
                })
                for opp in self._extract_list(opp_result):
                    parts = [
                        opp.get("BillingAddressLine1") or "",
                        opp.get("BillingAddressLine2") or "",
                        opp.get("BillingAddressCity") or "",
                        opp.get("BillingAddressStateProvinceCode") or "",
                        opp.get("BillingAddressZipCode") or "",
                    ]
                    address = ", ".join(p for p in parts if p)
                    opp_map[opp.get("OpportunityID")] = {
                        "name":      opp.get("OpportunityName") or "",
                        "property":  opp.get("PropertyName") or "",
                        "address":   address,
                        "property_id": opp.get("PropertyID"),
                    }
            except Exception as e:
                logger.warning(f"Opportunity enrichment failed: {e}")

        # Step 3: Fetch OpportunityServices to get ServiceName per OpportunityServiceID
        service_map: dict = {}  # OpportunityServiceID → ServiceName
        for chunk_start in range(0, len(opp_ids), 10):
            chunk = opp_ids[chunk_start:chunk_start + 10]
            or_filter = " or ".join(f"OpportunityID eq {oid}" for oid in chunk)
            try:
                svc_result = await self._get("OpportunityServices", {
                    "$filter": f"({or_filter})",
                    "$top": "200",
                })
                for svc in self._extract_list(svc_result):
                    sid = svc.get("OpportunityServiceID")
                    if sid:
                        label = (
                            svc.get("ServiceNameAbr")
                            or svc.get("DisplayName")
                            or svc.get("ServiceName")
                            or ""
                        )
                        service_map[sid] = label
                        if sid not in service_map or not service_map.get(sid):
                            logger.info(f"OpportunityServices sample keys: {list(svc.keys())[:20]}")
            except Exception as e:
                logger.warning(f"OpportunityServices enrichment failed: {e}")

        # Step 4: Fetch ProductionNote from /Properties for each unique PropertyID
        property_ids = list({
            info["property_id"]
            for info in opp_map.values()
            if info.get("property_id")
        })
        production_note_map: dict = {}  # PropertyID → ProductionNote
        for chunk_start in range(0, len(property_ids), 20):
            chunk = property_ids[chunk_start:chunk_start + 20]
            or_filter = " or ".join(f"PropertyID eq {pid}" for pid in chunk)
            try:
                prop_result = await self._get("Properties", {
                    "$filter": f"({or_filter})",
                    "$select": "PropertyID,ProductionNote",
                    "$top": "100",
                })
                for prop in self._extract_list(prop_result):
                    pid = prop.get("PropertyID")
                    if pid:
                        production_note_map[pid] = prop.get("ProductionNote") or ""
            except Exception as e:
                logger.warning(f"Properties ProductionNote fetch failed: {e}")

        for t in tickets:
            info = opp_map.get(t.get("OpportunityID"), {})
            svc_id = t.get("OpportunityServiceID")
            t["OpportunityName"]  = info.get("name", "")
            t["PropertyName"]     = info.get("property", "")
            t["PropertyAddress"]  = info.get("address", "")
            t["ProductionNote"]   = production_note_map.get(info.get("property_id"), "")
            t["ServiceName"]      = service_map.get(svc_id, "") if svc_id else ""
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
            t["WorkTicketTitle"]     = service_map.get(t.get("OpportunityServiceID"), "") or f"Ticket #{t.get('WorkTicketNumber') or t.get('WorkTicketID')}"

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

    # Fields confirmed read-only / computed on WorkTicket — exclude from POST body
    _TICKET_READONLY = frozenset({
        "WorkTicketStatusName", "CrewLeaderName", "BranchName", "OpportunityNumber",
        "HoursAct", "WarrantyHoursAct", "OTHoursAct",
        "LaborCostAct", "MaterialCostAct", "EquipmentCostAct",
        "SubCostAct", "OtherCostAct", "TotalCostAct",
        "EarnedRevenue", "RealizeRateRevenue", "EstRealizeRateRevenue",
        "InvoiceNumber", "InvoiceID", "InvoicedAmount",
        "LastModifiedByUserID", "LastModifiedByUserName", "LastModifiedDateTime",
        "CreatedByUserID", "CreatedByUserName", "CreatedDateTime",
        "WorkTicketRevenues", "WorkTicketStatus",
        "OnSiteHours", "OnSiteOverUnder", "OnSiteVariance",
        "Revenue", "BudgetVariance", "PercentComplete",
        "VisitsScheduled", "DistributedHours",
        "ReviewedDateTime", "ReviewedUserID", "ReviewedUserName",
        "StartFormDateTime", "StartFormUserId",
        "Occurrences",
    })

    async def patch_work_ticket_notes(
        self, ticket_id: int, notes: str
    ) -> dict:
        """
        Append *notes* to a WorkTicket's Notes field.

        Fetches the existing Notes first so previous submissions accumulate
        (new entry is prepended above the old content with a separator line).

        Write strategy — tries six URL patterns in order until one succeeds:
        1. PATCH WorkTickets/{id}          (slash notation)
        2. PATCH WorkTickets({id})         (OData key notation)
        3. PUT   WorkTickets/{id}
        4. PUT   WorkTickets({id})
        5. POST  WorkTickets  body={WorkTicketID, Notes}          (minimal upsert)
        6. POST  WorkTickets  body=<full ticket stripped of RO fields + Notes>
        """
        # ── Fetch existing notes so we can append rather than overwrite ──────
        existing_notes = ""
        full_ticket: dict | None = None
        try:
            result = await self._get("WorkTickets", {
                "$filter": f"WorkTicketID eq {ticket_id}",
                "$top": "1",
            })
            tickets = self._extract_list(result)
            if tickets:
                full_ticket = tickets[0]
                existing_notes = (full_ticket.get("Notes") or "").strip()
        except Exception as e:
            logger.info(f"Could not fetch existing WorkTicket notes ({e}); will overwrite")

        separator = "\n" + "─" * 40 + "\n"
        combined_notes = (notes + separator + existing_notes) if existing_notes else notes

        attempts = [
            ("PATCH", f"WorkTickets/{ticket_id}",    {"Notes": combined_notes}),
            ("PATCH", f"WorkTickets({ticket_id})",   {"Notes": combined_notes}),
            ("PUT",   f"WorkTickets/{ticket_id}",    {"Notes": combined_notes}),
            ("PUT",   f"WorkTickets({ticket_id})",   {"Notes": combined_notes}),
            ("POST",  "WorkTickets",                 {"WorkTicketID": ticket_id, "Notes": combined_notes}),
        ]
        # Attempt 6: full ticket body stripped of read-only fields
        if full_ticket:
            stripped = {
                k: v for k, v in full_ticket.items()
                if k not in self._TICKET_READONLY
            }
            stripped["Notes"] = combined_notes
            attempts.append(("POST", "WorkTickets", stripped))

        for method, path, body in attempts:
            try:
                if method == "PATCH":
                    result = await self._patch(path, body)
                elif method == "PUT":
                    result = await self._put(path, body)
                else:
                    result = await self._post(path, body)
                logger.info(f"WorkTicket {ticket_id} Notes written via {method} {path}")
                return result
            except Exception as e:
                sc = getattr(getattr(e, "response", None), "status_code", None)
                logger.info(f"{method} {path} failed ({sc}), trying next…")

        raise RuntimeError(f"All write attempts failed for WorkTicket {ticket_id}")

    async def create_opportunity(self, body: dict) -> dict:
        """POST a new Opportunity to Aspire."""
        return await self._post("Opportunities", body)

    async def patch_opportunity(self, opp_id: int, body: dict) -> dict:
        """PATCH an existing Opportunity."""
        try:
            return await self._patch(f"Opportunities({opp_id})", body)
        except Exception:
            return await self._patch(f"Opportunities/{opp_id}", body)

    async def create_issue(self, body: dict) -> dict:
        """POST a new Issue to Aspire (links to Opportunity or WorkTicket)."""
        return await self._post("Issues", body)

    async def upload_aspire_attachment(
        self,
        object_id: int,
        object_code: str,
        filename: str,
        file_bytes: bytes,
        attachment_type_id: int = 3,  # 3=Photo, 4=Document, 11=AP Invoice
        expose_to_crew: bool = True,
        attach_to_invoice: Optional[bool] = None,
    ) -> dict:
        """
        Upload a file directly to Aspire via POST /Attachments.
        FileData is base64-encoded. ObjectCode is 'WorkTicket' or 'Opportunity'.
        attach_to_invoice must be set (True/False) for Opportunity attachments.
        """
        import base64
        file_data = base64.b64encode(file_bytes).decode("utf-8")
        body = {
            "FileName":         filename,
            "FileData":         file_data,
            "ObjectId":         object_id,
            "ObjectCode":       object_code,
            "AttachmentTypeId": attachment_type_id,
            "ExposeToCrew":     expose_to_crew,
        }
        if attach_to_invoice is not None:
            body["AttachToInvoice"] = attach_to_invoice
        return await self._post("Attachments", body)

    async def close(self):
        await self._http.aclose()
