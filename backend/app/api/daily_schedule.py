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

from fastapi import APIRouter, HTTPException

from app.core.config import settings
from app.api.construction_plan import _aspire, _fetch_opp_actuals

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


async def _fetch_visits(day: str) -> list[dict]:
    """All WorkTicketVisits scheduled on `day` (YYYY-MM-DD)."""
    visits: list[dict] = []
    flt = (f"ScheduledDate ge {day}T00:00:00Z and "
           f"ScheduledDate lt {day}T23:59:59Z")
    for skip in range(0, 2000, 500):
        try:
            batch = _aspire._extract_list(await _aspire._get("WorkTicketVisits", {
                "$filter": flt,
                "$select": "WorkTicketVisitID,RouteID,WorkTicketID,WorkTicketNumber,ScheduledDate",
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


def _div_sort_key(div: str):
    try:
        return (0, _DIV_ORDER.index(div))
    except ValueError:
        return (1, div.lower())


@router.get("/day")
async def get_day_schedule(date: str | None = None):
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

    visits = await _fetch_visits(date)

    if not visits:
        payload = {
            "date": date,
            "divisions": [],
            "summary": {"total_sites": 0, "maintenance": 0, "project": 0, "other": 0, "visits": 0},
        }
        _cache[date] = (payload, _time.time())
        return payload

    route_map = await _get_route_map()

    wt_ids  = sorted({v["WorkTicketID"] for v in visits if v.get("WorkTicketID")})
    wt2opp  = await _fetch_wt_opp_map(wt_ids)
    opp_ids = sorted({o for o in wt2opp.values() if o})
    opps    = await _fetch_opp_actuals(opp_ids)   # {opp_id: {PropertyName, OpportunityType, ...}}

    # division -> lead -> { (key) : site }  (dedup by opportunity + type)
    tree: dict[str, dict[str, dict[str, dict]]] = defaultdict(lambda: defaultdict(dict))
    totals = {"maintenance": 0, "project": 0, "other": 0}

    for v in visits:
        route = route_map.get(v.get("RouteID")) or {}
        oid   = wt2opp.get(v.get("WorkTicketID"))
        opp   = opps.get(oid) or {}

        division = route.get("division") or opp.get("DivisionName") or "Unassigned"
        lead     = route.get("lead") or route.get("route_name") or "Unassigned"
        prop     = opp.get("PropertyName") or f"WT #{v.get('WorkTicketNumber') or v.get('WorkTicketID')}"
        tag      = _type_tag(opp.get("OpportunityType"))

        dedup_key = f"{oid or v.get('WorkTicketID')}|{tag}"
        bucket = tree[division][lead]
        if dedup_key not in bucket:
            bucket[dedup_key] = {
                "property":            prop,
                "type":                tag,
                "opp_id":              oid,
                "work_ticket_number":  v.get("WorkTicketNumber"),
            }
            totals[tag] += 1

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
            "total_sites":  total_sites,
            "maintenance":  totals["maintenance"],
            "project":      totals["project"],
            "other":        totals["other"],
            "visits":       len(visits),
        },
    }
    _cache[date] = (payload, _time.time())
    return payload
