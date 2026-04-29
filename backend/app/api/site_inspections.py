"""
Site Safety Inspections API

POST   /safety/inspections              — submit a new inspection (multipart)
GET    /safety/inspections              — list inspections (admin)
GET    /safety/inspections/{id}         — full inspection detail
GET    /safety/inspections/action-items/open — all open action items (admin dashboard)
PATCH  /safety/inspections/action-items/{item_id} — resolve an action item
"""
import asyncio
import json
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.core.database import Database
from app.services import r2

router = APIRouter(prefix="/safety/inspections", tags=["site-inspections"])
logger = logging.getLogger(__name__)

MAX_PHOTO_SIZE = 20 * 1024 * 1024  # 20 MB


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _get_db() -> Database:
    db = Database()
    await db.connect()
    return db


def _row(r) -> dict:
    return dict(r) if r else {}


# ── Submit inspection ──────────────────────────────────────────────────────────

@router.post("")
async def submit_inspection(
    inspection_date: str           = Form(...),
    site_name:       str           = Form(...),
    inspector_name:  str           = Form(...),
    crew_present:    str           = Form(default="[]"),    # JSON array
    overall_result:  str           = Form(default="pass"),  # pass|conditional|fail
    notes:           Optional[str] = Form(default=None),
    checklist_json:  str           = Form(default="[]"),    # JSON array of checklist items
    actions_json:    str           = Form(default="[]"),    # JSON array of action items
    photo:           Optional[UploadFile] = File(default=None),
):
    """Submit a completed site inspection."""
    # Parse JSON fields
    try:
        checklist = json.loads(checklist_json)
        actions   = json.loads(actions_json)
        crew      = json.loads(crew_present) if crew_present else []
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"Invalid JSON in form data: {e}")

    if overall_result not in ("pass", "conditional", "fail"):
        raise HTTPException(400, "overall_result must be pass, conditional, or fail")

    # Upload photo to R2 if provided
    photo_r2_key = None
    if photo and photo.filename:
        photo_bytes = await photo.read()
        if len(photo_bytes) > MAX_PHOTO_SIZE:
            raise HTTPException(413, "Photo too large — maximum 20 MB")
        if photo_bytes:
            uid = uuid.uuid4().hex[:8]
            safe = "".join(c if c.isalnum() or c in (".", "-", "_") else "_" for c in (photo.filename or "photo.jpg"))
            photo_r2_key = f"inspections/{uid}_{safe}"
            content_type = photo.content_type or "image/jpeg"

            if r2._r2_available():
                def _upload():
                    client = r2._make_client()
                    client.put_object(
                        Bucket=r2.settings.R2_BUCKET_NAME,
                        Key=photo_r2_key,
                        Body=photo_bytes,
                        ContentType=content_type,
                    )
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(None, _upload)
                logger.info("Inspection photo uploaded: %s", photo_r2_key)

    # Insert main record
    db = await _get_db()
    try:
        rows = await db._q(
            """INSERT INTO site_inspections
               (inspection_date, site_name, inspector_name, crew_present,
                overall_result, notes, photo_r2_key)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               RETURNING id""",
            [
                inspection_date, site_name.strip(), inspector_name.strip(),
                json.dumps(crew), overall_result,
                (notes or "").strip() or None,
                photo_r2_key,
            ],
        )
        inspection_id = rows[0]["id"]

        # Insert checklist items
        for item in checklist:
            await db._x(
                """INSERT INTO inspection_checklist
                   (inspection_id, category, item, result, notes)
                   VALUES (?, ?, ?, ?, ?)""",
                [
                    inspection_id,
                    item.get("category", ""),
                    item.get("item", ""),
                    item.get("result", "na"),
                    item.get("notes") or None,
                ],
            )

        # Insert action items
        for action in actions:
            desc = (action.get("description") or "").strip()
            if not desc:
                continue
            await db._x(
                """INSERT INTO inspection_action_items
                   (inspection_id, description, assigned_to, due_date)
                   VALUES (?, ?, ?, ?)""",
                [
                    inspection_id,
                    desc,
                    (action.get("assigned_to") or "").strip() or None,
                    action.get("due_date") or None,
                ],
            )

    finally:
        await db.close()

    logger.info("Inspection #%s submitted for %s by %s (result: %s)",
                inspection_id, site_name, inspector_name, overall_result)
    return {"id": inspection_id, "status": "submitted"}


# ── List inspections ───────────────────────────────────────────────────────────

@router.get("")
async def list_inspections(
    start_date: Optional[str] = None,
    end_date:   Optional[str] = None,
    site_name:  Optional[str] = None,
    result:     Optional[str] = None,
    limit:      int = 100,
):
    """List inspections for the admin panel."""
    db = await _get_db()
    try:
        where  = ["1=1"]
        params = []
        if start_date:
            where.append("i.inspection_date >= ?")
            params.append(start_date)
        if end_date:
            where.append("i.inspection_date <= ?")
            params.append(end_date)
        if site_name:
            where.append("lower(i.site_name) LIKE ?")
            params.append(f"%{site_name.lower()}%")
        if result:
            where.append("i.overall_result = ?")
            params.append(result)

        params.append(limit)
        rows = await db._q(
            f"""SELECT i.id, i.inspection_date, i.site_name, i.inspector_name,
                       i.overall_result, i.notes, i.created_at,
                       i.crew_present,
                       COUNT(DISTINCT c.id) AS checklist_count,
                       SUM(CASE WHEN c.result = 'fail' THEN 1 ELSE 0 END) AS fail_count,
                       COUNT(DISTINCT a.id) AS action_count,
                       SUM(CASE WHEN a.status = 'open' THEN 1 ELSE 0 END) AS open_actions
                FROM site_inspections i
                LEFT JOIN inspection_checklist c ON c.inspection_id = i.id
                LEFT JOIN inspection_action_items a ON a.inspection_id = i.id
                WHERE {' AND '.join(where)}
                GROUP BY i.id
                ORDER BY i.inspection_date DESC, i.id DESC
                LIMIT ?""",
            params,
        )
        return {"inspections": [_row(r) for r in rows]}
    finally:
        await db.close()


# ── Open action items (dashboard) ──────────────────────────────────────────────

@router.get("/action-items/open")
async def list_open_action_items():
    """Return all open action items across all inspections."""
    db = await _get_db()
    try:
        rows = await db._q(
            """SELECT a.id, a.inspection_id, a.description, a.assigned_to,
                      a.due_date, a.status, a.created_at,
                      i.site_name, i.inspection_date
               FROM inspection_action_items a
               JOIN site_inspections i ON i.id = a.inspection_id
               WHERE a.status = 'open'
               ORDER BY a.due_date ASC NULLS LAST, a.created_at ASC""",
            [],
        )
        return {"action_items": [_row(r) for r in rows]}
    finally:
        await db.close()


# ── Inspection detail ──────────────────────────────────────────────────────────

@router.get("/{inspection_id}")
async def get_inspection(inspection_id: int):
    """Return full inspection detail including checklist and action items."""
    db = await _get_db()
    try:
        rows = await db._q(
            "SELECT * FROM site_inspections WHERE id = ?", [inspection_id]
        )
        if not rows:
            raise HTTPException(404, "Inspection not found")
        inspection = _row(rows[0])
        # parse crew JSON
        try:
            inspection["crew_present"] = json.loads(inspection.get("crew_present") or "[]")
        except Exception:
            inspection["crew_present"] = []

        checklist = await db._q(
            "SELECT * FROM inspection_checklist WHERE inspection_id = ? ORDER BY id",
            [inspection_id],
        )
        actions = await db._q(
            "SELECT * FROM inspection_action_items WHERE inspection_id = ? ORDER BY id",
            [inspection_id],
        )

        inspection["checklist"]     = [_row(r) for r in checklist]
        inspection["action_items"]  = [_row(r) for r in actions]
        return inspection
    finally:
        await db.close()


# ── Resolve action item ────────────────────────────────────────────────────────

class ResolveBody(BaseModel):
    resolved_notes: Optional[str] = None


@router.patch("/action-items/{item_id}/resolve")
async def resolve_action_item(item_id: int, body: ResolveBody):
    """Mark an action item as resolved."""
    db = await _get_db()
    try:
        await db._x(
            """UPDATE inspection_action_items
               SET status = 'resolved',
                   resolved_notes = ?,
                   resolved_at = datetime('now')
               WHERE id = ?""",
            [body.resolved_notes or None, item_id],
        )
        return {"id": item_id, "status": "resolved"}
    finally:
        await db.close()


@router.patch("/action-items/{item_id}/reopen")
async def reopen_action_item(item_id: int):
    """Reopen a resolved action item."""
    db = await _get_db()
    try:
        await db._x(
            """UPDATE inspection_action_items
               SET status = 'open', resolved_notes = NULL, resolved_at = NULL
               WHERE id = ?""",
            [item_id],
        )
        return {"id": item_id, "status": "open"}
    finally:
        await db.close()
