"""
Portal usage — which pages people open, and how often.

  POST /usage/pageview   the frontend sends one of these each time a page opens. Open to everyone
                         (the crew pages have no login); a signed-in person is stamped from their
                         token, a crew phone sends the name it already remembers plus a random
                         device id. Nothing else about the visitor is stored.
  GET  /admin/usage      admin-only report: views by page, by person, by day.

Paths are stored with record ids folded to ':id' (/field/project/123 → /field/project/:id) so a
page counts as one page however many jobs it was opened for.
"""
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from app.api.auth import _require_admin, get_db, optional_actor
from app.core.database import Database

router = APIRouter(tags=["usage"])

_ID_SEG = re.compile(r"^(\d+|[A-Za-z0-9_-]{17,})$")
_TAB = re.compile(r"^[a-z0-9_-]{1,20}$")


class PageViewIn(BaseModel):
    path: str = Field(..., max_length=300)
    tab: Optional[str] = Field(None, max_length=20)
    device: Optional[str] = Field(None, max_length=40)
    name: Optional[str] = Field(None, max_length=60)


def _norm_path(path: str, tab: Optional[str]) -> Optional[str]:
    path = (path or "").split("?")[0].split("#")[0].strip()
    if not path.startswith("/"):
        return None
    segs = [s for s in path.split("/") if s][:6]
    out = "/" + "/".join(":id" if _ID_SEG.match(s) else s[:40] for s in segs)
    if tab and _TAB.match(tab):
        out += f"?tab={tab}"
    return out[:120]


@router.post("/usage/pageview")
async def record_pageview(body: PageViewIn, actor: Optional[dict] = Depends(optional_actor),
                          db: Database = Depends(get_db)):
    path = _norm_path(body.path, body.tab)
    if not path:
        return {"ok": False}
    user_id = actor.get("id") if actor and isinstance(actor.get("id"), int) else None
    who = (actor.get("name") or actor.get("email")) if user_id else (body.name or "").strip()[:60] or None
    kind = "field" if path == "/crew" or path.startswith("/field") or path.startswith("/keys/scan") \
        or path == "/ops/time-tracking" else "office"
    device = re.sub(r"[^A-Za-z0-9_-]", "", body.device or "")[:40] or None
    # A quick double-fire (page re-render, back-and-forth) shouldn't count twice.
    recent = await db._q(
        "SELECT 1 FROM page_views WHERE path=? AND COALESCE(user_id,-1)=COALESCE(?,-1) "
        "AND COALESCE(device,'')=COALESCE(?,'') AND viewed_at >= datetime('now','-20 seconds') LIMIT 1",
        [path, user_id, device])
    if recent:
        return {"ok": True, "dup": True}
    await db._x("INSERT INTO page_views (path, kind, user_id, who, device) VALUES (?,?,?,?,?)",
                [path, kind, user_id, who, device])
    return {"ok": True}


@router.get("/admin/usage")
async def usage_report(days: int = Query(7, ge=1, le=180), _admin: dict = Depends(_require_admin),
                       db: Database = Depends(get_db)):
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    # A visitor = the signed-in person, else the crew name, else the phone.
    vis = "COALESCE('u' || user_id, 'n' || lower(who), 'd' || device, 'anon')"
    by_page = await db._q(
        f"SELECT path, kind, COUNT(*) views, COUNT(DISTINCT {vis}) people, MAX(viewed_at) last_at "
        "FROM page_views WHERE viewed_at >= ? GROUP BY path, kind ORDER BY views DESC", [since])
    by_person = await db._q(
        # One row per person: anyone signed in is office staff, even when they open a crew page.
        f"SELECT {vis} vkey, MAX(who) who, MAX(user_id) user_id, "
        "CASE WHEN MAX(user_id) IS NOT NULL THEN 'office' ELSE 'field' END kind, COUNT(*) views, "
        "COUNT(DISTINCT path) pages, COUNT(DISTINCT substr(viewed_at,1,10)) days_active, MAX(viewed_at) last_at "
        "FROM page_views WHERE viewed_at >= ? GROUP BY vkey ORDER BY views DESC", [since])
    top_pages = await db._q(
        f"SELECT {vis} vkey, path, COUNT(*) n FROM page_views WHERE viewed_at >= ? "
        "GROUP BY vkey, path ORDER BY n DESC", [since])
    by_day = await db._q(
        "SELECT substr(viewed_at,1,10) day, kind, COUNT(*) views FROM page_views WHERE viewed_at >= ? "
        "GROUP BY day, kind ORDER BY day", [since])
    tops: dict[str, list] = {}
    for r in top_pages:
        lst = tops.setdefault(r["vkey"], [])
        if len(lst) < 3:
            lst.append({"path": r["path"], "views": r["n"]})
    for p in by_person:
        p["top_pages"] = tops.get(p.pop("vkey"), [])
        if not p.get("who"):
            p["who"] = "Unnamed phone" if p["kind"] == "field" else "Unknown"
    return {
        "days": days, "since": since,
        "total_views": sum(r["views"] for r in by_page),
        "by_page": by_page, "by_person": by_person, "by_day": by_day,
    }
