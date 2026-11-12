"""
Training courses — progress for signed-in people, and a report of who finished what.

  GET  /training/progress                              the signed-in person's progress on every course
  POST /training/courses/{course_id}/modules/{module_id}/complete
                                                       mark one module done (idempotent); the course is
                                                       stamped complete when its last module is done
  GET  /training/report                                HR: everyone with the Training area or any progress

Course content lives in the frontend (src/lib/training/). The server only knows each course's module
ids, so it can tell when a course is finished and refuse ids that don't exist. Add a course here and
in the frontend together.
"""
from fastapi import APIRouter, Depends, HTTPException

from app.api.auth import current_actor, get_db, require_access
from app.core.database import Database

router = APIRouter(prefix="/training", tags=["training"])

# course id → its module ids, in order. Keep in step with frontend src/lib/training/.
COURSES: dict[str, dict] = {
    "difficult-customers": {
        "title": "Handling Difficult Customers",
        "modules": ["why", "brain", "last", "empathy", "neighbours", "deescalate", "escalate", "walkaway", "practice"],
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
    finished = {r["course_id"]: r["completed_at"] for r in done}
    out = {cid: {"done": [], "finished_at": finished.get(cid)} for cid in COURSES}
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
    return {"done": [m for m in course["modules"] if m in done], "finished_at": finished_at}


@router.get("/report")
async def training_report(_actor: dict = Depends(require_access), db: Database = Depends(get_db)):
    """Everyone who should take the courses (Training area) or has started one, with their progress."""
    users = await db._q("SELECT id, name, email, role, areas, active FROM users WHERE active = 1")
    progress = await db._q(
        "SELECT user_id, course_id, COUNT(*) n, MAX(completed_at) last_at FROM training_progress "
        "GROUP BY user_id, course_id")
    completions = await db._q("SELECT user_id, course_id, completed_at FROM training_completions")
    prog = {(r["user_id"], r["course_id"]): r for r in progress}
    fin = {(r["user_id"], r["course_id"]): r["completed_at"] for r in completions}
    started = {r["user_id"] for r in progress}

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
            }
        people.append({"user_id": u["id"], "name": u["name"], "email": u["email"],
                       "training_only": areas == {"training"}, "courses": courses})
    people.sort(key=lambda p: (p["name"] or "").lower())
    return {"courses": [{"id": cid, "title": c["title"], "modules": len(c["modules"])}
                        for cid, c in COURSES.items()],
            "people": people}
