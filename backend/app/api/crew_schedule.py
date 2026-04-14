"""
Crew Schedule API — assign field staff to routes for a given day.

GET    /crew/assignments?work_date=YYYY-MM-DD  — assignments for a date, grouped by route
POST   /crew/assignments                       — add an employee to a route
DELETE /crew/assignments/{id}                  — remove an assignment
GET    /crew/employees                         — active employees from Aspire (cached 10 min)
"""
import logging
import time
from datetime import date as _date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.database import Database
from app.core.config import settings
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/crew", tags=["crew-schedule"])

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

# ── Shared DB instance ────────────────────────────────────────────────────────
_db = Database()

async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


# ── Employees excluded from scheduling (office/management) ───────────────────
_EXCLUDED_EMPLOYEES = {
    "paul winckers",
    "rodger mclean",
    "vesna hozjan",
    "eduardo",
    "keeland kannan",
    "jimmy sturrock",
}

# ── Simple in-process employee cache (avoids hammering Aspire) ────────────────
_emp_cache: list[dict] = []
_emp_cache_ts: float   = 0.0
_EMP_TTL = 600  # 10 minutes


async def _get_employees() -> list[dict]:
    global _emp_cache, _emp_cache_ts
    if _emp_cache and (time.time() - _emp_cache_ts) < _EMP_TTL:
        return _emp_cache
    all_employees = await _aspire.get_aspire_employees()
    _emp_cache = [
        e for e in all_employees
        if e.get("FullName", "").strip().lower() not in _EXCLUDED_EMPLOYEES
    ]
    _emp_cache_ts = time.time()
    return _emp_cache


# ── Pydantic models ───────────────────────────────────────────────────────────

class AssignmentCreate(BaseModel):
    work_date:     str   # YYYY-MM-DD
    route_name:    str
    employee_id:   int
    employee_name: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/assignments")
async def get_assignments(
    work_date: Optional[str] = Query(default=None),
    db: Database = Depends(get_db),
):
    """Return all crew assignments for a date, grouped by route_name."""
    if not work_date:
        work_date = _date.today().isoformat()
    rows = await db._q(
        "SELECT * FROM crew_assignments WHERE work_date = ? ORDER BY route_name, id",
        [work_date],
    )
    # Group by route_name → list of assignment objects
    groups: dict[str, list] = {}
    for row in rows:
        rn = row["route_name"]
        groups.setdefault(rn, []).append({
            "id":            row["id"],
            "route_name":    row["route_name"],
            "employee_id":   row["employee_id"],
            "employee_name": row["employee_name"],
        })
    return {"work_date": work_date, "assignments": groups}


@router.post("/assignments")
async def add_assignment(
    body: AssignmentCreate,
    db: Database = Depends(get_db),
):
    """Assign an employee to a route on a given date (idempotent)."""
    existing = await db._q(
        """SELECT id FROM crew_assignments
           WHERE work_date = ? AND route_name = ? AND employee_id = ?""",
        [body.work_date, body.route_name, body.employee_id],
    )
    if existing:
        return {"id": existing[0]["id"], "created": False}

    new_id = await db._x(
        """INSERT INTO crew_assignments (work_date, route_name, employee_id, employee_name)
           VALUES (?, ?, ?, ?)""",
        [body.work_date, body.route_name, body.employee_id, body.employee_name],
    )
    logger.info(f"Crew assigned: {body.employee_name} → {body.route_name} on {body.work_date}")
    return {"id": new_id, "created": True}


@router.delete("/assignments/{assignment_id}")
async def remove_assignment(
    assignment_id: int,
    db: Database = Depends(get_db),
):
    """Remove a crew assignment by ID."""
    await db._x("DELETE FROM crew_assignments WHERE id = ?", [assignment_id])
    return {"deleted": True, "id": assignment_id}


@router.get("/employees")
async def get_employees():
    """Return active employees from Aspire for the staff pool (cached 10 min)."""
    employees = await _get_employees()
    return {"employees": employees}
