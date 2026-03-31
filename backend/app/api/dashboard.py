"""
Construction Division Dashboard API.
GET /dashboard/construction          — all jobs + targets
GET /dashboard/construction/{id}/tickets — work tickets for one job
"""
import logging
from collections import Counter
from fastapi import APIRouter, HTTPException, Query

from app.core.config import settings
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

# Dashboard always reads from production — never sandbox
# (read-only, no risk; use ASPIRE_SANDBOX for AP invoice posting)
_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

REVENUE_TARGET = 1_600_000.0
MARGIN_TARGET  =   600_000.0


@router.get("/construction/probe")
async def probe_aspire():
    """Diagnostic: returns first 20 opportunities with no filter to check divisions/dates."""
    try:
        token = await _aspire._get_token()
        # Fetch up to 500 to find all divisions across the full dataset
        result = await _aspire._get("Opportunities", {
            "$select": "OpportunityID,OpportunityName,DivisionName,DivisionID,OpportunityStatusName,WonDate,StartDate",
            "$top": "500",
        })
        opps = _aspire._extract_list(result)
        # Tally all unique divisions with counts
        division_counts = Counter(
            (o.get("DivisionName") or "(none)", o.get("DivisionID"))
            for o in opps
        )
        divisions = {f"{name} (ID:{did})": count for (name, did), count in division_counts.most_common()}
        return {"total_fetched": len(opps), "divisions": divisions, "sample": opps[:5]}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/construction/opp/{opp_id}")
async def get_opp_raw(opp_id: int):
    """Debug: fetch one opportunity with ALL fields to see exact API field names."""
    try:
        result = await _aspire._get("Opportunities", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$top": "1",
        })
        opps = _aspire._extract_list(result)
        return {"opportunity_id": opp_id, "record": opps[0] if opps else None}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/construction/debug")
async def debug_filters():
    """
    Diagnostic: tries multiple filter approaches and returns counts.
    Helps identify which Aspire OData filters actually work.
    """
    results = {}
    try:
        # Test 1: No filter — should return records
        r1 = await _aspire._get("Opportunities", {
            "$select": "OpportunityID,DivisionName,OpportunityStatusName,CompleteDate",
            "$top": "10",
        })
        raw1 = _aspire._extract_list(r1)
        results["no_filter_top10"] = {
            "count": len(raw1),
            "sample_statuses": list({o.get("OpportunityStatusName") for o in raw1}),
            "sample_divisions": list({o.get("DivisionName") for o in raw1}),
        }

        # Test 2: DivisionName filter only
        try:
            r2 = await _aspire._get("Opportunities", {
                "$filter": "DivisionName eq 'Construction'",
                "$select": "OpportunityID,DivisionName,OpportunityStatusName,CompleteDate",
                "$top": "50",
            })
            raw2 = _aspire._extract_list(r2)
            results["division_name_filter"] = {
                "count": len(raw2),
                "statuses": dict(Counter(o.get("OpportunityStatusName") for o in raw2)),
            }
        except Exception as e:
            results["division_name_filter"] = {"error": str(e)}

        # Test 3: DivisionID filter only
        try:
            r3 = await _aspire._get("Opportunities", {
                "$filter": "DivisionID eq 8",
                "$select": "OpportunityID,DivisionName,OpportunityStatusName,CompleteDate",
                "$top": "50",
            })
            raw3 = _aspire._extract_list(r3)
            results["division_id_filter"] = {
                "count": len(raw3),
                "statuses": dict(Counter(o.get("OpportunityStatusName") for o in raw3)),
            }
        except Exception as e:
            results["division_id_filter"] = {"error": str(e)}

        # Test 4: Status filter only (Won)
        try:
            r4 = await _aspire._get("Opportunities", {
                "$filter": "OpportunityStatusName eq 'Won'",
                "$select": "OpportunityID,DivisionName,OpportunityStatusName",
                "$top": "50",
            })
            raw4 = _aspire._extract_list(r4)
            results["status_won_filter"] = {
                "count": len(raw4),
                "divisions": dict(Counter(o.get("DivisionName") for o in raw4)),
            }
        except Exception as e:
            results["status_won_filter"] = {"error": str(e)}

        # Test 5: Combined DivisionName + Won (one-level parens)
        try:
            r5 = await _aspire._get("Opportunities", {
                "$filter": "DivisionName eq 'Construction' and OpportunityStatusName eq 'Won'",
                "$select": "OpportunityID,DivisionName,OpportunityStatusName,CompleteDate",
                "$top": "50",
            })
            raw5 = _aspire._extract_list(r5)
            results["division_and_won"] = {"count": len(raw5)}
        except Exception as e:
            results["division_and_won"] = {"error": str(e)}

        return results

    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/construction")
async def get_construction_dashboard(year: int = Query(default=2026)):
    """
    Returns Construction division jobs split into completed vs in-progress,
    with separate totals for each against the $1.6M / $600K targets.
    """
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(
            status_code=503,
            detail="Aspire credentials not configured (ASPIRE_CLIENT_ID / ASPIRE_CLIENT_SECRET)",
        )

    try:
        opps = await _aspire.get_construction_opportunities(year=year)
    except Exception as e:
        logger.error(f"Dashboard fetch failed: {e}")
        raise HTTPException(status_code=502, detail=f"Aspire API error: {e}")

    def is_complete(o: dict) -> bool:
        # Most reliable indicator: job has a CompleteDate set.
        # OpportunityStatusName stays "Won" even for completed jobs in Aspire.
        # JobStatusName field name may vary — CompleteDate is always present when done.
        if o.get("CompleteDate"):
            return True
        job_status = (o.get("JobStatusName") or "").lower()
        return "complete" in job_status

    def complete_in_year(o: dict, yr: int) -> bool:
        """True if job is complete AND CompleteDate is in the target year."""
        if not is_complete(o):
            return False
        complete_date = o.get("CompleteDate") or ""
        return complete_date.startswith(str(yr))

    def is_in_progress(o: dict) -> bool:
        """Won jobs that haven't been completed — the current active pipeline."""
        if is_complete(o):
            return False
        opp_status = (o.get("OpportunityStatusName") or "").lower()
        return opp_status == "won"

    # Completed: JobStatus=Complete AND CompleteDate in target year
    # In-progress: OpportunityStatus=Won AND JobStatus not Complete (all pipeline, no date cap)
    completed   = [o for o in opps if complete_in_year(o, year)]
    in_progress = [o for o in opps if is_in_progress(o)]

    def totals(jobs: list) -> dict:
        return {
            "won_dollars":            sum(float(o.get("WonDollars") or 0) for o in jobs),
            "actual_earned_revenue":  sum(float(o.get("ActualEarnedRevenue") or 0) for o in jobs),
            "actual_gross_margin":    sum(float(o.get("ActualGrossMarginDollars") or 0) for o in jobs),
            "estimated_revenue":      sum(float(o.get("EstimatedDollars") or 0) for o in jobs),
            "estimated_gross_margin": sum(float(o.get("EstimatedGrossMarginDollars") or 0) for o in jobs),
            "job_count":              len(jobs),
        }

    return {
        "year": year,
        "targets": {
            "revenue": REVENUE_TARGET,
            "margin":  MARGIN_TARGET,
        },
        "completed":   totals(completed),
        "in_progress": totals(in_progress),
        "jobs": completed + in_progress,   # completed (year-filtered) + all Won
    }


@router.get("/construction/{opportunity_id}/tickets")
async def get_job_tickets(opportunity_id: int):
    """Returns work tickets for a single Construction job."""
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")

    try:
        tickets = await _aspire.get_work_tickets_summary(opportunity_id)
    except Exception as e:
        logger.error(f"Work ticket fetch failed for {opportunity_id}: {e}")
        raise HTTPException(status_code=502, detail=f"Aspire API error: {e}")

    return {"opportunity_id": opportunity_id, "tickets": tickets}
