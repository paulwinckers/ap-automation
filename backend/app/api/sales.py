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
import json
import logging
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.services import r2
from app.services.aspire import AspireClient
from app.api.auth import require_access, _get_current_user
from app.api.construction_plan import get_db

router = APIRouter(prefix="/sales", tags=["sales"])
logger = logging.getLogger(__name__)
_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

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


def _actor_id(user: dict, provided_id: Optional[int]) -> Optional[int]:
    """The real user id to stamp on a write (directory identity): an explicit id wins (the
    agent/app can name the coworker); else the logged-in user's id; else None (service key)."""
    if provided_id:
        return provided_id
    if user and user.get("id") and user.get("id") != 0 and user.get("email") != "service":
        return user.get("id")
    return None


async def _user_name(db: Database, user_id: Optional[int]) -> Optional[str]:
    """Resolve a user id → display name (for stamping assignee text alongside the id)."""
    if not user_id:
        return None
    rows = await db._q("SELECT name, email FROM users WHERE id = ?", [user_id])
    if not rows:
        return None
    return rows[0].get("name") or rows[0].get("email")


@router.get("/assignees", dependencies=[Depends(require_access)])
async def list_assignees(db: Database = Depends(get_db)):
    """Active users for the assignee / 'due from' picker (any logged-in user can read)."""
    rows = await db._q("SELECT id, name, email FROM users WHERE active = 1 ORDER BY name", [])
    return {"assignees": rows or []}


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
    created_by_user_id: Optional[int] = None   # directory identity (whose followup this is)


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
    owner_id = _actor_id(user, body.created_by_user_id)
    rows = await db._q(
        """INSERT INTO sales_activities
           (customer_key, opportunity_id, property_id, type, subject, body, direction, occurred_at,
            next_action_date, next_action_note, created_by, created_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING *""",
        [body.customer_key, body.opportunity_id, body.property_id, atype, body.subject, body.body,
         body.direction, body.occurred_at or _now(), body.next_action_date, body.next_action_note,
         _actor(user, body.created_by), owner_id])
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
    assignee_user_id: Optional[int] = None   # directory identity (who it's due from)
    due_date:       Optional[str] = None
    priority:       Optional[str] = None
    created_by:     Optional[str] = None


class TaskPatch(BaseModel):
    title:    Optional[str] = None
    detail:   Optional[str] = None
    assignee: Optional[str] = None
    assignee_user_id: Optional[int] = None
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
    # Resolve the assignee: if a real user id is given, stamp both the id and (for display) the name.
    assignee_name = body.assignee
    if body.assignee_user_id and not (assignee_name or "").strip():
        assignee_name = await _user_name(db, body.assignee_user_id)
    rows = await db._q(
        """INSERT INTO sales_tasks
           (customer_key, opportunity_id, activity_id, title, detail, assignee, assignee_user_id,
            due_date, priority, status, created_by, created_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, datetime('now')) RETURNING *""",
        [body.customer_key, body.opportunity_id, body.activity_id, body.title.strip(), body.detail,
         assignee_name, body.assignee_user_id, body.due_date, body.priority,
         _actor(user, body.created_by), _actor_id(user, None)])
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
    if body.assignee_user_id is not None:
        # Reassign by directory identity — stamp the id and refresh the display name to match.
        sets.append("assignee_user_id = ?"); params.append(body.assignee_user_id or None)
        sets.append("assignee = ?");         params.append(await _user_name(db, body.assignee_user_id) or body.assignee)
    elif body.assignee is not None:
        sets.append("assignee = ?"); params.append(body.assignee)
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


# ── Deletes (for corrections / cleanup) ──────────────────────────────────────────

@router.delete("/activity/{activity_id}", dependencies=[Depends(require_access)])
async def delete_activity(activity_id: int, db: Database = Depends(get_db)):
    await db._x("DELETE FROM sales_attachments WHERE parent_type = 'activity' AND parent_id = ?", [activity_id])
    await db._x("DELETE FROM sales_activities WHERE id = ?", [activity_id])
    return {"ok": True, "deleted": activity_id}


@router.delete("/task/{task_id}", dependencies=[Depends(require_access)])
async def delete_task(task_id: int, db: Database = Depends(get_db)):
    await db._x("DELETE FROM sales_task_updates WHERE task_id = ?", [task_id])
    await db._x("DELETE FROM sales_attachments WHERE parent_type = 'task' AND parent_id = ?", [task_id])
    await db._x("DELETE FROM sales_tasks WHERE id = ?", [task_id])
    return {"ok": True, "deleted": task_id}


# ── Unified "due" worklist (open tasks + pending followups) ──────────────────────

def _due_bucket(due_date: Optional[str], today: str) -> str:
    """Classify an item's due date relative to today (YYYY-MM-DD strings sort lexically)."""
    if not due_date:
        return "someday"
    d = due_date[:10]
    if d < today:
        return "overdue"
    if d == today:
        return "today"
    # within the next 7 days → 'week', else 'later'
    try:
        from datetime import date, timedelta
        t = date.fromisoformat(today)
        if date.fromisoformat(d) <= t + timedelta(days=7):
            return "week"
    except ValueError:
        pass
    return "later"


async def _collect_due(db: Database, *, assignee_user_id: Optional[int] = None,
                       name: Optional[str] = None, due_before: Optional[str] = None) -> list[dict]:
    """Build the merged worklist (open tasks + un-done followups). Matching:
      - by assignee_user_id (directory identity) when given, OR
      - by name (legacy rows where assignee / created_by is just a name), OR
      - everything when neither is given.
    When both an id and a name are given, a row matches if EITHER matches (so legacy
    name-only rows still surface for the right person)."""
    n_l = name.lower() if name else None
    today = datetime.now(timezone.utc).date().isoformat()

    def person_match(row_id, row_name) -> bool:
        if assignee_user_id is None and n_l is None:
            return True
        if assignee_user_id is not None and row_id == assignee_user_id:
            return True
        if n_l is not None and (row_name or "").lower() == n_l:
            return True
        return False

    items: list[dict] = []
    for t in await db._q("SELECT * FROM sales_tasks WHERE status = 'open'", []):
        if not person_match(t.get("assignee_user_id"), t.get("assignee")):
            continue
        if due_before and (t.get("due_date") or "9999-99-99") > due_before:
            continue
        items.append({"kind": "task", "id": t["id"], "title": t.get("title"),
                      "detail": t.get("detail"), "customer_key": t.get("customer_key"),
                      "who": t.get("assignee"), "who_user_id": t.get("assignee_user_id"),
                      "due_date": t.get("due_date"), "opportunity_id": t.get("opportunity_id"),
                      "bucket": _due_bucket(t.get("due_date"), today)})
    for a in await db._q(
            "SELECT * FROM sales_activities WHERE next_action_done = 0 AND next_action_date IS NOT NULL", []):
        if not person_match(a.get("created_by_user_id"), a.get("created_by")):
            continue
        if due_before and (a.get("next_action_date") or "9999-99-99") > due_before:
            continue
        items.append({"kind": "followup", "id": a["id"],
                      "title": a.get("next_action_note") or (a.get("body") or "")[:60],
                      "customer_key": a.get("customer_key"), "who": a.get("created_by"),
                      "who_user_id": a.get("created_by_user_id"),
                      "due_date": a.get("next_action_date"), "activity_type": a.get("type"),
                      "bucket": _due_bucket(a.get("next_action_date"), today)})
    items.sort(key=lambda x: (x.get("due_date") or "9999-99-99"))
    return items


@router.get("/due", dependencies=[Depends(require_access)])
async def due_items(assignee: Optional[str] = None, assignee_user_id: Optional[int] = None,
                    due_before: Optional[str] = None, db: Database = Depends(get_db)):
    """What needs doing: open tasks + activities with an un-done followup, merged and sorted
    by date. Filter by `assignee_user_id` (directory identity — preferred) or `assignee`
    (legacy name), and `due_before` (YYYY-MM-DD). This is what the agent prompts from and what
    pairs with the CX action-review for a single morning worklist (e.g. "what's due for Dave")."""
    items = await _collect_due(db, assignee_user_id=assignee_user_id, name=assignee, due_before=due_before)
    return {"count": len(items), "items": items}


@router.get("/due/mine")
async def my_due_items(user: dict = Depends(_get_current_user), db: Database = Depends(get_db)):
    """The logged-in user's personal worklist — their open tasks + pending followups, matched by
    their user id AND their name (so legacy name-only rows still appear). Items carry a `bucket`
    (overdue/today/week/later/someday) for grouping. This is the 'My Action Items' surface."""
    items = await _collect_due(db, assignee_user_id=user.get("id"),
                               name=user.get("name") or user.get("email"))
    for it in items:
        it["source"] = it["kind"] == "task" and "sales_task" or "sales_followup"
    counts: dict = {}
    for it in items:
        counts[it["bucket"]] = counts.get(it["bucket"], 0) + 1
    return {"user": {"id": user.get("id"), "name": user.get("name"), "email": user.get("email")},
            "count": len(items), "counts": counts, "items": items}


_SEV_BUCKET = {"overdue": "overdue", "due": "today", "soon": "week"}
_BUCKET_ORDER = {"overdue": 0, "today": 1, "week": 2, "later": 3, "someday": 4}


@router.get("/worklist/mine")
async def my_worklist(user: dict = Depends(_get_current_user), db: Database = Depends(get_db)):
    """ONE morning worklist for the logged-in user: their sales tasks + pending followups
    (source sales_task / sales_followup) PLUS the CX client-comms due that they OWN — scoped by
    the comms template's role→person map in CX settings (scheduler→Keeland, supervisor→Dustin,
    designer→Jenna, …). Comms for a role with no configured person, and non-comms actions, are
    'unassigned' and surface to admins so nothing falls through. Everything is bucketed
    (overdue/today/week/later/someday) and merged into a single sorted list."""
    me_email = (user.get("email") or "").strip().lower()
    me_name  = (user.get("name") or "").strip().lower()
    is_admin = (user.get("role") == "admin")

    # 1) Sales side (reuse the identity-linked collector)
    items = await _collect_due(db, assignee_user_id=user.get("id"),
                               name=user.get("name") or user.get("email"))
    for it in items:
        it["source"] = "sales_task" if it["kind"] == "task" else "sales_followup"

    # 2) CX comms side — only the actions this user owns (by role), admins also get unassigned
    try:
        from app.api.cx import enriched_due_actions
        from app.api.cx import _db as _cx_db
        cx_actions = await enriched_due_actions(await _cx_db())
    except Exception as e:
        logger.warning(f"worklist: CX actions unavailable: {e}")
        cx_actions = []

    for a in cx_actions:
        owner_email = (a.get("owner_email") or "").strip().lower()
        owner_name  = (a.get("owner_name") or "").strip().lower()
        mine = (me_email and owner_email == me_email) or (me_name and owner_name == me_name)
        unassigned = not owner_email and not owner_name
        if not (mine or (unassigned and is_admin)):
            continue
        items.append({
            "kind": "cx", "source": "cx_comms",
            "id": f"{a.get('opportunity_id')}:{a.get('action_key')}",
            "opportunity_id": a.get("opportunity_id"),
            "action_key": a.get("action_key"),
            "template_key": a.get("template_key"),
            "title": a.get("label"),
            "job": a.get("property_name") or a.get("opportunity_name"),
            "customer_key": None, "due_date": None,
            "severity": a.get("severity"),
            "bucket": _SEV_BUCKET.get(a.get("severity"), "week"),
            "who": a.get("owner_name"), "last_sent": a.get("last_sent"),
            "unassigned": unassigned,
        })

    # 3) Prep checklist items assigned to this user (open only) — individually assignable prep tasks
    today = datetime.now(timezone.utc).date().isoformat()
    try:
        from app.api.construction_plan import PREP_ITEMS
        prep_label = {it["key"]: it["label"] for it in PREP_ITEMS}
        prep_rows = await db._q(
            "SELECT opportunity_id, item_key, checked, status, due_date, assignee_user_id, assignee "
            "FROM job_prep_checklist", [])
    except Exception as e:
        logger.warning(f"worklist: prep items unavailable: {e}")
        prep_rows, prep_label = [], {}

    mine_prep = []
    for r in prep_rows:
        status = (r.get("status") or "").lower()
        if not status and r.get("checked"):
            status = "complete"
        if status in ("complete", "uploaded", "na"):
            continue
        aid = r.get("assignee_user_id"); aname = (r.get("assignee") or "").strip().lower()
        if (aid and aid == user.get("id")) or (me_name and aname == me_name):
            mine_prep.append(r)

    # Resolve job names for the assigned items from the spine cache (small IN query, chunked).
    name_by_opp: dict = {}
    opp_ids = list({r["opportunity_id"] for r in mine_prep})
    for i in range(0, len(opp_ids), 90):
        chunk = opp_ids[i:i + 90]
        ph = ",".join("?" for _ in chunk)
        try:
            for jr in await db._q(f"SELECT opportunity_id, payload FROM spine_jobs WHERE opportunity_id IN ({ph})", chunk):
                try:
                    p = json.loads(jr.get("payload") or "{}")
                    name_by_opp[jr["opportunity_id"]] = p.get("property_name") or p.get("opportunity_name")
                except Exception:
                    pass
        except Exception:
            pass

    for r in mine_prep:
        opp = r["opportunity_id"]
        items.append({
            "kind": "prep", "source": "prep",
            "id": f"{opp}:{r['item_key']}", "opportunity_id": opp, "item_key": r["item_key"],
            "title": prep_label.get(r["item_key"], r["item_key"]),
            "job": name_by_opp.get(opp) or f"Job #{opp}",
            "customer_key": None, "due_date": r.get("due_date"),
            "bucket": _due_bucket(r.get("due_date"), today),
            "who": r.get("assignee"),
        })

    items.sort(key=lambda x: (_BUCKET_ORDER.get(x.get("bucket"), 9), x.get("due_date") or "9999-99-99"))
    counts: dict = {}
    sources: dict = {}
    for it in items:
        counts[it["bucket"]] = counts.get(it["bucket"], 0) + 1
        sources[it["source"]] = sources.get(it["source"], 0) + 1
    return {"user": {"id": user.get("id"), "name": user.get("name"), "email": user.get("email"),
                     "is_admin": is_admin},
            "count": len(items), "counts": counts, "sources": sources, "items": items}


# ── Fan-out: create an Aspire opportunity from a site visit (GATED — prod write) ──

class OppIn(BaseModel):
    opportunity_name: str
    opportunity_type: str               # Aspire-required (e.g. 'Project'); confirm valid values on first use
    property_id:   Optional[int] = None
    division_id:   Optional[int] = None
    sales_rep_id:  Optional[int] = None
    start_date:    Optional[str] = None
    activity_id:   Optional[int] = None  # link the created opp back to the site-visit activity
    confirmed:     bool = False
    extra:         Optional[dict] = None  # passthrough for other Aspire Opportunity fields


@router.post("/opportunity")
async def create_opportunity(body: OppIn, user: dict = Depends(require_access), db: Database = Depends(get_db)):
    """Create a real Aspire Opportunity (header) from a site visit. IRREVERSIBLE — Aspire has
    no opportunity delete via API — so it only runs with confirmed=true (set after the user
    approves the details). Estimate lines stay read-only; the visit's notes/photos are the
    estimator's brief. Links the new opportunity_id back onto the activity."""
    if not body.confirmed:
        return {"ok": False, "error": "Not created. This makes a permanent Aspire opportunity — set confirmed=true only after the user approves name/type/property/division."}
    payload = {"OpportunityName": body.opportunity_name, "OpportunityType": body.opportunity_type}
    if body.property_id:  payload["PropertyID"] = body.property_id
    if body.division_id:  payload["DivisionID"] = body.division_id
    if body.sales_rep_id: payload["SalesRepID"] = body.sales_rep_id
    if body.start_date:   payload["StartDate"] = body.start_date
    if body.extra:        payload.update(body.extra)
    try:
        res = await _aspire.create_opportunity(payload)
    except Exception as e:
        logger.error(f"Aspire opportunity create failed: {e}")
        raise HTTPException(status_code=502, detail=f"Aspire opportunity create failed: {e}")
    opp_id = res.get("OpportunityID") if isinstance(res, dict) else None
    if body.activity_id and opp_id:
        await db._x("UPDATE sales_activities SET opportunity_id = ?, updated_at = datetime('now') WHERE id = ?",
                    [opp_id, body.activity_id])
    return {"ok": True, "opportunity_id": opp_id, "aspire_response": res}
