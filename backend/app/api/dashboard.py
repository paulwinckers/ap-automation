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

    # ── Merge change orders into their parent opportunity ─────────────────────
    def merge_change_orders(jobs: list) -> list:
        """
        Group all opportunities that share an OpportunityNumber. Within each
        group the row with the largest WonDollars is treated as the parent
        contract; every other row is a change order / add-on and gets rolled
        into it. This avoids relying on name conventions (Aspire data uses
        "Change Order", "Changed Order", or no prefix at all).
        """
        from collections import defaultdict
        groups: dict = defaultdict(list)
        no_number: list = []
        for o in jobs:
            num = o.get("OpportunityNumber")
            if num is None:
                no_number.append(o)
            else:
                groups[num].append(o)

        merged: list = []
        for num, group in groups.items():
            if len(group) == 1:
                merged.append(group[0])
                continue

            # Parent = largest WonDollars; all others are change orders
            group_sorted = sorted(
                group,
                key=lambda o: float(o.get("WonDollars") or 0),
                reverse=True,
            )
            parent = dict(group_sorted[0])  # shallow copy — don't mutate original
            cos    = group_sorted[1:]

            co_won    = sum(float(c.get("WonDollars")                  or 0) for c in cos)
            co_est    = sum(float(c.get("EstimatedDollars")             or 0) for c in cos)
            co_est_gm = sum(float(c.get("EstimatedGrossMarginDollars")  or 0) for c in cos)
            co_act_rev = sum(float(c.get("ActualEarnedRevenue")         or 0) for c in cos)
            co_act_gm  = sum(float(c.get("ActualGrossMarginDollars")    or 0) for c in cos)

            parent["WonDollars"]                  = float(parent.get("WonDollars")                  or 0) + co_won
            parent["EstimatedDollars"]            = float(parent.get("EstimatedDollars")            or 0) + co_est
            parent["EstimatedGrossMarginDollars"] = float(parent.get("EstimatedGrossMarginDollars") or 0) + co_est_gm
            parent["ActualEarnedRevenue"]         = float(parent.get("ActualEarnedRevenue")         or 0) + co_act_rev
            parent["ActualGrossMarginDollars"]    = float(parent.get("ActualGrossMarginDollars")    or 0) + co_act_gm

            # Recalculate margin % from updated totals
            new_est_rev = parent["EstimatedDollars"]
            new_act_rev = parent["ActualEarnedRevenue"]
            parent["EstimatedGrossMarginPercent"] = (
                (parent["EstimatedGrossMarginDollars"] / new_est_rev * 100) if new_est_rev else None
            )
            parent["ActualGrossMarginPercent"] = (
                (parent["ActualGrossMarginDollars"] / new_act_rev * 100) if new_act_rev else None
            )

            parent["change_order_count"] = len(cos)
            parent["change_order_total"] = co_won

            merged.append(parent)

        merged.extend(no_number)
        return merged

    opps = merge_change_orders(opps)

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

@router.get("/estimating/fields")
async def estimating_fields_probe():
    """Fetch one opportunity with ALL fields so we can find the correct last-modified field name."""
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")
    try:
        result = await _aspire._get("Opportunities", {
            "$filter": "OpportunityStatusName ne 'Won' and OpportunityStatusName ne 'Lost'",
            "$top": "1",
            "$orderby": "CreatedDateTime desc",
        })
        opps = _aspire._extract_list(result)
        if not opps:
            return {"error": "No opportunities found"}
        opp = opps[0]
        # Return all fields so we can find the last-modified one
        date_fields = {k: v for k, v in opp.items() if v and ("date" in k.lower() or "time" in k.lower() or "modified" in k.lower() or "updated" in k.lower() or "activity" in k.lower())}
        return {"all_field_names": sorted(opp.keys()), "date_like_fields": date_fields}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/properties/fields")
async def properties_fields_probe():
    """Fetch one Property with ALL fields to discover tags, tiers, classifications."""
    try:
        result = await _aspire._get("Properties", {"$top": "1"})
        props = _aspire._extract_list(result)
        if not props:
            return {"error": "No properties found or endpoint 403"}
        prop = props[0]
        return {"all_field_names": sorted(prop.keys()), "sample": prop}
    except Exception as e:
        return {"error": str(e)}


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
                "EstimatedDollars,BidDueDate,StartDate,CreatedDateTime,ModifiedDate,WonDate,LostDate"
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

    def is_not_test(o: dict) -> bool:
        prop = (o.get("PropertyName") or "").strip().lower()
        return "dario" not in prop or "test" not in prop

    opps = [o for o in raw_opps if is_active(o) and has_property(o) and is_not_test(o)]

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

        start_dt        = parse_date(o.get("StartDate"))
        last_modified_dt = parse_date(o.get("ModifiedDate"))
        shaped.append({
            "id":                 o.get("OpportunityID"),
            "opp_number":         o.get("OpportunityNumber"),
            "name":               o.get("OpportunityName") or "(no name)",
            "property":           o.get("PropertyName") or "",
            "division":           o.get("DivisionName") or "",
            "opp_type":           o.get("OpportunityType") or "Unknown",
            "sales_type":         o.get("SalesTypeName") or "",
            "status":             o.get("OpportunityStatusName") or "",
            "created_date":       (created_dt.date().isoformat()      if created_dt      else None),
            "due_date":           (due_dt.date().isoformat()          if due_dt          else None),
            "start_date":         (start_dt.date().isoformat()        if start_dt        else None),
            "last_activity_date": (last_modified_dt.date().isoformat() if last_modified_dt else None),
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

    # ── Unique sales types, phases and divisions (sorted, blanks excluded) ────
    sales_types = sorted({s["sales_type"] for s in shaped if s["sales_type"]})
    phases      = sorted({s["status"]     for s in shaped if s["status"]})
    divisions   = sorted({s["division"]   for s in shaped if s["division"]})

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
        "divisions":   divisions,
        "salespeople": salespeople,
    }


# ── Sales Dashboard — live Aspire feeds ──────────────────────────────────────

@router.get("/sales/pipeline")
async def get_sales_pipeline():
    """
    Pipeline feed for the Sales Dashboard.
    Returns all opportunities (excluding Lost) shaped for chart consumption.
    JS expects: division, status, start_date, estimated_dollars,
                probability, weighted_pipeline, weighted_hours
    """
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")
    SELECT = (
        "OpportunityID,OpportunityNumber,OpportunityName,"
        "DivisionName,OpportunityStatusName,"
        "StartDate,WonDate,EstimatedDollars,Probability,EstimatedLaborHours"
    )
    CURRENT_YEAR = "2026"

    def _date_only(val: str | None) -> str | None:
        if not val:
            return None
        return val[:10]  # '2025-03-01T00:00:00Z' → '2025-03-01'

    try:
        # Call 1: active pipeline only (excludes Won so 500-cap isn't eaten by closed deals)
        active_raw = await _aspire._get_all("Opportunities", params={
            "$filter": "OpportunityStatusName ne 'Won' and OpportunityStatusName ne 'Lost'",
            "$select": SELECT,
            "$top": "500",
        })
        # Call 2: Won opps from current year only
        won_raw = await _aspire._get_all("Opportunities", params={
            "$filter": "OpportunityStatusName eq 'Won'",
            "$select": SELECT,
            "$top": "500",
            "$orderby": "WonDate desc",   # most-recent first so we get 2026 wins
        })
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Aspire API error: {e}")

    pipeline = []

    def _build_row(o: dict, chart_date: str | None) -> dict | None:
        if not chart_date:
            return None
        estimated   = float(o.get("EstimatedDollars") or 0)
        probability = float(o.get("Probability") or 0) / 100.0
        est_hours   = float(o.get("EstimatedLaborHours") or 0)
        return {
            "division":          o.get("DivisionName") or "",
            "status":            o.get("OpportunityStatusName") or "",
            "start_date":        chart_date,
            "estimated_dollars": estimated,
            "probability":       probability,
            "weighted_pipeline": round(estimated * probability, 2),
            "weighted_hours":    round(est_hours * probability, 2),
            "opp_number":        o.get("OpportunityNumber"),
            "opp_name":          o.get("OpportunityName") or "",
        }

    # Active pipeline — use StartDate for monthly bucketing
    for o in active_raw:
        row = _build_row(o, _date_only(o.get("StartDate")))
        if row:
            pipeline.append(row)

    # Won in current year — use WonDate for monthly bucketing
    for o in won_raw:
        won_date = _date_only(o.get("WonDate"))
        if not won_date or not won_date.startswith(CURRENT_YEAR):
            continue
        row = _build_row(o, won_date)
        if row:
            pipeline.append(row)

    return {
        "count":    len(pipeline),
        "pipeline": pipeline,
    }


@router.get("/sales/work-tickets")
async def get_sales_work_tickets():
    """
    Work tickets feed for the Sales Dashboard hours charts.
    DivisionName is not on WorkTickets — we fetch OpportunityID→DivisionName
    from Opportunities and join in Python.
    """
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")

    # Fetch work tickets (no DivisionName — it's not a WorkTicket field)
    # Paginate through all work tickets using $skip (Aspire caps at 500/page)
    SELECT_WT = (
        "WorkTicketID,WorkTicketStatusName,"
        "ScheduledStartDate,AnticStartDate,CompleteDate,HoursEst,HoursAct,OpportunityID"
    )
    FILTER_WT = (
        "WorkTicketStatusName eq 'Open'"
        " or WorkTicketStatusName eq 'Scheduled'"
        " or WorkTicketStatusName eq 'Pending Approval'"
        " or WorkTicketStatusName eq 'Complete'"
    )
    PAGE = 500
    raw: list = []
    try:
        skip = 0
        while True:
            page_data = await _aspire._get("WorkTickets", params={
                "$select": SELECT_WT,
                "$filter": FILTER_WT,
                "$top":    str(PAGE),
                "$skip":   str(skip),
                "$orderby": "ScheduledStartDate desc",
            })
            records = _aspire._extract_list(page_data)
            raw.extend(records)
            if len(records) < PAGE:
                break   # last page — end of data
            # Early exit: if the last record on this page is pre-2026,
            # all subsequent pages will also be pre-2026 (descending order)
            last_date = records[-1].get("ScheduledStartDate") or ""
            if last_date and last_date < "2026-01-01":
                break
            skip += PAGE
            if skip >= 50_000:
                break   # hard safety cap
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Aspire WorkTickets error: {e}")

    # Build OpportunityID → DivisionName lookup.
    # Two passes (recent-won desc + oldest-won asc) to maximise coverage
    # within Aspire's 500-record cap.
    opp_division: dict[str, str] = {}
    try:
        for order in ("WonDate desc", "WonDate asc"):
            batch = await _aspire._get_all("Opportunities", params={
                "$select": "OpportunityID,DivisionName",
                "$filter": "OpportunityStatusName eq 'Won'",
                "$top": "500",
                "$orderby": order,
            })
            for o in batch:
                oid = str(o.get("OpportunityID"))
                if oid not in opp_division:
                    opp_division[oid] = o.get("DivisionName") or ""
    except Exception:
        pass  # non-fatal

    tickets = []
    for t in raw:
        est_hrs = float(t.get("HoursEst") or 0)
        if est_hrs <= 0:
            continue
        # Prefer ScheduledStartDate → AnticStartDate → CompleteDate
        sched = t.get("ScheduledStartDate") or t.get("AnticStartDate") or t.get("CompleteDate")
        if not sched:
            continue
        # Ignore tickets outside 2026 (e.g. 2025 closed tickets)
        if not sched.startswith("2026"):
            continue
        opp_id   = str(t.get("OpportunityID") or "")
        division = opp_division.get(opp_id, "")
        tickets.append({
            "status":    t.get("WorkTicketStatusName") or "",
            "sched_date": sched[:10],
            "est_hrs":   est_hrs,
            "act_hrs":   float(t.get("HoursAct") or 0),
            "division":  division,
        })

    return {
        "count":        len(tickets),
        "work_tickets": tickets,
    }


# ── Sales Revenue (RevenueVariances) ──────────────────────────────────────────

@router.get("/sales/wt-revenue/probe")
async def get_wt_revenue_probe():
    """Probe WorkTicketRevenues — check fields, date range and sample values."""
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")
    try:
        data = await _aspire._get("WorkTicketRevenues", params={
            "$top": "10", "$orderby": "RevenueMonth desc"
        })
        records = _aspire._extract_list(data)
        from collections import defaultdict
        by_year: dict = defaultdict(int)
        for r in records:
            yr = (r.get("RevenueMonth") or "")[:4]
            by_year[yr] += 1
        return {
            "count": len(records),
            "all_fields": sorted(records[0].keys()) if records else [],
            "years_in_sample": dict(by_year),
            "sample": records,
        }
    except Exception as e:
        return {"error": str(e)}


@router.get("/sales/invoices/probe")
async def get_sales_invoices_probe():
    """Probe Invoices endpoint — show available fields and sample records."""
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")
    try:
        data = await _aspire._get("Invoices", params={
            "$top": "5", "$orderby": "InvoiceDate desc"
        })
        records = _aspire._extract_list(data)
        return {
            "count": len(records),
            "all_fields": sorted(records[0].keys()) if records else [],
            "sample": records,
        }
    except Exception as e:
        return {"error": str(e)}


@router.get("/sales/revenue/probe")
async def get_sales_revenue_probe():
    """Fetch up to 500 RevenueVariances and show year breakdown + sample per year."""
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")
    try:
        data = await _aspire._get("RevenueVariances", params={
            "$top": "500", "$orderby": "AdjustmentDate desc"
        })
        records = _aspire._extract_list(data)
        from collections import defaultdict
        by_year: dict = defaultdict(list)
        for r in records:
            yr = (r.get("AdjustmentDate") or "unknown")[:4]
            by_year[yr].append(r)
        return {
            "total_fetched": len(records),
            "years_found": {yr: len(rows) for yr, rows in sorted(by_year.items())},
            "sample_newest_5": records[:5],
            "all_fields": sorted(records[0].keys()) if records else [],
        }
    except Exception as e:
        return {"error": str(e)}


@router.get("/sales/revenue")
async def get_sales_revenue():
    """
    Monthly earned revenue by division from Aspire RevenueVariances.
    Returns { revenue: { "2026-01": { constrRev, maintRev }, ... } }
    """
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")

    # ContractYear is a contract-sequence number (1, 2…), NOT a calendar year.
    # Filter by AdjustmentDate in Python; order desc so 2026 rows come first
    # and we can exit early once we fall into prior years.
    SELECT = "AdjustmentDate,DivisionName,EarnedRevenue"
    PAGE   = 500
    raw: list = []
    try:
        skip = 0
        while True:
            page_data = await _aspire._get("RevenueVariances", params={
                "$select":  SELECT,
                "$top":     str(PAGE),
                "$skip":    str(skip),
                "$orderby": "AdjustmentDate desc",
            })
            records = _aspire._extract_list(page_data)
            raw.extend(records)
            if len(records) < PAGE:
                break
            # Early exit: last record on this page is before 2026
            last_date = records[-1].get("AdjustmentDate") or ""
            if last_date and last_date < "2026-01-01":
                break
            skip += PAGE
            if skip >= 50_000:
                break
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Aspire RevenueVariances error: {e}")

    # Aggregate EarnedRevenue by month-key and division type
    from collections import defaultdict
    monthly: dict = defaultdict(lambda: {"constrRev": 0.0, "maintRev": 0.0})

    def _is_construction(name: str) -> bool:
        return "construction" in (name or "").lower()

    def _is_maintenance(name: str) -> bool:
        s = (name or "").lower()
        return ("maintenance" in s or "irrigation" in s or "lighting" in s
                or "residential" in s or "commercial" in s)

    for r in raw:
        adj_date = r.get("AdjustmentDate") or ""
        if not adj_date:
            continue
        mk = adj_date[:7]          # "2026-03"
        if not mk.startswith("2026"):
            continue
        earned = float(r.get("EarnedRevenue") or 0)
        div    = r.get("DivisionName") or ""
        if _is_construction(div):
            monthly[mk]["constrRev"] += earned
        elif _is_maintenance(div):
            monthly[mk]["maintRev"] += earned

    return {
        "count":   len(raw),
        "revenue": dict(monthly),
    }


# ── Activities Dashboard ───────────────────────────────────────────────────────

@router.get("/activities/probe")
async def activities_probe():
    result = {}
    try:
        data = await _aspire._get("Activities", {"$top": "3", "$orderby": "DueDate asc"})
        recs = _aspire._extract_list(data)
        result["get_activities"] = "OK"
        result["count"] = len(recs)
        result["fields"] = sorted(recs[0].keys()) if recs else []
        result["samples"] = recs
        # summarise unique values
        result["statuses"]  = list({r.get("Status")       for r in recs if r.get("Status")})
        result["types"]     = list({r.get("ActivityType") for r in recs if r.get("ActivityType")})
        result["priorities"]= list({r.get("Priority")     for r in recs if r.get("Priority")})
    except Exception as e:
        result["get_activities"] = f"FAILED: {e}"
    return result


@router.get("/activities")
async def get_activities_dashboard(show_completed: bool = False):
    from datetime import datetime, timezone, timedelta
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")

    try:
        raw = await _aspire._get_all("Activities", {
            "$select": (
                "ActivityID,ActivityNumber,Subject,ActivityType,Status,Priority,"
                "Notes,StartDate,EndDate,DueDate,CompleteDate,CreatedDate,ModifiedDate,"
                "CreatedByUserName,CompletedByUserName,"
                "PropertyID,OpportunityID,WorkTicketID,"
                "ActivityCategoryName,IsMileStone,Private"
            ),
            "$top": "500",
            "$orderby": "DueDate asc",
        })
        logger.info(f"Activities dashboard: fetched {len(raw)} total from Aspire")
    except Exception as e:
        logger.error(f"Activities fetch failed: {e}")
        raise HTTPException(status_code=502, detail=f"Aspire API error: {e}")

    # Filter completed/cancelled unless show_completed=True
    def is_active(a: dict) -> bool:
        if show_completed:
            return True
        status = (a.get("Status") or "").strip().lower()
        return "complet" not in status and "closed" not in status and "cancel" not in status

    activities = [a for a in raw if is_active(a)]

    now = datetime.now(timezone.utc)
    week_end = now + timedelta(days=7)

    def parse_dt(s):
        if not s:
            return None
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
        except Exception:
            return None

    def urgency(due_dt) -> str:
        if due_dt is None:
            return "no-date"
        d = (due_dt - now).days
        if d < 0:   return "overdue"
        if d <= 7:  return "urgent"
        if d <= 30: return "soon"
        return "ok"

    shaped = []
    for a in activities:
        due_dt     = parse_dt(a.get("DueDate"))
        created_dt = parse_dt(a.get("CreatedDate"))
        modified_dt= parse_dt(a.get("ModifiedDate"))
        urg        = urgency(due_dt)
        due_days   = int((due_dt - now).days) if due_dt else None

        shaped.append({
            "id":            a.get("ActivityID"),
            "number":        a.get("ActivityNumber"),
            "subject":       a.get("Subject") or "(no subject)",
            "activity_type": a.get("ActivityType") or "Unknown",
            "status":        a.get("Status") or "",
            "priority":      a.get("Priority") or "",
            "category":      a.get("ActivityCategoryName") or "",
            "notes":         (a.get("Notes") or "")[:200],   # truncate for perf
            "due_date":      due_dt.date().isoformat()      if due_dt      else None,
            "start_date":    parse_dt(a.get("StartDate")).date().isoformat() if parse_dt(a.get("StartDate")) else None,
            "complete_date": parse_dt(a.get("CompleteDate")).date().isoformat() if parse_dt(a.get("CompleteDate")) else None,
            "created_date":  created_dt.date().isoformat()  if created_dt  else None,
            "modified_date": modified_dt.date().isoformat() if modified_dt else None,
            "created_by":    a.get("CreatedByUserName") or "",
            "completed_by":  a.get("CompletedByUserName") or "",
            "opportunity_id":a.get("OpportunityID"),
            "work_ticket_id":a.get("WorkTicketID"),
            "is_milestone":  bool(a.get("IsMileStone")),
            "days_until_due":due_days,
            "urgency":       urg,
            "_is_overdue":   urg == "overdue",
            "_due_this_week":due_dt is not None and now <= due_dt <= week_end,
        })

    summary = {
        "total":         len(shaped),
        "overdue":       sum(1 for s in shaped if s["_is_overdue"]),
        "due_this_week": sum(1 for s in shaped if s["_due_this_week"]),
        "milestones":    sum(1 for s in shaped if s["is_milestone"]),
    }

    activity_types = sorted({s["activity_type"] for s in shaped if s["activity_type"] and s["activity_type"] != "Unknown"})
    statuses       = sorted({s["status"]         for s in shaped if s["status"]})
    priorities     = sorted({s["priority"]        for s in shaped if s["priority"]})
    categories     = sorted({s["category"]        for s in shaped if s["category"]})
    created_by_list= sorted({s["created_by"]      for s in shaped if s["created_by"]})

    # Strip internal keys before returning
    def clean(a: dict) -> dict:
        return {k: v for k, v in a.items() if not k.startswith("_")}

    return {
        "summary":        summary,
        "activity_types": activity_types,
        "statuses":       statuses,
        "priorities":     priorities,
        "categories":     categories,
        "created_by_list":created_by_list,
        "activities":     [clean(a) for a in shaped],
    }
