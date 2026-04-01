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


@router.get("/construction/opp/{opp_number}")
async def get_opp_raw(opp_number: int):
    """Debug: fetch one opportunity by OpportunityNumber with ALL fields."""
    try:
        # No $select — return every field Aspire gives us
        result = await _aspire._get("Opportunities", {
            "$filter": f"OpportunityNumber eq {opp_number}",
            "$top": "1",
        })
        opps = _aspire._extract_list(result)
        if opps:
            return {"opp_number": opp_number, "fields": list(opps[0].keys()), "record": opps[0]}
        # Fallback: return first Construction job with all fields
        result2 = await _aspire._get("Opportunities", {"$top": "1"})
        sample = _aspire._extract_list(result2)
        return {"opp_number": opp_number, "not_found": True, "sample_fields": list(sample[0].keys()) if sample else []}
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
    Returns Construction division jobs split into three buckets:
    - completed:     jobs with CompleteDate (or EndDate/WonDate) in target year
    - in_production: Won jobs where work has begun (JobStatus ≠ Not Started)
    - in_queue:      Won jobs not yet started (JobStatus = Not Started or null)
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
        if o.get("CompleteDate"):
            return True
        job_status = (o.get("JobStatusName") or "").lower()
        return "complete" in job_status

    def complete_in_year(o: dict, yr: int) -> bool:
        """True if job is complete AND its best available date is in the target year.
        Aspire often leaves CompleteDate null even when JobStatusName=Complete;
        fall back to EndDate then WonDate for year matching.
        If no date at all, include the job (it's complete and we don't know when).
        """
        if not is_complete(o):
            return False
        date_str = (
            o.get("CompleteDate")
            or o.get("EndDate")
            or o.get("WonDate")
            or ""
        )
        return not date_str or date_str.startswith(str(yr))

    def is_in_queue(o: dict) -> bool:
        """Won job with JobStatus = 'Not Started' (or no status) — scheduled but no work begun."""
        if is_complete(o):
            return False
        if (o.get("OpportunityStatusName") or "").lower() != "won":
            return False
        job_status = (o.get("JobStatusName") or "").lower()
        return not job_status or "not started" in job_status

    def is_in_production(o: dict) -> bool:
        """Won job where work has begun — JobStatus is set and not 'Not Started'."""
        if is_complete(o):
            return False
        if (o.get("OpportunityStatusName") or "").lower() != "won":
            return False
        job_status = (o.get("JobStatusName") or "").lower()
        return bool(job_status) and "not started" not in job_status

    completed     = [o for o in opps if complete_in_year(o, year)]
    in_production = [o for o in opps if is_in_production(o)]
    in_queue      = [o for o in opps if is_in_queue(o)]

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
        "completed":          totals(completed),
        "in_production":      totals(in_production),
        "in_queue":           totals(in_queue),
        "in_progress":        totals(in_production + in_queue),  # legacy compat
        "completed_jobs":     completed,
        "in_production_jobs": in_production,
        "in_queue_jobs":      in_queue,
        "jobs":               completed + in_production + in_queue,  # legacy compat
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
