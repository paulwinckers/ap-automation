"""Invoice data models."""
from enum import Enum
from typing import Optional
from pydantic import BaseModel


class InvoiceStatus(str, Enum):
    PENDING = "pending"
    QUEUED  = "queued"
    POSTED  = "posted"
    ERROR   = "error"


class RoutingDecision(str, Enum):
    ASPIRE = "aspire"
    QBO    = "qbo"
    QUEUE  = "queue"


class LineItem(BaseModel):
    description: Optional[str] = None
    quantity:    Optional[float] = None
    unit_price:  Optional[float] = None
    amount:      Optional[float] = None


class TaxLine(BaseModel):
    tax_name:   str
    tax_rate:   Optional[float] = None
    tax_amount: Optional[float] = None


class InvoiceExtraction(BaseModel):
    """Structured data returned by Claude extraction."""
    vendor_name:    Optional[str] = None
    invoice_number: Optional[str] = None
    invoice_date:   Optional[str] = None
    due_date:       Optional[str] = None
    po_number:      Optional[str] = None
    subtotal:       Optional[float] = None
    tax_lines:      list[TaxLine] = []
    total_amount:   Optional[float] = None
    currency:       str = "CAD"
    line_items:     list[LineItem] = []
    notes:          Optional[str] = None

    @property
    def tax_amount(self) -> float:
        return sum(t.tax_amount for t in self.tax_lines)


class Invoice(BaseModel):
    """Full invoice record as stored in D1."""
    id:                  int
    status:              InvoiceStatus
    tax_lines:           list[TaxLine] = []
    # Transient fields — not stored in DB
    file_bytes:          Optional[bytes] = None
    doc_type:            Optional[str] = None   # 'vendor' | 'mastercard' | 'expense'
    vendor_name:         Optional[str] = None
    vendor_id_resolved:  Optional[int] = None
    invoice_number:      Optional[str] = None
    invoice_date:        Optional[str] = None
    due_date:            Optional[str] = None
    subtotal:            Optional[float] = None
    tax_amount:          Optional[float] = None
    total_amount:        Optional[float] = None
    currency:            str = "CAD"
    po_number:           Optional[str] = None
    po_number_override:  Optional[str] = None
    po_aspire_id:        Optional[str] = None
    gl_account:          Optional[str] = None
    pdf_r2_key:          Optional[str] = None
    pdf_filename:        Optional[str] = None
    intake_source:       Optional[str] = None
    aspire_receipt_id:   Optional[str] = None
    qbo_bill_id:         Optional[str] = None
    error_message:       Optional[str] = None
    received_at:         Optional[str] = None
    line_items:          list[LineItem] = []
