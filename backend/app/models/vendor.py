"""Vendor rule data models."""
from enum import Enum
from typing import Optional
from pydantic import BaseModel


class VendorType(str, Enum):
    JOB_COST = "job_cost"
    OVERHEAD = "overhead"
    MIXED    = "mixed"


class VendorRule(BaseModel):
    id:                  int
    vendor_name:         str
    vendor_id_aspire:    Optional[str] = None
    vendor_id_qbo:       Optional[str] = None
    type:                VendorType
    default_gl_account:  Optional[str] = None
    default_gl_name:     Optional[str] = None
    forward_to:          Optional[str] = None   # email for confirmation / forwarding
    match_keyword:       Optional[str] = None   # override keyword for fuzzy matching
    notes:               Optional[str] = None
    is_employee:         bool = False
    active:              bool = True
    aspire_post:         bool = False   # if True, attempt to create receipt in Aspire on match


class VendorRuleCreate(BaseModel):
    vendor_name:         str
    vendor_id_aspire:    Optional[str] = None
    vendor_id_qbo:       Optional[str] = None
    type:                VendorType
    default_gl_account:  Optional[str] = None
    default_gl_name:     Optional[str] = None
    notes:               Optional[str] = None
    is_employee:         bool = False


class VendorRuleUpdate(BaseModel):
    vendor_id_aspire:    Optional[str] = None
    vendor_id_qbo:       Optional[str] = None
    type:                Optional[VendorType] = None
    default_gl_account:  Optional[str] = None
    default_gl_name:     Optional[str] = None
    match_keyword:       Optional[str] = None
    notes:               Optional[str] = None
    is_employee:         Optional[bool] = None
    active:              Optional[bool] = None
    aspire_post:         Optional[bool] = None
