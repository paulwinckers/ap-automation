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

import asyncio
import logging
import time
from datetime import date, datetime
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


def _to_qbo_date(d: str | None) -> str:
    """Normalize any date string to YYYY-MM-DD for QBO. Falls back to today."""
    if not d:
        return date.today().isoformat()
    # Already correct
    if len(d) == 10 and d[4] == "-":
        return d
    # Try common formats
    for fmt in ("%m/%d/%Y", "%d/%m/%Y", "%B %d, %Y", "%b %d, %Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(d, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    logger.warning(f"Could not parse date '{d}' — using today")
    return date.today().isoformat()

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

    async def _get(self, path: str, params: dict = None, _retry: int = 0) -> dict:
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
        if resp.status_code == 429 and _retry < 4:
            wait = int(resp.headers.get("Retry-After", 10 * (2 ** _retry)))
            logger.warning(f"QBO rate limit (429) — waiting {wait}s before retry {_retry + 1}/4")
            await asyncio.sleep(wait)
            return await self._get(path, params, _retry + 1)
        resp.raise_for_status()
        return resp.json()

    async def _post(self, path: str, body: dict, _retry: int = 0) -> dict:
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
        if resp.status_code == 429 and _retry < 4:
            wait = int(resp.headers.get("Retry-After", 10 * (2 ** _retry)))
            logger.warning(f"QBO rate limit (429) on POST — waiting {wait}s before retry {_retry + 1}/4")
            await asyncio.sleep(wait)
            return await self._post(path, body, _retry + 1)
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

    async def _get_purchase_tax_rate_refs(self, tax_code_id: str) -> list[str]:
        """
        Return the list of TaxRateRef values from a TaxCode's PurchaseTaxRateList.
        Used to build explicit TxnTaxDetail amounts.
        """
        codes = await self._get_tax_codes()
        for tc in codes.values():
            if tc["Id"] == tax_code_id:
                rate_list = tc.get("PurchaseTaxRateList", {}).get("TaxRateDetail", [])
                return [r["TaxRateRef"]["value"] for r in rate_list if "TaxRateRef" in r]
        return []

    async def _build_line_and_taxes(
        self,
        invoice: "Invoice",
        account_ref: dict,
    ) -> tuple[list, Optional[dict], str]:
        """
        Build a single expense line + resolve tax code for QBO Canada.

        Returns (lines, txn_tax_detail, global_tax_calculation).

        Strategy: set TaxCodeRef on the line and let QBO calculate tax from its
        own rate tables (TaxExcluded).  Never send explicit TxnTaxDetail —
        QBO Canada error 6000 fires whenever manual amounts don't match the
        stored rate to the cent.  Standard CA rates (5% GST, 7% PST) produce
        the same amounts as the invoice anyway.
        """
        # ── Description: summarise extracted line items ───────────────────────
        if invoice.line_items:
            parts = [li.description for li in invoice.line_items if li.description]
            summary = "; ".join(parts[:5])
            if len(invoice.line_items) > 5:
                summary += f" (+{len(invoice.line_items) - 5} more)"
        else:
            summary = None

        inv_ref = f"Invoice {invoice.invoice_number}" if invoice.invoice_number else invoice.vendor_name
        description = f"{inv_ref} — {summary}" if summary else inv_ref

        # ── Line amount: subtotal (pre-tax) ───────────────────────────────────
        line_amount = invoice.subtotal if invoice.subtotal else invoice.total_amount

        line: dict = {
            "Amount": line_amount,
            "DetailType": "AccountBasedExpenseLineDetail",
            "Description": description,
            "AccountBasedExpenseLineDetail": {
                "AccountRef": account_ref,
                "BillableStatus": "NotBillable",
            },
        }

        # ── Resolve tax code (QBO Canada requires TaxCodeRef on every line) ──
        has_gst = any(
            "gst" in (tl.tax_name or "").lower() or "cra" in (tl.tax_name or "").lower()
            for tl in (invoice.tax_lines or [])
        )
        has_pst = any(
            "pst" in (tl.tax_name or "").lower() or "bc" in (tl.tax_name or "").lower()
            for tl in (invoice.tax_lines or [])
        )
        if not has_gst and not has_pst and invoice.tax_amount and invoice.tax_amount > 0:
            has_gst = True
            has_pst = True

        tax_code_id = await self._resolve_tax_code(has_gst, has_pst)
        if tax_code_id:
            line["AccountBasedExpenseLineDetail"]["TaxCodeRef"] = {"value": tax_code_id}
            global_tax_calc = "TaxExcluded"
        else:
            global_tax_calc = "NotApplicable"

        # TxnTaxDetail is intentionally omitted — QBO Canada calculates tax
        # from TaxCodeRef automatically; sending explicit amounts triggers
        # error 6000 when they don't match the stored rate exactly.
        return [line], None, global_tax_calc

    # ── Vendor lookup ─────────────────────────────────────────────────────────

    async def find_vendor(self, vendor_name: str) -> Optional[dict]:
        """
        Look up a vendor by name in QBO.
        Tries exact match first, then partial LIKE match (active vendors), then
        inactive vendors — so we never create a duplicate just because someone
        deactivated the old record.
        Returns the vendor object or None.
        """
        # QBO's IDS query API is XML-based internally — '&' in a string literal
        # is treated as a malformed XML entity and causes a 400. Escape it.
        escaped = vendor_name.replace("&", "&amp;").replace("'", "\\'")
        # For LIKE queries: use the text before any '&' or '(' so we avoid the
        # problematic character entirely, then strip legal suffixes and collapse spaces.
        import re as _re
        like_base = vendor_name.split("&")[0].split("(")[0]
        like_base = " ".join(like_base.split())
        like_base = _re.sub(
            r'\s+(Ltd\.?|LTD\.?|Inc\.?|INC\.?|Corp\.?|CORP\.?|LLC|L\.L\.C\.?|Co\.?|CO\.?)$',
            '', like_base, flags=_re.IGNORECASE
        ).strip()
        like_term = like_base.replace("&", "&amp;").replace("'", "\\'")

        # 1. Exact match (active)
        result = await self._get(
            "query",
            {"query": f"SELECT * FROM Vendor WHERE DisplayName = '{escaped}' MAXRESULTS 1"},
        )
        vendors = result.get("QueryResponse", {}).get("Vendor", [])
        if vendors:
            return vendors[0]

        # 2. Partial match (active) — handles minor name differences
        result = await self._get(
            "query",
            {"query": f"SELECT * FROM Vendor WHERE DisplayName LIKE '%{like_term}%' MAXRESULTS 5"},
        )
        for v in result.get("QueryResponse", {}).get("Vendor", []):
            if "deleted" not in v.get("DisplayName", "").lower():
                return v

        # 3. First-significant-word fallback on ACTIVE vendors — handles cases where statement
        #    name and QBO name share a key word but differ in the rest
        #    (e.g. "LORDCO PARTS LTD" vs "Lordco Auto Parts").
        #    Done BEFORE the inactive search so active accounts are always preferred.
        words = [w for w in like_base.split() if len(w) >= 5]
        if words:
            first_word = words[0].replace("&", "&amp;").replace("'", "\\'")
            result = await self._get(
                "query",
                {"query": f"SELECT * FROM Vendor WHERE DisplayName LIKE '%{first_word}%' MAXRESULTS 10"},
            )
            for v in result.get("QueryResponse", {}).get("Vendor", []):
                if "deleted" not in v.get("DisplayName", "").lower():
                    logger.info(f"First-word vendor match: '{vendor_name}' → '{v['DisplayName']}' (word: '{first_word}')")
                    return v

        # 4. Partial match (inactive, non-deleted) — last resort to prevent creating duplicates
        #    when a vendor was deactivated. Not used for reconciliation (active preferred above).
        result = await self._get(
            "query",
            {"query": f"SELECT * FROM Vendor WHERE DisplayName LIKE '%{like_term}%' AND Active = false MAXRESULTS 5"},
        )
        for v in result.get("QueryResponse", {}).get("Vendor", []):
            if "deleted" not in v.get("DisplayName", "").lower():
                return v

        return None

    async def find_or_create_vendor(self, vendor_name: str) -> dict:
        """Find vendor in QBO, creating a stub record only if truly not found."""
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
        Look up a QBO account by name or AcctNum.
        QBO's query API doesn't support filtering by AcctNum, so we fetch the
        full COA and search in memory.
        e.g. find_account("6710") or find_account("Shop purchases and supplies")
        """
        # Try exact name match first (fast path for when we already have the name)
        escaped = account_code.replace("'", "\\'")
        result = await self._get(
            "query",
            {"query": f"SELECT * FROM Account WHERE Name = '{escaped}' MAXRESULTS 1"},
        )
        accounts = result.get("QueryResponse", {}).get("Account", [])
        if accounts:
            return accounts[0]

        # Fall back: fetch full COA and search by AcctNum in memory
        # (QBO doesn't support WHERE AcctNum = '...' in queries)
        all_accounts = await self.list_expense_accounts()
        for acct in all_accounts:
            if acct.get("AcctNum") == account_code:
                return acct

        # Also search credit card / liability accounts (not in list_expense_accounts)
        # MasterCard, Visa, AMEX accounts live under AccountType = 'Credit Card'
        cc_result = await self._get(
            "query",
            {"query": "SELECT Id, Name, AcctNum, AccountType FROM Account WHERE Active = true AND AccountType = 'Credit Card' MAXRESULTS 50"},
        )
        cc_accounts = cc_result.get("QueryResponse", {}).get("Account", [])
        for acct in cc_accounts:
            if acct.get("AcctNum") == account_code:
                return acct

        # Broad fallback: search ALL active account types (Asset, Liability, etc.)
        # Needed for GL codes outside the 6000s — e.g. 1xxx asset accounts, 2xxx liability accounts.
        # QBO returns up to 1000 records per query; split into two calls to stay within limits.
        for acct_type_filter in [
            "AccountType IN ('Other Current Asset', 'Fixed Asset', 'Bank')",
            "AccountType IN ('Other Current Liability', 'Long Term Liability', 'Other Asset')",
        ]:
            broad_result = await self._get(
                "query",
                {"query": f"SELECT Id, Name, AcctNum, AccountType, AccountSubType FROM Account WHERE Active = true AND {acct_type_filter} MAXRESULTS 200"},
            )
            for acct in broad_result.get("QueryResponse", {}).get("Account", []):
                if acct.get("AcctNum") == account_code:
                    return acct

        # Last resort: name contains the code (all already-fetched account types)
        code_lower = account_code.lower()
        for acct in all_accounts + cc_accounts:
            if code_lower in (acct.get("Name") or "").lower():
                return acct

        return None

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

        # ── Build single expense line + explicit tax detail ───────────────────
        lines, txn_tax_detail, global_tax_calc = await self._build_line_and_taxes(invoice, account_ref)

        # ── Build bill payload ────────────────────────────────────────────────
        # QBO rejects explicit null for optional fields — omit them entirely
        # Always post in CAD — multi-currency not enabled in QBO.
        # If original invoice was in another currency, note it in the private note.
        orig_currency = invoice.currency or "CAD"
        currency_note = f" | Original currency: {orig_currency} — update amount in QBO" if orig_currency != "CAD" else ""
        bill_body = {
            "VendorRef": vendor_ref,
            "CurrencyRef": {"value": "CAD"},
            "TxnDate": _to_qbo_date(invoice.invoice_date),
            "PrivateNote": (
                f"Auto-posted by AP Automation | "
                f"Source: {invoice.intake_source or 'upload'} | "
                f"PDF: {invoice.pdf_filename or 'n/a'}"
                f"{currency_note}"
            ),
            "Line": lines,
            "GlobalTaxCalculation": global_tax_calc,
        }
        if txn_tax_detail:
            bill_body["TxnTaxDetail"] = txn_tax_detail
        if invoice.due_date:
            bill_body["DueDate"] = _to_qbo_date(invoice.due_date)
        if invoice.invoice_number:
            bill_body["DocNumber"] = invoice.invoice_number

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

        qbo_amount = bill.get("TotalAmt")
        logger.info(f"QBO bill created — Id: {bill_id}, DocNumber: {invoice.invoice_number}, TotalAmt: {qbo_amount}")

        # ── Attach original invoice file ──────────────────────────────────────
        if file_bytes and filename:
            try:
                await self._attach_file_to_bill(bill_id, file_bytes, filename)
                logger.info(f"Attached '{filename}' to QBO bill {bill_id}")
            except Exception as e:
                logger.warning(f"Could not attach file to QBO bill {bill_id}: {e} — bill was still created")

        return bill_id, qbo_amount

    async def _attach_file(self, entity_id: str, entity_type: str, file_bytes: bytes, filename: str) -> None:
        """Upload a file and attach it to any QBO entity (Bill, VendorCredit, Purchase, etc.)."""
        import base64
        import mimetypes as _mimetypes
        mime_type, _ = _mimetypes.guess_type(filename)
        if not mime_type:
            mime_type = "application/pdf" if filename.lower().endswith(".pdf") else "image/jpeg"
        body = {
            "AttachableRef": [{"EntityRef": {"type": entity_type, "value": entity_id}}],
            "FileName": filename,
            "ContentType": mime_type,
            "Note": f"Original document — auto-attached by AP Automation",
        }
        token = await self._ensure_token()
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

    # ── Purchase (credit card charge) creation ────────────────────────────────

    async def post_purchase(
        self,
        invoice: Invoice,
        gl_account: str,
        payment_account: str = None,   # None → use settings.MASTERCARD_GL
        employee_name: str = None,
        file_bytes: bytes = None,
        filename: str = None,
    ) -> str:
        """
        Create a Purchase (CreditCardCharge) in QBO for a MasterCard receipt.

        payment_account: the QBO account code for the company MasterCard (default 2240)
        gl_account:      the expense GL account to charge (from vendor rule or fallback)

        Returns the QBO Purchase Id.
        """
        # ── Resolve payment account (MasterCard liability) ────────────────────
        if payment_account is None:
            payment_account = settings.MASTERCARD_GL
        pay_account = await self.find_account(payment_account)
        if not pay_account:
            raise ValueError(
                f"Payment account '{payment_account}' not found in QBO chart of accounts."
            )
        pay_account_ref = {"value": pay_account["Id"], "name": pay_account["Name"]}

        # ── Resolve expense GL account ────────────────────────────────────────
        account = await self.find_account(gl_account)
        if not account:
            raise ValueError(
                f"GL account '{gl_account}' not found in QBO chart of accounts."
            )
        account_ref = {"value": account["Id"], "name": account["Name"]}

        # ── Build single expense line + explicit tax detail ───────────────────
        lines, txn_tax_detail, global_tax_calc = await self._build_line_and_taxes(invoice, account_ref)

        # ── Build purchase payload ────────────────────────────────────────────
        # QBO rejects explicit null for optional fields — omit them entirely
        employee_note = f" | Purchased by: {employee_name}" if employee_name else ""
        purchase_body = {
            "PaymentType": "CreditCard",
            "AccountRef": pay_account_ref,
            "CurrencyRef": {"value": invoice.currency or "CAD"},
            "TxnDate": _to_qbo_date(invoice.invoice_date),
            "PrivateNote": (
                f"Auto-posted by AP Automation | MasterCard receipt{employee_note} | "
                f"Source: {invoice.intake_source or 'upload'} | "
                f"PDF: {invoice.pdf_filename or 'n/a'}"
            ),
            "Line": lines,
            "GlobalTaxCalculation": global_tax_calc,
        }
        if txn_tax_detail:
            purchase_body["TxnTaxDetail"] = txn_tax_detail
        if invoice.invoice_number:
            purchase_body["DocNumber"] = invoice.invoice_number

        # Optional: link to employee/vendor as EntityRef on the purchase
        if invoice.vendor_name:
            vendor = await self.find_vendor(invoice.vendor_name)
            if vendor:
                purchase_body["EntityRef"] = {
                    "value": vendor["Id"],
                    "name": vendor["DisplayName"],
                    "type": "Vendor",
                }

        logger.info(
            f"Posting QBO purchase (MC) — vendor: {invoice.vendor_name}, "
            f"amount: {invoice.total_amount} CAD, GL: {gl_account}"
        )
        logger.debug(f"QBO purchase payload: {purchase_body}")

        try:
            result = await self._post("purchase", purchase_body)
        except httpx.HTTPStatusError as e:
            error_body = e.response.text
            logger.error(f"QBO purchase POST failed — status {e.response.status_code}")
            logger.error(f"QBO error response: {error_body}")
            logger.error(f"QBO purchase payload: {purchase_body}")
            raise
        except Exception as e:
            logger.error(f"QBO purchase POST failed: {e}")
            raise

        purchase = result.get("Purchase", {})
        purchase_id = purchase.get("Id")

        if not purchase_id:
            raise ValueError(f"QBO purchase creation returned no Id. Response: {result}")

        qbo_amount = purchase.get("TotalAmt")
        logger.info(f"QBO purchase created — Id: {purchase_id}, TotalAmt: {qbo_amount}")

        # ── Attach original receipt file ──────────────────────────────────────
        if file_bytes and filename:
            try:
                await self._attach_file(purchase_id, "Purchase", file_bytes, filename)
                logger.info(f"Attached '{filename}' to QBO purchase {purchase_id}")
            except Exception as e:
                logger.warning(f"Could not attach file to QBO purchase {purchase_id}: {e}")

        return purchase_id, qbo_amount

    # ── Vendor credit creation ────────────────────────────────────────────────

    async def post_vendor_credit(self, invoice: Invoice, gl_account: str, file_bytes: bytes = None, filename: str = None) -> str:
        """
        Create a VendorCredit in QBO for a vendor credit memo / store return.
        Uses TaxInclusive with the full absolute total so QBO back-calculates
        tax — avoids rate-mismatch 400 errors from negative extracted amounts.
        Returns (credit_id, qbo_amount).
        """
        vendor = await self.find_or_create_vendor(invoice.vendor_name)
        vendor_ref = {"value": vendor["Id"], "name": vendor["DisplayName"]}

        account = await self.find_account(gl_account)
        if not account:
            raise ValueError(f"GL account '{gl_account}' not found in QBO chart of accounts.")
        account_ref = {"value": account["Id"], "name": account["Name"]}

        # Use the full absolute total as the line amount with TaxInclusive so QBO
        # back-calculates the tax split.  This avoids 400 errors from negative
        # extracted tax amounts or rate-mismatch issues on the credit side.
        total_abs = abs(invoice.total_amount or invoice.subtotal or 0)

        # Build description from line items (same logic as _build_line_and_taxes)
        if invoice.line_items:
            parts = [li.description for li in invoice.line_items if li.description]
            summary = "; ".join(parts[:5])
            if len(invoice.line_items) > 5:
                summary += f" (+{len(invoice.line_items) - 5} more)"
            inv_ref = f"Invoice {invoice.invoice_number}" if invoice.invoice_number else invoice.vendor_name
            description = f"{inv_ref} — {summary}"
        else:
            description = f"Invoice {invoice.invoice_number}" if invoice.invoice_number else invoice.vendor_name

        # Resolve tax code (same pattern as _build_line_and_taxes)
        has_tax = bool(invoice.tax_amount and invoice.tax_amount != 0)
        tax_code_id = await self._resolve_tax_code(has_tax, has_tax) if has_tax else None

        line: dict = {
            "Amount": total_abs,
            "DetailType": "AccountBasedExpenseLineDetail",
            "Description": description,
            "AccountBasedExpenseLineDetail": {
                "AccountRef": account_ref,
                "BillableStatus": "NotBillable",
            },
        }
        if tax_code_id:
            line["AccountBasedExpenseLineDetail"]["TaxCodeRef"] = {"value": tax_code_id}
            global_tax_calc = "TaxInclusive"
        else:
            global_tax_calc = "NotApplicable"

        credit_body = {
            "VendorRef": vendor_ref,
            "CurrencyRef": {"value": "CAD"},
            "TxnDate": _to_qbo_date(invoice.invoice_date),
            "PrivateNote": (
                f"Auto-posted by AP Automation | Credit memo / return | "
                f"Source: {invoice.intake_source or 'field'} | "
                f"PDF: {invoice.pdf_filename or 'n/a'}"
            ),
            "Line": [line],
            "GlobalTaxCalculation": global_tax_calc,
        }
        if invoice.invoice_number:
            credit_body["DocNumber"] = invoice.invoice_number

        logger.info(
            f"Posting QBO vendor credit — vendor: {invoice.vendor_name}, "
            f"amount: {invoice.total_amount} CAD, GL: {gl_account}"
        )

        try:
            result = await self._post("vendorcredit", credit_body)
        except httpx.HTTPStatusError as e:
            logger.error(f"QBO vendor credit POST failed — status {e.response.status_code}: {e.response.text}")
            raise

        credit = result.get("VendorCredit", {})
        credit_id = credit.get("Id")
        if not credit_id:
            raise ValueError(f"QBO vendor credit creation returned no Id. Response: {result}")

        qbo_amount = credit.get("TotalAmt")
        logger.info(f"QBO vendor credit created — Id: {credit_id}, DocNumber: {invoice.invoice_number}, TotalAmt: {qbo_amount}")

        if file_bytes and filename:
            try:
                await self._attach_file(credit_id, "VendorCredit", file_bytes, filename)
                logger.info(f"Attached '{filename}' to QBO vendor credit {credit_id}")
            except Exception as e:
                logger.warning(f"Could not attach file to QBO vendor credit {credit_id}: {e}")

        return credit_id, qbo_amount

    # ── Chart of accounts ─────────────────────────────────────────────────────

    async def list_expense_accounts(self) -> list[dict]:
        """
        Return all active expense/overhead accounts from the QBO chart of accounts.
        Used for GL suggestion when a vendor is unknown or the user wants to correct the GL.
        """
        # QBO query language doesn't support OR with parentheses — run two queries
        expense_result = await self._get(
            "query",
            {"query": "SELECT Id, Name, AcctNum, AccountType, AccountSubType FROM Account WHERE Active = true AND AccountType = 'Expense' MAXRESULTS 200"},
        )
        other_result = await self._get(
            "query",
            {"query": "SELECT Id, Name, AcctNum, AccountType, AccountSubType FROM Account WHERE Active = true AND AccountType = 'Other Expense' MAXRESULTS 200"},
        )
        accounts = (
            expense_result.get("QueryResponse", {}).get("Account", []) +
            other_result.get("QueryResponse", {}).get("Account", [])
        )
        return accounts

    # ── Vendor statement reconciliation (future) ──────────────────────────────

    async def search_vendors(self, q: str) -> list[dict]:
        """Search active QBO vendors by name fragment. Used for vendor linking UI."""
        escaped = q.replace("&", "&amp;").replace("'", "\\'")
        result = await self._get(
            "query",
            {"query": f"SELECT Id, DisplayName, Active FROM Vendor WHERE DisplayName LIKE '%{escaped}%' AND Active = true MAXRESULTS 20"},
        )
        return result.get("QueryResponse", {}).get("Vendor", [])

    async def get_vendor_bills(
        self,
        vendor_name: str,
        from_date: str,
        to_date: str,
        vendor_id: str = None,
    ) -> list[dict]:
        """
        Fetch bills for a vendor that were OPEN as of to_date.
        Used for vendor statement reconciliation — moment-in-time snapshot.

        A bill is "open as of to_date" if:
          TxnDate <= to_date  (it existed by the statement date)
          AND (TotalAmt - payments_received_on_or_before_to_date) > 0

        Bills paid AFTER to_date are treated as unpaid for reconciliation purposes.
        Bills fully paid ON OR BEFORE to_date are excluded (they were closed by then).

        Each returned bill has an extra key `_balance_as_of_date` with the
        as-of-date outstanding balance for use in the diff engine.
        """
        if not vendor_id:
            vendor = await self.find_vendor(vendor_name)
            if not vendor:
                return []
            vendor_id = vendor["Id"]

        # Fetch all bills with TxnDate <= to_date
        result = await self._get(
            "query",
            {
                "query": (
                    f"SELECT * FROM Bill "
                    f"WHERE VendorRef = '{vendor_id}' "
                    f"AND TxnDate <= '{to_date}' "
                    f"MAXRESULTS 200"
                )
            },
        )
        all_bills = result.get("QueryResponse", {}).get("Bill", [])
        if not all_bills:
            return []

        # Fetch BillPayments made ON OR BEFORE to_date so we know what was
        # already paid by the statement date.
        pay_result = await self._get(
            "query",
            {
                "query": (
                    f"SELECT * FROM BillPayment "
                    f"WHERE VendorRef = '{vendor_id}' "
                    f"AND TxnDate <= '{to_date}' "
                    f"MAXRESULTS 200"
                )
            },
        )
        payments = pay_result.get("QueryResponse", {}).get("BillPayment", [])

        # Build map: bill_id → total amount paid on or before to_date
        paid_by_date: dict[str, float] = {}
        for pmt in payments:
            for line in pmt.get("Line", []):
                for linked in line.get("LinkedTxn", []):
                    if linked.get("TxnType") == "Bill":
                        bill_id = linked.get("TxnId")
                        if bill_id:
                            paid_by_date[bill_id] = (
                                paid_by_date.get(bill_id, 0.0)
                                + float(line.get("Amount") or 0)
                            )

        # Keep only bills that had an outstanding balance as of to_date
        open_bills = []
        for bill in all_bills:
            total = float(bill.get("TotalAmt") or 0)
            paid = paid_by_date.get(bill["Id"], 0.0)
            balance_as_of_date = round(total - paid, 2)
            if balance_as_of_date > 0.01:
                bill["_balance_as_of_date"] = balance_as_of_date
                open_bills.append(bill)

        return open_bills

    async def get_transaction_amount(self, entity_id: str, doc_type: Optional[str]) -> Optional[float]:
        """
        Fetch TotalAmt for a single QBO transaction by ID.
        Uses doc_type as a hint but falls back through all entity types if the
        first attempt returns a 400/404 (e.g. doc_type is NULL but entity is a VendorCredit).
        Returns None only if all three types fail.
        """
        if doc_type == "credit_memo":
            candidates = [("vendorcredit", "VendorCredit"), ("bill", "Bill"), ("purchase", "Purchase")]
        elif doc_type == "mastercard":
            candidates = [("purchase", "Purchase"), ("bill", "Bill"), ("vendorcredit", "VendorCredit")]
        else:
            candidates = [("bill", "Bill"), ("vendorcredit", "VendorCredit"), ("purchase", "Purchase")]

        for path_prefix, key in candidates:
            try:
                result = await self._get(f"{path_prefix}/{entity_id}")
                amount = result.get(key, {}).get("TotalAmt")
                if amount is not None:
                    return amount
            except Exception:
                continue
        return None

    async def get_attachment_url(self, entity_id: str, doc_type: Optional[str]) -> Optional[str]:
        """
        Return the TempDownloadUri for the first attachment on a QBO transaction.
        QBO's TempDownloadUri is valid for a short window (~30 minutes).
        Returns None if no attachment found.
        """
        if doc_type == "credit_memo":
            entity_type = "VendorCredit"
        elif doc_type in ("mastercard", "mc_purchase"):
            entity_type = "Purchase"
        else:
            entity_type = "Bill"

        escaped_id = entity_id.replace("'", "\\'")
        try:
            result = await self._get(
                "query",
                {"query": f"SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = '{entity_type}' AND AttachableRef.EntityRef.value = '{escaped_id}' MAXRESULTS 1"},
            )
            attachables = result.get("QueryResponse", {}).get("Attachable", [])
            if attachables:
                return attachables[0].get("TempDownloadUri")
        except Exception as e:
            logger.warning(f"Could not fetch QBO attachment for {entity_type} {entity_id}: {e}")
        return None

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

    # Save the new refresh token to D1 immediately so the running app picks it up
    from app.services.d1_settings import set_setting
    await set_setting("QBO_REFRESH_TOKEN", refresh_token)
    logger.info("New QBO refresh token saved to D1")

    return {
        "message": "✅ QBO reconnected successfully. Token saved — no manual steps needed.",
        "QBO_REALM_ID":      realmId,
        "QBO_REFRESH_TOKEN": refresh_token,
        "note": (
            "The refresh token has been saved to D1 automatically. "
            "Also update QBO_REFRESH_TOKEN in Railway env vars so it survives a full redeploy."
        ),
    }
