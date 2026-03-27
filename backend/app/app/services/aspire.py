"""
Aspire API client — wraps the Aspire External REST API (OData v4).

Docs: https://guide.youraspire.com/apidocs
Base URL: https://cloud-api.youraspire.com
Auth: Bearer token (OAuth2 client credentials)
"""

import logging
from typing import Optional

import httpx

from app.core.config import settings
from app.models.invoice import Invoice

logger = logging.getLogger(__name__)

PRODUCTION_BASE = "https://cloud-api.youraspire.com"
SANDBOX_BASE    = "https://cloudsandbox-api.youraspire.com"


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
                "Accept": "application/json",
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
        resp.raise_for_status()
        return resp.json()

    # ── PO / Opportunity lookup ───────────────────────────────────────────────

    async def get_purchase_order(self, po_number: str) -> Optional[dict]:
        """
        Look up a PO/Opportunity in Aspire by CustomerPONum.
        Returns the first matching record, or None if not found.
        """
        logger.info(f"Looking up PO '{po_number}' in Aspire")
        try:
            result = await self._get(
                "Opportunities",
                params={"$filter": f"CustomerPONum eq '{po_number}'", "$top": 1},
            )
            records = result.get("value", result if isinstance(result, list) else [])
            if records:
                logger.info(f"PO '{po_number}' found — OpportunityID {records[0].get('OpportunityID')}")
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

    # ── Bill / Receipt creation ───────────────────────────────────────────────

    async def post_bill(self, invoice: Invoice, po_data: dict) -> str:
        """
        Create a Receipt (AP bill) in Aspire matched to the given PO.
        Returns the Aspire ReceiptID.

        NOTE: The exact POST body shape depends on your Aspire version
        and the Receipts endpoint schema. Adjust fields to match your
        Aspire API reference under the Receipts/Purchasing section.
        """
        opportunity_id = po_data["OpportunityID"]

        body = {
            "OpportunityID":    opportunity_id,
            "VendorName":       invoice.vendor_name,
            "InvoiceNumber":    invoice.invoice_number,
            "InvoiceDate":      invoice.invoice_date,
            "DueDate":          invoice.due_date,
            "TotalAmount":      invoice.total_amount,
            "TaxAmount":        invoice.tax_amount,
            "Notes":            f"Auto-posted by AP Automation | PDF: {invoice.pdf_filename}",
            "LineItems": [
                {
                    "Description": li.description,
                    "Quantity":    li.quantity,
                    "UnitPrice":   li.unit_price,
                    "Amount":      li.amount,
                }
                for li in (invoice.line_items or [])
            ],
        }

        logger.info(f"Posting bill to Aspire — OpportunityID {opportunity_id}")
        result = await self._post("Receipts", body)
        receipt_id = str(result.get("ReceiptID") or result.get("id"))
        return receipt_id

    async def close(self):
        await self._http.aclose()
