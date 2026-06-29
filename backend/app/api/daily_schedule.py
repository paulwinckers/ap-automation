"""
Daily Schedule — a high-level list of the sites we're visiting on a given day,
pulled live from Aspire's scheduling (WorkTicketVisits).

Grouped Division → Lead → Property, with each site tagged Maintenance
(OpportunityType = Contract) or Project (OpportunityType = Work Order).

Data path per day:
  WorkTicketVisits (ScheduledDate = day)
    → Routes      (RouteID → DivisionName, CrewLeaderContactName/lead)
    → WorkTickets (WorkTicketID → OpportunityID)
    → Opportunities (OpportunityID → PropertyName, OpportunityType, DivisionName)
"""

import logging
import time as _time
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.api.construction_plan import (
    _aspire, _fetch_opp_actuals, get_db, STAGES, DEFAULT_STAGE,
)

# A project (Work Order) counts as "ready" once it reaches Set for Production or beyond.
_READY_FROM_INDEX = STAGES.index("Set for Production")


def _stage_is_ready(stage: str | None) -> bool:
    try:
        return STAGES.index(stage or DEFAULT_STAGE) >= _READY_FROM_INDEX
    except ValueError:
        return False

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/schedule", tags=["daily-schedule"])

# Preferred division ordering (anything else sorts after, alphabetically)
_DIV_ORDER = [
    "Construction",
    "Residential Maintenance",
    "Commercial Maintenance",
    "Irrigation/Lighting",
    "Snow",
]

# Small in-memory cache: {date_str: (payload, ts)}
_cache: dict[str, tuple[dict, float]] = {}
_CACHE_TTL = 300  # 5 minutes

# Routes change rarely — cache the route map for the process lifetime / TTL.
_routes_cache: tuple[dict, float] | None = None
_ROUTES_TTL = 1800  # 30 minutes


def _type_tag(opp_type: str | None) -> str:
    t = (opp_type or "").strip().lower()
    if t == "contract":
        return "maintenance"
    if t == "work order":
        return "project"
    return "other"


async def _get_route_map() -> dict[int, dict]:
    """RouteID → {division, lead, route_name, manager} for all routes (cached)."""
    global _routes_cache
    if _routes_cache and (_time.time() - _routes_cache[1]) < _ROUTES_TTL:
        return _routes_cache[0]
    rmap: dict[int, dict] = {}
    try:
        rows = _aspire._extract_list(await _aspire._get("Routes", {
            "$select": "RouteID,RouteName,DivisionName,CrewLeaderContactName,ManagerName",
            "$top": "500",
        }))
        for r in rows:
            rid = r.get("RouteID")
            if rid is None:
                continue
            rmap[rid] = {
                "division":   r.get("DivisionName") or "",
                "lead":       r.get("CrewLeaderContactName") or r.get("RouteName") or "",
                "route_name": r.get("RouteName") or "",
                "manager":    r.get("ManagerName") or "",
            }
    except Exception as e:
        logger.warning(f"Routes fetch failed: {e}")
    _routes_cache = (rmap, _time.time())
    return rmap


async def _fetch_visits_range(start: str, end_exclusive: str) -> list[dict]:
    """All WorkTicketVisits with ScheduledDate in [start, end_exclusive) (YYYY-MM-DD)."""
    visits: list[dict] = []
    flt = (f"ScheduledDate ge {start}T00:00:00Z and "
           f"ScheduledDate lt {end_exclusive}T00:00:00Z")
    for skip in range(0, 5000, 500):
        try:
            batch = _aspire._extract_list(await _aspire._get("WorkTicketVisits", {
                "$filter": flt,
                "$select": "WorkTicketVisitID,RouteID,WorkTicketID,WorkTicketNumber,ScheduledDate,SequenceNum",
                "$top": "500",
                "$skip": str(skip),
            }))
        except Exception as e:
            logger.warning(f"WorkTicketVisits fetch failed (skip={skip}): {e}")
            break
        if not batch:
            break
        visits.extend(batch)
        if len(batch) < 500:
            break
    return visits


async def _fetch_wt_opp_map(wt_ids: list[int]) -> dict[int, int]:
    """WorkTicketID → OpportunityID (batched)."""
    out: dict[int, int] = {}
    for i in range(0, len(wt_ids), 15):
        chunk = wt_ids[i:i + 15]
        or_f = " or ".join(f"WorkTicketID eq {x}" for x in chunk)
        try:
            rows = _aspire._extract_list(await _aspire._get("WorkTickets", {
                "$filter": f"({or_f})",
                "$select": "WorkTicketID,OpportunityID",
                "$top": "100",
            }))
        except Exception as e:
            logger.warning(f"WorkTickets chunk fetch failed: {e}")
            continue
        for w in rows:
            wid = w.get("WorkTicketID")
            oid = w.get("OpportunityID")
            if wid and oid:
                out[wid] = oid
    return out


async def _enrich_visits(visits: list[dict]) -> list[dict]:
    """Attach division / lead / property / type / date to each visit."""
    route_map = await _get_route_map()
    wt_ids  = sorted({v["WorkTicketID"] for v in visits if v.get("WorkTicketID")})
    wt2opp  = await _fetch_wt_opp_map(wt_ids)
    opp_ids = sorted({o for o in wt2opp.values() if o})
    opps    = await _fetch_opp_actuals(opp_ids)

    records: list[dict] = []
    for v in visits:
        route = route_map.get(v.get("RouteID")) or {}
        oid   = wt2opp.get(v.get("WorkTicketID"))
        opp   = opps.get(oid) or {}
        records.append({
            "date":               (v.get("ScheduledDate") or "")[:10],
            "division":           route.get("division") or opp.get("DivisionName") or "Unassigned",
            "lead":               route.get("lead") or route.get("route_name") or "Unassigned",
            "property":           opp.get("PropertyName") or f"WT #{v.get('WorkTicketNumber') or v.get('WorkTicketID')}",
            "type":               _type_tag(opp.get("OpportunityType")),
            "opp_id":             oid,
            "work_ticket_number": v.get("WorkTicketNumber"),
            "sequence":           v.get("SequenceNum") if v.get("SequenceNum") is not None else 9999,
            "visit_id":           v.get("WorkTicketVisitID") or 0,
        })
    # Stable order so "first work ticket" for a property is deterministic (route order).
    records.sort(key=lambda r: (r["date"], r["sequence"], r["visit_id"]))
    return records


def _site_key(r: dict) -> str:
    """Dedup key: one entry per opportunity (so a project with multiple work
    tickets is listed once — its first by route order). Falls back to the work
    ticket when there's no opportunity."""
    return f"opp{r['opp_id']}" if r.get("opp_id") else f"wt{r['work_ticket_number']}"


async def _project_stage_map(db: Database, records: list[dict]) -> dict[int, str]:
    """{opportunity_id: stage} from the construction plan, for project (work order) opps."""
    proj_oids = sorted({r["opp_id"] for r in records if r["type"] == "project" and r.get("opp_id")})
    if not proj_oids:
        return {}
    ph = ",".join("?" for _ in proj_oids)
    try:
        rows = await db._q(
            f"SELECT opportunity_id, stage FROM job_planning WHERE opportunity_id IN ({ph})",
            proj_oids,
        )
        return {r["opportunity_id"]: r["stage"] for r in rows if r.get("stage")}
    except Exception as e:
        logger.warning(f"job_planning stage lookup failed: {e}")
        return {}


def _make_site(r: dict, stage_map: dict[int, str]) -> dict:
    """Site dict for the response. Projects carry their plan stage + ready flag."""
    site = {
        "property":           r["property"],
        "type":               r["type"],
        "opp_id":             r["opp_id"],
        "work_ticket_number": r["work_ticket_number"],
    }
    if r["type"] == "project":
        stage = stage_map.get(r["opp_id"]) if r.get("opp_id") else None
        stage = stage or DEFAULT_STAGE
        site["stage"] = stage
        site["ready"] = _stage_is_ready(stage)
    return site


def _div_sort_key(div: str):
    try:
        return (0, _DIV_ORDER.index(div))
    except ValueError:
        return (1, div.lower())


@router.get("/day")
async def get_day_schedule(date: str | None = None, db: Database = Depends(get_db)):
    """
    High-level list of sites being visited on a day, grouped Division → Lead → Property.

    `date` is YYYY-MM-DD; defaults to today in the configured timezone.
    """
    tz = ZoneInfo(settings.CONSTRUCTION_REPORT_TIMEZONE or "America/Vancouver")
    if not date:
        date = datetime.now(tz).strftime("%Y-%m-%d")
    if len(date) != 10 or date[4] != "-" or date[7] != "-":
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")

    # Cache
    cached = _cache.get(date)
    if cached and (_time.time() - cached[1]) < _CACHE_TTL:
        return cached[0]

    next_day = (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    visits = await _fetch_visits_range(date, next_day)

    if not visits:
        payload = {
            "date": date,
            "divisions": [],
            "summary": {"total_sites": 0, "maintenance": 0, "project": 0, "project_ready": 0, "other": 0, "visits": 0},
        }
        _cache[date] = (payload, _time.time())
        return payload

    records   = await _enrich_visits(visits)
    stage_map = await _project_stage_map(db, records)

    # division -> lead -> { dedup_key : site }  (one entry per opportunity)
    tree: dict[str, dict[str, dict[str, dict]]] = defaultdict(lambda: defaultdict(dict))
    totals = {"maintenance": 0, "project": 0, "other": 0}
    project_ready = 0

    for r in records:
        dedup_key = _site_key(r)
        bucket = tree[r["division"]][r["lead"]]
        if dedup_key not in bucket:
            site = _make_site(r, stage_map)
            bucket[dedup_key] = site
            totals[r["type"]] += 1
            if site.get("ready"):
                project_ready += 1

    # Build sorted response
    divisions = []
    for div in sorted(tree.keys(), key=_div_sort_key):
        leads = []
        div_site_count = 0
        for lead in sorted(tree[div].keys(), key=str.lower):
            sites = sorted(tree[div][lead].values(), key=lambda s: s["property"].lower())
            div_site_count += len(sites)
            leads.append({"lead": lead, "site_count": len(sites), "sites": sites})
        divisions.append({
            "division":    div,
            "site_count":  div_site_count,
            "lead_count":  len(leads),
            "leads":       leads,
        })

    total_sites = totals["maintenance"] + totals["project"] + totals["other"]
    payload = {
        "date": date,
        "divisions": divisions,
        "summary": {
            "total_sites":    total_sites,
            "maintenance":    totals["maintenance"],
            "project":        totals["project"],
            "project_ready":  project_ready,
            "other":          totals["other"],
            "visits":         len(visits),
        },
    }
    _cache[date] = (payload, _time.time())
    return payload


@router.get("/week")
async def get_week_schedule(start: str | None = None, db: Database = Depends(get_db)):
    """
    Weekly grid of the 5 workdays (Mon–Fri) for the week containing `start`.

    Same content as /day but spread across the work week: Division → Lead, with
    each lead's sites laid out per workday. `start` is any YYYY-MM-DD in the
    target week (normalized to that week's Monday); defaults to the current week.
    """
    tz = ZoneInfo(settings.CONSTRUCTION_REPORT_TIMEZONE or "America/Vancouver")
    if not start:
        start = datetime.now(tz).strftime("%Y-%m-%d")
    if len(start) != 10 or start[4] != "-" or start[7] != "-":
        raise HTTPException(status_code=400, detail="start must be YYYY-MM-DD")

    # Normalize to Monday of that week; 5 workdays Mon–Fri.
    anchor  = datetime.strptime(start, "%Y-%m-%d")
    monday  = anchor - timedelta(days=anchor.weekday())
    days    = [(monday + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(5)]
    week_start = days[0]
    end_excl   = (monday + timedelta(days=5)).strftime("%Y-%m-%d")  # Saturday (exclusive)

    cache_key = f"week:{week_start}"
    cached = _cache.get(cache_key)
    if cached and (_time.time() - cached[1]) < _CACHE_TTL:
        return cached[0]

    visits = await _fetch_visits_range(week_start, end_excl)
    day_index = {d: i for i, d in enumerate(days)}

    if not visits:
        payload = {
            "week_start": week_start, "days": days, "divisions": [],
            "summary": {"total_sites": 0, "maintenance": 0, "project": 0, "project_ready": 0, "other": 0, "visits": 0},
        }
        _cache[cache_key] = (payload, _time.time())
        return payload

    records   = await _enrich_visits(visits)
    stage_map = await _project_stage_map(db, records)

    # division -> lead -> [ {dedup_key: site} per workday ]
    def _empty_week():
        return [dict() for _ in range(5)]
    tree: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(_empty_week))
    totals = {"maintenance": 0, "project": 0, "other": 0}
    project_ready = 0

    for r in records:
        di = day_index.get(r["date"])
        if di is None:
            continue  # weekend / out of range
        bucket = tree[r["division"]][r["lead"]][di]
        dedup_key = _site_key(r)
        if dedup_key not in bucket:
            site = _make_site(r, stage_map)
            bucket[dedup_key] = site
            totals[r["type"]] += 1
            if site.get("ready"):
                project_ready += 1

    divisions = []
    for div in sorted(tree.keys(), key=_div_sort_key):
        leads = []
        div_site_count = 0
        for lead in sorted(tree[div].keys(), key=str.lower):
            week_days = [
                sorted(day_bucket.values(), key=lambda s: s["property"].lower())
                for day_bucket in tree[div][lead]
            ]
            lead_count = sum(len(d) for d in week_days)
            div_site_count += lead_count
            leads.append({"lead": lead, "site_count": lead_count, "days": week_days})
        divisions.append({
            "division":   div,
            "site_count": div_site_count,
            "lead_count": len(leads),
            "leads":      leads,
        })

    total_sites = totals["maintenance"] + totals["project"] + totals["other"]
    payload = {
        "week_start": week_start,
        "days": days,
        "divisions": divisions,
        "summary": {
            "total_sites":    total_sites,
            "maintenance":    totals["maintenance"],
            "project":        totals["project"],
            "project_ready":  project_ready,
            "other":          totals["other"],
            "visits":         len(visits),
        },
    }
    _cache[cache_key] = (payload, _time.time())
    return payload


# ── Weekly schedule email ─────────────────────────────────────────────────────

_TYPE_DOT = {"maintenance": "#16a34a", "project": "#7c3aed", "other": "#94a3b8"}
_DIV_EMOJI = {
    "Construction": "🏗️", "Residential Maintenance": "🏡",
    "Commercial Maintenance": "🏢", "Irrigation/Lighting": "💧", "Snow": "❄️",
}


def _render_week_email_html(payload: dict) -> str:
    """Render the weekly schedule as a table-based HTML email (Outlook-safe)."""
    days = payload.get("days", [])
    s    = payload.get("summary", {})
    # Day column headers (short)
    def hdr(d):
        dt = datetime.strptime(d, "%Y-%m-%d")
        return f'{dt.strftime("%a")} <span style="color:#94a3b8;font-weight:600">{dt.strftime("%-d")}</span>'

    range_lbl = ""
    if days:
        a = datetime.strptime(days[0], "%Y-%m-%d").strftime("%b %-d")
        b = datetime.strptime(days[-1], "%Y-%m-%d").strftime("%b %-d, %Y")
        range_lbl = f"{a} – {b}"

    def cell(sites: list[dict]) -> str:
        if not sites:
            return '<span style="color:#d1d5db">·</span>'
        out = []
        for st in sites:
            dot = _TYPE_DOT.get(st.get("type"), _TYPE_DOT["other"])
            ready_tag = ""
            if st.get("type") == "project":
                if st.get("ready"):
                    ready_tag = ('<span style="color:#15803d;font-weight:700;font-size:11px">'
                                 '&nbsp;✓ Ready</span>')
                else:
                    ready_tag = ('<span style="color:#b45309;font-weight:700;font-size:11px">'
                                 '&nbsp;⏳ Not ready</span>')
            out.append(
                f'<span style="display:inline-block;width:7px;height:7px;border-radius:50%;'
                f'background:{dot};margin-right:6px"></span>{st.get("property","")}{ready_tag}'
            )
        return '<br>'.join(out)

    div_blocks = []
    for div in payload.get("divisions", []):
        rows = []
        for ld in div.get("leads", []):
            tds = "".join(
                f'<td style="padding:6px 10px;border-top:1px solid #f1f5f9;font-size:12px;'
                f'color:#1f2937;vertical-align:top">{cell(day)}</td>'
                for day in ld.get("days", [])
            )
            rows.append(
                f'<tr><td style="padding:6px 10px;border-top:1px solid #f1f5f9;font-size:12px;'
                f'font-weight:700;color:#1f2937;vertical-align:top;white-space:nowrap">{ld.get("lead","")}'
                f'<div style="font-size:10px;color:#9ca3af;font-weight:600">{ld.get("site_count",0)}</div></td>{tds}</tr>'
            )
        day_headers = "".join(
            f'<th style="padding:7px 10px;text-align:left;font-size:11px;color:#374151;'
            f'background:#f8fafc;border-bottom:2px solid #e5e7eb">{hdr(d)}</th>'
            for d in days
        )
        emoji = _DIV_EMOJI.get(div["division"], "📍")
        div_blocks.append(
            f'<h3 style="margin:22px 0 8px;font-size:15px;color:#111827">{emoji} {div["division"]} '
            f'<span style="font-size:12px;color:#9ca3af;font-weight:600">'
            f'{div.get("site_count",0)} visits · {div.get("lead_count",0)} crews</span></h3>'
            f'<table style="border-collapse:collapse;width:100%;border:1px solid #e5e7eb;border-radius:8px">'
            f'<thead><tr><th style="padding:7px 10px;text-align:left;font-size:11px;color:#6b7280;'
            f'background:#f8fafc;border-bottom:2px solid #e5e7eb">Lead</th>{day_headers}</tr></thead>'
            f'<tbody>{"".join(rows)}</tbody></table>'
        )

    legend = (
        '<div style="margin-top:14px;font-size:12px;color:#6b7280">'
        f'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:{_TYPE_DOT["maintenance"]};margin-right:5px"></span>Maintenance'
        '&nbsp;&nbsp;&nbsp;'
        f'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:{_TYPE_DOT["project"]};margin-right:5px"></span>Project'
        '</div>'
    )

    return f"""<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:0 auto;color:#111827">
      <h2 style="margin:0 0 2px;font-size:20px">🗓️ Weekly Schedule</h2>
      <div style="font-size:14px;color:#6b7280;margin-bottom:4px">{range_lbl}</div>
      <div style="font-size:13px;color:#374151;margin-bottom:6px">
        <strong>{s.get("total_sites",0)}</strong> sites &nbsp;·&nbsp;
        <strong style="color:#15803d">{s.get("maintenance",0)}</strong> maintenance &nbsp;·&nbsp;
        <strong style="color:#6d28d9">{s.get("project",0)}</strong> projects
        <span style="color:#94a3b8">({s.get("project_ready",0)} ready)</span>
      </div>
      {''.join(div_blocks) if div_blocks else '<p style="color:#6b7280">No sites scheduled this week.</p>'}
      {legend if div_blocks else ''}
    </div>"""


def _week_recipients() -> list[str]:
    raw = (getattr(settings, "SCHEDULE_WEEK_RECIPIENTS", "") or "").strip()
    if raw:
        return [r.strip() for r in raw.split(",") if r.strip()]
    return ["pwinckers1@gmail.com"]


class WeekEmailBody(BaseModel):
    to: list[str] | None = None


@router.post("/week/email")
async def email_week_schedule(start: str | None = None, body: WeekEmailBody | None = None,
                              db: Database = Depends(get_db)):
    """Email the weekly schedule (manual send). Defaults to the configured recipient."""
    from app.services.email_intake import GraphClient

    payload    = await get_week_schedule(start, db)
    recipients = (body.to if body and body.to else None) or _week_recipients()

    days = payload.get("days", [])
    if days:
        a = datetime.strptime(days[0], "%Y-%m-%d").strftime("%b %-d")
        b = datetime.strptime(days[-1], "%Y-%m-%d").strftime("%b %-d")
        subject = f"🗓️ Weekly Schedule — {a}–{b}"
    else:
        subject = "🗓️ Weekly Schedule"

    html  = _render_week_email_html(payload)
    graph = GraphClient()
    await graph.send_email(
        mailbox=settings.MS_AP_INBOX,
        to_addresses=recipients,
        subject=subject,
        body_html=html,
    )
    logger.info(f"Weekly schedule emailed to {recipients} ({payload['summary']['total_sites']} sites)")
    return {
        "ok": True,
        "recipients": recipients,
        "week_start": payload.get("week_start"),
        "sites": payload.get("summary", {}).get("total_sites", 0),
    }
