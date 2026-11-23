"""
Training courses — progress for signed-in people, and a report of who finished what.

  GET  /training/progress                              the signed-in person's progress on every course
  POST /training/courses/{course_id}/modules/{module_id}/complete
                                                       mark one module done (idempotent); the course is
                                                       stamped complete when its last module is done
  GET  /training/report                                HR: everyone with the Training area, an assignment
                                                       or any progress
  GET  /training/assign/people                         HR: active people who can be assigned courses
  POST /training/assign                                HR: assign courses to people {course_ids, user_ids, due_date?}
  DELETE /training/assign/{course_id}/{user_id}        HR: remove one assignment

Course content lives in the frontend (src/lib/training/). The server only knows each course's module
ids, so it can tell when a course is finished and refuse ids that don't exist. Add a course here and
in the frontend together.
"""
import html
import logging
import re
from datetime import date
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from app.api.auth import current_actor, get_db, require_access
from app.core.database import Database

router = APIRouter(prefix="/training", tags=["training"])
logger = logging.getLogger(__name__)

# course id → its module ids, in order. Keep in step with frontend src/lib/training/.
COURSES: dict[str, dict] = {
    "difficult-customers": {
        "title": "Handling Difficult Customers",
        "modules": ["why", "brain", "last", "empathy", "neighbours", "deescalate", "escalate", "walkaway", "practice"],
    },
    # Winter safety — one course per winter SWP (frontend src/lib/training/winterSafety.ts)
    "winter-swp20-driving": {
        "title": "Winter: Driving & Storm Call-Out (SWP-20)",
        "modules": ["ready", "conditions", "stranded"],
    },
    "winter-swp16-sidewalks": {
        "title": "Winter: Sidewalk Snow & Ice (SWP-16)",
        "modules": ["plan", "blower", "shovel", "cold"],
    },
    "winter-swp18-plow-trucks": {
        "title": "Winter: Snow Plowing with Trucks (SWP-18)",
        "modules": ["pretrip", "plowing", "backing", "fatigue"],
    },
    "winter-swp19-skid-steer": {
        "title": "Winter: Skid-Steer / Bobcat Snow Clearing (SWP-19)",
        "modules": ["pretrip", "zone", "stability", "attach"],
    },
    "winter-swp17-brine": {
        "title": "Winter: Liquid Brine Application (SWP-17)",
        "modules": ["when", "mix", "drive", "pressure"],
    },
}


def _course(course_id: str) -> dict:
    c = COURSES.get(course_id)
    if not c:
        raise HTTPException(status_code=404, detail="Course not found")
    return c


def _person_id(actor: dict) -> int:
    uid = actor.get("id")
    if not isinstance(uid, int) or uid <= 0:
        raise HTTPException(status_code=400, detail="Sign in as a person to save course progress")
    return uid


@router.get("/progress")
async def my_progress(actor: dict = Depends(current_actor), db: Database = Depends(get_db)):
    uid = _person_id(actor)
    rows = await db._q(
        "SELECT course_id, module_id, completed_at FROM training_progress WHERE user_id = ?", [uid])
    done = await db._q(
        "SELECT course_id, completed_at FROM training_completions WHERE user_id = ?", [uid])
    assigned = await db._q(
        "SELECT course_id, due_date, assigned_at FROM training_assignments WHERE user_id = ?", [uid])
    finished = {r["course_id"]: r["completed_at"] for r in done}
    asg = {r["course_id"]: r for r in assigned}
    out = {cid: {"done": [], "finished_at": finished.get(cid), "assigned": cid in asg,
                 "due_date": asg[cid]["due_date"] if cid in asg else None} for cid in COURSES}
    for r in rows:
        if r["course_id"] in out:
            out[r["course_id"]]["done"].append(r["module_id"])
    return {"courses": out}


@router.post("/courses/{course_id}/modules/{module_id}/complete")
async def complete_module(course_id: str, module_id: str,
                          actor: dict = Depends(current_actor), db: Database = Depends(get_db)):
    uid = _person_id(actor)
    course = _course(course_id)
    if module_id not in course["modules"]:
        raise HTTPException(status_code=404, detail="Module not found")
    await db._x(
        "INSERT OR IGNORE INTO training_progress (user_id, course_id, module_id) VALUES (?,?,?)",
        [uid, course_id, module_id])
    rows = await db._q(
        "SELECT module_id FROM training_progress WHERE user_id = ? AND course_id = ?", [uid, course_id])
    done = {r["module_id"] for r in rows}
    finished_at = None
    if all(m in done for m in course["modules"]):
        await db._x(
            "INSERT OR IGNORE INTO training_completions (user_id, course_id) VALUES (?,?)", [uid, course_id])
        fin = await db._q(
            "SELECT completed_at FROM training_completions WHERE user_id = ? AND course_id = ?", [uid, course_id])
        finished_at = fin[0]["completed_at"] if fin else None
    asg = await db._q(
        "SELECT due_date FROM training_assignments WHERE user_id = ? AND course_id = ?", [uid, course_id])
    return {"done": [m for m in course["modules"] if m in done], "finished_at": finished_at,
            "assigned": bool(asg), "due_date": asg[0]["due_date"] if asg else None}


@router.get("/report")
async def training_report(_actor: dict = Depends(require_access), db: Database = Depends(get_db)):
    """Everyone who should take the courses (Training area or an assignment) or has started one,
    with their progress and whether each course is assigned to them (and by when)."""
    users = await db._q("SELECT id, name, email, role, areas, active FROM users WHERE active = 1")
    progress = await db._q(
        "SELECT user_id, course_id, COUNT(*) n, MAX(completed_at) last_at FROM training_progress "
        "GROUP BY user_id, course_id")
    completions = await db._q("SELECT user_id, course_id, completed_at FROM training_completions")
    assignments = await db._q("SELECT user_id, course_id, due_date, assigned_at FROM training_assignments")
    prog = {(r["user_id"], r["course_id"]): r for r in progress}
    fin = {(r["user_id"], r["course_id"]): r["completed_at"] for r in completions}
    asg = {(r["user_id"], r["course_id"]): r for r in assignments}
    started = {r["user_id"] for r in progress} | {r["user_id"] for r in assignments}

    people = []
    for u in users:
        areas = {a.strip() for a in (u.get("areas") or "").split(",") if a.strip()}
        if u["role"] == "service" or ("training" not in areas and u["id"] not in started):
            continue
        courses = {}
        for cid, c in COURSES.items():
            p = prog.get((u["id"], cid))
            courses[cid] = {
                "done": p["n"] if p else 0,
                "total": len(c["modules"]),
                "last_at": p["last_at"] if p else None,
                "finished_at": fin.get((u["id"], cid)),
                "assigned": (u["id"], cid) in asg,
                "due_date": asg[(u["id"], cid)]["due_date"] if (u["id"], cid) in asg else None,
            }
        people.append({"user_id": u["id"], "name": u["name"], "email": u["email"],
                       "training_only": areas == {"training"}, "courses": courses})
    people.sort(key=lambda p: (p["name"] or "").lower())
    return {"courses": [{"id": cid, "title": c["title"], "modules": len(c["modules"])}
                        for cid, c in COURSES.items()],
            "people": people}


# ── Assignments (HR) ────────────────────────────────────────────────────────────────────────────

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class AssignIn(BaseModel):
    course_ids: list[str]
    user_ids: list[int]
    due_date: Optional[str] = None   # YYYY-MM-DD, or empty for no due date
    notify: bool = True              # push + email each person about their NEWLY assigned courses


def _portal_base() -> str:
    from app.core.config import settings
    return (getattr(settings, "PORTAL_BASE_URL", "") or "https://darios-ap.pages.dev").rstrip("/")


def _nice_due(due: Optional[str]) -> str:
    if not due:
        return ""
    try:
        d = date.fromisoformat(due)
        return f"{d.strftime('%B')} {d.day}"
    except ValueError:
        return due


def _assign_email(name: str, courses: list[str], due: Optional[str], by: str, link: str) -> str:
    e = html.escape
    items = "".join(f'<li style="margin:0 0 6px">{e(t)}</li>' for t in courses)
    due_line = f'<p style="margin:0 0 12px"><b>Please finish by {e(_nice_due(due))}.</b></p>' if due else ""
    first = e((name or "there").split()[0])
    which = "this course" if len(courses) == 1 else "these courses"
    return f"""<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px">
  <div style="background:#1f4d2b;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0">
    <div style="font-size:17px;font-weight:800">New training assigned to you</div>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:16px 18px;color:#111827;font-size:15px;line-height:1.5">
    <p style="margin:0 0 12px">Hi {first},</p>
    <p style="margin:0 0 8px">{e(by)} assigned you {which}:</p>
    <ul style="margin:0 0 12px;padding-left:20px">{items}</ul>
    {due_line}
    <p style="margin:0 0 16px">Each one is short, with videos and quick checks, and works on your phone. Your progress saves as you go.</p>
    <p style="margin:0 0 4px"><a href="{e(link)}" style="display:inline-block;background:#1f4d2b;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px">Open my courses</a></p>
    <p style="margin:12px 0 0;font-size:13px;color:#6b7280">Sign in with your usual Darios portal login.</p>
  </div>
</div>"""


async def _notify_assigned(new_by_user: dict, due: Optional[str], by: str) -> None:
    """Push + email each person once, listing the courses NEWLY assigned to them. Runs after the
    response (BackgroundTasks) and never raises: a failed push or email is logged, not surfaced."""
    if not new_by_user:
        return
    from app.core.config import settings
    from app.core.database import Database
    from app.api.push import push_to_user
    link = f"{_portal_base()}/training"
    db = Database()
    await db.connect()
    try:
        ids = list(new_by_user)
        rows = await db._q(
            f"SELECT id, name, email FROM users WHERE active = 1 AND id IN ({','.join('?' * len(ids))})", ids)
    except Exception as ex:
        logger.warning(f"training notify: user lookup failed: {ex}")
        rows = []
    finally:
        await db.close()
    graph = None
    sender = getattr(settings, "ms_send_from", "") or ""
    for u in rows:
        titles = [COURSES[c]["title"] for c in new_by_user.get(u["id"], []) if c in COURSES]
        if not titles:
            continue
        n = len(titles)
        due_txt = f" · due {_nice_due(due)}" if due else ""
        push_body = (titles[0] if n == 1 else f"{n} courses, starting with {titles[0]}") + due_txt
        try:
            await push_to_user(u["id"], "New training assigned", push_body, "/training")
        except Exception as ex:
            logger.warning(f"training notify: push to user {u['id']} failed: {ex}")
        email = (u.get("email") or "").strip()
        if "@" in email and sender:
            try:
                if graph is None:
                    from app.services.email_intake import GraphClient
                    graph = GraphClient()
                await graph.send_email(
                    mailbox=sender, to_addresses=[email],
                    subject=("New training: " + titles[0]) if n == 1 else f"New training: {n} courses assigned to you",
                    body_html=_assign_email(u.get("name") or "", titles, due, by, link))
            except Exception as ex:
                logger.warning(f"training notify: email to user {u['id']} failed: {ex}")


@router.get("/assign/people")
async def assignable_people(_actor: dict = Depends(require_access), db: Database = Depends(get_db)):
    """Active people (not service accounts) HR can assign courses to."""
    users = await db._q("SELECT id, name, email, role, areas FROM users WHERE active = 1")
    people = [{"user_id": u["id"], "name": u["name"], "email": u["email"],
               "training_only": {a.strip() for a in (u.get("areas") or "").split(",") if a.strip()} == {"training"}}
              for u in users if u["role"] != "service"]
    people.sort(key=lambda p: (p["name"] or "").lower())
    return {"people": people}


@router.post("/assign")
async def assign_courses(body: AssignIn, background: BackgroundTasks = None,
                         actor: dict = Depends(require_access), db: Database = Depends(get_db)):
    """Assign each course to each person. Re-assigning updates the due date; progress is untouched.
    With notify (default), each person gets ONE push + email about the courses that are NEW to them
    (re-assigning an existing course, e.g. to change its due date, doesn't notify again)."""
    if not body.course_ids or not body.user_ids:
        raise HTTPException(status_code=400, detail="Pick at least one course and one person")
    for cid in body.course_ids:
        _course(cid)
    due = (body.due_date or "").strip() or None
    if due and not _DATE.match(due):
        raise HTTPException(status_code=400, detail="Due date must be YYYY-MM-DD")
    ids = sorted(set(body.user_ids))
    marks = ",".join("?" * len(ids))
    found = await db._q(f"SELECT id FROM users WHERE active = 1 AND id IN ({marks})", ids)
    missing = set(ids) - {r["id"] for r in found}
    if missing:
        raise HTTPException(status_code=400, detail=f"Unknown or inactive people: {sorted(missing)}")
    by = actor.get("name") or actor.get("email") or "HR"
    course_ids = list(dict.fromkeys(body.course_ids))
    cmarks = ",".join("?" * len(course_ids))
    existing = await db._q(
        f"SELECT user_id, course_id FROM training_assignments WHERE user_id IN ({marks}) AND course_id IN ({cmarks})",
        ids + course_ids)
    had = {(r["user_id"], r["course_id"]) for r in existing}
    new_by_user: dict = {}
    n = 0
    for uid in ids:
        for cid in course_ids:
            if (uid, cid) not in had:
                new_by_user.setdefault(uid, []).append(cid)
            await db._x(
                "INSERT INTO training_assignments (user_id, course_id, due_date, assigned_by) VALUES (?,?,?,?) "
                "ON CONFLICT(user_id, course_id) DO UPDATE SET due_date = excluded.due_date, "
                "assigned_by = excluded.assigned_by",
                [uid, cid, due, by])
            n += 1
    to_notify = new_by_user if body.notify else {}
    if to_notify:
        if background is not None:
            background.add_task(_notify_assigned, to_notify, due, by)
        else:
            await _notify_assigned(to_notify, due, by)
    return {"assigned": n, "new": sum(len(v) for v in new_by_user.values()), "notified": len(to_notify)}


@router.delete("/assign/{course_id}/{user_id}")
async def unassign_course(course_id: str, user_id: int,
                          _actor: dict = Depends(require_access), db: Database = Depends(get_db)):
    """Remove one assignment. The person's progress on the course is kept."""
    await db._x("DELETE FROM training_assignments WHERE user_id = ? AND course_id = ?", [user_id, course_id])
    return {"ok": True}
