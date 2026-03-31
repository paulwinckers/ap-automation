"""
Vendor Statement Reconciliation service.

Flow:
  1. Extract statement lines from PDF via Claude
  2. Query QBO for open bills for the same vendor in the same period
  3. Diff the two lists — matched / amount mismatch / missing from QBO / extra in QBO
  4. Return structured result for the frontend

Invoice number normalisation:
  Vendor statements often prefix numbers with "INV #", "#", "INV-" etc.
  We strip all of these before comparing to QBO DocNumber.
"""

import json
import logging
import re
import base64
from datetime import date, datetime
from typing import Optional

import anthropic

from app.core.config import settings
from app.services.qbo import QBOClient

logger = logging.getLogger(__name__)

STATEMENT_EXTRACTION_PROMPT = """
You are an accounts payable assistant. Extract all data from this vendor account statement and return ONLY a JSON object.

Required fields:
- vendor_name: string — the vendor/supplier company name (who sent the statement)
- statement_date: string — ISO 8601 date (YYYY-MM-DD) of the statement
- closing_balance: number — the total amount due shown on the statement
- currency: string — "CAD" unless clearly stated otherwise
- aging: object with keys current, days_1_30, days_31_60, days_61_90, over_90 — aging bucket amounts (0 if not shown)
- lines: array of {
    line_date: string (ISO 8601),
    invoice_number: string — the invoice/reference number as shown (e.g. "INV #620024", "620024", "#1234"),
    raw_description: string — the full description text as shown on the statement,
    amount: number — the transaction amount (positive for charges, negative for credits/payments),
    running_balance: number or null — the running balance shown after this line
  }

Rules:
- Return ONLY the JSON object. No preamble, no markdown, no explanation.
- Include ALL lines on the statement — invoices, payments, credits, adjustments.
- For payments or credits, use negative amounts.
- If a field is not present, use null.
- The vendor_name is the company sending the statement (not the recipient).
"""


def _normalize_invoice_number(raw: str) -> str:
    """
    Strip common prefixes from vendor invoice numbers for comparison.
    "INV #620024" → "620024"
    "INV-620024"  → "620024"
    "#620024"     → "620024"
    "620024"      → "620024"
    """
    if not raw:
        return ""
    normalized = raw.strip()
    # Remove common prefixes: INV #, INV#, INV-, #
    normalized = re.sub(r'^(INV\s*#?\s*|INV-|#)', '', normalized, flags=re.IGNORECASE)
    return normalized.strip()


def _diff_statement_vs_qbo(
    statement_lines: list[dict],
    qbo_bills: list[dict],
) -> dict:
    """
    Compare statement lines against QBO bills.
    Returns a structured diff with four categories.
    """
    # Build lookup maps — keyed by normalized invoice number
    # Statement: number → line
    stmt_map: dict[str, dict] = {}
    for line in statement_lines:
        if line.get("amount", 0) <= 0:
            continue  # skip payments/credits for matching
        num = _normalize_invoice_number(line.get("invoice_number") or "")
        if num:
            stmt_map[num] = line

    # QBO: DocNumber → bill
    qbo_map: dict[str, dict] = {}
    for bill in qbo_bills:
        doc = _normalize_invoice_number(bill.get("DocNumber") or "")
        if doc:
            qbo_map[doc] = bill

    matched = []
    amount_mismatch = []
    in_stmt_not_qbo = []
    in_qbo_not_stmt = []

    # Walk statement lines
    for num, stmt_line in stmt_map.items():
        stmt_amount = stmt_line.get("amount", 0)
        if num in qbo_map:
            qbo_bill = qbo_map[num]
            qbo_amount = float(qbo_bill.get("TotalAmt") or qbo_bill.get("Balance") or 0)
            # Allow $0.01 rounding tolerance
            if abs(stmt_amount - qbo_amount) <= 0.01:
                matched.append({
                    "invoice_number": num,
                    "date": stmt_line.get("line_date"),
                    "stmt_amount": stmt_amount,
                    "qbo_amount": qbo_amount,
                    "qbo_bill_id": qbo_bill.get("Id"),
                    "qbo_doc_number": qbo_bill.get("DocNumber"),
                })
            else:
                amount_mismatch.append({
                    "invoice_number": num,
                    "date": stmt_line.get("line_date"),
                    "stmt_amount": stmt_amount,
                    "qbo_amount": qbo_amount,
                    "difference": round(stmt_amount - qbo_amount, 2),
                    "qbo_bill_id": qbo_bill.get("Id"),
                })
        else:
            in_stmt_not_qbo.append({
                "invoice_number": num,
                "date": stmt_line.get("line_date"),
                "stmt_amount": stmt_amount,
                "raw_description": stmt_line.get("raw_description"),
            })

    # Walk QBO bills not matched
    for num, qbo_bill in qbo_map.items():
        if num not in stmt_map:
            in_qbo_not_stmt.append({
                "invoice_number": num,
                "qbo_amount": float(qbo_bill.get("TotalAmt") or 0),
                "qbo_balance": float(qbo_bill.get("Balance") or 0),
                "qbo_date": qbo_bill.get("TxnDate"),
                "qbo_bill_id": qbo_bill.get("Id"),
                "qbo_doc_number": qbo_bill.get("DocNumber"),
            })

    return {
        "matched": matched,
        "amount_mismatch": amount_mismatch,
        "in_stmt_not_qbo": in_stmt_not_qbo,
        "in_qbo_not_stmt": in_qbo_not_stmt,
        "summary": {
            "matched_count": len(matched),
            "mismatch_count": len(amount_mismatch),
            "missing_from_qbo": len(in_stmt_not_qbo),
            "extra_in_qbo": len(in_qbo_not_stmt),
            "total_discrepancy": round(
                sum(r["difference"] for r in amount_mismatch) +
                sum(r["stmt_amount"] for r in in_stmt_not_qbo), 2
            ),
        },
    }


class ReconciliationService:
    def __init__(self):
        self._claude = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        self.qbo = QBOClient()

    async def extract_statement(self, file_bytes: bytes, filename: str) -> dict:
        """
        Use Claude to extract structured data from a vendor statement PDF.
        Returns the raw extraction dict.
        """
        file_b64 = base64.standard_b64encode(file_bytes).decode("utf-8")

        if filename.lower().endswith(".pdf"):
            file_content = {
                "type": "document",
                "source": {"type": "base64", "media_type": "application/pdf", "data": file_b64},
            }
        else:
            file_content = {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": file_b64},
            }

        message = await self._claude.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=4096,
            messages=[{
                "role": "user",
                "content": [
                    file_content,
                    {"type": "text", "text": STATEMENT_EXTRACTION_PROMPT},
                ],
            }],
        )

        raw = message.content[0].text.strip()
        logger.info(f"Statement extraction response: {raw[:300]}")

        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        data = json.loads(raw)

        # Normalize invoice numbers in lines
        for line in data.get("lines", []):
            line["invoice_number"] = _normalize_invoice_number(
                line.get("invoice_number") or ""
            )

        return data

    async def reconcile(
        self,
        statement: dict,
        from_date: str,
        to_date: str,
    ) -> dict:
        """
        Compare extracted statement against QBO bills for the vendor.
        from_date / to_date: YYYY-MM-DD range to query QBO.
        """
        vendor_name = statement.get("vendor_name", "")
        logger.info(f"Reconciling statement for {vendor_name} ({from_date} to {to_date})")

        try:
            qbo_bills = await self.qbo.get_vendor_bills(vendor_name, from_date, to_date)
        except Exception as e:
            logger.error(f"QBO bill query failed for {vendor_name}: {e}")
            qbo_bills = []

        diff = _diff_statement_vs_qbo(
            statement_lines=statement.get("lines", []),
            qbo_bills=qbo_bills,
        )

        return {
            "vendor_name": vendor_name,
            "statement_date": statement.get("statement_date"),
            "closing_balance": statement.get("closing_balance"),
            "currency": statement.get("currency", "CAD"),
            "aging": statement.get("aging", {}),
            "statement_line_count": len(statement.get("lines", [])),
            "qbo_bill_count": len(qbo_bills),
            "diff": diff,
            "refreshed_at": datetime.utcnow().isoformat() + "Z",
        }

    async def close(self):
        await self.qbo.close()
