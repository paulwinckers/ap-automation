"""
Construction Monthly Planning API
Leads commit jobs to a month and set revenue/hours goals.
Live Aspire actuals (hours, % complete, revenue) are layered on top.

GET    /construction/plan/{month}                  — full plan with live actuals
PUT    /construction/plan/{month}/goal             — set/update monthly goal
POST   /construction/plan/{month}/jobs             — commit a job to the month
DELETE /construction/plan/{month}/jobs/{opp_id}   — remove a committed job
GET    /construction/plan/{month}/suggestions      — active construction opps not yet committed
"""
import logging
from datetime import datetime, timezone, date as _date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/construction/plan", tags=["construction-plan"])

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

# ── DB helper ─────────────────────────────────────────────────────────────────
_db = Database()

async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


# ── Pydantic models ───────────────────────────────────────────────────────────
class GoalIn(BaseModel):
    revenue_goal: Optional[float] = None
    hours_goal:   Optional[float] = None
    notes:        Optional[str]   = None

class JobIn(BaseModel):
    opportunity_id:   int
    opportunity_name: Optional[str] = None
    property_name:    Optional[str] = None
    notes:            Optional[str] = None
    committed_by:     Optional[str] = None


# ── Aspire helpers ────────────────────────────────────────────────────────────
async def _fetch_opp_actuals(opp_ids: list[int]) -> dict[int, dict]:
    """Fetch live actuals for a list of OpportunityIDs from Aspire."""
    if not opp_ids:
        return {}
    out: dict[int, dict] = {}
    chunk_size = 15
    for i in range(0, len(opp_ids), chunk_size):
        chunk = opp_ids[i:i + chunk_size]
        or_filter = " or ".join(f"OpportunityID eq {oid}" for oid in chunk)
        try:
            res = await _aspire._get("Opportunities", {
                "$filter": f"({or_filter})",
                "$select": (
                    "OpportunityID,OpportunityName,PropertyName,OpportunityNumber,"
                    "DivisionName,WonDollars,ActualEarnedRevenue,EstimatedDollars,"
                    "EstimatedLaborHours,ActualLaborHours,PercentComplete,"
                    "OpportunityStatusName,StartDate,EndDate"
                ),
                "$top": "200",
            })
            for o in _aspire._extract_list(res):
                oid = o.get("OpportunityID")
                if oid:
                    out[oid] = o
        except Exception as e:
            logger.warning(f"Aspire actuals fetch failed: {e}")
    return out


async def _fetch_scheduled_opp_ids(month: str) -> dict[int, list[dict]]:
    """
    Return {opportunity_id: [ticket, ...]} for all Construction work tickets
    whose ScheduledStartDate falls within the given YYYY-MM month.
    Matches Aspire's 'This Month' filter: status Open or Scheduled, date in month.
    """
    y, m = int(month[:4]), int(month[5:7])
    if m == 12:
        next_m = f"{y + 1}-01"
    else:
        next_m = f"{y}-{str(m + 1).zfill(2)}"
    start = f"{month}-01"
    end   = f"{next_m}-01"

    # Fetch all tickets with ScheduledStartDate in the month (no status filter —
    # Aspire's 'This Month' view shows Open + Scheduled + any other non-terminal status).
    # We try without the time suffix first as some Aspire environments prefer bare dates.
    tickets: list[dict] = []
    for date_fmt in (
        f"ScheduledStartDate ge {start} and ScheduledStartDate lt {end}",
        f"ScheduledStartDate ge {start}T00:00:00Z and ScheduledStartDate lt {end}T00:00:00Z",
    ):
        try:
            res = await _aspire._get("WorkTickets", {
                "$filter": date_fmt,
                "$orderby": "WorkTicketID desc",
                "$top": "500",
            })
            tickets = _aspire._extract_list(res)
            logger.info(f"Plan: fetched {len(tickets)} work tickets for {month} using filter: {date_fmt}")
            if tickets:
                break
        except Exception as e:
            logger.warning(f"WorkTickets filter failed ({date_fmt}): {e}")

    if not tickets:
        return {}

    # Filter out completed / cancelled tickets
    skip_statuses = {"complete", "completed", "cancelled", "canceled"}
    tickets = [
        t for t in tickets
        if (t.get("WorkTicketStatusName") or "").lower() not in skip_statuses
    ]

    # Filter to Construction division via Opportunity lookup
    opp_ids = list({t.get("OpportunityID") for t in tickets if t.get("OpportunityID")})
    if not opp_ids:
        return {}

    opp_div: dict[int, str] = {}
    branch = (settings.ASPIRE_CONSTRUCTION_BRANCH or "Construction").lower()
    for i in range(0, len(opp_ids), 15):
        chunk = opp_ids[i:i+15]
        or_f  = " or ".join(f"OpportunityID eq {oid}" for oid in chunk)
        try:
            res2 = await _aspire._get("Opportunities", {
                "$filter": f"({or_f})",
                "$select": "OpportunityID,DivisionName",
                "$top": "200",
            })
            for o in _aspire._extract_list(res2):
                oid = o.get("OpportunityID")
                if oid:
                    opp_div[oid] = (o.get("DivisionName") or "").lower()
        except Exception:
            pass

    out: dict[int, list[dict]] = {}
    for t in tickets:
        oid = t.get("OpportunityID")
        if oid and branch in opp_div.get(oid, ""):
            out.setdefault(oid, []).append(t)

    logger.info(f"Plan: {len(out)} Construction opportunities with scheduled tickets in {month}")
    return out


async def _fetch_construction_opps(exclude_ids: set[int] | None = None) -> list[dict]:
    """Fetch active Construction division opportunities from Aspire, excluding given IDs."""
    try:
        res = await _aspire._get("Opportunities", {
            "$filter": "OpportunityStatusName ne 'Lost' and OpportunityStatusName ne 'Complete'",
            "$select": (
                "OpportunityID,OpportunityName,PropertyName,DivisionName,"
                "OpportunityStatusName,WonDollars,EstimatedLaborHours,ActualLaborHours,"
                "PercentComplete,StartDate,EndDate"
            ),
            "$top": "500",
            "$orderby": "OpportunityName asc",
        })
        all_opps = _aspire._extract_list(res)
        branch = (settings.ASPIRE_CONSTRUCTION_BRANCH or "Construction").lower()
        return [
            o for o in all_opps
            if branch in (o.get("DivisionName") or "").lower()
            and (not exclude_ids or o.get("OpportunityID") not in exclude_ids)
        ]
    except Exception as e:
        logger.warning(f"Aspire opps fetch failed: {e}")
        return []


def _risk_flag(opp: dict) -> str:
    """Return a risk label for a committed job based on % complete and hours burn."""
    pct  = float(opp.get("PercentComplete") or 0)
    est  = float(opp.get("EstimatedLaborHours") or 0)
    act  = float(opp.get("ActualLaborHours") or 0)
    burn = (act / est * 100) if est else 0

    if burn > 90 and pct < 70:
        return "over_budget"
    if burn > pct + 25:
        return "at_risk"
    if pct >= 100:
        return "complete"
    return "on_track"


def _days_left_in_month(month: str) -> int:
    try:
        y, m = int(month[:4]), int(month[5:7])
        if m == 12:
            end = _date(y + 1, 1, 1)
        else:
            end = _date(y, m + 1, 1)
        return (end - _date.today()).days
    except Exception:
        return 0


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{month}")
async def get_plan(month: str, db: Database = Depends(get_db)):
    """
    Return the full monthly plan: goal + jobs with live Aspire actuals.

    Jobs come from two sources (merged, deduped):
      1. SCHEDULED — work tickets with ScheduledStartDate in the month (auto, from Aspire)
      2. MANUAL    — opportunities committed via the Add Job button (stored in D1)

    month format: YYYY-MM
    """
    if len(month) != 7 or month[4] != "-":
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")

    import asyncio as _aio

    # Fetch goal, manually committed jobs, and scheduled work tickets in parallel
    goal_rows_coro  = db._q("SELECT * FROM construction_monthly_goals WHERE month = ?", [month])
    target_rows_coro = db._q("SELECT * FROM construction_job_targets WHERE month = ? ORDER BY created_at", [month])
    scheduled_coro  = _fetch_scheduled_opp_ids(month)

    goal_rows, target_rows, scheduled_map = await _aio.gather(
        goal_rows_coro, target_rows_coro, scheduled_coro
    )

    goal = dict(goal_rows[0]) if goal_rows else {
        "month": month, "revenue_goal": None, "hours_goal": None, "notes": None
    }
    manual_targets = [dict(r) for r in target_rows]
    manual_ids     = {t["opportunity_id"] for t in manual_targets}
    scheduled_ids  = set(scheduled_map.keys())

    # All unique opportunity IDs we need actuals for
    all_opp_ids = list(scheduled_ids | manual_ids)
    actuals = await _fetch_opp_actuals(all_opp_ids)

    def _make_job(oid: int, source: str, notes: str = "", committed_by: str = "", committed_at: str = "") -> dict:
        opp     = actuals.get(oid, {})
        hrs_est = float(opp.get("EstimatedLaborHours") or 0)
        hrs_act = float(opp.get("ActualLaborHours") or 0)
        rev_act = float(opp.get("ActualEarnedRevenue") or 0)
        rev_est = float(opp.get("WonDollars") or opp.get("EstimatedDollars") or 0)
        pct     = float(opp.get("PercentComplete") or 0)
        # Scheduled dates from the work tickets for this opp
        tickets = scheduled_map.get(oid, [])
        sched_dates = sorted(
            [t.get("ScheduledStartDate", "") for t in tickets if t.get("ScheduledStartDate")]
        )
        return {
            "opportunity_id":   oid,
            "opportunity_name": opp.get("OpportunityName") or f"Job #{oid}",
            "property_name":    opp.get("PropertyName") or "",
            "opp_number":       opp.get("OpportunityNumber"),
            "status":           opp.get("OpportunityStatusName") or "",
            "hrs_est":          hrs_est,
            "hrs_act":          hrs_act,
            "pct_complete":     pct,
            "revenue_est":      rev_est,
            "revenue_act":      rev_act,
            "start_date":       opp.get("StartDate"),
            "end_date":         opp.get("EndDate"),
            "scheduled_dates":  sched_dates,      # ticket-level scheduled dates
            "ticket_count":     len(tickets),
            "source":           source,           # "scheduled" | "manual" | "both"
            "notes":            notes,
            "committed_by":     committed_by,
            "committed_at":     committed_at,
            "risk":             _risk_flag(opp),
        }

    jobs: dict[int, dict] = {}

    # 1. Add scheduled jobs
    for oid in scheduled_ids:
        jobs[oid] = _make_job(oid, source="scheduled")

    # 2. Merge manual jobs — upgrade source to "both" if already scheduled
    for t in manual_targets:
        oid = t["opportunity_id"]
        if oid in jobs:
            jobs[oid]["source"] = "both"
            jobs[oid]["notes"]  = t.get("notes") or ""
        else:
            jobs[oid] = _make_job(
                oid, source="manual",
                notes=t.get("notes") or "",
                committed_by=t.get("committed_by") or "",
                committed_at=t.get("created_at") or "",
            )

    job_list = list(jobs.values())
    risk_order = {"over_budget": 0, "at_risk": 1, "on_track": 2, "complete": 3}
    job_list.sort(key=lambda j: (risk_order.get(j["risk"], 9), j["property_name"]))

    summary = {
        "job_count":         len(job_list),
        "scheduled_count":   len(scheduled_ids),
        "manual_count":      len(manual_ids - scheduled_ids),
        "days_left":         _days_left_in_month(month),
        "hrs_est":           sum(j["hrs_est"] for j in job_list),
        "hrs_act":           sum(j["hrs_act"] for j in job_list),
        "revenue_est":       sum(j["revenue_est"] for j in job_list),
        "revenue_act":       sum(j["revenue_act"] for j in job_list),
    }

    return {"month": month, "goal": goal, "jobs": job_list, "summary": summary}


@router.put("/{month}/goal")
async def set_goal(month: str, body: GoalIn, db: Database = Depends(get_db)):
    """Set or update the monthly revenue / hours goal."""
    if len(month) != 7 or month[4] != "-":
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")
    await db._x(
        """INSERT INTO construction_monthly_goals (month, revenue_goal, hours_goal, notes, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(month) DO UPDATE SET
             revenue_goal = excluded.revenue_goal,
             hours_goal   = excluded.hours_goal,
             notes        = excluded.notes,
             updated_at   = excluded.updated_at""",
        [month, body.revenue_goal, body.hours_goal, body.notes],
    )
    return {"ok": True, "month": month}


@router.post("/{month}/jobs")
async def add_job(month: str, body: JobIn, db: Database = Depends(get_db)):
    """Commit an opportunity to the month's plan."""
    if len(month) != 7 or month[4] != "-":
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")
    try:
        await db._x(
            """INSERT OR IGNORE INTO construction_job_targets
               (month, opportunity_id, opportunity_name, property_name, notes, committed_by)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [month, body.opportunity_id, body.opportunity_name,
             body.property_name, body.notes, body.committed_by],
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "month": month, "opportunity_id": body.opportunity_id}


@router.delete("/{month}/jobs/{opp_id}")
async def remove_job(month: str, opp_id: int, db: Database = Depends(get_db)):
    """Remove an opportunity from the month's plan."""
    await db._x(
        "DELETE FROM construction_job_targets WHERE month = ? AND opportunity_id = ?",
        [month, opp_id],
    )
    return {"ok": True, "month": month, "opportunity_id": opp_id}


@router.get("/{month}/suggestions")
async def get_suggestions(month: str, db: Database = Depends(get_db)):
    """
    Return active Construction opportunities not already in this month's plan
    (neither scheduled nor manually added). Used to populate the 'Add Job' dropdown.
    """
    if len(month) != 7 or month[4] != "-":
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")

    import asyncio as _aio

    committed_rows_coro = db._q(
        "SELECT opportunity_id FROM construction_job_targets WHERE month = ?", [month]
    )
    committed_rows, scheduled_map = await _aio.gather(
        committed_rows_coro, _fetch_scheduled_opp_ids(month)
    )

    already_in_plan = {r["opportunity_id"] for r in committed_rows} | set(scheduled_map.keys())

    opps = await _fetch_construction_opps(exclude_ids=already_in_plan)
    suggestions = [
        {
            "opportunity_id":   o.get("OpportunityID"),
            "opportunity_name": o.get("OpportunityName") or "",
            "property_name":    o.get("PropertyName") or "",
            "status":           o.get("OpportunityStatusName") or "",
            "pct_complete":     float(o.get("PercentComplete") or 0),
            "hrs_est":          float(o.get("EstimatedLaborHours") or 0),
            "hrs_act":          float(o.get("ActualLaborHours") or 0),
            "won_dollars":      float(o.get("WonDollars") or 0),
        }
        for o in opps
    ]
    return {"month": month, "suggestions": suggestions}
