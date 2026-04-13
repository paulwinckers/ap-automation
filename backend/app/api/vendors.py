"""
Vendor rules API endpoints.

GET    /vendors/          — List all vendor rules
POST   /vendors/          — Create a new vendor rule
GET    /vendors/{id}      — Get a single vendor rule
PUT    /vendors/{id}      — Update a vendor rule
DELETE /vendors/{id}      — Deactivate a vendor rule (soft delete)
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.database import Database
from app.models.vendor import VendorType

logger = logging.getLogger(__name__)
router = APIRouter()

_db = Database()


async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


class VendorCreateRequest(BaseModel):
    vendor_name:        str
    type:               VendorType
    default_gl_account: Optional[str] = None
    default_gl_name:    Optional[str] = None
    forward_to:         Optional[str] = None
    vendor_id_aspire:   Optional[str] = None
    vendor_id_qbo:      Optional[str] = None
    notes:              Optional[str] = None
    is_employee:        bool = False


class VendorUpdateRequest(BaseModel):
    vendor_name:        Optional[str] = None
    type:               Optional[VendorType] = None
    default_gl_account: Optional[str] = None
    default_gl_name:    Optional[str] = None
    forward_to:         Optional[str] = None
    vendor_id_aspire:   Optional[str] = None
    vendor_id_qbo:      Optional[str] = None
    notes:              Optional[str] = None
    match_keyword:      Optional[str] = None
    is_employee:        Optional[bool] = None
    active:             Optional[bool] = None
    aspire_post:        Optional[bool] = None   # enable direct Aspire receipt creation for this vendor


@router.get("/employees")
async def list_employees(db: Database = Depends(get_db)):
    """Return names of vendors flagged as employees — used by the field crew expense form."""
    names = await db.get_employees()
    return {"employees": names}


@router.get("/gl-lookup")
async def gl_lookup(vendor_name: str, db: Database = Depends(get_db)):
    """
    Return the GL account for a vendor name.
    Called by the field crew app after quick-extract to show the GL confirmation step.
    Returns { found, gl_account, gl_name } — found=false if vendor is unknown.
    """
    rule = await db.get_vendor_rule_by_name(vendor_name)
    if not rule or not rule.default_gl_account:
        return {"found": False, "gl_account": None, "gl_name": None}
    return {
        "found":      True,
        "gl_account": rule.default_gl_account,
        "gl_name":    rule.default_gl_name or rule.default_gl_account,
    }


@router.get("/")
async def list_vendors(db: Database = Depends(get_db)):
    vendors = await db.get_all_vendor_rules()
    return {
        "vendors": [v.model_dump() for v in vendors],
        "count":   len(vendors),
    }


@router.post("/")
async def create_vendor(body: VendorCreateRequest, db: Database = Depends(get_db)):
    # Check for duplicate
    existing = await db.get_vendor_rule_by_name(body.vendor_name)
    if existing:
        raise HTTPException(status_code=409, detail=f"Vendor '{body.vendor_name}' already exists")

    vendor_id = await db.create_vendor_rule(
        vendor_name        = body.vendor_name,
        vendor_type        = body.type.value,
        default_gl_account = body.default_gl_account,
        default_gl_name    = body.default_gl_name,
        forward_to         = body.forward_to,
        vendor_id_aspire   = body.vendor_id_aspire,
        vendor_id_qbo      = body.vendor_id_qbo,
        notes              = body.notes,
        is_employee        = body.is_employee,
    )
    await db.audit(None, "vendor_rule_added", "user", {
        "vendor_name": body.vendor_name,
        "type": body.type.value,
    })
    return {"id": vendor_id, "message": f"Vendor '{body.vendor_name}' created"}


@router.get("/gl-name")
async def gl_name_lookup(account: str = Query(...)):
    """
    Look up a GL account name from QBO by account code or name.
    Used by the vendor admin form to auto-fill the GL name field.
    Returns { found, gl_name } — found=false if account doesn't exist in QBO.
    """
    from app.services.qbo import QBOClient
    qbo = QBOClient()
    try:
        acct = await qbo.find_account(account)
        if acct:
            return {"found": True, "gl_name": acct.get("Name", account)}
        return {"found": False, "gl_name": None}
    except Exception as e:
        logger.warning(f"GL name lookup failed for '{account}': {e}")
        return {"found": False, "gl_name": None}


@router.get("/{vendor_id}")
async def get_vendor(vendor_id: int, db: Database = Depends(get_db)):
    vendors = await db.get_all_vendor_rules()
    vendor = next((v for v in vendors if v.id == vendor_id), None)
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor rule not found")
    return vendor.model_dump()


@router.put("/{vendor_id}")
async def update_vendor(
    vendor_id: int,
    body:      VendorUpdateRequest,
    db:        Database = Depends(get_db),
):
    raw = body.model_dump()
    updates = {k: v for k, v in raw.items() if v is not None}
    if "forward_to" in raw:
        updates["forward_to"] = raw["forward_to"] or None
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    if "type" in updates and updates["type"] is not None:
        updates["type"] = updates["type"].value
    await db.update_vendor_rule(vendor_id, updates)
    return {"id": vendor_id, "message": "Vendor rule updated"}


@router.delete("/{vendor_id}")
async def deactivate_vendor(vendor_id: int, db: Database = Depends(get_db)):
    """Soft delete — sets active=0 rather than removing the record."""
    await db.update_vendor_rule(vendor_id, {"active": 0})
    return {"id": vendor_id, "message": "Vendor rule deactivated"}
