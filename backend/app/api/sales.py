"""
Sales activity layer — own-D1 CRUD for the sales team.

Scope (locked plan, see memory project-sales-activity-tracking):
  - sales_activities   notes / calls / meetings / emails / SITE VISITS, each anchored on the
                       spine customer_key (so PRE-opportunity leads work), with an optional
                       next_action_date (followup).
  - sales_tasks        LIVING work items spawned from a visit/note (assignee, due, status) —
                       held here (not Aspire) so they can be appended to, carry photos, be
                       marked done, and be surfaced by the agent as a "due" worklist.
  - sales_task_updates append log / progress thread on a task.
  - sales_attachments  pics/videos (R2) on an activity OR a task (shared pattern).

Step 2 = the capture API (create/append/attach/complete). The fan-out (create Aspire
opportunity / task / followup), the Claude tools, and the field form build on these.
"""
import logging
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

from app.core.database import Database
from app.services import r2
from app.api.auth import require_access
from app.api.construction_plan import get_db

router = APIRouter(prefix="/sales", tags=["sales"])
logger = logging.getLogger(__name__)

_TABLES = ("sales_activities", "sales_tasks", "sales_task_updates", "sales_attachments")
_ACTIVITY_TYPES = ("note", "call", "meeting", "email", "site_visit")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _actor(user: dict, provided: Optional[str]) -> Optional[str]:
    """Who to attribute a write to: an explicit value (the agent can pass the salesperson's
    name) wins; else the logged-in user; else None (e.g. service key with nothing supplied)."""
    if provided and provided.strip():
        return provided.strip()
    if user and user.get("email") and user.get("email") != "service":
        return user.get("name") or user.get("email")
    return None


async def _attach_media(db: Database, parent_type: str, rows: list[dict]) -> None:
    """Attach presigned R2 media to each row in place (reads the small table, filters in memory)."""
    if not rows:
        return
    ids = {r["id"] for r in rows}
    by_parent: dict = defaultdict(list)
    try:
        for a in await db._q("SELECT * FROM sales_attachments WHERE parent_type = ?", [parent_type]):
            if a.get("parent_id") in ids:
                url = await r2.get_presigned_url(a["r2_key"], expires_in=6 * 3600)
                by_parent[a["parent_id"]].append({
                    "id": a["id"], "kind": a.get("kind"), "caption": a.get("caption"),
                    "file_name": a.get("file_name"), "url": url,
                })
    except Exception as e:
        logger.warning(f"attach media failed: {e}")
    for r in rows:
        r["attachments"] = by_parent.get(r["id"], [])


@router.get("/status", dependencies=[Depends(require_access)])
async def sales_status(db: Database = Depends(get_db)):
    """Row counts per sales table — confirms the schema exists and is reachable."""
    tables = {}
    for t in _TABLES:
        try:
            r = await db._q(f"SELECT COUNT(*) AS n FROM {t}", [])
            tables[t] = (r[0].get("n") if r else 0) or 0
        except Exception as e:
            tables[t] = f"ERR: {e}"
    return {"ok": all(isinstance(v, int) for v in tables.values()), "tables": tables}


# ── Activities (notes / calls / meetings / emails / site visits) ─────────────────

class ActivityIn(BaseModel):
    customer_key:     Optional[str] = None
    opportunity_id:   Optional[int] = None
    property_id:      Optional[int] = None
    type:             str = "note"
    subject:          Optional[str] = None
    body:             Optional[str] = None
    direction:        Optional[str] = None   # email: 'in' | 'out'
    occurred_at:      Optional[str] = None
    next_action_date: Optional[str] = None
    next_action_note: Optional[str] = None
    created_by:       Optional[str] = None


class ActivityPatch(BaseModel):
    subject:          Optional[str] = None
    body:             Optional[str] = None
    next_action_date: Optional[str] = None
    next_action_note: Optional[str] = None
    next_action_done: Optional[bool] = None


@router.post("/activity")
async def create_activity(body: ActivityIn, user: dict = Depends(require_access), db: Database = Depends(get_db)):
    """Log a sales activity (note/call/meeting/email/site_visit) against a customer."""
    atype = body.type if body.type in _ACTIVITY_TYPES else "note"
    rows = await db._q(
        """INSERT INTO sales_activities
           (customer_key, opportunity_id, property_id, type, subject, body, direction, occurred_at,
            next_action_date, next_action_note, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING *""",
        [body.customer_key, body.opportunity_id, body.property_id, atype, body.subject, body.body,
         body.direction, body.occurred_at or _now(), body.next_action_date, body.next_action_note,
         _actor(user, body.created_by)])
    return {"ok": True, "activity": rows[0] if rows else None}


@router.get("/activities", dependencies=[Depends(require_access)])
async def list_activities(customer_key: Optional[str] = None, opportunity_id: Optional[int] = None,
                          limit: int = 100, db: Database = Depends(get_db)):
    """A customer's (or job's) sales timeline, newest first, with attachments."""
    where, params = [], []
    if customer_key:
        where.append("customer_key = ?"); params.append(customer_key)
    if opportunity_id:
        where.append("opportunity_id = ?"); params.append(opportunity_id)
    sql = "SELECT * FROM sales_activities"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT ?"
    params.append(max(1, min(500, limit)))
    acts = await db._q(sql, params)
    await _attach_media(db, "activity", acts)
    return {"count": len(acts), "activities": acts}


@router.patch("/activity/{activity_id}", dependencies=[Depends(require_access)])
async def patch_activity(activity_id: int, body: ActivityPatch, db: Database = Depends(get_db)):
    """Edit an activity / mark its followup done."""
    sets, params = ["updated_at = datetime('now')"], []
    if body.subject is not None:          sets.append("subject = ?");          params.append(body.subject)
    if body.body is not None:             sets.append("body = ?");             params.append(body.body)
    if body.next_action_date is not None: sets.append("next_action_date = ?"); params.append(body.next_action_date or None)
    if body.next_action_note is not None: sets.append("next_action_note = ?"); params.append(body.next_action_note)
    if body.next_action_done is not None: sets.append("next_action_done = ?"); params.append(1 if body.next_action_done else 0)
    params.append(activity_id)
    rows = await db._q(f"UPDATE sales_activities SET {', '.join(sets)} WHERE id = ? RETURNING *", params)
    if not rows:
        raise HTTPException(status_code=404, detail="Activity not found")
    return {"ok": True, "activity": rows[0]}


# ── Tasks (living work items) ────────────────────────────────────────────────────

class TaskIn(BaseModel):
    customer_key:   Optional[str] = None
    opportunity_id: Optional[int] = None
    activity_id:    Optional[int] = None   # the visit/note that spawned it
    title:          str
    detail:         Optional[str] = None
    assignee:       Optional[str] = None
    due_date:       Optional[str] = None
    priority:       Optional[str] = None
    created_by:     Optional[str] = None


class TaskPatch(BaseModel):
    title:    Optional[str] = None
    detail:   Optional[str] = None
    assignee: Optional[str] = None
    due_date: Optional[str] = None
    priority: Optional[str] = None
    status:   Optional[str] = None   # open | done | cancelled


class TaskUpdateIn(BaseModel):
    body:   str
    author: Optional[str] = None


@router.post("/task")
async def create_task(body: TaskIn, user: dict = Depends(require_access), db: Database = Depends(get_db)):
    """Create a task (standalone or spawned from an activity)."""
    if not (body.title or "").strip():
        raise HTTPException(status_code=400, detail="title is required")
    rows = await db._q(
        """INSERT INTO sales_tasks
           (customer_key, opportunity_id, activity_id, title, detail, assignee, due_date, priority,
            status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, datetime('now')) RETURNING *""",
        [body.customer_key, body.opportunity_id, body.activity_id, body.title.strip(), body.detail,
         body.assignee, body.due_date, body.priority, _actor(user, body.created_by)])
    return {"ok": True, "task": rows[0] if rows else None}


@router.post("/task/{task_id}/update")
async def add_task_update(task_id: int, body: TaskUpdateIn, user: dict = Depends(require_access),
                          db: Database = Depends(get_db)):
    """Append a progress note to a task's thread (the 'living' part)."""
    if not (body.body or "").strip():
        raise HTTPException(status_code=400, detail="body is required")
    if not await db._q("SELECT id FROM sales_tasks WHERE id = ?", [task_id]):
        raise HTTPException(status_code=404, detail="Task not found")
    rows = await db._q(
        "INSERT INTO sales_task_updates (task_id, author, body, created_at) VALUES (?, ?, ?, datetime('now')) RETURNING *",
        [task_id, _actor(user, body.author), body.body.strip()])
    await db._x("UPDATE sales_tasks SET updated_at = datetime('now') WHERE id = ?", [task_id])
    return {"ok": True, "update": rows[0] if rows else None}


@router.patch("/task/{task_id}", dependencies=[Depends(require_access)])
async def patch_task(task_id: int, body: TaskPatch, db: Database = Depends(get_db)):
    """Edit a task / reassign / mark done (sets done_at)."""
    sets, params = ["updated_at = datetime('now')"], []
    if body.title is not None:    sets.append("title = ?");    params.append(body.title)
    if body.detail is not None:   sets.append("detail = ?");   params.append(body.detail)
    if body.assignee is not None: sets.append("assignee = ?"); params.append(body.assignee)
    if body.due_date is not None: sets.append("due_date = ?"); params.append(body.due_date or None)
    if body.priority is not None: sets.append("priority = ?"); params.append(body.priority)
    if body.status is not None and body.status in ("open", "done", "cancelled"):
        sets.append("status = ?");  params.append(body.status)
        sets.append("done_at = ?"); params.append(_now() if body.status == "done" else None)
    params.append(task_id)
    rows = await db._q(f"UPDATE sales_tasks SET {', '.join(sets)} WHERE id = ? RETURNING *", params)
    if not rows:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"ok": True, "task": rows[0]}


@router.get("/tasks", dependencies=[Depends(require_access)])
async def list_tasks(customer_key: Optional[str] = None, assignee: Optional[str] = None,
                     status: Optional[str] = None, due_before: Optional[str] = None,
                     limit: int = 200, db: Database = Depends(get_db)):
    """List tasks with their update threads + attachments. Filter by customer/assignee/status,
    and due_before (YYYY-MM-DD) for the 'due' worklist. Reads whole small tables, filters in memory."""
    rows = await db._q("SELECT * FROM sales_tasks", [])

    def ok(t):
        if customer_key and t.get("customer_key") != customer_key:
            return False
        if assignee and (t.get("assignee") or "").lower() != assignee.lower():
            return False
        if status and t.get("status") != status:
            return False
        if due_before and (t.get("due_date") or "9999-99") > due_before:
            return False
        return True

    out = sorted([t for t in rows if ok(t)], key=lambda t: (t.get("due_date") or "9999-99", t.get("id")))
    out = out[:max(1, min(500, limit))]
    await _attach_media(db, "task", out)
    ids = {t["id"] for t in out}
    threads: dict = defaultdict(list)
    try:
        for u in await db._q("SELECT * FROM sales_task_updates ORDER BY id", []):
            if u["task_id"] in ids:
                threads[u["task_id"]].append(u)
    except Exception:
        pass
    for t in out:
        t["updates"] = threads.get(t["id"], [])
    return {"count": len(out), "tasks": out}


# ── Attachments (photos/videos on an activity or task → R2) ──────────────────────

@router.post("/{parent_type}/{parent_id}/attachment")
async def upload_attachment(parent_type: str, parent_id: int, file: UploadFile = File(...),
                            caption: Optional[str] = Form(None), user: dict = Depends(require_access),
                            db: Database = Depends(get_db)):
    """Attach a photo/video/file to an activity or task (stored in R2)."""
    if parent_type not in ("activity", "task"):
        raise HTTPException(status_code=400, detail="parent_type must be 'activity' or 'task'")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    res = await r2.upload_field_photo(data, file.filename or "upload", _actor(user, None) or "sales",
                                      f"sales-{parent_type}", str(parent_id))
    if not res:
        raise HTTPException(status_code=502, detail="Storage not configured / upload failed")
    key, url = res
    ct = file.content_type or ""
    kind = "photo" if ct.startswith("image") else "video" if ct.startswith("video") else "file"
    rows = await db._q(
        """INSERT INTO sales_attachments
           (parent_type, parent_id, r2_key, file_name, content_type, kind, caption, uploaded_by, uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING *""",
        [parent_type, parent_id, key, file.filename, ct, kind, caption, _actor(user, None)])
    att = rows[0] if rows else {}
    att["url"] = url
    return {"ok": True, "attachment": att}
