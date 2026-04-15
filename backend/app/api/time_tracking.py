"""
Time Tracking API — crew clock-in/out and segment tracking.

GET  /time/crew-members                    — active employees with PIN (cached 10 min)
GET  /time/session?employee_id=X&work_date=YYYY-MM-DD
POST /time/clock-in
POST /time/clock-out
POST /time/segment/start
PATCH /time/segment/{segment_id}/end
GET  /time/work-tickets?work_date=YYYY-MM-DD
GET  /time/drive-ticket
POST /time/drive-ticket
POST /time/submit/{session_id}
"""

import logging
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.database import Database
from app.core.config import settings
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/time", tags=["time-tracking"])

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

# ── Shared DB instance ────────────────────────────────────────────────────────
_db = Database()


async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


# ── Crew-member cache (10 min) ────────────────────────────────────────────────
_crew_cache: list[dict] = []
_crew_cache_ts: float = 0.0
_CREW_TTL = 600  # 10 minutes


async def _get_crew_members() -> list[dict]:
    global _crew_cache, _crew_cache_ts
    if _crew_cache and (time.time() - _crew_cache_ts) < _CREW_TTL:
        return _crew_cache
    members = await _aspire.get_crew_members_with_pin()
    _crew_cache = members
    _crew_cache_ts = time.time()
    return _crew_cache


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    """Return current UTC time as ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


def _duration_minutes(start_iso: str, end_iso: str) -> int:
    """Compute elapsed minutes between two ISO-8601 strings."""
    try:
        fmt = "%Y-%m-%dT%H:%M:%S.%f%z"
        def _parse(s: str) -> datetime:
            # Handle both with and without microseconds, with and without Z suffix
            s = s.replace("Z", "+00:00")
            for f in (
                "%Y-%m-%dT%H:%M:%S.%f%z",
                "%Y-%m-%dT%H:%M:%S%z",
                "%Y-%m-%dT%H:%M:%S.%f",
                "%Y-%m-%dT%H:%M:%S",
            ):
                try:
                    return datetime.strptime(s, f)
                except ValueError:
                    continue
            return datetime.fromisoformat(s)
        start_dt = _parse(start_iso)
        end_dt   = _parse(end_iso)
        diff = (end_dt - start_dt).total_seconds()
        return max(0, int(diff // 60))
    except Exception as e:
        logger.warning(f"_duration_minutes failed ({start_iso!r}, {end_iso!r}): {e}")
        return 0


# ── Pydantic models ───────────────────────────────────────────────────────────

class ClockInBody(BaseModel):
    employee_id:   int
    employee_name: str
    work_date:     str  # YYYY-MM-DD


class ClockOutBody(BaseModel):
    session_id: int


class SegmentStartBody(BaseModel):
    session_id:       int
    segment_type:     str   # 'onsite' | 'drive' | 'lunch'
    work_ticket_id:   Optional[int]  = None
    work_ticket_num:  Optional[str]  = None
    work_ticket_name: Optional[str]  = None


class DriveTicketBody(BaseModel):
    ticket_id:   int
    ticket_num:  str
    ticket_name: str
    month:       str  # YYYY-MM


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/crew-members")
async def get_crew_members():
    """Return active employees with EmployeePin — cached 10 min."""
    try:
        members = await _get_crew_members()
        return {"crew_members": members}
    except Exception as e:
        logger.error(f"get_crew_members failed: {e}", exc_info=True)
        raise HTTPException(status_code=502, detail=f"Failed to fetch crew members: {e}")


@router.get("/session")
async def get_session(
    employee_id: int = Query(...),
    work_date:   str = Query(...),
    db: Database = Depends(get_db),
):
    """Get session + segments for an employee on a given date."""
    session = await db.get_time_session_for_day(employee_id, work_date)
    if not session:
        return {"session": None, "segments": []}
    segments = await db.get_time_segments(session["id"])
    return {"session": dict(session), "segments": [dict(s) for s in segments]}


@router.post("/clock-in")
async def clock_in(body: ClockInBody, db: Database = Depends(get_db)):
    """
    Create or resume a session for the day.
    - No session yet → create fresh one.
    - Session exists, not clocked out → return it as-is.
    - Session exists, clocked out → clear clock_out so they can continue.
    """
    existing = await db.get_time_session_for_day(body.employee_id, body.work_date)
    if existing:
        if existing.get("clock_out"):
            # Re-open: clear clock_out so they can keep working
            await db.update_time_session(existing["id"], {"clock_out": None})
            existing = await db.get_time_session(existing["id"])
        segments = await db.get_time_segments(existing["id"])
        return {
            "session":  dict(existing),
            "segments": [dict(s) for s in segments],
            "created":  False,
        }

    session_id = await db.create_time_session(
        work_date=body.work_date,
        employee_id=body.employee_id,
        employee_name=body.employee_name,
    )
    session = await db.get_time_session(session_id)
    return {"session": dict(session), "segments": [], "created": True}


@router.post("/clock-out")
async def clock_out(body: ClockOutBody, db: Database = Depends(get_db)):
    """Set clock_out = now and end any open segment."""
    session = await db.get_time_session(body.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    now = _now_iso()

    # End any open segment first
    open_seg = await db.get_open_segment(body.session_id)
    if open_seg:
        dur = _duration_minutes(open_seg["start_time"], now)
        await db.end_time_segment(open_seg["id"], now, dur)

    # Set clock_out
    await db.update_time_session(body.session_id, {"clock_out": now})

    session = await db.get_time_session(body.session_id)
    segments = await db.get_time_segments(body.session_id)
    return {"session": dict(session), "segments": [dict(s) for s in segments]}


@router.post("/segment/start")
async def start_segment(body: SegmentStartBody, db: Database = Depends(get_db)):
    """
    End the current open segment (if any), then start a new one.
    Atomic from the caller's perspective.
    """
    session = await db.get_time_session(body.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if body.segment_type not in ("onsite", "drive", "lunch"):
        raise HTTPException(status_code=422, detail="segment_type must be onsite, drive, or lunch")

    now = _now_iso()

    # End current open segment
    open_seg = await db.get_open_segment(body.session_id)
    if open_seg:
        dur = _duration_minutes(open_seg["start_time"], now)
        await db.end_time_segment(open_seg["id"], now, dur)

    # Start new segment
    seg_id = await db.create_time_segment(
        session_id=body.session_id,
        segment_type=body.segment_type,
        work_ticket_id=body.work_ticket_id,
        work_ticket_num=body.work_ticket_num,
        work_ticket_name=body.work_ticket_name,
        start_time=now,
    )

    segments = await db.get_time_segments(body.session_id)
    return {
        "new_segment_id": seg_id,
        "segments": [dict(s) for s in segments],
    }


@router.patch("/segment/{segment_id}/end")
async def end_segment(segment_id: int, db: Database = Depends(get_db)):
    """Manually end a specific segment."""
    rows = await db._q("SELECT * FROM time_segments WHERE id = ?", [segment_id])
    if not rows:
        raise HTTPException(status_code=404, detail="Segment not found")
    seg = rows[0]
    if seg.get("end_time"):
        return {"segment": dict(seg), "already_ended": True}

    now = _now_iso()
    dur = _duration_minutes(seg["start_time"], now)
    await db.end_time_segment(segment_id, now, dur)

    rows = await db._q("SELECT * FROM time_segments WHERE id = ?", [segment_id])
    return {"segment": dict(rows[0]), "already_ended": False}


@router.get("/work-tickets")
async def get_work_tickets(work_date: str = Query(...)):
    """Fetch today's scheduled work tickets from Aspire (for ticket picker)."""
    try:
        tickets = await _aspire.get_scheduled_work_tickets(
            date_range="today", specific_date=work_date
        )
        return {"work_tickets": tickets, "work_date": work_date}
    except Exception as e:
        logger.error(f"get_work_tickets failed: {e}", exc_info=True)
        raise HTTPException(status_code=502, detail=f"Failed to fetch work tickets: {e}")


@router.get("/work-tickets/search")
async def search_work_tickets(q: str = Query(default="")):
    """
    Search work tickets by keyword (ticket # or opportunity name).
    Wide date window (±3 months) so monthly recurring tickets are always found.
    """
    try:
        tickets = await _aspire.search_work_tickets(query=q)
        return {"work_tickets": tickets}
    except Exception as e:
        logger.error(f"search_work_tickets failed: {e}", exc_info=True)
        raise HTTPException(status_code=502, detail=f"Failed to search work tickets: {e}")


@router.get("/drive-ticket")
async def get_drive_ticket(db: Database = Depends(get_db)):
    """Get the current monthly drive ticket from settings."""
    ticket_id   = await db.get_setting("drive_ticket_id")
    ticket_num  = await db.get_setting("drive_ticket_num")
    ticket_name = await db.get_setting("drive_ticket_name")
    ticket_month = await db.get_setting("drive_ticket_month")
    return {
        "ticket_id":    int(ticket_id) if ticket_id else None,
        "ticket_num":   ticket_num,
        "ticket_name":  ticket_name,
        "ticket_month": ticket_month,
    }


@router.post("/drive-ticket")
async def save_drive_ticket(body: DriveTicketBody, db: Database = Depends(get_db)):
    """Save the monthly drive ticket to settings."""
    await db.set_setting("drive_ticket_id",    str(body.ticket_id))
    await db.set_setting("drive_ticket_num",   body.ticket_num)
    await db.set_setting("drive_ticket_name",  body.ticket_name)
    await db.set_setting("drive_ticket_month", body.month)
    return {"ok": True}


@router.post("/submit/{session_id}")
async def submit_session(session_id: int, db: Database = Depends(get_db)):
    """
    Submit a completed session to Aspire:
    1. POST each onsite/drive segment to /WorkTicketTimes
    2. POST the overall clock record to /ClockTimes
    3. Mark session status = 'submitted'
    """
    session = await db.get_time_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.get("status") == "submitted":
        return {"ok": True, "already_submitted": True}

    if not session.get("clock_out"):
        raise HTTPException(
            status_code=422, detail="Cannot submit — employee has not clocked out yet"
        )

    segments = await db.get_time_segments(session_id)
    contact_id  = session["employee_id"]
    work_date   = session["work_date"]
    errors: list[str] = []
    wtt_ids: list[str] = []

    # ── Step 1: POST work ticket time entries ─────────────────────────────────
    for seg in segments:
        if seg.get("segment_type") not in ("onsite", "drive"):
            continue
        if not seg.get("end_time"):
            logger.warning(f"Skipping open segment {seg['id']} — no end_time")
            continue
        wt_id = seg.get("work_ticket_id")
        if not wt_id:
            logger.warning(f"Segment {seg['id']} has no work_ticket_id — skipping WorkTicketTimes POST")
            continue
        try:
            result = await _aspire.post_work_ticket_time(
                work_ticket_id=int(wt_id),
                contact_id=contact_id,
                start_time=seg["start_time"],
                end_time=seg["end_time"],
            )
            wtt_id = (
                result.get("WorkTicketTimeID")
                or result.get("Id")
                or result.get("id")
                or ""
            )
            wtt_ids.append(str(wtt_id))
            # Store aspire_wtt_id back on the segment row
            await db._x(
                "UPDATE time_segments SET aspire_wtt_id = ? WHERE id = ?",
                [str(wtt_id), seg["id"]],
            )
            logger.info(f"WorkTicketTime posted — wtt_id={wtt_id} for segment {seg['id']}")
        except Exception as e:
            msg = f"WorkTicketTimes POST failed for segment {seg['id']}: {e}"
            logger.error(msg)
            errors.append(msg)

    # ── Step 2: POST clock-in/out record ──────────────────────────────────────
    clock_id = None
    try:
        result = await _aspire.post_clock_time(
            contact_id=contact_id,
            date=work_date,
            clock_in_time=session["clock_in"],
            clock_out_time=session["clock_out"],
            break_time=session.get("break_minutes") or 0,
        )
        clock_id = (
            result.get("ClockTimeID")
            or result.get("Id")
            or result.get("id")
            or ""
        )
        logger.info(f"ClockTime posted — clock_id={clock_id} for session {session_id}")
    except Exception as e:
        msg = f"ClockTimes POST failed for session {session_id}: {e}"
        logger.error(msg)
        errors.append(msg)

    # ── Step 3: Mark status ───────────────────────────────────────────────────
    if errors:
        await db.update_time_session(session_id, {"status": "error"})
        raise HTTPException(
            status_code=502,
            detail=f"Submission partially failed ({len(errors)} error(s)): {'; '.join(errors)}",
        )

    await db.update_time_session(session_id, {
        "status":         "submitted",
        "submitted_at":   _now_iso(),
        "aspire_clock_id": str(clock_id) if clock_id else None,
    })

    return {
        "ok":          True,
        "clock_id":    clock_id,
        "wtt_ids":     wtt_ids,
        "session_id":  session_id,
    }
