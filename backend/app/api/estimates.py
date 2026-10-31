"""
Estimate read API — Aspire Opportunity estimate totals + service-line detail.

Read-only: Aspire estimate lines are write-locked; we only read. Powers estimator queries —
compare two estimates (Darios builds a separate opportunity per option/revision), review
estimates by division + status, and year-over-year comparisons.

GET /estimates                      — list/filter estimates (division, status, query, year)
GET /estimates/compare?a=&b=        — two estimates side by side with deltas
GET /estimates/{opportunity_id}     — one estimate: header totals + service-line breakdown
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.config import settings
from app.services.aspire import AspireClient
from app.api.auth import require_access

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/estimates", tags=["estimates"])
_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

ASPIRE_WEB = "https://cloud.youraspire.com/app/opportunities/details/"

_HEADER_SELECT = ",".join([
    "OpportunityID", "OpportunityName", "OpportunityNumber", "DivisionName",
    "OpportunityStatusName", "OpportunityStageName", "JobStatusName", "OpportunityType",
    "SalesTypeName", "PropertyID", "PropertyName", "SalesRepContactName", "BillingContactName",
    "CreatedDateTime", "ProposedDate", "StartDate", "EndDate", "WonDate", "WonDollars",
    "EstimatedDollars", "EstimatedTotalCost", "EstimatedLaborHours", "EstimatedLaborCost",
    "EstimatedMaterialCost", "EstimatedEquipmentCost", "EstimatedSubCost", "EstimatedOtherCost",
    "EstimatedOverheadDollars", "EstimatedGrossMarginDollars", "EstimatedGrossMarginPercent",
    "EstimatedNetProfitDollars", "EstimatedNetProfitPercent",
    "ActualEarnedRevenue", "ActualCostDollars", "ActualLaborHours", "ActualGrossMarginPercent",
])
_LIST_SELECT = ",".join([
    "OpportunityID", "OpportunityName", "OpportunityNumber", "DivisionName",
    "OpportunityStatusName", "PropertyName", "SalesRepContactName", "CreatedDateTime",
    "StartDate", "EstimatedDollars", "EstimatedGrossMarginPercent", "EstimatedLaborHours", "WonDollars",
])


def _num(v):
    try:
        return round(float(v), 2) if v is not None else None
    except (TypeError, ValueError):
        return None


def _esc(s: str) -> str:
    return (s or "").replace("'", "''")


def _url(oid) -> str:
    return ASPIRE_WEB + str(oid)


async def _fetch_header(opp_id: int) -> Optional[dict]:
    res = await _aspire._get("Opportunities", {
        "$filter": f"OpportunityID eq {opp_id}", "$select": _HEADER_SELECT, "$top": "1"})
    rows = _aspire._extract_list(res)
    return rows[0] if rows else None


def _shape_header(o: dict) -> dict:
    return {
        "opportunity_id": o.get("OpportunityID"),
        "name": o.get("OpportunityName"),
        "number": o.get("OpportunityNumber"),
        "division": o.get("DivisionName"),
        "status": o.get("OpportunityStatusName"),
        "stage": o.get("OpportunityStageName"),
        "type": o.get("OpportunityType"),
        "sales_type": o.get("SalesTypeName"),
        "property": o.get("PropertyName"),
        "property_id": o.get("PropertyID"),
        "sales_rep": o.get("SalesRepContactName"),
        "created": (o.get("CreatedDateTime") or "")[:10] or None,
        "proposed": (o.get("ProposedDate") or "")[:10] or None,
        "start_date": (o.get("StartDate") or "")[:10] or None,
        "won_date": (o.get("WonDate") or "")[:10] or None,
        "won_dollars": _num(o.get("WonDollars")),
        "estimate": {
            "price": _num(o.get("EstimatedDollars")),
            "cost": _num(o.get("EstimatedTotalCost")),
            "gross_margin": _num(o.get("EstimatedGrossMarginDollars")),
            "gross_margin_pct": _num(o.get("EstimatedGrossMarginPercent")),
            "net_profit": _num(o.get("EstimatedNetProfitDollars")),
            "net_profit_pct": _num(o.get("EstimatedNetProfitPercent")),
            "labor_hours": _num(o.get("EstimatedLaborHours")),
            "labor_cost": _num(o.get("EstimatedLaborCost")),
            "material_cost": _num(o.get("EstimatedMaterialCost")),
            "equipment_cost": _num(o.get("EstimatedEquipmentCost")),
            "sub_cost": _num(o.get("EstimatedSubCost")),
            "other_cost": _num(o.get("EstimatedOtherCost")),
            "overhead": _num(o.get("EstimatedOverheadDollars")),
        },
        "actual": {
            "revenue": _num(o.get("ActualEarnedRevenue")),
            "cost": _num(o.get("ActualCostDollars")),
            "labor_hours": _num(o.get("ActualLaborHours")),
            "gross_margin_pct": _num(o.get("ActualGrossMarginPercent")),
        },
        "aspire_url": _url(o.get("OpportunityID")),
    }


async def _fetch_lines(opp_id: int) -> list[dict]:
    """Current estimate service lines (excludes lines removed by a later revision)."""
    try:
        res = await _aspire._get("OpportunityServices", {
            "$filter": f"OpportunityID eq {opp_id} and RemovedOpportunityRevisionID eq null",
            "$select": "OpportunityServiceID,DisplayName,SortOrder,ExtendedHours,ExtendedCost,ExtendedPrice,NetProfitPercent",
            "$orderby": "SortOrder asc", "$top": "500"})
    except Exception as e:
        logger.warning(f"estimate lines fetch failed for {opp_id}: {e}")
        return []
    out = []
    for s in _aspire._extract_list(res):
        price, cost = _num(s.get("ExtendedPrice")), _num(s.get("ExtendedCost"))
        margin = _num(s.get("NetProfitPercent"))
        if margin is None and price:
            margin = round(100 * (price - (cost or 0)) / price, 1)
        out.append({
            "service": s.get("DisplayName"),
            "hours": _num(s.get("ExtendedHours")),
            "cost": cost, "price": price, "margin_pct": margin,
        })
    return out


@router.get("", dependencies=[Depends(require_access)])
@router.get("/", dependencies=[Depends(require_access)])
async def list_estimates(
    division: Optional[str] = Query(None, description="Division-name substring, e.g. 'Snow', 'Construction', 'Maintenance' (blank = all divisions)"),
    status:   Optional[str] = Query(None, description="One or more Aspire statuses, comma-separated, e.g. 'Reviewed,Estimated' (exact names)"),
    query:    Optional[str] = Query(None, description="Substring of the opportunity or property name"),
    year:     Optional[int] = Query(None, description="Only estimates created in this calendar year"),
    limit:    int           = Query(100, description="Max results"),
):
    """List / filter estimates with their header totals (price, margin %, labor hours) — for
    reviewing a batch (e.g. Snow estimates in Reviewed or Estimated) or finding estimates to compare."""
    clauses = []
    if division:
        clauses.append(f"contains(DivisionName, '{_esc(division)}')")
    if status:
        vals = [s.strip() for s in status.split(",") if s.strip()]
        if vals:
            clauses.append("(" + " or ".join(f"OpportunityStatusName eq '{_esc(v)}'" for v in vals) + ")")
    if query:
        q = _esc(query)
        clauses.append(f"(contains(OpportunityName, '{q}') or contains(PropertyName, '{q}'))")
    if year:
        clauses.append(f"(CreatedDateTime ge {year}-01-01T00:00:00Z and CreatedDateTime le {year}-12-31T23:59:59Z)")
    params = {"$select": _LIST_SELECT, "$orderby": "CreatedDateTime desc", "$top": str(min(max(limit, 1), 1000))}
    if clauses:
        params["$filter"] = " and ".join(clauses)
    try:
        res = await _aspire._get("Opportunities", params)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Aspire estimate list failed: {e}")
    rows = _aspire._extract_list(res)
    out = [{
        "opportunity_id": o.get("OpportunityID"),
        "name": o.get("OpportunityName"),
        "number": o.get("OpportunityNumber"),
        "division": o.get("DivisionName"),
        "status": o.get("OpportunityStatusName"),
        "property": o.get("PropertyName"),
        "sales_rep": o.get("SalesRepContactName"),
        "created": (o.get("CreatedDateTime") or "")[:10] or None,
        "start_date": (o.get("StartDate") or "")[:10] or None,
        "price": _num(o.get("EstimatedDollars")),
        "gross_margin_pct": _num(o.get("EstimatedGrossMarginPercent")),
        "labor_hours": _num(o.get("EstimatedLaborHours")),
        "won_dollars": _num(o.get("WonDollars")),
        "aspire_url": _url(o.get("OpportunityID")),
    } for o in rows]
    return {"count": len(out), "filters": {"division": division, "status": status, "query": query, "year": year}, "estimates": out}


@router.get("/compare", dependencies=[Depends(require_access)])
async def compare_estimates(
    a: int = Query(..., description="First opportunity id"),
    b: int = Query(..., description="Second opportunity id"),
):
    """Two estimates side by side: header totals with b−a deltas, plus a line-by-line comparison
    matched on service name. Darios keeps each option/revision as its own opportunity, so this is
    the 'compare my two revisions' view — and works year-over-year (last year's vs this year's)."""
    oa, ob = await _fetch_header(a), await _fetch_header(b)
    if not oa:
        raise HTTPException(status_code=404, detail=f"No opportunity {a}")
    if not ob:
        raise HTTPException(status_code=404, detail=f"No opportunity {b}")
    ha, hb = _shape_header(oa), _shape_header(ob)
    ha["lines"], hb["lines"] = await _fetch_lines(a), await _fetch_lines(b)

    def _d(x, y):
        if x is None and y is None:
            return None
        return round((y or 0) - (x or 0), 2)

    ea, eb = ha["estimate"], hb["estimate"]
    deltas = {k: _d(ea.get(k), eb.get(k)) for k in
              ("price", "cost", "gross_margin", "gross_margin_pct", "net_profit", "net_profit_pct",
               "labor_hours", "labor_cost", "material_cost", "equipment_cost", "sub_cost", "other_cost", "overhead")}

    # line-by-line, matched on normalized service name
    def _key(s):
        return (s or "").strip().lower()
    la = {_key(l["service"]): l for l in ha["lines"]}
    lb = {_key(l["service"]): l for l in hb["lines"]}
    line_rows = []
    for k in sorted(set(la) | set(lb)):
        x, y = la.get(k), lb.get(k)
        name = (x or y)["service"]
        line_rows.append({
            "service": name,
            "a_hours": x["hours"] if x else None, "b_hours": y["hours"] if y else None,
            "a_price": x["price"] if x else None, "b_price": y["price"] if y else None,
            "price_delta": _d(x["price"] if x else None, y["price"] if y else None),
            "only_in": None if (x and y) else ("a" if x else "b"),
        })

    return {
        "a": ha, "b": hb,
        "deltas": deltas,              # b − a; positive = b is higher
        "line_comparison": line_rows,
        "note": "deltas are b minus a (positive = second estimate is higher). Lines matched on service name; only_in flags a line present in just one.",
    }


@router.get("/{opportunity_id}", dependencies=[Depends(require_access)])
async def get_estimate(opportunity_id: int):
    """One estimate: Opportunity header totals (price, cost, margin, labor hours, cost by category,
    plus actuals once the job runs) and the service-line breakdown."""
    o = await _fetch_header(opportunity_id)
    if not o:
        raise HTTPException(status_code=404, detail=f"No opportunity {opportunity_id}")
    h = _shape_header(o)
    h["lines"] = await _fetch_lines(opportunity_id)
    return h
