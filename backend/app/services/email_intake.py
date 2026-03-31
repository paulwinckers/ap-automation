"""
Email intake service — monitors the AP inbox via Microsoft Graph API
and processes incoming vendor invoices automatically.

Improvements in this version:
  1. Invoice pre-screening — Claude checks if email is an invoice before processing
  2. Non-invoice emails — marked as read, moved to AP Processed, logged but not forwarded
  3. Folder management — processed emails moved to 'AP Processed' folder
                         failed emails stay in inbox (visible for manual review)
  4. Daily summary — sent at 5:00 PM to paul@darios.ca and keeland@darios.ca

Auth:     App-only (client credentials) — no user login required.
Polling:  Every 5 minutes via a background task started on app startup.
Scope:    Mail.Read, Mail.ReadWrite, Mail.Send on the AP mailbox.
"""

import asyncio
import base64
import logging
import time
from datetime import datetime, timezone
from typing import Optional

import httpx
import anthropic

from app.core.config import settings
from app.core.database import Database
from app.models.invoice import Invoice, InvoiceStatus, LineItem, TaxLine
from app.services.extractor import InvoiceExtractor
from app.services.qbo import QBOClient
from app.services.routing import route_invoice, RoutingOutcome
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)

DEST_KEELAND  = "keeland@darios.ca"
DEST_PAUL     = "paul@darios.ca"
SUMMARY_TO    = ["paul@darios.ca", "keeland@darios.ca"]
PROCESSED_FOLDER = "AP Processed"

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
TOKEN_URL  = "https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"

SCREENING_PROMPT = """Look at this email and reply with ONLY one word.

CREDIT_MEMO — vendor credit notes, credit memos, or refund notices where money is owed TO us (negative amount, return, credit)
INVOICE  — vendor bills or invoices with a PDF attachment, or emails where payment is still due
RECEIPT  — online purchase confirmations or subscription renewal receipts with no PDF, from vendors like GoDaddy, Adobe, Microsoft, Intuit, Google, AWS, QuickBooks — payment already charged to a credit card
NOT_INVOICE — newsletters, marketing, meeting requests, reports, HR, legal, bank notifications, calendar invites

Reply with only: CREDIT_MEMO, INVOICE, RECEIPT, or NOT_INVOICE"""

CREDIT_MEMO_GL = "LS - Construction Materials"  # Job cost GL for vendor credits


class GraphClient:
    def __init__(self):
        self._token: Optional[str] = None
        self._token_expiry: float = 0
        self._http = httpx.AsyncClient(timeout=30.0)
        self._folder_cache: dict[str, str] = {}

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
            params=params, headers=await self._headers(),
        )
        resp.raise_for_status()
        return resp.json()

    async def _post(self, path: str, body: dict) -> Optional[dict]:
        h = await self._headers()
        h["Content-Type"] = "application/json"
        resp = await self._http.post(
            f"{GRAPH_BASE}/{path.lstrip('/')}", json=body, headers=h,
        )
        resp.raise_for_status()
        return resp.json() if resp.content else None

    async def _patch(self, path: str, body: dict) -> None:
        h = await self._headers()
        h["Content-Type"] = "application/json"
        resp = await self._http.patch(
            f"{GRAPH_BASE}/{path.lstrip('/')}", json=body, headers=h,
        )
        resp.raise_for_status()

    async def get_unread_emails(self, mailbox: str, received_after: str = None) -> list[dict]:
        filter_parts = ["isRead eq false"]
        if received_after:
            filter_parts.append(f"receivedDateTime ge {received_after}")
        result = await self._get(
            f"users/{mailbox}/mailFolders/inbox/messages",
            params={
                "$filter": " and ".join(filter_parts),
                "$orderby": "receivedDateTime desc",
                "$top": "25",
                "$select": "id,subject,from,receivedDateTime,hasAttachments,body,isRead",
            },
        )
        return result.get("value", [])

    async def get_attachments(self, mailbox: str, message_id: str) -> list[dict]:
        result = await self._get(f"users/{mailbox}/messages/{message_id}/attachments")
        return result.get("value", [])

    async def mark_as_read(self, mailbox: str, message_id: str) -> None:
        await self._patch(f"users/{mailbox}/messages/{message_id}", {"isRead": True})

    async def forward_email(self, mailbox: str, message_id: str, to_address: str, comment: str) -> None:
        await self._post(
            f"users/{mailbox}/messages/{message_id}/forward",
            {"comment": comment, "toRecipients": [{"emailAddress": {"address": to_address}}]},
        )

    async def send_email(
        self,
        mailbox: str,
        to_addresses: list[str],
        subject: str,
        body_html: str,
        attachment_bytes: Optional[bytes] = None,
        attachment_filename: Optional[str] = None,
    ) -> None:
        message: dict = {
            "subject": subject,
            "body": {"contentType": "HTML", "content": body_html},
            "toRecipients": [{"emailAddress": {"address": a}} for a in to_addresses],
        }
        if attachment_bytes and attachment_filename:
            import mimetypes
            mime_type, _ = mimetypes.guess_type(attachment_filename)
            mime_type = mime_type or "application/octet-stream"
            message["attachments"] = [
                {
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    "name": attachment_filename,
                    "contentType": mime_type,
                    "contentBytes": base64.b64encode(attachment_bytes).decode("utf-8"),
                }
            ]
        await self._post(
            f"users/{mailbox}/sendMail",
            {"message": message, "saveToSentItems": True},
        )

    async def send_receipt_confirmation(
        self,
        mailbox: str,
        to_address: str,
        vendor_name: str,
        total_amount: float,
        gl_name: str,
        qbo_id: str,
        txn_date: Optional[str],
        attachment_bytes: Optional[bytes] = None,
        attachment_filename: Optional[str] = None,
    ) -> None:
        """
        Send a QBO post confirmation email to the employee who submitted the receipt.
        Optionally attaches the original receipt photo.
        """
        currency = "CAD"
        amount_fmt = f"${total_amount:,.2f} {currency}" if total_amount else "N/A"
        date_fmt = txn_date or "N/A"

        body_html = f"""
<html><body style="font-family:Arial,sans-serif;color:#1a1d23;max-width:600px">
<div style="background:#2563eb;padding:20px 24px;border-radius:8px 8px 0 0">
  <h2 style="color:#fff;margin:0;font-size:18px">✅ Your expense is posted</h2>
</div>
<div style="background:#fff;border:1px solid #e2e6ed;border-top:none;padding:24px;border-radius:0 0 8px 8px">
  <p style="margin:0 0 16px">Your receipt has been reviewed and posted to QuickBooks Online.</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr><td style="padding:8px 0;color:#6b7280;width:140px">Vendor</td><td style="padding:8px 0;font-weight:600">{vendor_name}</td></tr>
    <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#6b7280">Amount</td><td style="padding:8px 0;font-weight:600">{amount_fmt}</td></tr>
    <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#6b7280">GL Account</td><td style="padding:8px 0">{gl_name}</td></tr>
    <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#6b7280">QBO Reference</td><td style="padding:8px 0;font-size:12px;color:#6b7280">{qbo_id}</td></tr>
    <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#6b7280">Date</td><td style="padding:8px 0">{date_fmt}</td></tr>
  </table>
  <p style="margin:24px 0 0;font-size:12px;color:#9ca3af">
    Posted automatically by AP Automation · Dario's Landscape Services
  </p>
</div>
</body></html>"""

        message: dict = {
            "subject": f"✅ Your expense is posted — {vendor_name} {amount_fmt}",
            "body": {"contentType": "HTML", "content": body_html},
            "toRecipients": [{"emailAddress": {"address": to_address}}],
        }

        if attachment_bytes and attachment_filename:
            import mimetypes
            mime_type, _ = mimetypes.guess_type(attachment_filename)
            mime_type = mime_type or "image/jpeg"
            message["attachments"] = [
                {
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    "name": attachment_filename,
                    "contentType": mime_type,
                    "contentBytes": base64.b64encode(attachment_bytes).decode("utf-8"),
                }
            ]

        await self._post(
            f"users/{mailbox}/sendMail",
            {"message": message, "saveToSentItems": True},
        )

    async def get_or_create_folder(self, mailbox: str, folder_name: str) -> str:
        if folder_name in self._folder_cache:
            return self._folder_cache[folder_name]
        result = await self._get(
            f"users/{mailbox}/mailFolders",
            params={"$filter": f"displayName eq '{folder_name}'"},
        )
        folders = result.get("value", [])
        if folders:
            folder_id = folders[0]["id"]
        else:
            result = await self._post(f"users/{mailbox}/mailFolders", {"displayName": folder_name})
            folder_id = result["id"]
            logger.info(f"Created Outlook folder: {folder_name}")
        self._folder_cache[folder_name] = folder_id
        return folder_id

    async def move_to_folder(self, mailbox: str, message_id: str, folder_name: str) -> None:
        """Move an email to a named folder. Silently ignores 404 (already moved)."""
        try:
            folder_id = await self.get_or_create_folder(mailbox, folder_name)
            await self._post(
                f"users/{mailbox}/messages/{message_id}/move",
                {"destinationId": folder_id},
            )
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                logger.info(f"Email already moved or deleted — skipping folder move")
            else:
                raise

    async def close(self):
        await self._http.aclose()


class EmailIntakeService:
    def __init__(self):
        self.graph     = GraphClient()
        self.extractor = InvoiceExtractor()
        self.qbo       = QBOClient()
        self.aspire    = AspireClient(sandbox=settings.ASPIRE_SANDBOX)
        self._claude   = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        self._running  = False
        self._start_time: Optional[str] = None
        self._summary_sent_today = False
        self._posted:    list[dict] = []
        self._forwarded: list[dict] = []
        self._failed:    list[dict] = []
        self._skipped:   list[dict] = []

    async def start(self):
        if not settings.MS_CLIENT_ID or not settings.MS_TENANT_ID or not settings.MS_AP_INBOX:
            logger.info("Microsoft Graph not configured — email intake disabled")
            return
        self._start_time = None
        self._running = True
        logger.info(f"Email intake started — polling {settings.MS_AP_INBOX} every 5 minutes")
        logger.info("Processing all unread emails regardless of received time")
        print(f"[AP Automation] Email intake started — polling {settings.MS_AP_INBOX}", flush=True)
        asyncio.create_task(self._poll_loop())
        asyncio.create_task(self._summary_loop())

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
        since = settings.EMAIL_PROCESS_SINCE.strip() if settings.EMAIL_PROCESS_SINCE else None
        emails = await self.graph.get_unread_emails(settings.MS_AP_INBOX, received_after=since)
        if not emails:
            return
        cutoff_note = f" received after {since}" if since else ""
        logger.info(f"Found {len(emails)} unread email(s) in AP inbox{cutoff_note}")
        db = Database()
        await db.connect()
        try:
            for email in emails:
                try:
                    await self._process_email(email, db)
                except Exception as e:
                    subject = email.get("subject", "(no subject)")
                    logger.error(f"Failed to process email '{subject}': {e}")
                    self._failed.append({"subject": subject, "error": str(e)})
        finally:
            await db.close()

    async def _classify_email(self, email: dict, body_content: str) -> str:
        """
        Classify an email as 'invoice', 'receipt', or 'skip'.
        Returns one of those three strings.
        """
        subject = email.get("subject", "")
        subject_lower = subject.lower()
        sender = email.get("from", {}).get("emailAddress", {}).get("address", "").lower()

        # Never process our own outgoing invoices replied to by customers,
        # quotes/estimates, or employment/HR documents
        skip_phrases = [
            "from darios landscape",
            "from dario's landscape",
            "darios landscape services",
        ]
        if any(p in subject_lower for p in skip_phrases):
            return "skip"

        # Skip quotes/estimates — not payable invoices
        if any(k in subject_lower for k in ["quote for ", "estimate for ", "proposal for "]):
            return "skip"

        # Skip Amazon/retailer order confirmations — these are pre-shipment, not receipts
        # Amazon sends a separate invoice; order confirmations should not be posted
        if any(k in subject_lower for k in ["your amazon", "your order of", "order of \""]):
            return "skip"

        # Skip HR / legal documents
        if any(k in subject_lower for k in ["offer of employment", "employment offer", "contract of employment"]):
            return "skip"

        # Skip renewal reminders / expiry notices — no money has changed hands yet
        renewal_reminder_phrases = [
            "renew your", "renewal reminder", "your domain expires",
            "expiring soon", "expires soon", "before you lose",
            "before they expire", "don't lose your", "action required: renew",
            "your subscription is expiring", "your plan is expiring",
        ]
        if any(k in subject_lower for k in renewal_reminder_phrases):
            return "skip"

        # Skip software/account notifications — not financial transactions
        notification_phrases = [
            "updates to your", "changes to your", "new features in",
            "your account has been", "we've updated", "important changes to",
            "terms of service", "privacy policy", "security alert",
            "verify your", "confirm your email", "welcome to",
        ]
        if any(k in subject_lower for k in notification_phrases):
            return "skip"

        # Fast-path: credit memo keywords → credit_memo
        credit_memo_keywords = [
            "credit memo", "credit note", "credit memorandum",
            "vendor credit", "return credit", "credit adjustment",
        ]
        if any(k in subject_lower for k in credit_memo_keywords):
            return "credit_memo"

        # Fast-path: receipt keywords with no PDF attachment → receipt
        receipt_keywords = ["renewal receipt", "order receipt", "purchase receipt",
                            "subscription receipt", "payment receipt", "order confirmation",
                            "purchase confirmation", "billing receipt", "your receipt for",
                            "renewal for order", "receipt for order"]
        if any(k in subject_lower for k in receipt_keywords) and not email.get("hasAttachments"):
            return "receipt"

        # Fast-path: invoice keywords → invoice
        invoice_keywords = ["invoice", "bill", "statement", "purchase order",
                            "payment due", "amount due", "total due", "po #", "inv #"]
        if any(k in subject_lower for k in invoice_keywords):
            return "invoice"
        if email.get("hasAttachments"):
            return "invoice"

        # Ask Claude to classify
        try:
            snippet = body_content[:2000] if body_content else subject
            msg = await self._claude.messages.create(
                model="claude-haiku-4-5",
                max_tokens=10,
                messages=[{"role": "user", "content": f"Subject: {subject}\n\nBody:\n{snippet}\n\n{SCREENING_PROMPT}"}],
            )
            result = msg.content[0].text.strip().upper()
            if result == "CREDIT_MEMO":
                return "credit_memo"
            elif result == "INVOICE":
                return "invoice"
            elif result == "RECEIPT":
                return "receipt"
            return "skip"
        except Exception as e:
            logger.warning(f"Email screening failed: {e} — defaulting to skip")
            return "skip"

    async def _process_email(self, email: dict, db: Database):
        message_id   = email["id"]
        subject      = email.get("subject", "(no subject)")
        sender       = email.get("from", {}).get("emailAddress", {}).get("address", "unknown")
        body_content = email.get("body", {}).get("content", "")

        # Classify — invoice, receipt, or skip?
        email_type = await self._classify_email(email, body_content)
        if email_type == "skip":
            logger.info(f"Not an invoice — leaving untouched in inbox: '{subject}' from {sender}")
            self._skipped.append({"subject": subject, "from": sender})
            return

        if email_type == "credit_memo":
            logger.info(f"Processing credit memo: '{subject}' from {sender}")
            await self._process_credit_memo_email(email, body_content, db)
            return

        if email_type == "receipt":
            logger.info(f"Processing credit card receipt: '{subject}' from {sender}")
            await self._process_receipt_email(email, body_content, db)
            return

        logger.info(f"Processing invoice: '{subject}' from {sender}")

        # Get file content
        file_bytes: Optional[bytes] = None
        filename:   Optional[str]   = None
        if email.get("hasAttachments"):
            for att in await self.graph.get_attachments(settings.MS_AP_INBOX, message_id):
                name = att.get("name", "")
                if name.lower().endswith((".pdf", ".jpg", ".jpeg", ".png", ".webp")):
                    file_bytes = base64.b64decode(att["contentBytes"])
                    filename   = name
                    break
        if file_bytes is None:
            if not body_content.strip():
                await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
                return
            file_bytes = body_content.encode("utf-8")
            filename   = "email_body.html"

        # Extract with Claude
        try:
            extraction = await self.extractor.extract_from_pdf_bytes(file_bytes, filename or "")
        except Exception as e:
            logger.error(f"Extraction failed for '{subject}': {e}")
            self._failed.append({"subject": subject, "from": sender, "error": f"Extraction failed: {e}"})
            await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
            return  # Leave in inbox — failed items stay visible

        # If extraction yielded no vendor name, this isn't a real invoice — skip it
        if not extraction.vendor_name:
            logger.info(f"No vendor name extracted from '{subject}' — skipping (not a real invoice)")
            self._skipped.append({"subject": subject, "from": sender, "reason": "no vendor name extracted"})
            await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
            return

        # Duplicate check — skip if we've already processed this invoice number
        if extraction.invoice_number:
            duplicate = await db.find_duplicate_invoice(extraction.vendor_name, extraction.invoice_number)
            if duplicate:
                logger.info(
                    f"Duplicate invoice skipped: {extraction.vendor_name} #{extraction.invoice_number} "
                    f"(already in system as id={duplicate['id']}, status={duplicate['status']})"
                )
                await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
                await self.graph.move_to_folder(settings.MS_AP_INBOX, message_id, PROCESSED_FOLDER)
                self._skipped.append({
                    "subject": subject,
                    "from": sender,
                    "reason": f"duplicate — already in system (id={duplicate['id']}, status={duplicate['status']})",
                })
                return

        # Save to database
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

        # Route
        vendor_rule = await db.get_vendor_rule_by_name(extraction.vendor_name)
        moved = False

        if vendor_rule is None:
            await self._handle_unknown_vendor(message_id, extraction, invoice_id)
            await db.mark_queued(invoice_id, "vendor_unknown")
            moved = True

        elif vendor_rule.type == "overhead":
            invoice = Invoice(
                id=invoice_id, status=InvoiceStatus.PENDING,
                vendor_name=extraction.vendor_name,
                invoice_number=extraction.invoice_number,
                invoice_date=extraction.invoice_date,
                due_date=extraction.due_date,
                subtotal=extraction.subtotal,
                tax_amount=extraction.tax_amount,
                total_amount=extraction.total_amount,
                currency=extraction.currency,
                po_number=extraction.po_number,
                pdf_filename=filename or "email",
                intake_source="email",
                line_items=[LineItem(**li.model_dump()) for li in extraction.line_items],
                tax_lines=[TaxLine(**tl.model_dump()) for tl in extraction.tax_lines],
                file_bytes=file_bytes,  # pass through for QBO attachment
            )
            outcome = await route_invoice(invoice, db, self.aspire, self.qbo)
            if outcome == RoutingOutcome.POSTED_QBO:
                logger.info(f"Invoice {invoice_id} posted to QBO")
                self._posted.append({
                    "vendor": extraction.vendor_name,
                    "amount": extraction.total_amount,
                    "currency": extraction.currency,
                    "invoice_no": extraction.invoice_number,
                    "destination": "QBO",
                    "invoice_id": invoice_id,
                })
                await self.graph.move_to_folder(settings.MS_AP_INBOX, message_id, PROCESSED_FOLDER)
                moved = True
            else:
                self._failed.append({
                    "vendor": extraction.vendor_name,
                    "amount": extraction.total_amount,
                    "error": "QBO posting failed — check exception queue",
                })
                # Leave in inbox on failure

        elif vendor_rule.type in ("job_cost", "mixed"):
            forward_to = vendor_rule.forward_to or DEST_PAUL
            await self.graph.forward_email(
                settings.MS_AP_INBOX, message_id, forward_to,
                self._build_summary(extraction, vendor_rule.type)
            )
            await db.audit(invoice_id, "forwarded", "system", {"to": forward_to})
            self._forwarded.append({
                "vendor": extraction.vendor_name,
                "amount": extraction.total_amount,
                "forwarded_to": forward_to,
                "invoice_no": extraction.invoice_number,
            })
            logger.info(f"Invoice {invoice_id} forwarded to {forward_to}")
            await self.graph.move_to_folder(settings.MS_AP_INBOX, message_id, PROCESSED_FOLDER)
            moved = True

        # Mark as read — wrapped in try/catch since message ID can go stale
        # after move operations, but the invoice was still processed correctly
        try:
            await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
        except Exception as e:
            logger.warning(f"Could not mark email as read (already processed): {e}")

    async def _process_credit_memo_email(self, email: dict, body_content: str, db: Database):
        """
        Process a vendor credit memo email.
        1. Extract data with credit-memo-specific prompt
        2. Post to QBO as VendorCredit against GL 5105
        3. Email keeland@darios.ca to action in Aspire
        4. On uncertainty → exception queue
        """
        message_id = email["id"]
        subject    = email.get("subject", "(no subject)")
        sender     = email.get("from", {}).get("emailAddress", {}).get("address", "unknown")

        # Get attachment or fall back to email body
        file_bytes: Optional[bytes] = None
        filename:   Optional[str]   = None
        if email.get("hasAttachments"):
            for att in await self.graph.get_attachments(settings.MS_AP_INBOX, message_id):
                name = att.get("name", "")
                if name.lower().endswith((".pdf", ".jpg", ".jpeg", ".png", ".webp")):
                    file_bytes = base64.b64decode(att["contentBytes"])
                    filename   = name
                    break
        if file_bytes is None:
            file_bytes = body_content.encode("utf-8")
            filename   = "credit_memo.html"

        # Extract with credit-memo prompt
        try:
            extraction = await self.extractor.extract_credit_memo(file_bytes, filename)
        except Exception as e:
            logger.error(f"Credit memo extraction failed for '{subject}': {e}")
            self._failed.append({"subject": subject, "from": sender, "error": f"Credit memo extraction failed: {e}"})
            await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
            return

        # Guard: skip if no vendor name extracted
        if not extraction.vendor_name:
            logger.info(f"Credit memo skipped — no vendor name extracted from '{subject}'")
            self._skipped.append({"subject": subject, "from": sender, "reason": "no vendor name extracted"})
            await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
            return

        # Save to DB
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
            pdf_filename   = filename or "credit_memo",
            intake_source  = "email",
            intake_raw     = extraction.model_dump(),
            doc_type       = "credit_memo",
        )
        await db.audit(invoice_id, "received", "email", {"from": sender, "subject": subject, "type": "credit_memo"})

        invoice = Invoice(
            id=invoice_id, status=InvoiceStatus.PENDING,
            vendor_name=extraction.vendor_name,
            invoice_number=extraction.invoice_number,
            invoice_date=extraction.invoice_date,
            due_date=extraction.due_date,
            subtotal=extraction.subtotal,
            tax_amount=extraction.tax_amount,
            total_amount=extraction.total_amount,
            currency=extraction.currency,
            po_number=extraction.po_number,
            pdf_filename=filename or "credit_memo",
            intake_source="email",
            doc_type="credit_memo",
            line_items=[LineItem(**li.model_dump()) for li in extraction.line_items],
            tax_lines=[TaxLine(**tl.model_dump()) for tl in extraction.tax_lines],
            file_bytes=file_bytes,
        )

        # Post to QBO as vendor credit against GL 5105
        try:
            credit_id = await self.qbo.post_vendor_credit(
                invoice, CREDIT_MEMO_GL,
                file_bytes=file_bytes, filename=filename,
            )
            await db.mark_posted_qbo(invoice_id, credit_id, CREDIT_MEMO_GL, gl_name="Job Cost")
            await db.audit(invoice_id, "posted", "system", {
                "destination": "qbo_vendor_credit",
                "credit_id": credit_id,
                "gl_account": CREDIT_MEMO_GL,
            })
            logger.info(f"Credit memo {invoice_id} posted to QBO — credit id {credit_id}")
        except Exception as e:
            logger.error(f"QBO vendor credit post failed for '{subject}': {e}")
            await db.mark_queued(invoice_id, "credit_memo_post_failed")
            await db.audit(invoice_id, "queued", "system", {"reason": "credit_memo_post_failed", "error": str(e)})
            self._failed.append({"subject": subject, "from": sender, "error": f"QBO credit post failed: {e}"})
            await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
            return

        # Notify Keeland to action in Aspire
        amount = extraction.total_amount or 0
        amount_fmt = f"${abs(amount):,.2f} CAD"
        try:
            await self.graph.send_email(
                mailbox=settings.MS_AP_INBOX,
                to_addresses=[DEST_KEELAND],
                subject=f"Credit memo posted to QBO — {extraction.vendor_name or 'Unknown vendor'} {amount_fmt}",
                body_html=f"""
<html><body style="font-family:Arial,sans-serif;color:#1a1d23;max-width:600px">
<div style="background:#1e3a2f;padding:20px 24px;border-radius:8px 8px 0 0">
  <h2 style="color:#fff;margin:0;font-size:18px">Credit Memo — Action Required in Aspire</h2>
</div>
<div style="background:#fff;border:1px solid #e2e6ed;border-top:none;padding:24px;border-radius:0 0 8px 8px">
  <p style="margin:0 0 16px;color:#374151">
    A vendor credit memo has been received and posted to QuickBooks Online (GL 5105).
    Please apply this credit in Aspire against the appropriate job.
  </p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr><td style="padding:8px 0;color:#6b7280;width:160px">Vendor</td>
        <td style="padding:8px 0;font-weight:600">{extraction.vendor_name or '—'}</td></tr>
    <tr style="border-top:1px solid #f0f0f0">
        <td style="padding:8px 0;color:#6b7280">Credit Amount</td>
        <td style="padding:8px 0;font-weight:600;color:#059669">{amount_fmt}</td></tr>
    <tr style="border-top:1px solid #f0f0f0">
        <td style="padding:8px 0;color:#6b7280">Credit Memo #</td>
        <td style="padding:8px 0">{extraction.invoice_number or '—'}</td></tr>
    <tr style="border-top:1px solid #f0f0f0">
        <td style="padding:8px 0;color:#6b7280">Date</td>
        <td style="padding:8px 0">{extraction.invoice_date or '—'}</td></tr>
    <tr style="border-top:1px solid #f0f0f0">
        <td style="padding:8px 0;color:#6b7280">PO Number</td>
        <td style="padding:8px 0">{extraction.po_number or '—'}</td></tr>
    <tr style="border-top:1px solid #f0f0f0">
        <td style="padding:8px 0;color:#6b7280">QBO Credit ID</td>
        <td style="padding:8px 0;font-size:12px;color:#6b7280">{credit_id}</td></tr>
    <tr style="border-top:1px solid #f0f0f0">
        <td style="padding:8px 0;color:#6b7280">GL Posted</td>
        <td style="padding:8px 0">5105 — Job Cost</td></tr>
  </table>
  <p style="margin:24px 0 0;font-size:12px;color:#9ca3af">
    AP Automation · Dario's Landscape Services
  </p>
</div>
</body></html>""",
                attachment_bytes=file_bytes,
                attachment_filename=filename or "credit_memo.pdf",
            )
            logger.info(f"Credit memo notification sent to {DEST_KEELAND} for invoice {invoice_id}")
        except Exception as e:
            logger.warning(f"Credit memo Keeland notification failed (non-fatal): {e}")

        self._posted.append({
            "vendor": extraction.vendor_name,
            "amount": extraction.total_amount,
            "currency": extraction.currency,
            "invoice_no": extraction.invoice_number,
            "destination": "QBO (vendor credit)",
            "invoice_id": invoice_id,
        })

        await self.graph.move_to_folder(settings.MS_AP_INBOX, message_id, PROCESSED_FOLDER)
        try:
            await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
        except Exception as e:
            logger.warning(f"Could not mark credit memo email as read: {e}")

    async def _process_receipt_email(self, email: dict, body_content: str, db: Database):
        """
        Process a credit card receipt email (no PDF — extract from HTML body).
        Posts directly to QBO as a Purchase against the MasterCard account.
        """
        message_id = email["id"]
        subject    = email.get("subject", "(no subject)")
        sender     = email.get("from", {}).get("emailAddress", {}).get("address", "unknown")

        # Extract receipt data from email body
        try:
            extraction = await self.extractor.extract_from_html_body(body_content)
        except Exception as e:
            logger.error(f"Receipt extraction failed for '{subject}': {e}")
            self._failed.append({"subject": subject, "from": sender, "error": f"Receipt extraction failed: {e}"})
            return

        logger.info(
            f"Receipt extracted — vendor: {extraction.vendor_name}, "
            f"amount: {extraction.total_amount} {extraction.currency}, "
            f"order: {extraction.invoice_number}"
        )

        # Guard: if Claude couldn't extract vendor or amount this is a notification, not a real receipt
        if not extraction.vendor_name or not extraction.total_amount:
            logger.info(
                f"Receipt skipped — no vendor/amount found in '{subject}' from {sender}. "
                f"Likely a notification or reminder, not a payment confirmation."
            )
            self._skipped.append({"subject": subject, "from": sender})
            await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
            await self.graph.move_to_folder(settings.MS_AP_INBOX, message_id, PROCESSED_FOLDER)
            return

        # Duplicate check
        if extraction.invoice_number:
            duplicate = await db.find_duplicate_invoice(extraction.vendor_name, extraction.invoice_number)
            if duplicate:
                logger.info(f"Duplicate receipt skipped: {extraction.vendor_name} #{extraction.invoice_number}")
                await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
                await self.graph.move_to_folder(settings.MS_AP_INBOX, message_id, PROCESSED_FOLDER)
                return

        # Save to database with doc_type='mastercard'
        invoice_id = await db.create_invoice(
            vendor_name    = extraction.vendor_name,
            invoice_number = extraction.invoice_number,
            invoice_date   = extraction.invoice_date,
            due_date       = None,
            subtotal       = extraction.subtotal,
            tax_amount     = extraction.tax_amount,
            total_amount   = extraction.total_amount,
            currency       = extraction.currency,
            po_number      = None,
            pdf_filename   = "email_receipt.html",
            intake_source  = "email",
            intake_raw     = extraction.model_dump(),
            doc_type       = "mastercard",
        )
        await db.audit(invoice_id, "received", "email", {"from": sender, "subject": subject, "type": "receipt"})

        # Build Invoice and route — routing already handles doc_type='mastercard'
        invoice = Invoice(
            id             = invoice_id,
            status         = InvoiceStatus.PENDING,
            vendor_name    = extraction.vendor_name,
            invoice_number = extraction.invoice_number,
            invoice_date   = extraction.invoice_date,
            due_date       = None,
            subtotal       = extraction.subtotal,
            tax_amount     = extraction.tax_amount,
            total_amount   = extraction.total_amount,
            currency       = extraction.currency,
            po_number      = None,
            pdf_filename   = "email_receipt.html",
            intake_source  = "email",
            doc_type       = "mastercard",
            line_items     = [LineItem(**li.model_dump()) for li in extraction.line_items],
            tax_lines      = [TaxLine(**tl.model_dump()) for tl in extraction.tax_lines],
        )

        outcome = await route_invoice(invoice, db, self.aspire, self.qbo)
        if outcome == RoutingOutcome.POSTED_QBO:
            logger.info(f"Receipt {invoice_id} posted to QBO — {extraction.vendor_name} {extraction.total_amount}")
            self._posted.append({
                "vendor": extraction.vendor_name,
                "amount": extraction.total_amount,
                "currency": extraction.currency,
                "invoice_no": extraction.invoice_number,
                "destination": "QBO (MasterCard)",
                "invoice_id": invoice_id,
            })
            await self.graph.move_to_folder(settings.MS_AP_INBOX, message_id, PROCESSED_FOLDER)
        else:
            logger.warning(f"Receipt {invoice_id} could not be auto-posted — outcome: {outcome}")
            self._failed.append({
                "vendor": extraction.vendor_name,
                "amount": extraction.total_amount,
                "error": f"Receipt posting failed — outcome: {outcome}",
            })

        try:
            await self.graph.mark_as_read(settings.MS_AP_INBOX, message_id)
        except Exception as e:
            logger.warning(f"Could not mark receipt email as read: {e}")

    async def _handle_unknown_vendor(self, message_id: str, extraction, invoice_id: int):
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

Invoice ID in system: {invoice_id}"""

        try:
            await self.graph.forward_email(settings.MS_AP_INBOX, message_id, DEST_PAUL, note)
            await self.graph.move_to_folder(settings.MS_AP_INBOX, message_id, PROCESSED_FOLDER)
        except Exception as e:
            logger.error(f"Could not forward unknown vendor email: {e}")

        self._forwarded.append({
            "vendor": extraction.vendor_name,
            "amount": extraction.total_amount,
            "forwarded_to": DEST_PAUL,
            "invoice_no": extraction.invoice_number,
            "note": "Unknown vendor — rule needed",
        })

    # ── Daily summary ─────────────────────────────────────────────────────────

    async def _summary_loop(self):
        while self._running:
            now = datetime.now()
            if now.hour == 14 and now.minute == 0 and not self._summary_sent_today:  # 7am PDT (UTC-7)
                try:
                    await self._send_daily_summary()
                    self._summary_sent_today = True
                except Exception as e:
                    logger.error(f"Failed to send daily summary: {e}")
            if now.hour == 0 and now.minute == 0:
                self._summary_sent_today = False
            await asyncio.sleep(60)

    async def _send_daily_summary(self):
        today = datetime.now().strftime("%B %d, %Y")

        # Pull last 24 hours from D1 — accurate across redeploys
        from app.core.database import Database
        db = Database()
        await db.connect()
        try:
            all_invoices = await db._q(
                """SELECT vendor_name, invoice_number, total_amount, currency,
                          status, destination, qbo_bill_id, error_message,
                          intake_source, received_at
                   FROM invoices
                   WHERE received_at >= datetime('now', '-24 hours')
                   ORDER BY received_at DESC"""
            )
        finally:
            await db.close()

        posted    = [i for i in all_invoices if i["status"] == "posted"]
        errors    = [i for i in all_invoices if i["status"] == "error"]
        queued    = [i for i in all_invoices if i["status"] == "queued"]
        n_posted  = len(posted)
        n_queued  = len(queued)
        n_failed  = len(errors) + len(self._failed)   # DB errors + email failures
        n_skipped = len(self._skipped)

        def fmt_amt(row):
            try:
                return f"${float(row.get('total_amount') or 0):,.2f} {row.get('currency','CAD')}"
            except Exception:
                return "—"

        def invoice_rows(items, include_error=False):
            if not items:
                return "<tr><td colspan='4' style='padding:12px;color:#6b7280;text-align:center'>None in last 24 hours</td></tr>"
            rows = ""
            for i in items:
                dest = i.get("destination") or i.get("intake_source") or "—"
                extra = f"<td style='padding:6px 12px;border-bottom:1px solid #e2e6ed;color:#dc2626;font-size:11px'>{(i.get('error_message') or '')[:80]}</td>" if include_error else f"<td style='padding:6px 12px;border-bottom:1px solid #e2e6ed'>{dest.upper()}</td>"
                rows += f"<tr><td style='padding:6px 12px;border-bottom:1px solid #e2e6ed'>{i.get('vendor_name','—')}</td><td style='padding:6px 12px;border-bottom:1px solid #e2e6ed'>{i.get('invoice_number') or '—'}</td><td style='padding:6px 12px;border-bottom:1px solid #e2e6ed'>{fmt_amt(i)}</td>{extra}</tr>"
            return rows

        def skipped_rows():
            if not self._skipped:
                return "<tr><td colspan='2' style='padding:12px;color:#6b7280;text-align:center'>None</td></tr>"
            rows = ""
            for s in self._skipped[-20:]:  # cap at 20
                rows += f"<tr><td style='padding:6px 12px;border-bottom:1px solid #e2e6ed'>{s.get('subject','—')}</td><td style='padding:6px 12px;border-bottom:1px solid #e2e6ed;color:#6b7280'>{s.get('from','—')}</td></tr>"
            return rows

        posted_html  = invoice_rows(posted)
        queued_html  = invoice_rows(queued, include_error=False)
        failed_html  = invoice_rows(errors, include_error=True)
        skipped_html = skipped_rows()

        html = f"""
<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#1a1d23">
  <div style="background:#2563eb;padding:24px 32px;border-radius:8px 8px 0 0">
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:500">AP Automation — Daily Summary</h1>
    <p style="color:rgba(255,255,255,.8);margin:4px 0 0;font-size:14px">{today} · Previous 24 hours</p>
  </div>
  <div style="background:#f8f9fc;padding:20px 32px;border-bottom:1px solid #e2e6ed;display:flex;gap:24px">
    <div style="flex:1;text-align:center"><div style="font-size:28px;color:#059669">{n_posted}</div><div style="font-size:12px;color:#6b7280">posted to QBO</div></div>
    <div style="flex:1;text-align:center"><div style="font-size:28px;color:#d97706">{n_queued}</div><div style="font-size:12px;color:#6b7280">needs review</div></div>
    <div style="flex:1;text-align:center"><div style="font-size:28px;color:#dc2626">{n_failed}</div><div style="font-size:12px;color:#6b7280">failed</div></div>
    <div style="flex:1;text-align:center"><div style="font-size:28px;color:#6b7280">{n_skipped}</div><div style="font-size:12px;color:#6b7280">non-invoices skipped</div></div>
  </div>
  <div style="padding:24px 32px;background:#fff">
    <h2 style="font-size:13px;font-weight:600;color:#059669;text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px">✅ Posted to QBO</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f8f9fc">
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500">Vendor</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500">Invoice #</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500">Amount</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500">Destination</th>
      </tr></thead>
      <tbody>{posted_html}</tbody>
    </table>
    <h2 style="font-size:13px;font-weight:600;color:#d97706;text-transform:uppercase;letter-spacing:.04em;margin:24px 0 10px">⏳ Needs Review</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f8f9fc">
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500">Vendor</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500">Invoice #</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500">Amount</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500">Source</th>
      </tr></thead>
      <tbody>{queued_html}</tbody>
    </table>
    {"<h2 style='font-size:13px;font-weight:600;color:#dc2626;text-transform:uppercase;letter-spacing:.04em;margin:24px 0 10px'>❌ Failed — Action Required</h2><table style='width:100%;border-collapse:collapse;font-size:13px'><thead><tr style='background:#fef2f2'><th style='padding:8px 12px;text-align:left;color:#6b7280;font-weight:500'>Vendor</th><th style='padding:8px 12px;text-align:left;color:#6b7280;font-weight:500'>Invoice #</th><th style='padding:8px 12px;text-align:left;color:#6b7280;font-weight:500'>Amount</th><th style='padding:8px 12px;text-align:left;color:#6b7280;font-weight:500'>Error</th></tr></thead><tbody>" + failed_html + "</tbody></table>" if errors else ""}
    <h2 style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin:24px 0 10px">Non-invoices skipped</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f8f9fc">
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500">Subject</th>
        <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500">From</th>
      </tr></thead>
      <tbody>{skipped_html}</tbody>
    </table>
  </div>
  <div style="background:#f8f9fc;padding:16px 32px;border-radius:0 0 8px 8px;border-top:1px solid #e2e6ed">
    <p style="font-size:12px;color:#6b7280;margin:0">AP Automation · Dario's Landscape Services · {n_posted + n_queued} invoices processed · {n_skipped} non-invoices skipped</p>
  </div>
</div>"""

        await self.graph.send_email(
            mailbox=settings.MS_AP_INBOX,
            to_addresses=SUMMARY_TO,
            subject=f"AP Daily Summary — {today} ({n_posted} posted, {n_queued} needs review, {n_failed} failed)",
            body_html=html,
        )
        logger.info(f"Daily summary sent — {n_posted} posted, {n_queued} queued, {n_failed} failed, {n_skipped} skipped")
        self._failed.clear(); self._skipped.clear()

    # ── Helpers ───────────────────────────────────────────────────────────────

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


email_intake = EmailIntakeService()


# ── Standalone helper — callable from routing.py ──────────────────────────────

async def send_qbo_confirmation(
    to_address: str,
    vendor_name: str,
    total_amount: float,
    gl_name: str,
    qbo_id: str,
    txn_date: Optional[str],
    file_bytes: Optional[bytes] = None,
    filename: Optional[str] = None,
) -> None:
    """
    Send a posted-to-QBO confirmation email to an employee.
    Creates a temporary GraphClient — safe to call from any context.
    Silently logs failures so a failed email never blocks the QBO post.
    """
    if not settings.MS_AP_INBOX:
        logger.debug("MS_AP_INBOX not set — skipping confirmation email")
        return
    graph = GraphClient()
    try:
        await graph.send_receipt_confirmation(
            mailbox=settings.MS_AP_INBOX,
            to_address=to_address,
            vendor_name=vendor_name,
            total_amount=total_amount,
            gl_name=gl_name,
            qbo_id=qbo_id,
            txn_date=txn_date,
            attachment_bytes=file_bytes,
            attachment_filename=filename,
        )
        logger.info(f"Confirmation email sent to {to_address}")
    except Exception as e:
        logger.warning(f"Confirmation email failed (non-fatal): {e}")
    finally:
        await graph.close()
