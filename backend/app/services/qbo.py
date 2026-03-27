"""
QuickBooks Online API client — Canadian edition (BC: GST + PST separately).

Auth:    OAuth2 Authorization Code flow with refresh token rotation.
Tax:     GST 5%  → Canada Revenue Agency
         PST 7%  → BC Ministry of Finance
Scope:   com.intuit.quickbooks.accounting

Intuit API reference:
  https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill

Flow:
  1. On first run, call /auth/qbo/connect in a browser to authorise.
     QBO redirects to /auth/qbo/callback with a code.
  2. Exchange code → access_token + refresh_token (stored in .env / secrets).
  3. Access token expires every 60 min — refresh automatically.
  4. Refresh token expires every 100 days — rotate on each use.
"""

import logging
import time
from typing import Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse

from app.core.config import settings
from app.models.invoice import Invoice
from app.services.d1_settings import get_setting, set_setting

logger = logging.getLogger(__name__)

# ── Intuit endpoints ──────────────────────────────────────────────────────────
INTUIT_AUTH_URL   = "https://appcenter.intuit.com/connect/oauth2"
INTUIT_TOKEN_URL  = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
INTUIT_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke"

QBO_BASE_PROD    = "https://quickbooks.api.intuit.com"
QBO_BASE_SANDBOX = "https://sandbox-quickbooks.api.intuit.com"

SCOPE = "com.intuit.quickbooks.accounting"

# ── Canadian BC tax codes ─────────────────────────────────────────────────────
# These must match the tax agency names in your QBO company exactly.
# Taxes → Sales Tax → Manage Sales Tax
GST_AGENCY_NAME = "Canada Revenue Agency"
PST_AGENCY_NAME = "BC Ministry of Finance"

# The combined GST+PST tax code name as it appears in QBO Canada.
# Usually "GST/PST BC" or "GST_PST" — we look it up dynamically on first use.
GST_PST_CODE_NAME = "GST/PST BC"


class QBOClient:
    def __init__(self):
        self.base_url = QBO_BASE_SANDBOX if settings.QBO_SANDBOX else QBO_BASE_PROD
        self.realm_id = settings.QBO_REALM_ID
        self._access_token: Optional[str] = None
        self._token_expiry: float = 0
        self._refresh_token: str = settings.QBO_REFRESH_TOKEN  # overridden by D1 on first use
        self._http = httpx.AsyncClient(timeout=30.0)
        self._token_loaded_from_d1: bool = False

        # Cached tax code IDs looked up from QBO on first use
        self._tax_codes: Optional[dict] = None

    async def _load_refresh_token_from_d1(self) -> None:
        """On first API call, check D1 for a newer refresh token than the env var."""
        if self._token_loaded_from_d1:
            return
        self._token_loaded_from_d1 = True
        stored = await get_setting("QBO_REFRESH_TOKEN")
        if stored and stored != self._refresh_token:
            logger.info("QBO refresh token loaded from D1 (newer than env var)")
            self._refresh_token = stored

    # ── OAuth2 token management ───────────────────────────────────────────────

    async def _ensure_token(self) -> str:
        """Return a valid access token, refreshing if expired."""
        await self._load_refresh_token_from_d1()
        if self._access_token and time.time() < self._token_expiry - 60:
            return self._access_token
        return await self._refresh_access_token()

    async def _refresh_access_token(self) -> str:
        """Exchange refresh token for a new access + refresh token pair."""
        logger.info("Refreshing QBO access token")
        resp = await self._http.post(
            INTUIT_TOKEN_URL,
            data={
                "grant_type":    "refresh_token",
                "refresh_token": self._refresh_token,
            },
            auth=(settings.QBO_CLIENT_ID, settings.QBO_CLIENT_SECRET),
            headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()

        self._access_token = data["access_token"]
        self._token_expiry = time.time() + data["expires_in"]

        # Rotate refresh token — Intuit issues a new one each time
        new_refresh = data.get("refresh_token")
        if new_refresh and new_refresh != self._refresh_token:
            self._refresh_token = new_refresh
            logger.info("QBO refresh token rotated — saving to D1")
            await set_setting("QBO_REFRESH_TOKEN", new_refresh)

        return self._access_token

    def _log_intuit_tid(self, resp: httpx.Response) -> None:
        """Log the intuit_tid transaction ID from QBO response headers for support tracing."""
        tid = resp.headers.get("intuit_tid")
        if tid:
            logger.debug(f"QBO intuit_tid: {tid}")

    async def _get(self, path: str, params: dict = None) -> dict:
        token = await self._ensure_token()
        url = f"{self.base_url}/v3/company/{self.realm_id}/{path.lstrip('/')}"
        resp = await self._http.get(
            url,
            params={**(params or {}), "minorversion": "70"},
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
        )
        self._log_intuit_tid(resp)
        resp.raise_for_status()
        return resp.json()

    async def _post(self, path: str, body: dict) -> dict:
        token = await self._ensure_token()
        url = f"{self.base_url}/v3/company/{self.realm_id}/{path.lstrip('/')}"
        resp = await self._http.post(
            url,
            json=body,
            params={"minorversion": "70"},
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        self._log_intuit_tid(resp)
        resp.raise_for_status()
        return resp.json()

    # ── Tax code lookup ───────────────────────────────────────────────────────

    async def _get_tax_codes(self) -> dict:
        """
        Fetch and cache the tax codes from this QBO company.
        Returns a dict keyed by tax code Name → { Id, ... }

        In QBO Canada, the relevant codes for BC are:
          - "GST/PST BC"  — both taxes applied (most vendor purchases)
          - "GST"         — GST only (e.g. out-of-province vendors)
          - "Exempt"      — no tax
        """
        if self._tax_codes is not None:
            return self._tax_codes

        logger.info("Fetching QBO tax codes")
        result = await self._get("query", {"query": "SELECT * FROM TaxCode MAXRESULTS 100"})
        codes = {}
        for tc in result.get("QueryResponse", {}).get("TaxCode", []):
            codes[tc["Name"]] = tc
        self._tax_codes = codes
        logger.info(f"Loaded {len(codes)} QBO tax codes: {list(codes.keys())}")
        return codes

    async def _resolve_tax_code(self, has_gst: bool, has_pst: bool) -> Optional[str]:
        """
        Return the QBO TaxCode Id appropriate for this bill line.
        BC vendor purchases are almost always GST + PST.
        """
        codes = await self._get_tax_codes()

        if has_gst and has_pst:
            code = codes.get(GST_PST_CODE_NAME)
            if not code:
                # Fallback: try common alternate names
                for name in ["GST/PST", "GST PST BC", "GST+PST BC"]:
                    code = codes.get(name)
                    if code:
                        break
            if code:
                return code["Id"]
            logger.warning(f"GST+PST tax code not found — check QBO tax setup. "
                           f"Available: {list(codes.keys())}")

        elif has_gst:
            code = codes.get("GST") or codes.get("GST CA")
            if code:
                return code["Id"]

        return None  # No tax / exempt

    # ── Vendor lookup ─────────────────────────────────────────────────────────

    async def find_vendor(self, vendor_name: str) -> Optional[dict]:
        """Look up a vendor by name in QBO. Returns the vendor object or None."""
        escaped = vendor_name.replace("'", "\\'")
        result = await self._get(
            "query",
            {"query": f"SELECT * FROM Vendor WHERE DisplayName = '{escaped}' MAXRESULTS 1"},
        )
        vendors = result.get("QueryResponse", {}).get("Vendor", [])
        return vendors[0] if vendors else None

    async def find_or_create_vendor(self, vendor_name: str) -> dict:
        """Find vendor in QBO, creating a stub record if not found."""
        vendor = await self.find_vendor(vendor_name)
        if vendor:
            return vendor

        logger.info(f"Creating new QBO vendor: {vendor_name}")
        result = await self._post("vendor", {
            "DisplayName": vendor_name,
            "PrintOnCheckName": vendor_name,
            "TaxIdentifier": "",
            "sparse": True,
        })
        return result["Vendor"]

    # ── Account lookup ────────────────────────────────────────────────────────

    async def find_account(self, account_code: str) -> Optional[dict]:
        """
        Look up a QBO account by AcctNum first, then by Name.
        This handles companies that don't use account numbers.
        e.g. find_account("6840") or find_account("Repair and Maintenance")
        """
        # Try by account number first
        result = await self._get(
            "query",
            {"query": f"SELECT * FROM Account WHERE AcctNum = '{account_code}' MAXRESULTS 1"},
        )
        accounts = result.get("QueryResponse", {}).get("Account", [])
        if accounts:
            return accounts[0]

        # Fall back to account name search
        escaped = account_code.replace("'", "\\'")
        result = await self._get(
            "query",
            {"query": f"SELECT * FROM Account WHERE Name = '{escaped}' MAXRESULTS 1"},
        )
        accounts = result.get("QueryResponse", {}).get("Account", [])
        return accounts[0] if accounts else None

    # ── Bill creation ─────────────────────────────────────────────────────────

    async def post_bill(self, invoice: Invoice, gl_account: str, file_bytes: bytes = None, filename: str = None) -> str:
        """
        Create a Bill in QBO for an overhead invoice.
        Optionally attaches the original invoice file to the bill.

        gl_account: the GL account code or name from vendor_rules
        file_bytes: raw bytes of the invoice PDF or image (optional)
        filename:   original filename for the attachment (optional)

        Returns the QBO Bill Id.
        """
        # ── Resolve vendor ────────────────────────────────────────────────────
        vendor = await self.find_or_create_vendor(invoice.vendor_name)
        vendor_ref = {"value": vendor["Id"], "name": vendor["DisplayName"]}

        # ── Resolve GL account ────────────────────────────────────────────────
        account = await self.find_account(gl_account)
        if not account:
            raise ValueError(
                f"GL account '{gl_account}' not found in QBO chart of accounts. "
                f"Check that the account code exists in QBO."
            )
        account_ref = {"value": account["Id"], "name": account["Name"]}

        # ── Resolve tax code ──────────────────────────────────────────────────
        # Determine if invoice carries GST and/or PST based on extracted tax lines
        has_gst = any(
            "gst" in (tl.tax_name or "").lower() or "cra" in (tl.tax_name or "").lower()
            for tl in (invoice.tax_lines or [])
        )
        has_pst = any(
            "pst" in (tl.tax_name or "").lower() or "bc" in (tl.tax_name or "").lower()
            for tl in (invoice.tax_lines or [])
        )

        # Default to GST+PST for BC vendors if we couldn't detect from extraction
        if not has_gst and not has_pst and invoice.tax_amount and invoice.tax_amount > 0:
            has_gst = True
            has_pst = True

        tax_code_id = await self._resolve_tax_code(has_gst, has_pst)
        # If no tax code found, post without tax coding — QBO will leave it uncoded
        # This is acceptable for sandbox testing and for overhead invoices

        # ── Build line items ──────────────────────────────────────────────────
        if invoice.line_items:
            lines = [
                {
                    "Amount": li.amount,
                    "DetailType": "AccountBasedExpenseLineDetail",
                    "Description": li.description or "",
                    "AccountBasedExpenseLineDetail": {
                        "AccountRef": account_ref,
                        "BillableStatus": "NotBillable",
                        **({"TaxCodeRef": {"value": tax_code_id}} if tax_code_id else {}),
                    },
                }
                for li in invoice.line_items
            ]
        else:
            lines = [
                {
                    "Amount": invoice.subtotal or invoice.total_amount,
                    "DetailType": "AccountBasedExpenseLineDetail",
                    "Description": f"Invoice {invoice.invoice_number or ''} — {invoice.vendor_name}",
                    "AccountBasedExpenseLineDetail": {
                        "AccountRef": account_ref,
                        "BillableStatus": "NotBillable",
                        **({"TaxCodeRef": {"value": tax_code_id}} if tax_code_id else {}),
                    },
                }
            ]

        # ── Build bill payload ────────────────────────────────────────────────
        bill_body = {
            "VendorRef": vendor_ref,
            "CurrencyRef": {"value": invoice.currency or "CAD"},
            "TxnDate": invoice.invoice_date,
            "DueDate": invoice.due_date,
            "DocNumber": invoice.invoice_number,
            "PrivateNote": (
                f"Auto-posted by AP Automation | "
                f"Source: {invoice.intake_source or 'upload'} | "
                f"PDF: {invoice.pdf_filename or 'n/a'}"
            ),
            "Line": lines,
            "GlobalTaxCalculation": "TaxExcluded",
        }

        logger.info(
            f"Posting QBO bill — vendor: {invoice.vendor_name}, "
            f"amount: {invoice.total_amount} CAD, GL: {gl_account}"
        )

        try:
            result = await self._post("bill", bill_body)
        except httpx.HTTPStatusError as e:
            error_body = e.response.text
            logger.error(f"QBO bill POST failed — status {e.response.status_code}")
            logger.error(f"QBO error response: {error_body}")
            logger.error(f"QBO bill payload: {bill_body}")
            raise

        bill = result.get("Bill", {})
        bill_id = bill.get("Id")

        if not bill_id:
            raise ValueError(f"QBO bill creation returned no Id. Response: {result}")

        logger.info(f"QBO bill created — Id: {bill_id}, DocNumber: {invoice.invoice_number}")

        # ── Attach original invoice file ──────────────────────────────────────
        if file_bytes and filename:
            try:
                await self._attach_file_to_bill(bill_id, file_bytes, filename)
                logger.info(f"Attached '{filename}' to QBO bill {bill_id}")
            except Exception as e:
                logger.warning(f"Could not attach file to QBO bill {bill_id}: {e} — bill was still created")

        return bill_id

    async def _attach_file_to_bill(self, bill_id: str, file_bytes: bytes, filename: str) -> None:
        """
        Upload a file and attach it to a QBO bill using the attachable endpoint.
        QBO supports PDF, JPG, PNG attachments on bills.
        """
        import base64
        import mimetypes

        # Detect MIME type
        mime_type, _ = mimetypes.guess_type(filename)
        if not mime_type:
            if filename.lower().endswith(".pdf"):
                mime_type = "application/pdf"
            else:
                mime_type = "image/jpeg"

        file_b64 = base64.b64encode(file_bytes).decode("utf-8")

        body = {
            "AttachableRef": [{"EntityRef": {"type": "Bill", "value": bill_id}}],
            "FileName": filename,
            "ContentType": mime_type,
            "Note": f"Original invoice — auto-attached by AP Automation",
        }

        token = await self._ensure_token()
        # QBO attachment upload uses multipart form — different from regular JSON POST
        import httpx
        files = {"file_metadata_01": (None, str(body).replace("'", '"'), "application/json")}

        # Use the upload endpoint
        upload_url = f"{self.base_url}/v3/company/{self.realm_id}/upload"
        resp = await self._http.post(
            upload_url,
            params={"minorversion": "70"},
            headers={"Authorization": f"Bearer {token}"},
            files={
                "file_metadata_01": (None, __import__("json").dumps(body), "application/json"),
                "file_content_01":  (filename, file_bytes, mime_type),
            },
        )
        if resp.status_code not in (200, 201):
            raise ValueError(f"Attachment upload failed: {resp.status_code} {resp.text[:200]}")

    # ── Vendor statement reconciliation (future) ──────────────────────────────

    async def get_vendor_bills(
        self,
        vendor_name: str,
        from_date: str,
        to_date: str,
    ) -> list[dict]:
        """
        Fetch all bills for a vendor in a date range.
        Used for vendor statement reconciliation.

        from_date / to_date: "YYYY-MM-DD"
        """
        vendor = await self.find_vendor(vendor_name)
        if not vendor:
            return []

        vendor_id = vendor["Id"]
        result = await self._get(
            "query",
            {
                "query": (
                    f"SELECT * FROM Bill "
                    f"WHERE VendorRef = '{vendor_id}' "
                    f"AND TxnDate >= '{from_date}' "
                    f"AND TxnDate <= '{to_date}' "
                    f"MAXRESULTS 200"
                )
            },
        )
        return result.get("QueryResponse", {}).get("Bill", [])

    async def close(self):
        await self._http.aclose()


# ── OAuth2 setup router ───────────────────────────────────────────────────────
# Mount this in main.py: app.include_router(qbo_auth_router)
# Run ONCE to get your initial refresh token, then store it in .env / secrets.

qbo_auth_router = APIRouter(prefix="/auth/qbo", tags=["auth"])


@qbo_auth_router.get("/connect")
async def qbo_connect():
    """
    Step 1: Redirect the user to QBO's OAuth2 authorisation page.
    Visit http://localhost:8000/auth/qbo/connect in your browser.
    """
    params = {
        "client_id":     settings.QBO_CLIENT_ID,
        "response_type": "code",
        "scope":         SCOPE,
        "redirect_uri":  "https://ap-automation-production.up.railway.app/auth/qbo/callback",
        "state":         "ap-automation-setup",
    }
    return RedirectResponse(f"{INTUIT_AUTH_URL}?{urlencode(params)}")


@qbo_auth_router.get("/callback")
async def qbo_callback(code: str, realmId: str, state: str):
    """
    Step 2: QBO redirects here with an auth code.
    Exchange it for access + refresh tokens, then print them.
    Store the refresh_token as QBO_REFRESH_TOKEN in your .env.
    Store realmId as QBO_REALM_ID in your .env.
    """
    async with httpx.AsyncClient() as http:
        resp = await http.post(
            INTUIT_TOKEN_URL,
            data={
                "grant_type":   "authorization_code",
                "code":          code,
                "redirect_uri": "https://ap-automation-production.up.railway.app/auth/qbo/callback",
            },
            auth=(settings.QBO_CLIENT_ID, settings.QBO_CLIENT_SECRET),
            headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        tokens = resp.json()

    refresh_token = tokens["refresh_token"]
    access_token  = tokens["access_token"]

    logger.info(f"QBO OAuth complete — realmId: {realmId}")
    logger.info(f"Add to .env:  QBO_REALM_ID={realmId}")
    logger.info(f"Add to .env:  QBO_REFRESH_TOKEN={refresh_token}")

    return {
        "message":       "QBO connected. Copy these values into your .env file.",
        "QBO_REALM_ID":        realmId,
        "QBO_REFRESH_TOKEN":   refresh_token,
        "note": (
            "The access_token is short-lived (60 min) and NOT needed in .env. "
            "Only store the refresh_token — the app renews the access token automatically."
        ),
    }
