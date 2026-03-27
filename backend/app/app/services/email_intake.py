"""
Email intake service — monitors the AP inbox via Microsoft Graph API
and processes incoming vendor invoices automatically.

Auth:     App-only (client credentials) — no user login required.
Polling:  Every 5 minutes via a background task started on app startup.
Scope:    Mail.Read, Mail.ReadWrite on the AP mailbox.

Routing logic per email:
  - Overhead vendor        → extract with Claude, post to QBO automatically
  - Construction vendor    → forward to keeland@darios.ca + summary note
  - Inventory vendor       → forward to keeland@darios.ca + summary note
  - Maintenance vendor     → forward to paul@darios.ca + summary note
  - Unknown vendor         → forward to paul@darios.ca + extracted data
                             + suggested vendor rule to add
  - Mixed vendor + PO      → forward to appropriate job cost address
  - Mixed vendor + no PO   → forward to paul@darios.ca for review

Setup:
  1. Register app in Azure portal (portal.azure.com)
  2. Add Mail.Read and Mail.ReadWrite application permissions
  3. Grant admin consent
  4. Add to .env:
       MS_CLIENT_ID=your-app-client-id
       MS_TENANT_ID=your-azure-tenant-id
       MS_CLIENT_SECRET=your-client-secret
       MS_AP_INBOX=ap@darios.ca
"""

import asyncio
import base64
import logging
import time
from typing import Optional

import httpx

from app.core.config import settings
from app.core.database import Database
from app.models.invoice import Invoice, InvoiceStatus, LineItem, TaxLine
from app.services.extractor import InvoiceExtractor
from app.services.qbo import QBOClient
from app.services.routing import route_invoice, RoutingOutcome
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)

# ── Routing destinations ──────────────────────────────────────────────────────
DEST_KEELAND  = "keeland@darios.ca"   # construction + inventory vendors
DEST_PAUL     = "paul@darios.ca"      # maintenance vendors + unknown vendors

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
TOKEN_URL  = "https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"


class GraphClient:
    """Microsoft Graph API client using app-only (client credentials) auth."""

    def __init__(self):
        self._token: Optional[str] = None
        self._token_expiry: float = 0
        self._http = httpx.AsyncClient(timeout=30.0)

    async def _ensure_token(self) -> str:
        if self._token and time.time() < self._token_expiry - 60:
            return self._token
        url = TOKEN_URL.format(tenant_id=settings.MS_TENANT_ID)
        resp = await self._http.post(url, data={
            "grant_type":    "client_credentials",
            "client_id":     settings.MS_CLIENT_ID,
            "client_secret": settings.MS_CLIENT_SECRET,
            "scope":         "https://graph.microsoft.com/.default",
        })
        resp.raise_for_status()
        data = resp.json()
        self._token = data["access_token"]
        self._token_expiry = time.time() + data["expires_in"]
        return self._token

    async def _headers(self) -> dict:
        token = await self._ensure_token()
        return {"Authorization": f"Bearer {token}", "Accept": "application/json"}

    async def _get(self, path: str, params: dict = None) -> dict:
        resp = await self._http.get(
            f"{GRAPH_BASE}/{path.lstrip('/')}",
            params=params,
            headers=await self._headers(),
        )
        resp.raise_for_status()
        return resp.json()

    async def _post(self, path: str, body: dict) -> Optional[dict]:
        h = await self._headers()
        h["Content-Type"] = "application/json"
        resp = await self._http.post(
            f"{GRAPH_BASE}/{path.lstrip('/')}",
            json=body,
            headers=h,
        )
        resp.raise_for_status()
        return resp.json() if resp.content else None

    async def _patch(self, path: str, body: dict) -> None:
        h = await self._headers()
        h["Content-Type"] = "application/json"
        resp = await self._http.patch(
            f"{GRAPH_BASE}/{path.lstrip('/')}",
            json=body,
            headers=h,
        )
        resp.raise_for_status()

    async def get_unread_emails(self, mailbox: str) -> list[dict]:
        result = await self._get(
            f"users/{mailbox}/mailFolders/inbox/messages",
            params={
                "$filter": "isRead eq false",
                "$orderby": "receivedDateTime asc",
                "$top": "25",
                "$select": "id,subject,from,receivedDateTime,hasAttachments,body,isRead",
            },
        )
        return result.get("value", [])

    async def get_attachments(self, mailbox: str, message_id: str) -> list[dict]:
        result = await self._get(
            f"users/{mailbox}/messages/{message_id}/attachments"
        )
        return result.get("value", [])

    async def mark_as_read(self, mailbox: str, message_id: str) -> None:
        await self._patch(
            f"users/{mailbox}/messages/{message_id}",
            {"isRead": True},
        )

    async def forward_email(
        self,
        mailbox: str,
        message_id: str,
        to_address: str,
        comment: str,
    ) -> None:
        await self._post(
            f"users/{mailbox}/messages/{message_id}/forward",
            {
                "comment": comment,
                "toRecipients": [{"emailAddress": {"address": to_address}}],
            },
        )

    async def close(self):
        await self._http.aclose()


class EmailIntakeService:
    """
    Polls the AP inbox every 5 minutes and processes new emails.
    Started as a background task when the FastAPI app starts.
    """

    def __init__(self):
        self.graph     = GraphClient()
        self.extractor = InvoiceExtractor()
        self.qbo       = QBOClient()
        self.aspire    = AspireClient(sandbox=settings.ASPIRE_SANDBOX)
        self._running  = False

    async def start(self):
        if not settings.MS_CLIENT_ID or not settings.MS_TENANT_ID or not settings.MS_AP_INBOX:
            logger.info("Microsoft Graph not configured — email intake disabled")
            return
        self._running = True
        logger.info(f"Email intake started — polling {settings.MS_AP_INBOX} every 5 minutes")
        asyncio.create_task(self._poll_loop())

    async def stop(self):
        self._running = False
        await self.graph.close()

    async def _poll_loop(self):
        while self._running:
            try:
                await self._process_inbox()
            except Exception as e:
                logger.error(f"Email polling error: {e}")
            await asyncio.sleep(300)

    async def _process_inbox(self):
        emails = await self.graph.get_unread_emails(settings.MS_AP_INBOX)
        if not emails:
            return
        logger.info(f"Found {len(emails)} unread email(s) in AP inbox")
        db = Database()
        await db.connect()
        try:
            for email in emails:
                try:
                    await self._process_email(email, db)
                except Exception as e:
                    logger.error(f"Failed to process email '{email.get('subject')}': {e}")
        finally:
            await db.close()

    async def _process_email(self, email: dict, db: Database):
        message_id = email["id"]
        subject    = email.get("subject", "(no subject)")
        sender     = email.get("from", {}).get("emailAddress", {}).get("address", "unknown")
        logger.info(f"Processing: '{subject}' from {sender}")

        # ── Find the invoice content ──────────────────────────────────────────
        file_bytes: Optional[bytes] = None
        filename:   Optional[str]   = None

        if email.get("hasAttachments"):
            attachments = await self.graph.get_attachments(settings.MS_AP_INBOX, message_id)
            for att in attachments:
                name = att.get("name", "")
                if name.lower().endswith((".pdf", ".jpg", ".jpeg", ".png", ".webp")):
                    file_bytes = base64.b64decode(att["contentBytes"])
                    filename   = name
                    break

        if file_bytes is None:
            # Fall back to email body
            body_content = email.get("body", {}).get("content", "")
            if not body_content.strip():
                logger.info(f"No usable content in '{subject}' — skipping")
                await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
                return
            file_bytes = body_content.encode("utf-8")
            filename   = "email_body.html"

        # ── Extract with Claude ───────────────────────────────────────────────
        try:
            extraction = await self.extractor.extract_from_pdf_bytes(file_bytes, filename or "")
        except Exception as e:
            logger.error(f"Extraction failed for '{subject}': {e}")
            await self.graph.forward_email(
                settings.MS_AP_INBOX, message_id, DEST_PAUL,
                f"⚠️ AP Automation could not extract this invoice.\n\nError: {e}\n\nPlease process manually.",
            )
            await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
            return

        # ── Save to database ──────────────────────────────────────────────────
        invoice_id = await db.create_invoice(
            vendor_name    = extraction.vendor_name,
            invoice_number = extraction.invoice_number,
            invoice_date   = extraction.invoice_date,
            due_date       = extraction.due_date,
            subtotal       = extraction.subtotal,
            tax_amount     = extraction.tax_amount,
            total_amount   = extraction.total_amount,
            currency       = extraction.currency,
            po_number      = extraction.po_number,
            pdf_filename   = filename or "email",
            intake_source  = "email",
            intake_raw     = extraction.model_dump(),
        )
        await db.audit(invoice_id, "received", "email", {"from": sender, "subject": subject})
        await db.audit(invoice_id, "extracted", "claude", {
            "vendor": extraction.vendor_name, "total": extraction.total_amount,
        })

        # ── Vendor lookup ─────────────────────────────────────────────────────
        vendor_rule = await db.get_vendor_rule_by_name(extraction.vendor_name)

        if vendor_rule is None:
            # Unknown vendor — forward to Paul with full details
            await self._forward_unknown(message_id, extraction, invoice_id)
            await db.mark_queued(invoice_id, "vendor_unknown")

        elif vendor_rule.type == "overhead":
            # Post to QBO automatically
            invoice = Invoice(
                id             = invoice_id,
                status         = InvoiceStatus.PENDING,
                vendor_name    = extraction.vendor_name,
                invoice_number = extraction.invoice_number,
                invoice_date   = extraction.invoice_date,
                due_date       = extraction.due_date,
                subtotal       = extraction.subtotal,
                tax_amount     = extraction.tax_amount,
                total_amount   = extraction.total_amount,
                currency       = extraction.currency,
                po_number      = extraction.po_number,
                pdf_filename   = filename or "email",
                intake_source  = "email",
                line_items     = [LineItem(**li.model_dump()) for li in extraction.line_items],
                tax_lines      = [TaxLine(**tl.model_dump()) for tl in extraction.tax_lines],
            )
            outcome = await route_invoice(invoice, db, self.aspire, self.qbo)
            if outcome == RoutingOutcome.POSTED_QBO:
                logger.info(f"Invoice {invoice_id} auto-posted to QBO from email")
            else:
                await self.graph.forward_email(
                    settings.MS_AP_INBOX, message_id, DEST_PAUL,
                    f"⚠️ AP Automation tried to post this to QBO but failed.\n\nVendor: {extraction.vendor_name}\nAmount: ${extraction.total_amount} CAD\n\nPlease post manually.",
                )

        elif vendor_rule.type in ("job_cost", "mixed"):
            # Forward to the correct destination from vendor rule
            forward_to = vendor_rule.forward_to or DEST_PAUL
            summary    = self._build_summary(extraction, vendor_rule.type)
            await self.graph.forward_email(
                settings.MS_AP_INBOX, message_id, forward_to, summary
            )
            await db.audit(invoice_id, "forwarded", "system", {"to": forward_to})
            logger.info(f"Invoice {invoice_id} forwarded to {forward_to}")

        # ── Mark as read ──────────────────────────────────────────────────────
        await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)

    async def _forward_unknown(self, message_id: str, extraction, invoice_id: int):
        suggested = self._guess_type(extraction.vendor_name)
        note = f"""📋 AP Automation — Unknown Vendor

This invoice arrived but the vendor is not in your rules table.

EXTRACTED DATA:
  Vendor:   {extraction.vendor_name}
  Invoice:  {extraction.invoice_number or 'N/A'}
  Date:     {extraction.invoice_date or 'N/A'}
  Amount:   ${extraction.total_amount} {extraction.currency}
  PO#:      {extraction.po_number or 'Not found on invoice'}
  Tax:      ${extraction.tax_amount:.2f} CAD

SUGGESTED VENDOR RULE:
  Type:        {suggested}
  Forward to:  keeland@darios.ca (construction/inventory)
               paul@darios.ca (maintenance)

To add this vendor, go to http://YOUR-BACKEND/docs → POST /vendors/
Invoice ID in system: {invoice_id}"""

        await self.graph.forward_email(
            settings.MS_AP_INBOX, message_id, DEST_PAUL, note
        )
        logger.info(f"Unknown vendor '{extraction.vendor_name}' forwarded to {DEST_PAUL}")

    def _build_summary(self, extraction, vendor_type: str) -> str:
        lines = "\n".join(
            f"  • {li.description or 'Item'}: ${li.amount:.2f}"
            for li in (extraction.line_items or [])[:10]
        ) or "  (no line items extracted)"

        return f"""📋 AP Automation Summary

Vendor:   {extraction.vendor_name}
Invoice:  {extraction.invoice_number or 'N/A'}
Date:     {extraction.invoice_date or 'N/A'}
Amount:   ${extraction.total_amount} {extraction.currency}
PO#:      {extraction.po_number or 'Not on invoice'}
Tax:      ${extraction.tax_amount:.2f} CAD
Type:     {vendor_type.replace('_', ' ').title()}

Line items:
{lines}

Automatically extracted and routed by AP Automation."""

    def _guess_type(self, vendor_name: str) -> str:
        name = vendor_name.lower()
        if any(k in name for k in ["telus","shaw","bell","office","staples","insurance","hydro","fortis","bank"]):
            return "overhead"
        if any(k in name for k in ["nursery","supply","landscape","aggregate","mulch","siteone","nutrien","plant"]):
            return "job_cost (inventory)"
        if any(k in name for k in ["concrete","lumber","steel","electric","plumbing","excavat","roofing"]):
            return "job_cost (construction)"
        return "job_cost or overhead — please confirm"


# ── Singleton instance ────────────────────────────────────────────────────────
email_intake = EmailIntakeService()
