"""
Invoice extractor — uses Claude to pull structured data from PDF invoices
and phone camera images (JPEG, PNG, HEIC, WEBP).

Sends the file as base64 to Claude with the correct media type,
returns a validated InvoiceExtraction object.

Canadian context: extracts GST/HST/PST amounts separately.
"""

import base64
import json
import logging
import mimetypes

import anthropic
import httpx

from app.core.config import settings
from app.models.invoice import InvoiceExtraction

logger = logging.getLogger(__name__)

EXTRACTION_PROMPT = """
You are an accounts payable assistant for a Canadian landscaping company.
Extract all data from this vendor invoice and return ONLY a JSON object.

Required fields:
- vendor_name: string — the supplier/vendor company name
- invoice_number: string — the invoice or bill number
- invoice_date: string — ISO 8601 date (YYYY-MM-DD)
- due_date: string or null — ISO 8601 date if present
- po_number: string or null — purchase order number if present on the invoice
- subtotal: number — amount before tax
- tax_lines: array of { tax_name, tax_rate, tax_amount }
  (separate GST, HST, PST — do not combine)
- total_amount: number — final invoice total
- currency: string — "CAD" unless clearly stated otherwise
- line_items: array of {
    description: string,
    quantity: number or null,
    unit_price: number or null,
    amount: number
  }
- notes: string or null — any payment terms or special instructions

Rules:
- Return ONLY the JSON object. No preamble, no markdown, no explanation.
- If a field is not present, use null.
- All amounts must be numbers, not strings.
- po_number: only include if explicitly labelled as PO, P.O., Purchase Order,
  or similar. Do not infer it from other reference numbers.
- If multiple PO numbers appear, use the first one.
"""

# MIME types Claude accepts for documents vs images
PDF_MIME   = "application/pdf"
HTML_MIME  = "text/html"
IMAGE_MIMES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


def _detect_mime(filename: str, raw_bytes: bytes) -> str:
    """
    Detect the MIME type from the filename extension first,
    then fall back to inspecting the file header bytes.
    """
    if filename:
        name_lower = filename.lower()
        if name_lower.endswith(".pdf"):
            return PDF_MIME
        if name_lower.endswith((".html", ".htm")):
            return HTML_MIME
        if name_lower.endswith((".jpg", ".jpeg")):
            return "image/jpeg"
        if name_lower.endswith(".png"):
            return "image/png"
        if name_lower.endswith(".webp"):
            return "image/webp"
        if name_lower.endswith(".heic"):
            # Claude doesn't support HEIC natively — treat as JPEG
            # (most phones encode HEIC with JPEG-compatible data)
            return "image/jpeg"

    # Fall back to magic bytes
    if raw_bytes[:4] == b"%PDF":
        return PDF_MIME
    if raw_bytes[:5].lower().startswith(b"<html") or raw_bytes[:14].lower().startswith(b"<!doctype html"):
        return HTML_MIME
    if raw_bytes[:2] in (b"\xff\xd8",):
        return "image/jpeg"
    if raw_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw_bytes[:4] == b"RIFF" and raw_bytes[8:12] == b"WEBP":
        return "image/webp"

    # Default to JPEG for phone camera captures with no extension
    return "image/jpeg"


class InvoiceExtractor:
    def __init__(self):
        self.client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)

    async def extract_from_pdf_bytes(self, file_bytes: bytes, filename: str = "") -> InvoiceExtraction:
        """Extract invoice data from raw file bytes (PDF or image)."""
        mime_type = _detect_mime(filename, file_bytes)
        file_b64 = base64.standard_b64encode(file_bytes).decode("utf-8")
        return await self._call_claude(file_b64, mime_type)

    async def extract_from_pdf_url(self, url: str) -> InvoiceExtraction:
        """Fetch a file from URL (e.g. R2 presigned URL) and extract."""
        async with httpx.AsyncClient() as http:
            resp = await http.get(url)
            resp.raise_for_status()
        filename = url.split("/")[-1].split("?")[0]
        return await self.extract_from_pdf_bytes(resp.content, filename)

    async def _call_claude(self, file_b64: str, mime_type: str) -> InvoiceExtraction:
        logger.info(f"Calling Claude for invoice extraction — mime: {mime_type}")

        # HTML email bodies — send as plain text, not as image/document
        if mime_type == HTML_MIME:
            import base64 as _b64
            import re
            html_text = _b64.standard_b64decode(file_b64).decode("utf-8", errors="replace")
            # Strip HTML tags to get readable text
            plain_text = re.sub(r"<[^>]+>", " ", html_text)
            plain_text = re.sub(r"\s+", " ", plain_text).strip()
            message = await self.client.messages.create(
                model="claude-sonnet-4-5",
                max_tokens=2048,
                messages=[
                    {
                        "role": "user",
                        "content": f"Email body text:\n\n{plain_text[:8000]}\n\n{EXTRACTION_PROMPT}",
                    }
                ],
            )
        else:
            # Build content block — document type for PDFs, image type for images
            if mime_type == PDF_MIME:
                file_content = {
                    "type": "document",
                    "source": {
                        "type": "base64",
                        "media_type": PDF_MIME,
                        "data": file_b64,
                    },
                }
            else:
                # Ensure mime is one Claude accepts
                if mime_type not in IMAGE_MIMES:
                    mime_type = "image/jpeg"
                file_content = {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": mime_type,
                        "data": file_b64,
                    },
                }

            message = await self.client.messages.create(
                model="claude-sonnet-4-5",
                max_tokens=2048,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            file_content,
                            {
                                "type": "text",
                                "text": EXTRACTION_PROMPT,
                            },
                        ],
                    }
                ],
            )

        raw_text = message.content[0].text.strip()
        logger.info(f"Claude extraction response: {raw_text[:300]}")

        # Strip markdown code fences if Claude wrapped the JSON
        if raw_text.startswith("```"):
            raw_text = raw_text.split("```")[1]
            if raw_text.startswith("json"):
                raw_text = raw_text[4:]
            raw_text = raw_text.strip()

        try:
            data = json.loads(raw_text)
        except json.JSONDecodeError as e:
            logger.error(f"Claude returned invalid JSON: {e}\nRaw: {raw_text}")
            raise ValueError(f"Extraction failed — invalid JSON from Claude: {e}\nRaw response: {raw_text[:200]}")

        return InvoiceExtraction(**data)

