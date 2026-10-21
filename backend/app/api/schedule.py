"""
Construction Weekly Schedule board — crew × day grid (replaces the spreadsheet).

The portal is the source of truth for scheduling. A job is scheduled as a
*block*: total hours ÷ (employees × hours/day) = the number of working days it
spans. Crews work 10-hour days, Mon–Thu by default; Fridays are optional per
block. The block stretches across the chosen employees' rows automatically and
can be edited afterwards (move start, toggle Fridays, add/remove employees) —
the span recomputes.

GET    /construction/schedule/week?start=YYYY-MM-DD   — week: days, crew, blocks, labels, backlog
POST   /construction/schedule/block                   — schedule a job (employees + hours → span)
PUT    /construction/schedule/block/{id}              — move / edit a block (span recomputes)
DELETE /construction/schedule/block/{id}              — remove a block
POST   /construction/schedule/assignment              — a free label on a cell (Away/Shop)
DELETE /construction/schedule/assignment/{id}         — remove a free label
"""
import json
import logging
import math
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
DEFAULT_HOURS_PER_DAY = 10.0

# Shared, connect-once DB. A fresh Database()+connect() per request re-runs the
# entire schema.sql over D1 (dozens of HTTP round-trips ≈ 8s/request); reusing a
# single connected instance makes each call fast.
_DB = Database()


async def _db() -> Database:
    if _DB._db is None:
        await _DB.connect()
    return _DB


def _row(r) -> dict:
    return dict(r) if r else {}


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _parse(iso: str) -> date:
    return datetime.strptime(iso[:10], "%Y-%m-%d").date()


def _working_dates(start: date, count: int, include_friday: bool) -> list[str]:
    """Return `count` working dates from `start`. Working = Mon–Thu, plus Fri when
    include_friday. Sat/Sun excluded. If start lands on a non-working day, the
    span begins on the next working day."""
    out: list[str] = []
    d = start
    guard = 0
    while len(out) < count and guard < 400:
        wd = d.weekday()  # Mon=0 … Sun=6
        working = wd <= 3 or (wd == 4 and include_friday)
        if working:
            out.append(d.isoformat())
        d += timedelta(days=1)
        guard += 1
    return out


def _block_dates(hours, employees: list, hours_per_day, include_friday: bool, start_iso: str) -> list[str]:
    try:
        h = float(hours or 0)
    except (TypeError, ValueError):
        h = 0.0
    try:
        hpd = float(hours_per_day or DEFAULT_HOURS_PER_DAY) or DEFAULT_HOURS_PER_DAY
    except (TypeError, ValueError):
        hpd = DEFAULT_HOURS_PER_DAY
    emp = max(1, len(employees or []))
    days_needed = max(1, math.ceil(h / (emp * hpd))) if h > 0 else 1
    return _working_dates(_parse(start_iso), days_needed, include_friday)


def _shape_block(r: dict) -> dict:
    employees = []
    try:
        employees = json.loads(r.get("employees") or "[]")
    except Exception:
        employees = []
    inc_fri = bool(r.get("include_friday"))
    dates = _block_dates(r.get("hours"), employees, r.get("hours_per_day"), inc_fri, r.get("start_date"))
    return {
        "id": r["id"],
        "opportunity_id": r.get("opportunity_id"),
        "job_label": r.get("job_label"),
        "start_date": r.get("start_date"),
        "hours": r.get("hours"),
        "hours_per_day": r.get("hours_per_day") or DEFAULT_HOURS_PER_DAY,
        "include_friday": inc_fri,
        "employees": employees,
        "note": r.get("note"),
        "status": r.get("status") or "tentative",
        "dates": dates,
        "days_needed": len(dates),
        "end_date": dates[-1] if dates else r.get("start_date"),
    }


# ── Crew roster (portal-owned, independent of Aspire) ─────────────────────────────

_crew_seeded = False


async def _ensure_crew_seeded(db: Database) -> None:
    """On first use, seed the schedule crew from the existing construction leads
    so the board isn't empty. After that the roster is managed in the portal.
    Runs at most once per process."""
    global _crew_seeded
    if _crew_seeded:
        return
    try:
        existing = await db._q("SELECT COUNT(*) AS n FROM schedule_crew", [])
        if existing and (existing[0].get("n") or 0) > 0:
            _crew_seeded = True
            return
        leads = await db._q("SELECT aspire_name, display_name FROM construction_leads ORDER BY aspire_name", [])
        seen = set()
        i = 0
        for r in leads:
            name = (r.get("display_name") or r.get("aspire_name") or "").strip()
            if not name or name.lower() in seen:
                continue
            seen.add(name.lower())
            await db._x("INSERT INTO schedule_crew (name, active, sort_order) VALUES (?, 1, ?)", [name, i])
            i += 1
        if i:
            logger.info(f"schedule: seeded {i} crew from construction_leads")
        _crew_seeded = True
    except Exception as e:
        logger.warning(f"schedule crew seed skipped: {e}")


async def _active_crew(db: Database) -> list[dict]:
    rows = await db._q("SELECT id, name, active, sort_order FROM schedule_crew WHERE active = 1 ORDER BY sort_order, name", [])
    return [{"id": r["id"], "name": r["name"]} for r in rows]


@router.get("/crew")
async def list_crew(include_inactive: bool = Query(False)):
    db = await _db()
    try:
        await _ensure_crew_seeded(db)
        where = "" if include_inactive else "WHERE active = 1"
        rows = await db._q(f"SELECT id, name, active, sort_order FROM schedule_crew {where} ORDER BY active DESC, sort_order, name", [])
        return {"crew": [{"id": r["id"], "name": r["name"], "active": bool(r["active"]), "sort_order": r.get("sort_order") or 0} for r in rows]}
    finally:
        pass  # shared connection — do not close


class CrewBody(BaseModel):
    name: str


@router.post("/crew")
async def add_crew(body: CrewBody):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    db = await _db()
    try:
        mx = await db._q("SELECT COALESCE(MAX(sort_order), 0) AS m FROM schedule_crew", [])
        order = (mx[0].get("m") or 0) + 1 if mx else 0
        rows = await db._q("INSERT INTO schedule_crew (name, active, sort_order) VALUES (?, 1, ?) RETURNING id", [name, order])
        return {"id": rows[0]["id"], "name": name, "active": True}
    finally:
        pass  # shared connection — do not close


class CrewPatch(BaseModel):
    name:   Optional[str] = None
    active: Optional[bool] = None


@router.delete("/crew/{crew_id}")
async def delete_crew(crew_id: int):
    """Hard-delete a roster entry (for a typo/test). Existing blocks store the
    name as text, so their history is unaffected. Prefer deactivate for real staff."""
    db = await _db()
    try:
        await db._x("DELETE FROM schedule_crew WHERE id = ?", [crew_id])
        return {"ok": True, "id": crew_id}
    finally:
        pass  # shared connection — do not close


@router.put("/crew/{crew_id}")
async def update_crew(crew_id: int, body: CrewPatch):
    sets, params = [], []
    if body.name is not None:   sets.append("name = ?");   params.append(body.name.strip())
    if body.active is not None: sets.append("active = ?"); params.append(1 if body.active else 0)
    if not sets:
        return {"ok": True, "id": crew_id}
    params.append(crew_id)
    db = await _db()
    try:
        await db._x(f"UPDATE schedule_crew SET {', '.join(sets)} WHERE id = ?", params)
        return {"ok": True, "id": crew_id}
    finally:
        pass  # shared connection — do not close


# ── Week view ───────────────────────────────────────────────────────────────────

@router.get("/week")
async def get_week(start: Optional[str] = Query(None), weeks: int = Query(1)):
    try:
        base = _parse(start) if start else date.today()
    except ValueError:
        base = date.today()
    weeks = max(1, min(14, weeks))
    mon = _monday(base)
    days = [(mon + timedelta(days=7 * w + i)).isoformat() for w in range(weeks) for i in range(6)]  # Mon..Sat per week
    wk_set = set(days)
    lower = (mon - timedelta(days=60)).isoformat()
    upper = days[-1]

    db = await _db()
    try:
        await _ensure_crew_seeded(db)
        try:
            crew = await _active_crew(db)
        except Exception as e:
            logger.warning(f"schedule: crew load failed: {e}")
            crew = []

        block_rows = await db._q(
            "SELECT * FROM schedule_blocks WHERE start_date >= ? AND start_date <= ? ORDER BY start_date, id",
            [lower, upper],
        )
        blocks = []
        for r in block_rows:
            b = _shape_block(_row(r))
            if any(d in wk_set for d in b["dates"]):
                blocks.append(b)

        asg_rows = await db._q(
            "SELECT * FROM schedule_assignments WHERE work_date >= ? AND work_date <= ? ORDER BY id",
            [days[0], upper],
        )
        labels = [{
            "id": r["id"], "work_date": r["work_date"], "lead_name": r["lead_name"],
            "job_label": r.get("job_label"), "note": r.get("note"),
        } for r in (_row(x) for x in asg_rows)]

        # Any job that already has a block (anywhere, any week) is "scheduled" and
        # drops out of the unscheduled backlog.
        try:
            sched = await db._q("SELECT DISTINCT opportunity_id FROM schedule_blocks WHERE opportunity_id IS NOT NULL", [])
            scheduled_ids = {r["opportunity_id"] for r in sched}
        except Exception:
            scheduled_ids = set()
    finally:
        pass  # shared connection — do not close

    backlog = [j for j in await _backlog() if j.get("opportunity_id") not in scheduled_ids]
    return {"week_start": mon.isoformat(), "days": days, "crew": crew,
            "blocks": blocks, "labels": labels, "backlog": backlog}


_scope_cache: dict[int, tuple[str, float]] = {}
_SCOPE_TTL = 24 * 3600  # 1 day


@router.get("/job/{opp_id}/scope")
async def job_scope(opp_id: int):
    """Scope for the board popup — the SAME summary shown on the Construction Job
    (Projects) tab, so they match. Cached in-memory for a day so repeat clicks
    are instant and we don't re-summarise on every open."""
    import time as _t
    hit = _scope_cache.get(opp_id)
    if hit and (_t.time() - hit[1]) < _SCOPE_TTL:
        return {"opportunity_id": opp_id, "scope": hit[0], "cached": True}
    scope = ""
    try:
        from app.api.project_checkin import _fetch_scope_notes
        scope = await _fetch_scope_notes(opp_id)
    except Exception as e:
        logger.warning(f"scope fetch failed for {opp_id}: {e}")
    _scope_cache[opp_id] = (scope or "", _t.time())
    return {"opportunity_id": opp_id, "scope": scope or "", "cached": False}


async def _backlog() -> list[dict]:
    try:
        opps = await _aspire.get_construction_opportunities(year=date.today().year)
    except Exception as e:
        logger.warning(f"schedule backlog fetch failed: {e}")
        return []
    out = []
    for o in opps:
        if (o.get("OpportunityStatusName") or "").lower() != "won":
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
    out.sort(key=lambda x: (x["start_date"] or "9999", -(x["hours_est"] or 0)))
    return out


# ── Blocks ──────────────────────────────────────────────────────────────────────

class BlockBody(BaseModel):
    opportunity_id: Optional[int] = None
    job_label:      str
    start_date:     str
    hours:          Optional[float] = None
    hours_per_day:  Optional[float] = DEFAULT_HOURS_PER_DAY
    include_friday: bool = False
    employees:      list[str] = []
    note:           Optional[str] = None
    status:         str = "tentative"


@router.post("/block")
async def create_block(body: BlockBody):
    if not body.job_label or not body.start_date:
        raise HTTPException(400, "job_label and start_date are required")
    status = body.status if body.status in ("tentative", "confirmed") else "tentative"
    db = await _db()
    try:
        rows = await db._q(
            """INSERT INTO schedule_blocks
               (opportunity_id, job_label, start_date, hours, hours_per_day, include_friday, employees, note, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
               RETURNING *""",
            [body.opportunity_id, body.job_label.strip(), body.start_date[:10],
             body.hours, body.hours_per_day or DEFAULT_HOURS_PER_DAY,
             1 if body.include_friday else 0, json.dumps(body.employees or []),
             (body.note or "").strip() or None, status],
        )
        return _shape_block(_row(rows[0]))
    finally:
        pass  # shared connection — do not close


class BlockPatch(BaseModel):
    job_label:      Optional[str] = None
    start_date:     Optional[str] = None
    hours:          Optional[float] = None
    hours_per_day:  Optional[float] = None
    include_friday: Optional[bool] = None
    employees:      Optional[list[str]] = None
    note:           Optional[str] = None
    status:         Optional[str] = None


@router.put("/block/{block_id}")
async def update_block(block_id: int, body: BlockPatch):
    sets, params = ["updated_at = datetime('now')"], []
    if body.job_label is not None:     sets.append("job_label = ?");     params.append(body.job_label.strip())
    if body.start_date is not None:    sets.append("start_date = ?");    params.append(body.start_date[:10])
    if body.hours is not None:         sets.append("hours = ?");         params.append(body.hours)
    if body.hours_per_day is not None: sets.append("hours_per_day = ?"); params.append(body.hours_per_day or DEFAULT_HOURS_PER_DAY)
    if body.include_friday is not None:sets.append("include_friday = ?");params.append(1 if body.include_friday else 0)
    if body.employees is not None:     sets.append("employees = ?");     params.append(json.dumps(body.employees))
    if body.note is not None:          sets.append("note = ?");          params.append((body.note or "").strip() or None)
    if body.status is not None and body.status in ("tentative", "confirmed"):
        sets.append("status = ?"); params.append(body.status)
    params.append(block_id)
    db = await _db()
    try:
        rows = await db._q(f"UPDATE schedule_blocks SET {', '.join(sets)} WHERE id = ? RETURNING *", params)
        if not rows:
            raise HTTPException(404, "Block not found")
        return _shape_block(_row(rows[0]))
    finally:
        pass  # shared connection — do not close


@router.delete("/block/{block_id}")
async def delete_block(block_id: int):
    db = await _db()
    try:
        await db._x("DELETE FROM schedule_blocks WHERE id = ?", [block_id])
        return {"ok": True, "id": block_id}
    finally:
        pass  # shared connection — do not close


# ── Free labels (Away / Shop / Vacation) ──────────────────────────────────────────

class LabelBody(BaseModel):
    work_date: str
    lead_name: str
    job_label: str
    note:      Optional[str] = None


@router.post("/assignment")
async def create_label(body: LabelBody):
    if not body.work_date or not body.lead_name:
        raise HTTPException(400, "work_date and lead_name are required")
    db = await _db()
    try:
        rows = await db._q(
            """INSERT INTO schedule_assignments
               (work_date, lead_name, opportunity_id, job_label, note, sort_order, created_at, updated_at)
               VALUES (?, ?, NULL, ?, ?, 0, datetime('now'), datetime('now'))
               RETURNING id""",
            [body.work_date[:10], body.lead_name, (body.job_label or "").strip(), (body.note or "").strip() or None],
        )
        return {"id": rows[0]["id"]}
    finally:
        pass  # shared connection — do not close


@router.delete("/assignment/{assignment_id}")
async def delete_label(assignment_id: int):
    db = await _db()
    try:
        await db._x("DELETE FROM schedule_assignments WHERE id = ?", [assignment_id])
        return {"ok": True, "id": assignment_id}
    finally:
        pass  # shared connection — do not close
