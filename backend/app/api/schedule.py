"""
Construction Weekly Schedule board — the crew × day grid that drives the week.

The portal is the source of truth for scheduling (replaces the spreadsheet):
Won construction jobs flow in from Aspire as a backlog; the office drags them
onto a crew/day grid. Assignments live in D1 (schedule_assignments).

GET    /schedule/week?start=YYYY-MM-DD   — one week (Mon start): days, crew, assignments, backlog
POST   /schedule/assignment              — place a job (or a free label like "Away") on a cell
PUT    /schedule/assignment/{id}         — move / edit an assignment
DELETE /schedule/assignment/{id}         — remove it
"""
import logging
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.services.aspire import AspireClient

router = APIRouter(prefix="/construction/schedule", tags=["construction-schedule"])
logger = logging.getLogger(__name__)

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)


async def _db() -> Database:
    db = Database()
    await db.connect()
    return db


def _row(r) -> dict:
    return dict(r) if r else {}


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


# ── Week view ───────────────────────────────────────────────────────────────────

@router.get("/week")
async def get_week(start: Optional[str] = Query(None)):
    """Return one week of the board. `start` is any date in the week (defaults to
    this week); it's snapped back to Monday. Days are Mon–Sat."""
    try:
        base = datetime.strptime(start, "%Y-%m-%d").date() if start else date.today()
    except ValueError:
        base = date.today()
    mon = _monday(base)
    days = [(mon + timedelta(days=i)).isoformat() for i in range(6)]  # Mon..Sat
    week_end = days[-1]

    db = await _db()
    try:
        # Crew rows — the construction leads directory
        try:
            lead_rows = await db._q("SELECT aspire_name, email, display_name FROM construction_leads ORDER BY aspire_name", [])
            leads = [{"name": r["display_name"] or r["aspire_name"], "aspire_name": r["aspire_name"]} for r in lead_rows]
        except Exception as e:
            logger.warning(f"schedule: leads load failed: {e}")
            leads = []

        # Assignments for the week
        rows = await db._q(
            "SELECT * FROM schedule_assignments WHERE work_date >= ? AND work_date <= ? ORDER BY sort_order, id",
            [days[0], week_end],
        )
        assignments = [{
            "id": r["id"], "work_date": r["work_date"], "lead_name": r["lead_name"],
            "opportunity_id": r.get("opportunity_id"), "job_label": r.get("job_label"),
            "note": r.get("note"), "sort_order": r.get("sort_order") or 0,
        } for r in (_row(x) for x in rows)]
    finally:
        await db.close()

    backlog = await _backlog()

    return {"week_start": mon.isoformat(), "days": days, "leads": leads,
            "assignments": assignments, "backlog": backlog}


async def _backlog() -> list[dict]:
    """Active Won construction jobs available to schedule (not yet complete)."""
    try:
        opps = await _aspire.get_construction_opportunities(year=date.today().year)
    except Exception as e:
        logger.warning(f"schedule backlog fetch failed: {e}")
        return []
    out = []
    for o in opps:
        status = (o.get("OpportunityStatusName") or "").lower()
        if status != "won":
            continue
        js = (o.get("JobStatusName") or "").lower()
        if o.get("CompleteDate") or "complete" in js or float(o.get("PercentComplete") or 0) >= 1:
            continue
        out.append({
            "opportunity_id": o.get("OpportunityID"),
            "label": o.get("PropertyName") or o.get("OpportunityName") or "(unnamed)",
            "opportunity_name": o.get("OpportunityName"),
            "opp_number": o.get("OpportunityNumber"),
            "hours_est": o.get("EstimatedLaborHours"),
            "start_date": (o.get("StartDate") or "")[:10] or None,
        })
    # Soonest start first, then biggest
    out.sort(key=lambda x: (x["start_date"] or "9999", -(x["hours_est"] or 0)))
    return out


# ── Mutations ─────────────────────────────────────────────────────────────────

class AssignmentBody(BaseModel):
    work_date:      str
    lead_name:      str
    opportunity_id: Optional[int] = None
    job_label:      str
    note:           Optional[str] = None


@router.post("/assignment")
async def create_assignment(body: AssignmentBody):
    if not body.work_date or not body.lead_name:
        raise HTTPException(400, "work_date and lead_name are required")
    db = await _db()
    try:
        rows = await db._q(
            """INSERT INTO schedule_assignments
               (work_date, lead_name, opportunity_id, job_label, note, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
               RETURNING id""",
            [body.work_date, body.lead_name, body.opportunity_id,
             (body.job_label or "").strip(), (body.note or "").strip() or None],
        )
        return {"id": rows[0]["id"]}
    finally:
        await db.close()


class AssignmentPatch(BaseModel):
    work_date:      Optional[str] = None
    lead_name:      Optional[str] = None
    opportunity_id: Optional[int] = None
    job_label:      Optional[str] = None
    note:           Optional[str] = None
    sort_order:     Optional[int] = None


@router.put("/assignment/{assignment_id}")
async def update_assignment(assignment_id: int, body: AssignmentPatch):
    sets, params = ["updated_at = datetime('now')"], []
    for col in ("work_date", "lead_name", "opportunity_id", "job_label", "note", "sort_order"):
        val = getattr(body, col)
        if val is not None:
            sets.append(f"{col} = ?")
            params.append(val.strip() if isinstance(val, str) else val)
    params.append(assignment_id)
    db = await _db()
    try:
        await db._x(f"UPDATE schedule_assignments SET {', '.join(sets)} WHERE id = ?", params)
        return {"ok": True, "id": assignment_id}
    finally:
        await db.close()


@router.delete("/assignment/{assignment_id}")
async def delete_assignment(assignment_id: int):
    db = await _db()
    try:
        await db._x("DELETE FROM schedule_assignments WHERE id = ?", [assignment_id])
        return {"ok": True, "id": assignment_id}
    finally:
        await db.close()
