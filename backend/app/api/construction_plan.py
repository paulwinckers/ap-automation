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


async def _fetch_construction_opps() -> list[dict]:
    """Fetch active Construction division opportunities from Aspire."""
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
    Return the full monthly plan: goal + committed jobs with live Aspire actuals.
    month format: YYYY-MM
    """
    # Validate format
    if len(month) != 7 or month[4] != "-":
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")

    # Goal
    goal_rows = await db._q(
        "SELECT * FROM construction_monthly_goals WHERE month = ?", [month]
    )
    goal = dict(goal_rows[0]) if goal_rows else {
        "month": month, "revenue_goal": None, "hours_goal": None, "notes": None
    }

    # Committed jobs
    target_rows = await db._q(
        "SELECT * FROM construction_job_targets WHERE month = ? ORDER BY created_at",
        [month],
    )
    targets = [dict(r) for r in target_rows]
    opp_ids = [t["opportunity_id"] for t in targets]

    # Fetch live actuals from Aspire
    actuals = await _fetch_opp_actuals(opp_ids)

    # Merge committed + actuals
    jobs = []
    total_hrs_est = 0.0
    total_hrs_act = 0.0
    total_revenue_act = 0.0
    total_revenue_est = 0.0

    for t in targets:
        oid = t["opportunity_id"]
        opp = actuals.get(oid, {})
        hrs_est = float(opp.get("EstimatedLaborHours") or 0)
        hrs_act = float(opp.get("ActualLaborHours") or 0)
        rev_act = float(opp.get("ActualEarnedRevenue") or 0)
        rev_est = float(opp.get("WonDollars") or opp.get("EstimatedDollars") or 0)
        pct     = float(opp.get("PercentComplete") or 0)

        total_hrs_est     += hrs_est
        total_hrs_act     += hrs_act
        total_revenue_act += rev_act
        total_revenue_est += rev_est

        jobs.append({
            "opportunity_id":   oid,
            "opportunity_name": opp.get("OpportunityName") or t.get("opportunity_name") or f"Job #{oid}",
            "property_name":    opp.get("PropertyName") or t.get("property_name") or "",
            "opp_number":       opp.get("OpportunityNumber"),
            "status":           opp.get("OpportunityStatusName") or "",
            "hrs_est":          hrs_est,
            "hrs_act":          hrs_act,
            "pct_complete":     pct,
            "revenue_est":      rev_est,
            "revenue_act":      rev_act,
            "start_date":       opp.get("StartDate"),
            "end_date":         opp.get("EndDate"),
            "notes":            t.get("notes") or "",
            "committed_by":     t.get("committed_by") or "",
            "committed_at":     t.get("created_at") or "",
            "risk":             _risk_flag(opp),
        })

    # Sort: at-risk / over-budget first, then by property name
    risk_order = {"over_budget": 0, "at_risk": 1, "on_track": 2, "complete": 3}
    jobs.sort(key=lambda j: (risk_order.get(j["risk"], 9), j["property_name"]))

    summary = {
        "job_count":         len(jobs),
        "days_left":         _days_left_in_month(month),
        "hrs_est":           total_hrs_est,
        "hrs_act":           total_hrs_act,
        "revenue_est":       total_revenue_est,
        "revenue_act":       total_revenue_act,
    }

    return {"month": month, "goal": goal, "jobs": jobs, "summary": summary}


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
    Return active Construction opportunities not yet committed to this month.
    Used to populate the 'Add Job' dropdown.
    """
    if len(month) != 7 or month[4] != "-":
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")

    # Already committed this month
    committed_rows = await db._q(
        "SELECT opportunity_id FROM construction_job_targets WHERE month = ?", [month]
    )
    committed_ids = {r["opportunity_id"] for r in committed_rows}

    opps = await _fetch_construction_opps()
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
        if o.get("OpportunityID") not in committed_ids
    ]
    return {"month": month, "suggestions": suggestions}
