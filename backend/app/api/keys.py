"""
Key Management API.
QR code check-in/out system for the physical key box.

Public (no auth):
  GET  /keys/employees          — employee name list for scan page dropdown
  GET  /keys/{id}               — key info + current status + recent 10 log entries
  POST /keys/{id}/scan          — record check-in or check-out

Admin (JWT required):
  GET  /keys/                   — all active keys with current holder
  POST /keys/                   — create a key
  PATCH /keys/{id}              — update name/type/description
  DELETE /keys/{id}             — soft-delete (set active=0)
  GET  /keys/log/all            — full activity log, newest first
  GET  /keys/properties/search  — search Aspire property names
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Query

from app.api.auth import _get_current_user
from app.core.database import Database
from app.core.config import settings
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/keys", tags=["keys"])

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

# ── Shared DB ─────────────────────────────────────────────────────────────────
_db = Database()

async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


# ── Helper — current holder query ─────────────────────────────────────────────
KEYS_WITH_STATUS_SQL = """
    SELECT k.*,
           l.employee_name AS current_holder,
           l.action        AS last_action,
           l.scanned_at    AS last_scanned
    FROM keys k
    LEFT JOIN key_logs l ON l.id = (
        SELECT id FROM key_logs WHERE key_id = k.id
        ORDER BY scanned_at DESC, id DESC LIMIT 1
    )
    {where}
    ORDER BY k.key_type, k.name
"""

def _is_out(row: dict) -> bool:
    return row.get("last_action") == "out"


# ── Fixed-path public endpoints (must be before /{key_id}) ───────────────────

@router.get("/list")
async def list_keys_public(db: Database = Depends(get_db)):
    """Public — all active keys with current holder, for the field search page."""
    rows = await db._q(KEYS_WITH_STATUS_SQL.format(where="WHERE k.active = 1"), [])
    return {"keys": [dict(r) for r in rows]}


@router.get("/employees")
async def list_key_employees(db: Database = Depends(get_db)):
    """Employee names for the scan-page dropdown — pulled from Aspire Contacts (Employee type)."""
    try:
        aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)
        employees = await aspire.get_aspire_employees()
        names = sorted(e["FullName"] for e in employees if e.get("FullName"))
        if names:
            return {"employees": names}
    except Exception as ex:
        logger.warning(f"Aspire employee fetch failed, falling back to vendor_rules: {ex}")

    # Fallback: vendor_rules employees if Aspire is unavailable or returns nothing
    rows = await db._q(
        """SELECT vendor_name FROM vendor_rules
           WHERE active = 1 AND is_employee = 1
           ORDER BY vendor_name"""
    )
    return {"employees": [r["vendor_name"] for r in rows]}


@router.get("/properties/search")
async def search_aspire_properties(
    q: str = Query(..., min_length=2),
    _user: dict = Depends(_get_current_user),
):
    """Search Aspire properties by name (for admin key setup)."""
    q_safe = q.replace("'", "''")
    try:
        res = await _aspire._get("Properties", {
            "$filter": f"contains(PropertyName,'{q_safe}')",
            "$top": "20",
        })
        records = _aspire._extract_list(res)
        return {
            "results": [
                {
                    "property_id":   r.get("PropertyID"),
                    "property_name": r.get("PropertyName") or "",
                    "address":       ", ".join(filter(None, [r.get("Address1"), r.get("City")])),
                }
                for r in records
            ]
        }
    except Exception as e:
        logger.warning(f"Property search failed: {e}")
        return {"results": []}


@router.get("/log/all")
async def get_full_log(
    limit: int = Query(default=200, le=500),
    db: Database = Depends(get_db),
    _user: dict = Depends(_get_current_user),
):
    rows = await db._q(
        """SELECT l.*, k.name AS key_name, k.key_type
           FROM key_logs l
           JOIN keys k ON k.id = l.key_id
           ORDER BY l.scanned_at DESC
           LIMIT ?""",
        [limit],
    )
    return {"log": [dict(r) for r in rows]}


# ── Fixed-path admin endpoints (no path param) ────────────────────────────────

@router.get("/")
async def list_keys(
    db: Database = Depends(get_db),
    _user: dict = Depends(_get_current_user),
):
    """All active keys with current holder."""
    rows = await db._q(KEYS_WITH_STATUS_SQL.format(where="WHERE k.active = 1"), [])
    return {"keys": [dict(r) for r in rows]}


@router.post("/")
async def create_key(
    name:          str = Form(...),
    key_type:      str = Form(...),
    description:   str = Form(default=""),
    property_name: str = Form(default=""),
    db: Database = Depends(get_db),
    _user: dict = Depends(_get_current_user),
):
    if key_type not in ("vehicle", "property_owner", "other"):
        raise HTTPException(status_code=400, detail="Invalid key_type")
    key_id = await db._x(
        """INSERT INTO keys (name, key_type, description, property_name)
           VALUES (?, ?, ?, ?)""",
        [name.strip(), key_type, description.strip() or None, property_name.strip() or None],
    )
    logger.info(f"Key created: id={key_id} name={name!r} type={key_type}")
    return {"ok": True, "key_id": key_id}


# ── Parameterized endpoints (/{key_id} — must come after all fixed paths) ─────

@router.get("/{key_id}")
async def get_key(key_id: int, db: Database = Depends(get_db)):
    """Public — returns key info, current status, and last 10 log entries."""
    rows = await db._q(
        KEYS_WITH_STATUS_SQL.format(where="WHERE k.id = ? AND k.active = 1"),
        [key_id],
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Key not found")
    key = rows[0]
    log = await db._q(
        "SELECT * FROM key_logs WHERE key_id = ? ORDER BY scanned_at DESC, id DESC LIMIT 10",
        [key_id],
    )
    return {
        "key":         dict(key),
        "checked_out": _is_out(key),
        "log":         log,
    }


@router.post("/{key_id}/scan")
async def scan_key(
    key_id:        int,
    employee_name: str  = Form(...),
    action:        str  = Form(...),   # 'in' or 'out'
    notes:         str  = Form(default=""),
    db: Database = Depends(get_db),
):
    """Public — record a check-in or check-out."""
    if action not in ("in", "out"):
        raise HTTPException(status_code=400, detail="action must be 'in' or 'out'")
    if not employee_name.strip():
        raise HTTPException(status_code=400, detail="employee_name is required")

    # Verify key exists
    rows = await db._q("SELECT id, name FROM keys WHERE id = ? AND active = 1", [key_id])
    if not rows:
        raise HTTPException(status_code=404, detail="Key not found")

    await db._x(
        """INSERT INTO key_logs (key_id, employee_name, action, notes)
           VALUES (?, ?, ?, ?)""",
        [key_id, employee_name.strip(), action, notes.strip() or None],
    )
    logger.info(f"Key #{key_id} ({rows[0]['name']!r}) {action} by {employee_name!r}")
    return {"ok": True, "key_id": key_id, "action": action, "employee_name": employee_name}


@router.post("/{key_id}/transfer")
async def transfer_key(
    key_id:        int,
    employee_name: str  = Form(...),   # person receiving the key
    notes:         str  = Form(default=""),
    db: Database = Depends(get_db),
):
    """Public — Pass the Baton: auto check-in from current holder, check-out to new person."""
    # Verify key exists and is active
    key_rows = await db._q("SELECT id, name FROM keys WHERE id = ? AND active = 1", [key_id])
    if not key_rows:
        raise HTTPException(status_code=404, detail="Key not found")

    # Find current holder (last log entry)
    last = await db._q(
        "SELECT employee_name, action FROM key_logs WHERE key_id = ? ORDER BY scanned_at DESC, id DESC LIMIT 1",
        [key_id],
    )
    if not last or last[0]["action"] != "out":
        raise HTTPException(status_code=400, detail="Key is not currently checked out")

    current_holder = last[0]["employee_name"]
    new_holder     = employee_name.strip()

    if not new_holder:
        raise HTTPException(status_code=400, detail="employee_name is required")
    if new_holder == current_holder:
        raise HTTPException(status_code=400, detail="You already have this key")

    xfer_note = f"Passed to {new_holder}" + (f" — {notes}" if notes.strip() else "")

    # Check-in from current holder
    await db._x(
        "INSERT INTO key_logs (key_id, employee_name, action, notes) VALUES (?, ?, 'in', ?)",
        [key_id, current_holder, xfer_note],
    )
    # Check-out to new person
    await db._x(
        "INSERT INTO key_logs (key_id, employee_name, action, notes) VALUES (?, ?, 'out', ?)",
        [key_id, new_holder, f"Received from {current_holder}" + (f" — {notes}" if notes.strip() else "")],
    )
    logger.info(f"Key #{key_id} ({key_rows[0]['name']!r}) transferred {current_holder!r} → {new_holder!r}")
    return {"ok": True, "key_id": key_id, "from": current_holder, "to": new_holder}


@router.patch("/{key_id}")
async def update_key(
    key_id:        int,
    name:          Optional[str] = Form(default=None),
    key_type:      Optional[str] = Form(default=None),
    description:   Optional[str] = Form(default=None),
    property_name: Optional[str] = Form(default=None),
    db: Database = Depends(get_db),
    _user: dict = Depends(_get_current_user),
):
    updates: dict = {}
    if name          is not None: updates["name"]          = name.strip()
    if key_type      is not None:
        if key_type not in ("vehicle", "property_owner", "other"):
            raise HTTPException(status_code=400, detail="Invalid key_type")
        updates["key_type"] = key_type
    if description   is not None: updates["description"]   = description.strip() or None
    if property_name is not None: updates["property_name"] = property_name.strip() or None
    if not updates:
        return {"ok": True}
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    await db._x(
        f"UPDATE keys SET {set_clause} WHERE id = ?",
        list(updates.values()) + [key_id],
    )
    return {"ok": True}


@router.delete("/{key_id}")
async def deactivate_key(
    key_id: int,
    db: Database = Depends(get_db),
    _user: dict = Depends(_get_current_user),
):
    await db._x("UPDATE keys SET active = 0 WHERE id = ?", [key_id])
    return {"ok": True}
