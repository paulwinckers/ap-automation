"""
JHSC Safety Meetings API — meeting log (agenda / minutes), incident review items,
action items, and posting finished minutes to the field app.

Admin (require_access):
  POST   /safety/meetings                  — create a meeting (draft)
  GET    /safety/meetings                  — list meetings
  GET    /safety/meetings/open-incidents   — unresolved incidents to pull into review
  GET    /safety/meetings/{id}             — meeting + its items
  PUT    /safety/meetings/{id}             — update meeting header/agenda/minutes
  DELETE /safety/meetings/{id}             — delete a draft meeting (+ its items)
  POST   /safety/meetings/{id}/items       — add an item (topic | incident | action)
  PUT    /safety/meetings/items/{item_id}  — update an item (ties linked incident status)
  DELETE /safety/meetings/items/{item_id}  — remove an item
  POST   /safety/meetings/{id}/post        — publish minutes to the field app
  POST   /safety/meetings/{id}/unpost      — pull minutes back to draft

Public (field app):
  GET    /safety/meetings/field            — posted meetings, newest first
  GET    /safety/meetings/field/{id}       — one posted meeting + its items
"""
import asyncio
import logging
import re
from typing import Optional

import anthropic as _anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.auth import require_access
from app.core.config import settings
from app.core.database import Database

router = APIRouter(prefix="/safety/meetings", tags=["safety-meetings"])
logger = logging.getLogger(__name__)

MEETING_TYPES = ("monthly", "quarterly", "special")
MEETING_STATUSES = ("draft", "posted")
ITEM_TYPES = ("topic", "incident", "action")
ITEM_STATUSES = ("open", "in_progress", "done")


async def _get_db() -> Database:
    db = Database()
    await db.connect()
    return db


def _row(r) -> dict:
    return dict(r) if r else {}


def _bool(v) -> int:
    return 1 if str(v).strip().lower() in ("1", "true", "yes", "y", "on") else 0 if v is not None else 0


def _strip_html(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html or "")).strip()


_REC_SYSTEM = (
    "You advise a Joint Health & Safety Committee (JHSC) at a British Columbia landscaping "
    "company as it reviews a workplace incident during a safety meeting. Recommend, concisely, "
    "what change to the company's EXISTING safety program would best help prevent a recurrence.\n"
    "Rules:\n"
    "- Ground every recommendation ONLY in the provided Safety Library. Reference the specific "
    "document by its code (e.g. SWP-13, SAF-001) in square brackets at the very start.\n"
    "- If an existing procedure already covers the activity, recommend the specific addition or "
    "wording change to make to THAT document.\n"
    "- If no procedure covers the hazard, say so and recommend creating a new SWP, naming what it "
    "must require.\n"
    "- Do NOT invent regulations, statistics, or document codes that are not in the library.\n"
    "- Write 2–4 sentences, specific and actionable, suitable to paste into the meeting minutes. "
    "This is a recommendation for the committee to review and decide on — not a final policy."
)


async def _safety_library_text(db: Database) -> str:
    rows = await db._q(
        "SELECT code, title, category, layer, summary, plain_text, html "
        "FROM safety_documents ORDER BY layer, sort_order, id"
    )
    parts = []
    for r in rows:
        d = _row(r)
        body = (d.get("plain_text") or "").strip() or _strip_html(d.get("html") or "")
        tag = d.get("code") or (d.get("category") or "DOC").upper()
        parts.append(
            f"[{tag}] {d.get('title')} (layer {d.get('layer')}, {d.get('category')})\n"
            f"Summary: {d.get('summary') or '—'}\n"
            f"Excerpt: {body[:700]}"
        )
    return "\n\n".join(parts)


def _incident_brief(inc: dict) -> str:
    return (
        f"Date: {inc.get('incident_date')}  Type: {inc.get('incident_type')}  "
        f"Severity: {inc.get('severity')}\n"
        f"Location: {inc.get('location') or '—'}\n"
        f"What happened: {inc.get('description') or '—'}\n"
        f"Injury: {inc.get('injury_description') or '—'}\n"
        f"Immediate action taken: {inc.get('immediate_action') or '—'}\n"
        f"Contributing factors: {inc.get('contributing_factors') or '—'}"
    )


async def _ask_recommendation(inc: dict, library: str) -> str:
    """Ask Claude for a grounded policy/SWP recommendation for one incident. Returns text
    (or raises). Best-effort — callers handle failures."""
    if not getattr(settings, "ANTHROPIC_API_KEY", None):
        raise RuntimeError("AI recommendations are not configured (no ANTHROPIC_API_KEY)")
    client = _anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
    user = (
        f"INCIDENT UNDER REVIEW:\n{_incident_brief(inc)}\n\n"
        f"SAFETY LIBRARY (the company's current OH&S program — recommend changes grounded only "
        f"in these):\n{library}"
    )
    resp = await client.messages.create(
        model="claude-opus-4-5",
        max_tokens=600,
        system=_REC_SYSTEM,
        messages=[{"role": "user", "content": user}],
    )
    return (resp.content[0].text or "").strip()


# ── Models ──────────────────────────────────────────────────────────────────────

class MeetingIn(BaseModel):
    meeting_date: str
    meeting_time: Optional[str] = None
    location: Optional[str] = None
    meeting_type: str = "monthly"
    chair: Optional[str] = None
    attendees: Optional[str] = None
    quorum_met: Optional[bool] = False
    agenda: Optional[str] = None
    minutes: Optional[str] = None
    next_meeting: Optional[str] = None
    updated_by: Optional[str] = None


class ItemIn(BaseModel):
    item_type: str = "topic"
    incident_id: Optional[int] = None
    title: Optional[str] = None
    discussion: Optional[str] = None
    corrective_action: Optional[str] = None
    recommendation: Optional[str] = None
    assignee: Optional[str] = None
    due_date: Optional[str] = None
    status: str = "open"
    sort_order: Optional[int] = 0


class PostBody(BaseModel):
    posted_by: Optional[str] = None


# ── Create / list ─────────────────────────────────────────────────────────────

@router.post("", dependencies=[Depends(require_access)])
async def create_meeting(body: MeetingIn):
    if not (body.meeting_date or "").strip():
        raise HTTPException(400, "A meeting date is required")
    mtype = body.meeting_type if body.meeting_type in MEETING_TYPES else "monthly"
    db = await _get_db()
    try:
        rows = await db._q(
            """INSERT INTO safety_meetings
               (meeting_date, meeting_time, location, meeting_type, chair, attendees,
                quorum_met, agenda, minutes, next_meeting, status, updated_by, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, datetime('now'))
               RETURNING id""",
            [
                body.meeting_date.strip(), (body.meeting_time or "").strip() or None,
                (body.location or "").strip() or None, mtype,
                (body.chair or "").strip() or None, (body.attendees or "").strip() or None,
                _bool(body.quorum_met), (body.agenda or "").strip() or None,
                (body.minutes or "").strip() or None, (body.next_meeting or "").strip() or None,
                (body.updated_by or "").strip() or None,
            ],
        )
        return {"id": rows[0]["id"], "status": "draft"}
    finally:
        await db.close()


@router.get("", dependencies=[Depends(require_access)])
async def list_meetings(status: Optional[str] = None, limit: int = 100):
    db = await _get_db()
    try:
        where, params = ["1=1"], []
        if status in MEETING_STATUSES:
            where.append("status = ?"); params.append(status)
        params.append(limit)
        rows = await db._q(
            f"""SELECT m.*,
                   (SELECT COUNT(*) FROM safety_meeting_items i WHERE i.meeting_id = m.id) AS item_count,
                   (SELECT COUNT(*) FROM safety_meeting_items i
                      WHERE i.meeting_id = m.id AND i.item_type = 'action' AND i.status != 'done') AS open_actions
                FROM safety_meetings m
                WHERE {' AND '.join(where)}
                ORDER BY m.meeting_date DESC, m.id DESC
                LIMIT ?""",
            params,
        )
        return {"meetings": [_row(r) for r in rows]}
    finally:
        await db.close()


# ── Open incidents to review ──────────────────────────────────────────────────

@router.get("/open-incidents", dependencies=[Depends(require_access)])
async def open_incidents():
    """Unresolved incidents (status != closed) available to pull into a meeting for review."""
    db = await _get_db()
    try:
        rows = await db._q(
            """SELECT id, incident_date, reporter_name, location, incident_type,
                      severity, description, status
               FROM safety_incidents
               WHERE status != 'closed'
               ORDER BY
                 CASE severity WHEN 'critical' THEN 0 WHEN 'serious' THEN 1
                               WHEN 'moderate' THEN 2 ELSE 3 END,
                 incident_date DESC, id DESC""",
        )
        return {"incidents": [_row(r) for r in rows]}
    finally:
        await db.close()


# ── Bulk load + AI recommendations ────────────────────────────────────────────

async def _unlinked_open_incidents(db: Database, meeting_id: int) -> list[dict]:
    linked = {
        _row(r).get("incident_id")
        for r in await db._q(
            "SELECT incident_id FROM safety_meeting_items "
            "WHERE meeting_id = ? AND item_type = 'incident' AND incident_id IS NOT NULL",
            [meeting_id],
        )
    }
    rows = await db._q(
        """SELECT * FROM safety_incidents WHERE status != 'closed'
           ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'serious' THEN 1
                                  WHEN 'moderate' THEN 2 ELSE 3 END,
                    incident_date DESC, id DESC"""
    )
    return [_row(r) for r in rows if _row(r).get("id") not in linked]


@router.post("/{meeting_id}/load-incidents", dependencies=[Depends(require_access)])
async def load_incidents(meeting_id: int, recommend: bool = True):
    """Bulk-pull every unresolved incident (not already on this meeting) in as a review item.
    When recommend=true (default), also generate a grounded policy/SWP recommendation for each,
    cross-referencing the incident against the company's safety library."""
    db = await _get_db()
    try:
        if not await db._q("SELECT id FROM safety_meetings WHERE id = ?", [meeting_id]):
            raise HTTPException(404, "Meeting not found")
        pending = await _unlinked_open_incidents(db, meeting_id)
        created: list[tuple[int, dict]] = []
        for inc in pending:
            rows = await db._q(
                """INSERT INTO safety_meeting_items
                   (meeting_id, item_type, incident_id, title, status, sort_order)
                   VALUES (?, 'incident', ?, ?, 'open', 0)
                   RETURNING id""",
                [meeting_id, inc["id"], f"{inc.get('incident_type') or 'Incident'} — {inc.get('location') or 'Field'}"],
            )
            created.append((rows[0]["id"], inc))

        recs = 0
        errors = 0
        if recommend and created:
            try:
                library = await _safety_library_text(db)
                results = await asyncio.gather(
                    *[_ask_recommendation(inc, library) for _id, inc in created],
                    return_exceptions=True,
                )
                for (item_id, _inc), res in zip(created, results):
                    if isinstance(res, str) and res:
                        await db._x("UPDATE safety_meeting_items SET recommendation = ? WHERE id = ?", [res, item_id])
                        recs += 1
                    else:
                        errors += 1
                        logger.warning("Recommendation failed for item %s: %s", item_id, res)
            except Exception as e:
                logger.error("Bulk recommendation step failed: %s", e)
                errors = len(created)
        return {"added": len(created), "recommendations": recs, "recommendation_errors": errors}
    finally:
        await db.close()


@router.post("/{meeting_id}/recommend-all", dependencies=[Depends(require_access)])
async def recommend_all(meeting_id: int, overwrite: bool = False):
    """Generate a policy/SWP recommendation for every incident-review item on the meeting.
    By default only fills items that don't have one yet; overwrite=true regenerates all."""
    db = await _get_db()
    try:
        where_rec = "" if overwrite else "AND (recommendation IS NULL OR recommendation = '')"
        items = await db._q(
            f"""SELECT id, incident_id FROM safety_meeting_items
                WHERE meeting_id = ? AND item_type = 'incident' AND incident_id IS NOT NULL {where_rec}""",
            [meeting_id],
        )
        if not items:
            return {"recommendations": 0, "recommendation_errors": 0}
        library = await _safety_library_text(db)
        incs = {}
        for it in items:
            irow = await db._q("SELECT * FROM safety_incidents WHERE id = ?", [_row(it)["incident_id"]])
            if irow:
                incs[_row(it)["id"]] = _row(irow[0])
        pairs = [(iid, inc) for iid, inc in incs.items()]
        results = await asyncio.gather(*[_ask_recommendation(inc, library) for _iid, inc in pairs], return_exceptions=True)
        recs = errors = 0
        for (item_id, _inc), res in zip(pairs, results):
            if isinstance(res, str) and res:
                await db._x("UPDATE safety_meeting_items SET recommendation = ? WHERE id = ?", [res, item_id])
                recs += 1
            else:
                errors += 1
        return {"recommendations": recs, "recommendation_errors": errors}
    finally:
        await db.close()


@router.post("/items/{item_id}/recommend", dependencies=[Depends(require_access)])
async def recommend_item(item_id: int):
    """(Re)generate the grounded policy/SWP recommendation for one incident-review item."""
    db = await _get_db()
    try:
        rows = await db._q("SELECT * FROM safety_meeting_items WHERE id = ?", [item_id])
        if not rows:
            raise HTTPException(404, "Item not found")
        item = _row(rows[0])
        if not item.get("incident_id"):
            raise HTTPException(400, "Recommendations are generated from a linked incident")
        inc_rows = await db._q("SELECT * FROM safety_incidents WHERE id = ?", [item["incident_id"]])
        if not inc_rows:
            raise HTTPException(404, "Linked incident not found")
        library = await _safety_library_text(db)
        try:
            rec = await _ask_recommendation(_row(inc_rows[0]), library)
        except Exception as e:
            raise HTTPException(503, f"Could not generate a recommendation: {e}")
        await db._x("UPDATE safety_meeting_items SET recommendation = ? WHERE id = ?", [rec, item_id])
        return {"id": item_id, "recommendation": rec}
    finally:
        await db.close()


# ── Public (field app) ────────────────────────────────────────────────────────
# NOTE: these literal /field routes are declared BEFORE the /{meeting_id} routes so
# FastAPI matches them first (an int path param does not stop "field" from matching).

@router.get("/field")
async def field_meetings(limit: int = 24):
    """Posted meeting minutes for the field app, newest first."""
    db = await _get_db()
    try:
        rows = await db._q(
            """SELECT id, meeting_date, meeting_type, location, chair, attendees,
                      minutes, next_meeting, posted_at
               FROM safety_meetings
               WHERE status = 'posted'
               ORDER BY meeting_date DESC, id DESC
               LIMIT ?""",
            [limit],
        )
        return {"meetings": [_row(r) for r in rows]}
    finally:
        await db.close()


@router.get("/field/{meeting_id}")
async def field_meeting_detail(meeting_id: int):
    """One posted meeting with its action items (for the field reading view)."""
    db = await _get_db()
    try:
        mrows = await db._q(
            "SELECT * FROM safety_meetings WHERE id = ? AND status = 'posted'", [meeting_id]
        )
        if not mrows:
            raise HTTPException(404, "Meeting not found")
        meeting = _row(mrows[0])
        irows = await db._q(
            """SELECT item_type, title, discussion, corrective_action, assignee, due_date, status
               FROM safety_meeting_items
               WHERE meeting_id = ?
               ORDER BY sort_order ASC, id ASC""",
            [meeting_id],
        )
        meeting["items"] = [_row(r) for r in irows]
        return meeting
    finally:
        await db.close()


# ── Detail (admin) ────────────────────────────────────────────────────────────

async def _meeting_with_items(db: Database, meeting_id: int) -> dict:
    mrows = await db._q("SELECT * FROM safety_meetings WHERE id = ?", [meeting_id])
    if not mrows:
        raise HTTPException(404, "Meeting not found")
    meeting = _row(mrows[0])
    irows = await db._q(
        """SELECT i.*,
                  s.incident_date AS inc_date, s.severity AS inc_severity,
                  s.incident_type AS inc_type, s.location AS inc_location,
                  s.description AS inc_description, s.status AS inc_status,
                  s.reporter_name AS inc_reporter
           FROM safety_meeting_items i
           LEFT JOIN safety_incidents s ON s.id = i.incident_id
           WHERE i.meeting_id = ?
           ORDER BY i.sort_order ASC, i.id ASC""",
        [meeting_id],
    )
    meeting["items"] = [_row(r) for r in irows]
    return meeting


@router.get("/{meeting_id}", dependencies=[Depends(require_access)])
async def get_meeting(meeting_id: int):
    db = await _get_db()
    try:
        return await _meeting_with_items(db, meeting_id)
    finally:
        await db.close()


@router.put("/{meeting_id}", dependencies=[Depends(require_access)])
async def update_meeting(meeting_id: int, body: MeetingIn):
    mtype = body.meeting_type if body.meeting_type in MEETING_TYPES else "monthly"
    db = await _get_db()
    try:
        exists = await db._q("SELECT id FROM safety_meetings WHERE id = ?", [meeting_id])
        if not exists:
            raise HTTPException(404, "Meeting not found")
        await db._x(
            """UPDATE safety_meetings SET
                 meeting_date = ?, meeting_time = ?, location = ?, meeting_type = ?,
                 chair = ?, attendees = ?, quorum_met = ?, agenda = ?, minutes = ?,
                 next_meeting = ?, updated_by = ?, updated_at = datetime('now')
               WHERE id = ?""",
            [
                body.meeting_date.strip(), (body.meeting_time or "").strip() or None,
                (body.location or "").strip() or None, mtype,
                (body.chair or "").strip() or None, (body.attendees or "").strip() or None,
                _bool(body.quorum_met), (body.agenda or "").strip() or None,
                (body.minutes or "").strip() or None, (body.next_meeting or "").strip() or None,
                (body.updated_by or "").strip() or None, meeting_id,
            ],
        )
        return await _meeting_with_items(db, meeting_id)
    finally:
        await db.close()


@router.delete("/{meeting_id}", dependencies=[Depends(require_access)])
async def delete_meeting(meeting_id: int):
    db = await _get_db()
    try:
        await db._x("DELETE FROM safety_meeting_items WHERE meeting_id = ?", [meeting_id])
        await db._x("DELETE FROM safety_meetings WHERE id = ?", [meeting_id])
        return {"id": meeting_id, "deleted": True}
    finally:
        await db.close()


# ── Items ─────────────────────────────────────────────────────────────────────

@router.post("/{meeting_id}/items", dependencies=[Depends(require_access)])
async def add_item(meeting_id: int, body: ItemIn):
    itype = body.item_type if body.item_type in ITEM_TYPES else "topic"
    istatus = body.status if body.status in ITEM_STATUSES else "open"
    db = await _get_db()
    try:
        exists = await db._q("SELECT id FROM safety_meetings WHERE id = ?", [meeting_id])
        if not exists:
            raise HTTPException(404, "Meeting not found")
        rows = await db._q(
            """INSERT INTO safety_meeting_items
               (meeting_id, item_type, incident_id, title, discussion, corrective_action,
                assignee, due_date, status, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING id""",
            [
                meeting_id, itype, body.incident_id,
                (body.title or "").strip() or None, (body.discussion or "").strip() or None,
                (body.corrective_action or "").strip() or None, (body.assignee or "").strip() or None,
                (body.due_date or "").strip() or None, istatus, body.sort_order or 0,
            ],
        )
        return {"id": rows[0]["id"]}
    finally:
        await db.close()


@router.put("/items/{item_id}", dependencies=[Depends(require_access)])
async def update_item(item_id: int, body: ItemIn):
    itype = body.item_type if body.item_type in ITEM_TYPES else "topic"
    istatus = body.status if body.status in ITEM_STATUSES else "open"
    db = await _get_db()
    try:
        cur = await db._q("SELECT * FROM safety_meeting_items WHERE id = ?", [item_id])
        if not cur:
            raise HTTPException(404, "Item not found")
        await db._x(
            """UPDATE safety_meeting_items SET
                 item_type = ?, incident_id = ?, title = ?, discussion = ?,
                 corrective_action = ?, recommendation = ?, assignee = ?, due_date = ?,
                 status = ?, sort_order = ?
               WHERE id = ?""",
            [
                itype, body.incident_id, (body.title or "").strip() or None,
                (body.discussion or "").strip() or None, (body.corrective_action or "").strip() or None,
                (body.recommendation or "").strip() or None,
                (body.assignee or "").strip() or None, (body.due_date or "").strip() or None,
                istatus, body.sort_order or 0, item_id,
            ],
        )
        # Incident tie-in: resolving an incident-review item flips the incident's own status.
        # in_progress → reviewed, done → closed. Never re-opens a closed incident silently.
        inc_id = body.incident_id or _row(cur[0]).get("incident_id")
        if itype == "incident" and inc_id:
            new_inc = None
            if istatus == "done":
                new_inc = "closed"
            elif istatus == "in_progress":
                new_inc = "reviewed"
            if new_inc:
                try:
                    await db._x(
                        "UPDATE safety_incidents SET status = ?, reviewed_at = datetime('now') WHERE id = ?",
                        [new_inc, inc_id],
                    )
                except Exception as e:
                    logger.warning("Meeting item %s: incident %s status tie-in failed: %s", item_id, inc_id, e)
        return {"id": item_id, "status": istatus}
    finally:
        await db.close()


@router.delete("/items/{item_id}", dependencies=[Depends(require_access)])
async def delete_item(item_id: int):
    db = await _get_db()
    try:
        await db._x("DELETE FROM safety_meeting_items WHERE id = ?", [item_id])
        return {"id": item_id, "deleted": True}
    finally:
        await db.close()


# ── Post / unpost to field app ────────────────────────────────────────────────

@router.post("/{meeting_id}/post", dependencies=[Depends(require_access)])
async def post_meeting(meeting_id: int, body: PostBody):
    """Publish the minutes to the field app (status → posted)."""
    db = await _get_db()
    try:
        rows = await db._q("SELECT id, minutes FROM safety_meetings WHERE id = ?", [meeting_id])
        if not rows:
            raise HTTPException(404, "Meeting not found")
        if not (_row(rows[0]).get("minutes") or "").strip():
            raise HTTPException(400, "Add minutes before posting to the field app")
        await db._x(
            """UPDATE safety_meetings
               SET status = 'posted', posted_at = datetime('now'), posted_by = ?,
                   updated_at = datetime('now')
               WHERE id = ?""",
            [(body.posted_by or "").strip() or None, meeting_id],
        )
        return {"id": meeting_id, "status": "posted"}
    finally:
        await db.close()


@router.post("/{meeting_id}/unpost", dependencies=[Depends(require_access)])
async def unpost_meeting(meeting_id: int):
    db = await _get_db()
    try:
        await db._x(
            "UPDATE safety_meetings SET status = 'draft', posted_at = NULL, updated_at = datetime('now') WHERE id = ?",
            [meeting_id],
        )
        return {"id": meeting_id, "status": "draft"}
    finally:
        await db.close()
