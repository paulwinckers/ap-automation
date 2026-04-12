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
    Strip common prefixes and leading zeros from vendor invoice numbers for comparison.
    "INV #620024" → "620024"
    "0620024"     → "620024"  (Amrize-style leading zero)
    "INV-620024"  → "620024"
    "#620024"     → "620024"
    "620024"      → "620024"
    """
    if not raw:
        return ""
    normalized = raw.strip()
    # Remove common prefixes: INV #, INV#, INV-, #
    normalized = re.sub(r'^(INV\s*#?\s*|INV-|#)', '', normalized, flags=re.IGNORECASE)
    normalized = normalized.strip()
    # Strip leading zeros so "0620024" matches "620024"
    normalized = normalized.lstrip('0') or normalized  # keep at least one char if all zeros
    return normalized


def _diff_statement_vs_qbo(
    statement_lines: list[dict],
    qbo_bills: list[dict],
    qbo_credits: list[dict] = None,
) -> dict:
    """
    Compare statement lines against QBO bills and vendor credits.
    Returns a structured diff with categories for both charges and credits.

    Charge lines (amount > 0) are matched against QBO Bills.
    Credit lines (amount < 0) are matched against QBO VendorCredits.
    Payment lines are skipped — they appear on both sides and aren't a discrepancy.
    """
    qbo_credits = qbo_credits or []

    # ── Separate statement lines into charges and credits ─────────────────────
    stmt_charges: dict[str, dict] = {}
    stmt_credits: dict[str, dict] = {}

    for line in statement_lines:
        amount = line.get("amount", 0)
        num = _normalize_invoice_number(line.get("invoice_number") or "")
        if not num:
            continue
        if amount > 0:
            stmt_charges[num] = line
        elif amount < 0:
            # Negative amounts on statements are credits/adjustments
            stmt_credits[num] = line
        # amount == 0 (e.g. pure payment lines) → skip

    # ── QBO lookup maps ───────────────────────────────────────────────────────
    qbo_bill_map: dict[str, dict] = {}
    for bill in qbo_bills:
        doc = _normalize_invoice_number(bill.get("DocNumber") or "")
        if doc:
            qbo_bill_map[doc] = bill

    qbo_credit_map: dict[str, dict] = {}
    for credit in qbo_credits:
        doc = _normalize_invoice_number(credit.get("DocNumber") or "")
        if doc:
            qbo_credit_map[doc] = credit

    # ── Diff: charges vs QBO Bills ────────────────────────────────────────────
    matched = []
    amount_mismatch = []
    in_stmt_not_qbo = []
    in_qbo_not_stmt = []

    for num, stmt_line in stmt_charges.items():
        stmt_amount = stmt_line.get("amount", 0)
        if num in qbo_bill_map:
            qbo_bill = qbo_bill_map[num]
            # Compare against TotalAmt (original billed amount), not Balance.
            # A bill paid after the statement date should still match.
            qbo_amount = float(qbo_bill.get("TotalAmt") or 0)
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

    for num, qbo_bill in qbo_bill_map.items():
        if num not in stmt_charges:
            in_qbo_not_stmt.append({
                "invoice_number": num,
                "qbo_amount": float(qbo_bill.get("TotalAmt") or 0),
                # As-of-date balance injected by get_vendor_bills
                "qbo_balance": float(qbo_bill.get("_balance_as_of_date") or qbo_bill.get("Balance") or 0),
                "qbo_date": qbo_bill.get("TxnDate"),
                "qbo_bill_id": qbo_bill.get("Id"),
                "qbo_doc_number": qbo_bill.get("DocNumber"),
            })

    # ── Diff: credit notes vs QBO VendorCredits ───────────────────────────────
    credits_matched = []
    credits_amount_mismatch = []
    credits_in_stmt_not_qbo = []
    credits_in_qbo_not_stmt = []

    for num, stmt_line in stmt_credits.items():
        stmt_amount = abs(stmt_line.get("amount", 0))  # compare as positive
        if num in qbo_credit_map:
            qbo_credit = qbo_credit_map[num]
            qbo_amount = float(qbo_credit.get("TotalAmt") or 0)
            if abs(stmt_amount - qbo_amount) <= 0.01:
                credits_matched.append({
                    "invoice_number": num,
                    "date": stmt_line.get("line_date"),
                    "stmt_amount": -stmt_amount,
                    "qbo_amount": qbo_amount,
                    "qbo_credit_id": qbo_credit.get("Id"),
                    "qbo_doc_number": qbo_credit.get("DocNumber"),
                })
            else:
                credits_amount_mismatch.append({
                    "invoice_number": num,
                    "date": stmt_line.get("line_date"),
                    "stmt_amount": -stmt_amount,
                    "qbo_amount": qbo_amount,
                    "difference": round(qbo_amount - stmt_amount, 2),
                    "qbo_credit_id": qbo_credit.get("Id"),
                })
        else:
            credits_in_stmt_not_qbo.append({
                "invoice_number": num,
                "date": stmt_line.get("line_date"),
                "stmt_amount": -stmt_amount,
                "raw_description": stmt_line.get("raw_description"),
            })

    for num, qbo_credit in qbo_credit_map.items():
        if num not in stmt_credits:
            credits_in_qbo_not_stmt.append({
                "invoice_number": num,
                "qbo_amount": float(qbo_credit.get("TotalAmt") or 0),
                "qbo_balance": float(qbo_credit.get("_balance_as_of_date") or qbo_credit.get("Balance") or 0),
                "qbo_date": qbo_credit.get("TxnDate"),
                "qbo_credit_id": qbo_credit.get("Id"),
                "qbo_doc_number": qbo_credit.get("DocNumber"),
            })

    return {
        # Charge discrepancies
        "matched": matched,
        "amount_mismatch": amount_mismatch,
        "in_stmt_not_qbo": in_stmt_not_qbo,
        "in_qbo_not_stmt": in_qbo_not_stmt,
        # Credit note discrepancies
        "credits_matched": credits_matched,
        "credits_amount_mismatch": credits_amount_mismatch,
        "credits_in_stmt_not_qbo": credits_in_stmt_not_qbo,
        "credits_in_qbo_not_stmt": credits_in_qbo_not_stmt,
        "summary": {
            "matched_count": len(matched),
            "mismatch_count": len(amount_mismatch),
            "missing_from_qbo": len(in_stmt_not_qbo),
            "extra_in_qbo": len(in_qbo_not_stmt),
            "credits_matched_count": len(credits_matched),
            "credits_mismatch_count": len(credits_amount_mismatch),
            "credits_missing_from_qbo": len(credits_in_stmt_not_qbo),
            "credits_extra_in_qbo": len(credits_in_qbo_not_stmt),
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
        qbo_vendor_id: str = None,
    ) -> dict:
        """
        Compare extracted statement against QBO bills for the vendor.
        qbo_vendor_id: if provided, skips fuzzy name lookup and uses this ID directly.
        """
        vendor_name = statement.get("vendor_name", "")
        logger.info(f"Reconciling statement for {vendor_name} ({from_date} to {to_date})"
                    + (f" [linked to QBO vendor {qbo_vendor_id}]" if qbo_vendor_id else ""))

        try:
            qbo_result = await self.qbo.get_vendor_bills(vendor_name, from_date, to_date, vendor_id=qbo_vendor_id)
        except Exception as e:
            logger.error(f"QBO bill/credit query failed for {vendor_name}: {e}")
            qbo_result = {"bills": [], "credits": []}

        qbo_bills   = qbo_result.get("bills", [])
        qbo_credits = qbo_result.get("credits", [])

        diff = _diff_statement_vs_qbo(
            statement_lines=statement.get("lines", []),
            qbo_bills=qbo_bills,
            qbo_credits=qbo_credits,
        )

        # Net QBO balance = open bill balances (already net of applied credits)
        #                   minus any unapplied credits still sitting on the account.
        # get_vendor_bills annotates each bill with _balance_as_of_date (net of
        # payments + applied credits) and each credit with _balance_as_of_date
        # (0 if applied, full amount if unapplied).
        open_bill_total = round(
            sum(float(b.get("_balance_as_of_date") or b.get("TotalAmt") or 0) for b in qbo_bills),
            2,
        )
        unapplied_credit_total = round(
            sum(float(c.get("_balance_as_of_date") or 0) for c in qbo_credits),
            2,
        )
        qbo_total_balance = round(open_bill_total - unapplied_credit_total, 2)

        return {
            "vendor_name": vendor_name,
            "statement_date": statement.get("statement_date"),
            "closing_balance": statement.get("closing_balance"),
            "qbo_total_balance": qbo_total_balance,
            "qbo_open_bill_total": open_bill_total,
            "qbo_unapplied_credit_total": unapplied_credit_total,
            "currency": statement.get("currency", "CAD"),
            "aging": statement.get("aging", {}),
            "statement_line_count": len(statement.get("lines", [])),
            "qbo_bill_count": len(qbo_bills),
            "qbo_credit_count": len(qbo_credits),
            "diff": diff,
            "refreshed_at": datetime.utcnow().isoformat() + "Z",
        }

    async def close(self):
        await self.qbo.close()
