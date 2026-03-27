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

from fastapi import APIRouter, Depends, HTTPException
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
    vendor_id_aspire:   Optional[str] = None
    vendor_id_qbo:      Optional[str] = None
    notes:              Optional[str] = None


class VendorUpdateRequest(BaseModel):
    type:               Optional[VendorType] = None
    default_gl_account: Optional[str] = None
    default_gl_name:    Optional[str] = None
    vendor_id_aspire:   Optional[str] = None
    vendor_id_qbo:      Optional[str] = None
    notes:              Optional[str] = None
    active:             Optional[bool] = None


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
        vendor_id_aspire   = body.vendor_id_aspire,
        vendor_id_qbo      = body.vendor_id_qbo,
        notes              = body.notes,
    )
    await db.audit(None, "vendor_rule_added", "user", {
        "vendor_name": body.vendor_name,
        "type": body.type.value,
    })
    return {"id": vendor_id, "message": f"Vendor '{body.vendor_name}' created"}


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
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    if "type" in updates:
        updates["type"] = updates["type"].value
    await db.update_vendor_rule(vendor_id, updates)
    return {"id": vendor_id, "message": "Vendor rule updated"}


@router.delete("/{vendor_id}")
async def deactivate_vendor(vendor_id: int, db: Database = Depends(get_db)):
    """Soft delete — sets active=0 rather than removing the record."""
    await db.update_vendor_rule(vendor_id, {"active": 0})
    return {"id": vendor_id, "message": "Vendor rule deactivated"}
