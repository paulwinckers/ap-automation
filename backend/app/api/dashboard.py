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
        """Won job with zero actual labour hours — work not yet begun."""
        if is_complete(o):
            return False
        if (o.get("OpportunityStatusName") or "").lower() != "won":
            return False
        return float(o.get("ActualLaborHours") or 0) == 0

    def is_in_production(o: dict) -> bool:
        """Won job with actual labour hours logged — work is underway."""
        if is_complete(o):
            return False
        if (o.get("OpportunityStatusName") or "").lower() != "won":
            return False
        return float(o.get("ActualLaborHours") or 0) > 0

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


@router.get("/aspire/discover")
async def aspire_discover():
    """
    Probe Aspire write API surface — attachments, opportunity fields, work ticket fields.
    Returns enough to know what's required to POST photos and create opportunities.
    """
    result = {}

    # 1. Fetch one real WorkTicket with ALL fields so we know the schema
    try:
        wt = await _aspire._get("WorkTickets", {"$top": "1"})
        tickets = _aspire._extract_list(wt)
        if tickets:
            result["work_ticket_fields"] = list(tickets[0].keys())
            result["work_ticket_sample"] = tickets[0]
            result["work_ticket_id"] = tickets[0].get("WorkTicketID") or tickets[0].get("Id")
    except Exception as e:
        result["work_ticket_error"] = str(e)

    # 2. Try GET /WorkTicketNotes — see if there's a notes/comments entity
    try:
        wtn = await _aspire._get("WorkTicketNotes", {"$top": "1"})
        result["work_ticket_notes"] = _aspire._extract_list(wtn)[:1]
    except Exception as e:
        result["work_ticket_notes_error"] = str(e)

    # 3. Try GET /Attachments — see if there's a top-level attachments entity
    try:
        att = await _aspire._get("Attachments", {"$top": "1"})
        result["attachments"] = _aspire._extract_list(att)[:1]
    except Exception as e:
        result["attachments_error"] = str(e)

    # 4. Fetch one Opportunity with ALL fields to know what's required for POST
    try:
        opp = await _aspire._get("Opportunities", {"$top": "1"})
        opps = _aspire._extract_list(opp)
        if opps:
            result["opportunity_fields"] = list(opps[0].keys())
            result["opportunity_sample"] = opps[0]
    except Exception as e:
        result["opportunity_error"] = str(e)

    # 5. Try GET /Properties — needed for opportunity creation
    try:
        props = await _aspire._get("Properties", {"$top": "3"})
        result["properties_sample"] = _aspire._extract_list(props)[:3]
    except Exception as e:
        result["properties_error"] = str(e)

    # 6. Try GET /Contacts — needed for opportunity creation
    try:
        contacts = await _aspire._get("Contacts", {"$top": "3"})
        result["contacts_sample"] = _aspire._extract_list(contacts)[:3]
    except Exception as e:
        result["contacts_error"] = str(e)

    # 7. Try GET /Divisions — needed for routing new opportunities
    try:
        divs = await _aspire._get("Divisions", {"$top": "10"})
        result["divisions"] = _aspire._extract_list(divs)
    except Exception as e:
        result["divisions_error"] = str(e)

    return result


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


# ── Estimating Dashboard ───────────────────────────────────────────────────────

@router.get("/estimating/probe")
async def estimating_probe():
    """
    Diagnostic: returns raw counts at each filter stage so we can see
    why the pipeline looks smaller than expected.
    """
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")
    try:
        raw_opps = await _aspire._get_all("Opportunities", {
            "$select": "OpportunityID,OpportunityName,PropertyName,OpportunityStatusName,OpportunityType",
            "$filter": "OpportunityStatusName ne 'Won' and OpportunityStatusName ne 'Lost'",
            "$top": "500",
            "$orderby": "CreatedDateTime desc",
        })
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    total_fetched = len(raw_opps)
    status_counts = Counter(o.get("OpportunityStatusName") or "(none)" for o in raw_opps)
    no_property = [o for o in raw_opps if not (o.get("PropertyName") or "").strip()]
    active = [o for o in raw_opps if (
        "won"  not in (o.get("OpportunityStatusName") or "").lower() and
        "lost" not in (o.get("OpportunityStatusName") or "").lower()
    )]
    active_with_property = [o for o in active if (o.get("PropertyName") or "").strip()]

    return {
        "total_fetched": total_fetched,
        "status_breakdown": dict(status_counts.most_common()),
        "no_property_count": len(no_property),
        "no_property_sample": [{"id": o.get("OpportunityID"), "name": o.get("OpportunityName"), "status": o.get("OpportunityStatusName")} for o in no_property[:10]],
        "active_after_won_lost_filter": len(active),
        "active_with_property": len(active_with_property),
        "final_pipeline_count": len(active_with_property),
    }


@router.get("/estimating")
async def get_estimating_dashboard():
    """
    Returns all open (non-Won, non-Lost) opportunities grouped by salesperson
    then by stage (OpportunityStatusName).

    Response shape:
        {
          "summary": { total, total_value, overdue, due_this_week },
          "sales_types": ["Maintenance", ...],
          "salespeople": [
            {
              "name": "...", "total": N, "total_value": N, "overdue": N,
              "stages": [{ "stage": "...", "opportunities": [...] }]
            }
          ]
        }
    """
    from datetime import datetime, timezone, timedelta

    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(
            status_code=503,
            detail="Aspire credentials not configured (ASPIRE_CLIENT_ID / ASPIRE_CLIENT_SECRET)",
        )

    try:
        raw_opps = await _aspire._get_all("Opportunities", {
            "$select": (
                "OpportunityID,OpportunityNumber,OpportunityName,PropertyName,DivisionName,DivisionID,"
                "SalesRepContactName,SalesRepContactID,"
                "OpportunityStatusName,OpportunityStatusID,"
                "OpportunityType,SalesTypeName,SalesTypeID,"
                "EstimatedDollars,BidDueDate,CreatedDateTime,WonDate,LostDate"
            ),
            # Filter Won/Lost at the API level so the 500-record cap is spent
            # entirely on active opportunities rather than closed ones.
            "$filter": "OpportunityStatusName ne 'Won' and OpportunityStatusName ne 'Lost'",
            "$top": "500",
            "$orderby": "CreatedDateTime desc",
        })
        logger.info(f"Estimating dashboard: fetched {len(raw_opps)} active opportunities from Aspire")
    except Exception as e:
        logger.error(f"Estimating dashboard fetch failed: {e}")
        raise HTTPException(status_code=502, detail=f"Aspire API error: {e}")

    # ── Filter out Won / Lost and opportunities with no property ─────────────
    def is_active(o: dict) -> bool:
        status = (o.get("OpportunityStatusName") or "").strip().lower()
        return "won" not in status and "lost" not in status

    def has_property(o: dict) -> bool:
        return bool((o.get("PropertyName") or "").strip())

    opps = [o for o in raw_opps if is_active(o) and has_property(o)]

    # ── Date helpers ──────────────────────────────────────────────────────────
    now = datetime.now(timezone.utc)
    week_end = now + timedelta(days=7)

    def parse_date(s: str | None):
        if not s:
            return None
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
        except Exception:
            return None

    def days_since(dt) -> int:
        if dt is None:
            return 0
        return max(0, (now - dt).days)

    def days_until(dt) -> int | None:
        if dt is None:
            return None
        return (dt - now).days

    def urgency(due_dt) -> str:
        if due_dt is None:
            return "no-date"
        d = (due_dt - now).days
        if d < 0:
            return "overdue"
        if d <= 7:
            return "urgent"
        if d <= 30:
            return "soon"
        return "ok"

    # ── Shape each opportunity ────────────────────────────────────────────────
    shaped = []
    for o in opps:
        due_dt     = parse_date(o.get("BidDueDate"))
        created_dt = parse_date(o.get("CreatedDateTime"))
        urg        = urgency(due_dt)
        due_days   = days_until(due_dt)

        shaped.append({
            "id":              o.get("OpportunityID"),
            "opp_number":      o.get("OpportunityNumber"),
            "name":            o.get("OpportunityName") or "(no name)",
            "property":        o.get("PropertyName") or "",
            "division":        o.get("DivisionName") or "",
            "opp_type":        o.get("OpportunityType") or "Unknown",
            "sales_type":      o.get("SalesTypeName") or "",
            "status":          o.get("OpportunityStatusName") or "",
            "created_date":    (created_dt.date().isoformat() if created_dt else None),
            "due_date":        (due_dt.date().isoformat()     if due_dt     else None),
            "estimated_value": float(o.get("EstimatedDollars") or 0),
            "days_old":        days_since(created_dt),
            "days_until_due":  due_days,
            "urgency":         urg,
            "_salesperson":    (o.get("SalesRepContactName") or "Unassigned").strip(),
            "_stage":          o.get("OpportunityStatusName") or "Unknown",
            "_is_overdue":     urg == "overdue",
            "_due_this_week":  due_dt is not None and now <= due_dt <= week_end,
        })

    # ── Summary stats ─────────────────────────────────────────────────────────
    summary = {
        "total":         len(shaped),
        "total_value":   sum(s["estimated_value"] for s in shaped),
        "overdue":       sum(1 for s in shaped if s["_is_overdue"]),
        "due_this_week": sum(1 for s in shaped if s["_due_this_week"]),
    }

    # ── Unique sales types and phases (sorted, blanks excluded) ──────────────
    sales_types = sorted({s["sales_type"] for s in shaped if s["sales_type"]})
    phases      = sorted({s["status"]     for s in shaped if s["status"]})

    # ── Group by salesperson → stage ──────────────────────────────────────────
    from collections import defaultdict

    by_person: dict[str, list] = defaultdict(list)
    for s in shaped:
        by_person[s["_salesperson"]].append(s)

    def build_salesperson(name: str, opps_list: list) -> dict:
        by_stage: dict[str, list] = defaultdict(list)
        for o in opps_list:
            by_stage[o["_stage"]].append(o)

        # Strip internal keys before returning
        def clean(o: dict) -> dict:
            return {k: v for k, v in o.items() if not k.startswith("_")}

        stages = [
            {"stage": stage, "opportunities": [clean(o) for o in stage_opps]}
            for stage, stage_opps in sorted(by_stage.items())
        ]
        return {
            "name":        name,
            "total":       len(opps_list),
            "total_value": sum(o["estimated_value"] for o in opps_list),
            "overdue":     sum(1 for o in opps_list if o["_is_overdue"]),
            "stages":      stages,
        }

    # Sort alphabetically; put "Unassigned" last
    names_sorted = sorted(
        by_person.keys(),
        key=lambda n: (n == "Unassigned", n.lower()),
    )
    salespeople = [build_salesperson(name, by_person[name]) for name in names_sorted]

    return {
        "summary":     summary,
        "sales_types": sales_types,
        "phases":      phases,
        "salespeople": salespeople,
    }
