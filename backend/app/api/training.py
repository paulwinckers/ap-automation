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
  POST /training/assign/remind                         HR: send overdue reminders now (skips anyone reminded today)

Overdue reminders: a scheduler (start_training_reminders, wired in main.py) runs on weekdays at
REMINDER_HOUR Pacific. Anyone with an assigned, unfinished course past its due date gets ONE push +
email listing all their overdue courses — the first weekday after the due date, then every
REMINDER_EVERY_DAYS until they finish it or it's unassigned. training_assignments.last_reminded_at
(YYYY-MM-DD) is claimed atomically before sending, so restarts or a second replica never double-send.

Course content lives in the frontend (src/lib/training/). The server only knows each course's module
ids, so it can tell when a course is finished and refuse ids that don't exist. Add a course here and
in the frontend together.
"""
import asyncio
import html
import logging
import re
from datetime import date, timedelta
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


REMINDER_HOUR = 7            # local (Pacific) hour the daily check fires, weekdays only
REMINDER_EVERY_DAYS = 7      # after the first reminder, remind again this often while still overdue
_reminder_col_ok = False


async def _ensure_reminder_col(db) -> None:
    """Add training_assignments.last_reminded_at if missing. Safe to call repeatedly."""
    global _reminder_col_ok
    if _reminder_col_ok:
        return
    try:
        await db._x("ALTER TABLE training_assignments ADD COLUMN last_reminded_at TEXT", [])
    except Exception:
        pass  # already exists
    _reminder_col_ok = True


@router.get("/report")
async def training_report(_actor: dict = Depends(require_access), db: Database = Depends(get_db)):
    """Everyone who should take the courses (Training area or an assignment) or has started one,
    with their progress and whether each course is assigned to them (and by when)."""
    users = await db._q("SELECT id, name, email, role, areas, active FROM users WHERE active = 1")
    progress = await db._q(
        "SELECT user_id, course_id, COUNT(*) n, MAX(completed_at) last_at FROM training_progress "
        "GROUP BY user_id, course_id")
    completions = await db._q("SELECT user_id, course_id, completed_at FROM training_completions")
    await _ensure_reminder_col(db)
    assignments = await db._q(
        "SELECT user_id, course_id, due_date, assigned_at, last_reminded_at FROM training_assignments")
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
                "last_reminded_at": asg[(u["id"], cid)].get("last_reminded_at") if (u["id"], cid) in asg else None,
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
    from app.core.database import Database
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
    mailer = _Mailer()
    for u in rows:
        titles = [COURSES[c]["title"] for c in new_by_user.get(u["id"], []) if c in COURSES]
        if not titles:
            continue
        n = len(titles)
        due_txt = f" · due {_nice_due(due)}" if due else ""
        push_body = (titles[0] if n == 1 else f"{n} courses, starting with {titles[0]}") + due_txt
        await mailer.deliver(u, "New training assigned", push_body,
                             ("New training: " + titles[0]) if n == 1 else f"New training: {n} courses assigned to you",
                             _assign_email(u.get("name") or "", titles, due, by, link))


class _Mailer:
    """Sends one person a push (to their subscribed devices) and an email (if they have an address).
    Never raises — failures are logged. One Graph client is reused across a batch."""

    def __init__(self):
        from app.core.config import settings
        self.sender = getattr(settings, "ms_send_from", "") or ""
        self.graph = None

    async def deliver(self, u: dict, push_title: str, push_body: str, subject: str, body_html: str) -> dict:
        from app.api import push as push_mod
        out = {"push": False, "email": False}
        try:
            await push_mod.push_to_user(u["id"], push_title, push_body, "/training")
            out["push"] = True
        except Exception as ex:
            logger.warning(f"training notify: push to user {u['id']} failed: {ex}")
        email = (u.get("email") or "").strip()
        if "@" in email and self.sender:
            try:
                if self.graph is None:
                    from app.services import email_intake
                    self.graph = email_intake.GraphClient()
                await self.graph.send_email(mailbox=self.sender, to_addresses=[email],
                                            subject=subject, body_html=body_html)
                out["email"] = True
            except Exception as ex:
                logger.warning(f"training notify: email to user {u['id']} failed: {ex}")
        return out


# ── Overdue reminders ─────────────────────────────────────────────────────────────────────────

def _overdue_email(name: str, items: list[tuple[str, str]], link: str) -> str:
    """items = [(course title, due YYYY-MM-DD)], oldest due first."""
    e = html.escape
    first = e((name or "there").split()[0])
    lis = "".join(f'<li style="margin:0 0 6px">{e(t)} <span style="color:#b23a2a">(was due {e(_nice_due(d))})</span></li>'
                  for t, d in items)
    which = "this course is" if len(items) == 1 else "these courses are"
    return f"""<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px">
  <div style="background:#b23a2a;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0">
    <div style="font-size:17px;font-weight:800">Training overdue</div>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:16px 18px;color:#111827;font-size:15px;line-height:1.5">
    <p style="margin:0 0 12px">Hi {first},</p>
    <p style="margin:0 0 8px">A reminder that {which} past due:</p>
    <ul style="margin:0 0 12px;padding-left:20px">{lis}</ul>
    <p style="margin:0 0 16px">Each one only takes a few minutes and works on your phone. If you've already started, you'll pick up where you left off.</p>
    <p style="margin:0 0 4px"><a href="{e(link)}" style="display:inline-block;background:#1f4d2b;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px">Finish my training</a></p>
    <p style="margin:12px 0 0;font-size:13px;color:#6b7280">Questions or can't get in? Ask your supervisor.</p>
  </div>
</div>"""


async def send_overdue_reminders(db, today: str, min_gap_days: int = REMINDER_EVERY_DAYS) -> dict:
    """Remind everyone with an assigned, unfinished course whose due date is before `today`
    (YYYY-MM-DD) and who hasn't been reminded about it in the last `min_gap_days` days.
    Each (person, course) is CLAIMED with a conditional UPDATE before anything is sent, so two
    runs (restart, second replica, a manual press) can't both remind about the same course."""
    await _ensure_reminder_col(db)
    cutoff = (date.fromisoformat(today) - timedelta(days=min_gap_days)).isoformat()
    rows = await db._q(
        "SELECT a.user_id, a.course_id, a.due_date, u.name, u.email "
        "FROM training_assignments a JOIN users u ON u.id = a.user_id "
        "LEFT JOIN training_completions c ON c.user_id = a.user_id AND c.course_id = a.course_id "
        "WHERE u.active = 1 AND u.role != 'service' AND a.due_date IS NOT NULL AND a.due_date < ? "
        "AND c.user_id IS NULL AND (a.last_reminded_at IS NULL OR a.last_reminded_at <= ?)",
        [today, cutoff])
    claimed: dict[int, dict] = {}
    for r in rows:
        if r["course_id"] not in COURSES:
            continue
        got = await db._q(
            "UPDATE training_assignments SET last_reminded_at = ? WHERE user_id = ? AND course_id = ? "
            "AND (last_reminded_at IS NULL OR last_reminded_at <= ?) RETURNING course_id",
            [today, r["user_id"], r["course_id"], cutoff])
        if got:
            p = claimed.setdefault(r["user_id"], {"id": r["user_id"], "name": r["name"], "email": r["email"], "items": []})
            p["items"].append((COURSES[r["course_id"]]["title"], r["due_date"]))
    link = f"{_portal_base()}/training"
    mailer = _Mailer()
    courses = 0
    for p in claimed.values():
        items = sorted(p["items"], key=lambda x: x[1])
        n = len(items)
        courses += n
        push_body = (f"{items[0][0]} was due {_nice_due(items[0][1])}" if n == 1
                     else f"{n} courses past due, starting with {items[0][0]}")
        await mailer.deliver(p, "Training overdue", push_body,
                             f"Reminder: {items[0][0]} is overdue" if n == 1 else f"Reminder: {n} training courses are overdue",
                             _overdue_email(p["name"] or "", items, link))
    logger.info(f"training reminders: {len(claimed)} people, {courses} overdue courses (today={today})")
    return {"people": len(claimed), "courses": courses}


def _company_today() -> tuple:
    import zoneinfo
    from datetime import datetime
    from app.core.config import settings
    tz = zoneinfo.ZoneInfo(getattr(settings, "CONSTRUCTION_REPORT_TIMEZONE", "") or "America/Vancouver")
    return datetime.now(tz)


async def _reminder_loop():
    """Every 5 minutes; fires once on weekdays in the REMINDER_HOUR window. The DB claim makes a
    second firing (restart inside the window, extra replica) a harmless no-op."""
    last = ""
    while True:
        await asyncio.sleep(5 * 60)
        now = _company_today()
        today = now.strftime("%Y-%m-%d")
        if now.weekday() >= 5 or now.hour != REMINDER_HOUR or now.minute >= 30 or last == today:
            continue
        last = today
        from app.core.database import Database
        db = Database()
        try:
            await db.connect()
            await send_overdue_reminders(db, today)
        except Exception as ex:
            logger.error(f"training reminders failed: {ex}")
        finally:
            try:
                await db.close()
            except Exception:
                pass


_reminder_task = None


def start_training_reminders():
    global _reminder_task
    _reminder_task = asyncio.ensure_future(_reminder_loop())
    logger.info(f"Training reminder scheduler started (weekdays {REMINDER_HOUR}:00 Pacific)")


def stop_training_reminders():
    global _reminder_task
    if _reminder_task:
        _reminder_task.cancel()
        _reminder_task = None


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


@router.post("/assign/remind")
async def remind_overdue_now(_actor: dict = Depends(require_access), db: Database = Depends(get_db)):
    """HR: send overdue reminders now. Skips anyone already reminded about that course today,
    so pressing it twice doesn't double-send. Resets their weekly cycle from today."""
    return await send_overdue_reminders(db, _company_today().strftime("%Y-%m-%d"), min_gap_days=1)


@router.delete("/assign/{course_id}/{user_id}")
async def unassign_course(course_id: str, user_id: int,
                          _actor: dict = Depends(require_access), db: Database = Depends(get_db)):
    """Remove one assignment. The person's progress on the course is kept."""
    await db._x("DELETE FROM training_assignments WHERE user_id = ? AND course_id = ?", [user_id, course_id])
    return {"ok": True}
