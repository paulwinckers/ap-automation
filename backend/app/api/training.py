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
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.auth import current_actor, get_db, require_access
from app.core.database import Database

router = APIRouter(prefix="/training", tags=["training"])

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
async def assign_courses(body: AssignIn, actor: dict = Depends(require_access), db: Database = Depends(get_db)):
    """Assign each course to each person. Re-assigning updates the due date; progress is untouched."""
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
    n = 0
    for uid in ids:
        for cid in dict.fromkeys(body.course_ids):
            await db._x(
                "INSERT INTO training_assignments (user_id, course_id, due_date, assigned_by) VALUES (?,?,?,?) "
                "ON CONFLICT(user_id, course_id) DO UPDATE SET due_date = excluded.due_date, "
                "assigned_by = excluded.assigned_by",
                [uid, cid, due, by])
            n += 1
    return {"assigned": n}


@router.delete("/assign/{course_id}/{user_id}")
async def unassign_course(course_id: str, user_id: int,
                          _actor: dict = Depends(require_access), db: Database = Depends(get_db)):
    """Remove one assignment. The person's progress on the course is kept."""
    await db._x("DELETE FROM training_assignments WHERE user_id = ? AND course_id = ?", [user_id, course_id])
    return {"ok": True}
