"""
Vendor CSV import endpoint.

POST /vendors/import — upload a CSV file to bulk-create vendor rules.

CSV format:
  vendor_name, type, forward_to, default_gl_account, notes

Rules:
  - Existing vendors (matched by name) are updated, not duplicated
  - Blank fields are left as-is on update
  - Invalid rows are skipped and reported in the response
  - type must be: job_cost, overhead, or mixed
"""

import csv
import io
import logging
from fastapi import APIRouter, Depends, File, UploadFile, HTTPException
from app.core.database import Database

logger = logging.getLogger(__name__)

VALID_TYPES = {"job_cost", "overhead", "mixed"}
REQUIRED_COLS = {"vendor_name", "type"}

router = APIRouter()
_db = Database()

async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


@router.post("/import")
async def import_vendors_csv(
    file: UploadFile = File(...),
    db: Database = Depends(get_db),
):
    """
    Bulk import vendor rules from a CSV file.
    Returns a summary of created, updated, and skipped rows.
    """
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are accepted")

    content = await file.read()
    try:
        text = content.decode("utf-8-sig")  # handle BOM from Excel
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text))

    # Validate headers
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV file is empty")

    fieldnames = [f.strip().lower() for f in reader.fieldnames]
    missing = REQUIRED_COLS - set(fieldnames)
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"CSV missing required columns: {', '.join(missing)}"
        )

    created = []
    updated = []
    skipped = []

    for i, row in enumerate(reader, start=2):  # start=2 because row 1 is header
        # Clean up the row
        row = {k.strip().lower(): (v.strip() if v else "") for k, v in row.items()}

        vendor_name = row.get("vendor_name", "").strip()
        vendor_type = row.get("type", "").strip().lower()

        # Validate required fields
        if not vendor_name:
            skipped.append({"row": i, "reason": "Missing vendor_name"})
            continue

        if vendor_type not in VALID_TYPES:
            skipped.append({
                "row": i,
                "vendor": vendor_name,
                "reason": f"Invalid type '{vendor_type}' — must be job_cost, overhead, or mixed"
            })
            continue

        forward_to      = row.get("forward_to", "").strip() or None
        gl_account      = row.get("default_gl_account", "").strip() or None
        notes           = row.get("notes", "").strip() or None

        # Check if vendor already exists
        existing = await db.get_vendor_rule_by_name(vendor_name)

        if existing:
            # Update existing rule
            updates = {}
            if vendor_type:           updates["type"] = vendor_type
            if forward_to is not None: updates["forward_to"] = forward_to
            if gl_account is not None: updates["default_gl_account"] = gl_account
            if notes is not None:      updates["notes"] = notes
            updates["active"] = 1

            if updates:
                await db.update_vendor_rule(existing.id, updates)
            updated.append({"vendor": vendor_name, "type": vendor_type})
        else:
            # Create new rule
            await db.create_vendor_rule(
                vendor_name        = vendor_name,
                vendor_type        = vendor_type,
                default_gl_account = gl_account,
                default_gl_name    = None,
                vendor_id_aspire   = None,
                vendor_id_qbo      = None,
                notes              = notes,
            )
            # Set forward_to separately since create_vendor_rule doesn't have it yet
            new_rule = await db.get_vendor_rule_by_name(vendor_name)
            if new_rule and forward_to:
                await db.update_vendor_rule(new_rule.id, {"forward_to": forward_to})

            created.append({"vendor": vendor_name, "type": vendor_type})

    logger.info(f"CSV import complete — {len(created)} created, {len(updated)} updated, {len(skipped)} skipped")

    return {
        "summary": {
            "created": len(created),
            "updated": len(updated),
            "skipped": len(skipped),
            "total_rows": len(created) + len(updated) + len(skipped),
        },
        "created":  created,
        "updated":  updated,
        "skipped":  skipped,
    }
