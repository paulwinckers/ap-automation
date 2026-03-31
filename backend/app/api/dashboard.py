"""
Construction Division Dashboard API.
GET /dashboard/construction          — all jobs + targets
GET /dashboard/construction/{id}/tickets — work tickets for one job
"""
import logging
from fastapi import APIRouter, HTTPException, Query

from app.core.config import settings
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

_aspire = AspireClient(sandbox=settings.ASPIRE_SANDBOX)

REVENUE_TARGET = 1_600_000.0
MARGIN_TARGET  =   600_000.0


@router.get("/construction")
async def get_construction_dashboard(year: int = Query(default=2026)):
    """
    Returns Construction division jobs for the given year plus
    aggregate totals vs the $1.6M revenue / $600K margin targets.
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

    # Aggregate totals
    total_won    = sum(float(o.get("WonDollars") or 0) for o in opps)
    total_earned = sum(float(o.get("ActualEarnedRevenue") or 0) for o in opps)
    total_margin = sum(float(o.get("ActualGrossMarginDollars") or 0) for o in opps)
    total_est_rev = sum(float(o.get("EstimatedDollars") or 0) for o in opps)
    total_est_margin = sum(float(o.get("EstimatedGrossMarginDollars") or 0) for o in opps)

    return {
        "year": year,
        "targets": {
            "revenue": REVENUE_TARGET,
            "margin":  MARGIN_TARGET,
        },
        "totals": {
            "won_dollars":              total_won,
            "actual_earned_revenue":    total_earned,
            "actual_gross_margin":      total_margin,
            "estimated_revenue":        total_est_rev,
            "estimated_gross_margin":   total_est_margin,
            "job_count":                len(opps),
        },
        "jobs": opps,
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
