"""
Construction Division Dashboard API.
GET /dashboard/construction          — all jobs + targets
GET /dashboard/construction/{id}/tickets — work tickets for one job
"""
import logging
import re
import asyncio
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


@router.get("/probe/work-ticket/{wt_num}")
async def probe_work_ticket(wt_num: int, by_id: bool = False):
    """
    Diagnostic: look up a WorkTicket by WorkTicketNumber (default) or WorkTicketID (by_id=true).
    Then fetches the linked Opportunity to show DivisionName.
    """
    try:
        field = "WorkTicketID" if by_id else "WorkTicketNumber"
        result = await _aspire._get("WorkTickets", {
            "$filter": f"{field} eq {wt_num}",
            "$top": "1",
        })
        records = _aspire._extract_list(result)
        if not records:
            return {"found": False, field: wt_num}
        rec = records[0]
        out = {
            "found": True,
            "WorkTicketID":     rec.get("WorkTicketID"),
            "WorkTicketNumber": rec.get("WorkTicketNumber"),
            "OpportunityID":    rec.get("OpportunityID"),
            "OpportunityNumber":rec.get("OpportunityNumber"),
            "DivisionName_on_ticket": rec.get("DivisionName"),
            "ticket_fields": sorted(rec.keys()),
        }
        # Now look up the Opportunity to get DivisionName
        opp_id = rec.get("OpportunityID")
        if opp_id:
            try:
                opp_res = await _aspire._get("Opportunities", {
                    "$filter": f"OpportunityID eq {opp_id}",
                    "$top": "1",
                })
                opps = _aspire._extract_list(opp_res)
                if opps:
                    opp = opps[0]
                    out["opportunity"] = {
                        "OpportunityID":   opp.get("OpportunityID"),
                        "OpportunityName": opp.get("OpportunityName"),
                        "DivisionName":    opp.get("DivisionName"),
                        "DivisionID":      opp.get("DivisionID"),
                    }
            except Exception as e:
                out["opportunity_error"] = str(e)
        return out
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/probe/division-trace/{wt_number}")
async def probe_division_trace(wt_number: int, date: str = Query(None)):
    """
    Trace exactly why a ticket ends up in 'Other'.
    Steps through the same logic as the daily report: WorkTicketTimes → WorkTicket → Opportunity.
    wt_number = the WorkTicketNumber shown in Aspire UI.
    """
    from datetime import date as _date_cls, timedelta as _td, timezone, timedelta
    target = date or _date_cls.today().isoformat()
    tz_offset = getattr(settings, "REPORT_TZ_OFFSET", -7)
    if not date:
        from datetime import datetime
        target = datetime.now(timezone(timedelta(hours=tz_offset))).strftime("%Y-%m-%d")

    _next = _date_cls.fromisoformat(target) + _td(days=1)
    day_start_z = f"{target}T08:00:00Z"
    day_end_z   = f"{_next.isoformat()}T07:59:59Z"

    out: dict = {"target": target, "wt_number": wt_number, "steps": {}}

    # Step 1: find internal WorkTicketID
    try:
        r = await _aspire._get("WorkTickets", {"$filter": f"WorkTicketNumber eq {wt_number}", "$top": "1"})
        recs = _aspire._extract_list(r)
        if not recs:
            return {**out, "error": "WorkTicketNumber not found"}
        rec = recs[0]
        wt_id  = rec.get("WorkTicketID")
        opp_id = rec.get("OpportunityID")
        out["steps"]["1_ticket"] = {"WorkTicketID": wt_id, "OpportunityID": opp_id,
                                    "StatusName": rec.get("WorkTicketStatusName")}
    except Exception as e:
        return {**out, "error": f"Step 1 failed: {e}"}

    # Step 2: check WorkTicketTimes across a wide window to find where this ticket's entries actually live
    try:
        _prev = (_date_cls.fromisoformat(target) - _td(days=1)).isoformat()
        wide_start = f"{_prev}T00:00:00Z"
        wide_end   = f"{(_date_cls.fromisoformat(target) + _td(days=2)).isoformat()}T00:00:00Z"
        times = await _aspire._get_all("WorkTicketTimes", {
            "$filter": f"StartTime ge {wide_start} and StartTime le {wide_end}",
            "$top": "1000",
        })
        matching = [t for t in times if t.get("WorkTicketID") == wt_id]
        in_window   = [t for t in times if t.get("StartTime", "").startswith(target)]
        out["steps"]["2_time_entries"] = {
            "wide_window": f"{wide_start} → {wide_end}",
            "total_in_wide_window": len(times),
            "matching_this_ticket": len(matching),
            "in_target_date_window": len(in_window),
            "this_ticket_start_times": [t.get("StartTime") for t in matching],
        }
    except Exception as e:
        out["steps"]["2_time_entries"] = {"error": str(e)}

    # Step 3: fetch WorkTicket by internal ID using in() filter (same as Pass 3 code)
    try:
        r2 = await _aspire._get("WorkTickets", {"$filter": f"WorkTicketID in ({wt_id})", "$top": "5"})
        recs2 = _aspire._extract_list(r2)
        out["steps"]["3_wt_by_id_in_filter"] = {
            "count": len(recs2),
            "OpportunityID": recs2[0].get("OpportunityID") if recs2 else None,
        }
    except Exception as e:
        out["steps"]["3_wt_by_id_in_filter"] = {"error": str(e)}

    # Step 4: fetch Opportunity using in() filter (same as report code)
    try:
        r3 = await _aspire._get("Opportunities", {"$filter": f"OpportunityID in ({opp_id})", "$top": "5"})
        opps = _aspire._extract_list(r3)
        out["steps"]["4_opp_in_filter"] = {
            "count": len(opps),
            "DivisionName": opps[0].get("DivisionName") if opps else None,
            "OpportunityName": opps[0].get("OpportunityName") if opps else None,
        }
    except Exception as e:
        out["steps"]["4_opp_in_filter"] = {"error": str(e)}

    return out


@router.get("/probe/clock-times")
async def probe_clock_times(date: str = Query(None)):
    """
    Diagnostic: fetch raw ClockTimes records and try multiple filters.
    Returns field names + sample records so we can identify the correct filter field.
    """
    from datetime import date as _date
    target = date or _date.today().isoformat()
    results = {}

    # Try each filter variant
    filters = [
        ("no_filter_top3",         {}),
        ("date_eq",                {"$filter": f"Date eq {target}"}),
        ("date_ge_le",             {"$filter": f"Date ge {target} and Date le {target}"}),
        ("clock_start_range",      {"$filter": f"ClockStartDateTime ge {target}T00:00:00Z and ClockStartDateTime le {target}T23:59:59Z"}),
        ("clock_start_date_func",  {"$filter": f"Date(ClockStartDateTime) eq {target}"}),
    ]

    for label, params in filters:
        try:
            params["$top"] = "3"
            raw = await _aspire._get("ClockTimes", params)
            records = _aspire._extract_list(raw)
            results[label] = {
                "count": len(records),
                "fields": sorted(records[0].keys()) if records else [],
                "sample": records[:2] if records else [],
            }
        except Exception as e:
            results[label] = {"error": str(e)}

    return results


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

            co_won     = sum(float(c.get("WonDollars")                  or 0) for c in cos)
            co_est     = sum(float(c.get("EstimatedDollars")             or 0) for c in cos)
            co_est_gm  = sum(float(c.get("EstimatedGrossMarginDollars")  or 0) for c in cos)
            co_act_rev = sum(float(c.get("ActualEarnedRevenue")          or 0) for c in cos)
            co_act_gm  = sum(float(c.get("ActualGrossMarginDollars")     or 0) for c in cos)
            co_est_hrs = sum(float(c.get("EstimatedLaborHours")          or 0) for c in cos)
            co_act_hrs = sum(float(c.get("ActualLaborHours")             or 0) for c in cos)

            parent["WonDollars"]                  = float(parent.get("WonDollars")                  or 0) + co_won
            parent["EstimatedDollars"]            = float(parent.get("EstimatedDollars")            or 0) + co_est
            parent["EstimatedGrossMarginDollars"] = float(parent.get("EstimatedGrossMarginDollars") or 0) + co_est_gm
            parent["ActualEarnedRevenue"]         = float(parent.get("ActualEarnedRevenue")         or 0) + co_act_rev
            parent["ActualGrossMarginDollars"]    = float(parent.get("ActualGrossMarginDollars")    or 0) + co_act_gm
            parent["EstimatedLaborHours"]         = float(parent.get("EstimatedLaborHours")         or 0) + co_est_hrs
            parent["ActualLaborHours"]            = float(parent.get("ActualLaborHours")            or 0) + co_act_hrs

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


@router.get("/aspire/auth-probe")
async def aspire_auth_probe():
    """
    Probe Aspire /Authorization directly and return the raw response body
    regardless of status code — useful for diagnosing credential issues.
    """
    import httpx as _httpx
    base = _aspire.base_url
    try:
        async with _httpx.AsyncClient(timeout=15) as c:
            resp = await c.post(
                f"{base}/Authorization",
                json={
                    "ClientId": settings.ASPIRE_CLIENT_ID,
                    "Secret":   settings.ASPIRE_CLIENT_SECRET,
                },
            )
        return {
            "status_code":    resp.status_code,
            "response_body":  resp.text[:2000],
            "client_id_set":  bool(settings.ASPIRE_CLIENT_ID),
            "secret_set":     bool(settings.ASPIRE_CLIENT_SECRET),
            "client_id_len":  len(settings.ASPIRE_CLIENT_ID or ""),
            "base_url":       base,
        }
    except Exception as e:
        return {"error": str(e)}


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


@router.get("/estimating/tags-probe")
async def estimating_tags_probe():
    """
    Diagnostic: fetches first 10 properties that have non-empty Tags and returns
    the raw Tags value so we can see exactly how Aspire structures the field.
    """
    try:
        # No $select — PropertyTags is a nested field that can't be selected individually
        props = await _aspire._get_all("Properties", {"$top": "500"})
    except Exception as e:
        return {"error": str(e)}

    with_tags = [p for p in props if p.get("PropertyTags")]
    tier1_matches = []
    for p in props:
        for tag in (p.get("PropertyTags") or []):
            tag_str = str(tag).lower()
            if "tier 1" in tag_str:
                tier1_matches.append(p.get("PropertyName"))
                break
    return {
        "total_properties_fetched": len(props),
        "properties_with_tags": len(with_tags),
        "tier1_matches": len(tier1_matches),
        "tier1_property_names": tier1_matches,
        "sample_tagged_properties": [
            {"PropertyName": p.get("PropertyName"), "PropertyTags": p.get("PropertyTags")}
            for p in with_tags[:5]
        ],
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

    import asyncio

    async def _fetch_opps():
        return await _aspire._get_all("Opportunities", {
            "$select": (
                "OpportunityID,OpportunityNumber,OpportunityName,PropertyName,DivisionName,DivisionID,"
                "SalesRepContactName,SalesRepContactID,"
                "OpportunityStatusName,OpportunityStatusID,"
                "OpportunityType,SalesTypeName,SalesTypeID,"
                "EstimatedDollars,BidDueDate,StartDate,CreatedDateTime,ModifiedDate,WonDate,LostDate,"
                "ProposedDate,AnticipatedCloseDate"
            ),
            "$filter": "OpportunityStatusName ne 'Won' and OpportunityStatusName ne 'Lost'",
            "$top": "500",
            "$orderby": "CreatedDateTime desc",
        })

    async def _fetch_tier1_names() -> set[str]:
        """Return lowercase property names that carry a 'Tier 1' tag.
        PropertyTags is a nested field — must fetch without $select.
        """
        try:
            props = await _aspire._get_all("Properties", {"$top": "500"})
        except Exception as e:
            logger.warning(f"Tier 1 properties fetch failed: {e}")
            return set()
        names: set[str] = set()
        for p in props:
            for tag in (p.get("PropertyTags") or []):
                # tag may be a string, or a dict like {"TagName": "Tier 1", ...}
                tag_str = (
                    tag.get("TagName") or tag.get("Name") or str(tag)
                    if isinstance(tag, dict) else str(tag)
                )
                if "tier 1" in tag_str.lower():
                    pname = (p.get("PropertyName") or "").strip()
                    if pname:
                        names.add(pname.lower())
                    break
        logger.info(f"Tier 1 properties found: {len(names)}")
        return names

    try:
        raw_opps, tier1_names = await asyncio.gather(_fetch_opps(), _fetch_tier1_names())
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

    # ── Staleness thresholds ──────────────────────────────────────────────────
    TIER1_LIMIT    = 14   # days: Tier 1 turnaround must be ≤ this
    STANDARD_LIMIT = 28   # days: standard turnaround must be ≤ this
    WARNING_BUFFER = 3    # days before limit → show warning

    # ── Shape each opportunity ────────────────────────────────────────────────
    shaped = []
    for o in opps:
        due_dt          = parse_date(o.get("BidDueDate"))
        created_dt      = parse_date(o.get("CreatedDateTime"))
        proposed_dt     = parse_date(o.get("ProposedDate"))
        start_dt        = parse_date(o.get("StartDate"))
        last_modified_dt = parse_date(o.get("ModifiedDate"))

        urg      = urgency(due_dt)
        due_days = days_until(due_dt)
        is_tier1 = (o.get("PropertyName") or "").strip().lower() in tier1_names
        limit    = TIER1_LIMIT if is_tier1 else STANDARD_LIMIT
        days_open = days_since(created_dt)

        # ── Staleness alerts ──────────────────────────────────────────────────
        alerts: list[str] = []
        alert_level = "ok"   # ok | warning | overdue

        if proposed_dt is None:
            # Not yet delivered to client
            if days_open > limit:
                alerts.append(
                    f"Turnaround overdue: open {days_open}d (limit {limit}d)"
                )
                alert_level = "overdue"
            elif days_open >= limit - WARNING_BUFFER:
                alerts.append(
                    f"Turnaround due soon: open {days_open}d (limit {limit}d)"
                )
                alert_level = "warning"

            # Bid due date alerts (independent of turnaround)
            if due_dt is not None:
                bid_days = days_until(due_dt)
                if bid_days is not None and bid_days < 0:
                    alerts.append(
                        f"Bid due date passed {abs(bid_days)}d ago — not yet proposed"
                    )
                    alert_level = "overdue"
                elif bid_days is not None and 0 <= bid_days <= 3:
                    alerts.append(
                        f"Bid due in {bid_days}d — not yet proposed"
                    )
                    if alert_level == "ok":
                        alert_level = "warning"

        turnaround_days = (
            (proposed_dt - created_dt).days
            if proposed_dt and created_dt else None
        )

        shaped.append({
            "id":                 o.get("OpportunityID"),
            "opp_number":         o.get("OpportunityNumber"),
            "name":               o.get("OpportunityName") or "(no name)",
            "property":           o.get("PropertyName") or "",
            "division":           o.get("DivisionName") or "",
            "opp_type":           o.get("OpportunityType") or "Unknown",
            "sales_type":         o.get("SalesTypeName") or "",
            "status":             o.get("OpportunityStatusName") or "",
            "created_date":       (created_dt.date().isoformat()       if created_dt       else None),
            "due_date":           (due_dt.date().isoformat()           if due_dt           else None),
            "proposed_date":      (proposed_dt.date().isoformat()      if proposed_dt      else None),
            "start_date":         (start_dt.date().isoformat()         if start_dt         else None),
            "last_activity_date": (last_modified_dt.date().isoformat() if last_modified_dt else None),
            "estimated_value":    float(o.get("EstimatedDollars") or 0),
            "days_old":           days_open,
            "days_until_due":     due_days,
            "turnaround_days":    turnaround_days,
            "turnaround_limit":   limit,
            "urgency":            urg,
            "alert_level":        alert_level,
            "alerts":             alerts,
            "is_tier1":           is_tier1,
            "_salesperson":       (o.get("SalesRepContactName") or "Unassigned").strip(),
            "_salesperson_id":    o.get("SalesRepContactID"),
            "_stage":             o.get("OpportunityStatusName") or "Unknown",
            "_is_overdue":        urg == "overdue",
            "_due_this_week":     due_dt is not None and now <= due_dt <= week_end,
            "_has_alert":         alert_level in ("warning", "overdue"),
        })

    # ── Summary stats ─────────────────────────────────────────────────────────
    summary = {
        "total":                  len(shaped),
        "total_value":            sum(s["estimated_value"] for s in shaped),
        "overdue":                sum(1 for s in shaped if s["_is_overdue"]),
        "due_this_week":          sum(1 for s in shaped if s["_due_this_week"]),
        "tier1_count":            sum(1 for s in shaped if s["is_tier1"]),
        "alert_overdue":          sum(1 for s in shaped if s["alert_level"] == "overdue"),
        "alert_warning":          sum(1 for s in shaped if s["alert_level"] == "warning"),
        "tier1_overdue":          sum(1 for s in shaped if s["is_tier1"] and s["alert_level"] == "overdue"),
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
            "name":          name,
            "total":         len(opps_list),
            "total_value":   sum(o["estimated_value"] for o in opps_list),
            "overdue":       sum(1 for o in opps_list if o["_is_overdue"]),
            "alert_overdue": sum(1 for o in opps_list if o["alert_level"] == "overdue"),
            "alert_warning": sum(1 for o in opps_list if o["alert_level"] == "warning"),
            "stages":        stages,
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


# ── Estimating Digest Email ───────────────────────────────────────────────────

@router.post("/estimating/send-digest")
async def send_estimating_digest():
    """
    Send each salesperson a personalised HTML email listing their overdue /
    at-risk open estimates.  Only salespeople with at least one alert get an email.

    Rules:
      • Tier 1 property → turnaround limit 14 days
      • All others      → turnaround limit 28 days
      • Warning zone    → within 3 days of the limit
      • Bid due soon    → BidDueDate ≤ 3 days away, not yet proposed
      • Bid overdue     → BidDueDate passed, not yet proposed
    """
    from datetime import datetime, timezone, timedelta
    from app.services.email_intake import GraphClient
    from app.core.config import settings as cfg

    if not cfg.ASPIRE_CLIENT_ID or not cfg.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")

    TIER1_LIMIT    = 14
    STANDARD_LIMIT = 28
    WARNING_BUFFER = 3

    now = datetime.now(timezone.utc)

    def parse_dt(s):
        if not s:
            return None
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
        except Exception:
            return None

    import asyncio

    # Fetch opportunities + Tier1 set + employee emails in parallel
    async def _fetch_opps():
        return await _aspire._get_all("Opportunities", {
            "$select": (
                "OpportunityID,OpportunityNumber,OpportunityName,PropertyName,"
                "SalesRepContactName,SalesRepContactID,"
                "OpportunityStatusName,EstimatedDollars,"
                "BidDueDate,CreatedDateTime,ProposedDate,ModifiedDate"
            ),
            "$filter": "OpportunityStatusName ne 'Won' and OpportunityStatusName ne 'Lost'",
            "$top": "500",
            "$orderby": "CreatedDateTime desc",
        })

    async def _fetch_tier1():
        try:
            props = await _aspire._get_all("Properties", {"$top": "500"})
        except Exception:
            return set()
        names: set[str] = set()
        for p in props:
            for tag in (p.get("PropertyTags") or []):
                tag_str = (tag.get("TagName") or str(tag)) if isinstance(tag, dict) else str(tag)
                if "tier 1" in tag_str.lower():
                    pname = (p.get("PropertyName") or "").strip()
                    if pname:
                        names.add(pname.lower())
                    break
        return names

    async def _fetch_emails():
        try:
            employees = await _aspire.get_aspire_employees()
            return {
                str(e.get("ContactID")): e.get("Email") or ""
                for e in employees
                if e.get("ContactID")
            }
        except Exception as e:
            logger.warning(f"Could not fetch employee emails: {e}")
            return {}

    raw_opps, tier1_names, contact_emails = await asyncio.gather(
        _fetch_opps(), _fetch_tier1(), _fetch_emails()
    )

    # ── Compute alerts per opportunity ────────────────────────────────────────
    flagged_by_person: dict[str, dict] = {}  # name → {email, opps: []}

    for o in raw_opps:
        status = (o.get("OpportunityStatusName") or "").lower()
        if "won" in status or "lost" in status:
            continue
        if not (o.get("PropertyName") or "").strip():
            continue

        created_dt  = parse_dt(o.get("CreatedDateTime"))
        proposed_dt = parse_dt(o.get("ProposedDate"))
        due_dt      = parse_dt(o.get("BidDueDate"))
        is_tier1    = (o.get("PropertyName") or "").strip().lower() in tier1_names
        limit       = TIER1_LIMIT if is_tier1 else STANDARD_LIMIT
        days_open   = max(0, (now - created_dt).days) if created_dt else 0

        alerts: list[str] = []
        if proposed_dt is None:
            if days_open > limit:
                alerts.append(f"⛔ Turnaround overdue — open {days_open} days (limit {limit}d)")
            elif days_open >= limit - WARNING_BUFFER:
                alerts.append(f"⚠️ Turnaround due soon — open {days_open} days (limit {limit}d)")
            if due_dt:
                bid_days = (due_dt - now).days
                if bid_days < 0:
                    alerts.append(f"⛔ Bid due date passed {abs(bid_days)} day(s) ago — not yet proposed")
                elif 0 <= bid_days <= 3:
                    alerts.append(f"⚠️ Bid due in {bid_days} day(s) — not yet proposed")

        if not alerts:
            continue

        sp_name = (o.get("SalesRepContactName") or "Unassigned").strip()
        sp_id   = str(o.get("SalesRepContactID") or "")
        sp_email = contact_emails.get(sp_id, "")

        if sp_name not in flagged_by_person:
            flagged_by_person[sp_name] = {"email": sp_email, "opps": []}

        flagged_by_person[sp_name]["opps"].append({
            "name":       o.get("OpportunityName") or "(no name)",
            "property":   o.get("PropertyName") or "",
            "number":     o.get("OpportunityNumber") or "",
            "value":      float(o.get("EstimatedDollars") or 0),
            "days_open":  days_open,
            "due_date":   due_dt.date().isoformat() if due_dt else None,
            "is_tier1":   is_tier1,
            "alerts":     alerts,
        })

    if not flagged_by_person:
        return {"ok": True, "sent": 0, "message": "No alerts — all estimates on track!"}

    # ── Send one email per salesperson ────────────────────────────────────────
    if not cfg.MS_TENANT_ID or not cfg.MS_CLIENT_ID or not cfg.MS_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Microsoft Graph credentials not configured")

    graph   = GraphClient()
    mailbox = cfg.MS_AP_INBOX
    sent: list[str] = []
    skipped: list[str] = []

    today_str = now.strftime("%B %d, %Y")

    for sp_name, data in flagged_by_person.items():
        sp_email = data["email"]
        if not sp_email:
            skipped.append(sp_name)
            logger.warning(f"Digest: no email found for salesperson '{sp_name}' — skipping")
            continue

        opps = data["opps"]
        overdue_count = sum(1 for o in opps if any("⛔" in a for a in o["alerts"]))
        warning_count = len(opps) - overdue_count

        # Build rows HTML
        rows_html = ""
        for opp in sorted(opps, key=lambda x: -x["days_open"]):
            tier1_badge = '<span style="background:#d97706;color:#fff;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700;margin-left:6px">T1</span>' if opp["is_tier1"] else ""
            alerts_html = "".join(f'<div style="margin-top:4px;font-size:13px">{a}</div>' for a in opp["alerts"])
            due_str = f'<span style="color:#6b7280;font-size:12px">  ·  Due {opp["due_date"]}</span>' if opp["due_date"] else ""
            value_str = f'${opp["value"]:,.0f}' if opp["value"] else "—"
            rows_html += f"""
            <tr>
              <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;vertical-align:top">
                <div style="font-weight:600;color:#111">{opp['property']}{tier1_badge}</div>
                <div style="color:#374151;font-size:13px;margin-top:2px">{opp['name']}{due_str}</div>
                {alerts_html}
              </td>
              <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;text-align:right;white-space:nowrap;vertical-align:top">
                <div style="font-weight:600">{value_str}</div>
                <div style="color:#6b7280;font-size:12px">{opp['days_open']}d open</div>
              </td>
            </tr>"""

        body_html = f"""
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto">
          <div style="background:#0f172a;padding:20px 24px;border-radius:8px 8px 0 0">
            <h2 style="margin:0;color:#fff;font-size:18px">📋 Estimating Digest — {today_str}</h2>
            <p style="margin:4px 0 0;color:#94a3b8;font-size:13px">Hi {sp_name.split()[0]}, here are your estimates that need attention</p>
          </div>
          <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:16px 24px">
            <div style="display:flex;gap:12px;margin-bottom:16px">
              {"" if not overdue_count else f'<span style="background:#fee2e2;color:#dc2626;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600">⛔ {overdue_count} Overdue</span>'}
              {"" if not warning_count else f'<span style="background:#fef3c7;color:#d97706;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600">⚠️ {warning_count} Warning</span>'}
            </div>
            <table style="width:100%;border-collapse:collapse">
              {rows_html}
            </table>
            <p style="margin:16px 0 0;color:#9ca3af;font-size:12px">
              Turnaround targets: Tier 1 ≤ 14 days · Standard ≤ 28 days<br>
              This digest is sent automatically each morning.
            </p>
          </div>
        </div>"""

        try:
            await graph.send_email(
                mailbox=mailbox,
                to_addresses=[sp_email],
                subject=f"📋 Estimating Digest {today_str} — {len(opps)} estimate(s) need attention",
                body_html=body_html,
            )
            sent.append(sp_name)
            logger.info(f"Digest sent to {sp_name} <{sp_email}> ({len(opps)} alerts)")
        except Exception as e:
            logger.error(f"Digest email failed for {sp_name} <{sp_email}>: {e}")
            skipped.append(sp_name)

    return {
        "ok":      True,
        "sent":    len(sent),
        "skipped": len(skipped),
        "recipients": sent,
        "no_email":   skipped,
        "total_flagged_opps": sum(len(d["opps"]) for d in flagged_by_person.values()),
    }


# ── Issues Digest Email ───────────────────────────────────────────────────────

@router.get("/activities/send-issues-digest")
async def send_issues_digest():
    """
    Send a daily Issues digest:
    • Management summary email (all assignees, AI-generated highlights)
    • Individual digest per assignee (their new / updated / closed issues)

    Classification window: 24 hours.
    NEW     — CreatedDate within 24 h
    CLOSED  — CompleteDate within 24 h
    UPDATED — ModifiedDate within 24 h, not new, not closed
    """
    import re as _re
    import asyncio
    import traceback
    from datetime import datetime, timezone, timedelta
    from app.services.email_intake import GraphClient
    from app.core.config import settings as cfg

    if not cfg.ASPIRE_CLIENT_ID or not cfg.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")
    if not cfg.MS_TENANT_ID or not cfg.MS_CLIENT_ID or not cfg.MS_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Microsoft Graph credentials not configured")

    try:
     return await _issues_digest_body(cfg, asyncio, _re, timedelta, datetime, timezone, GraphClient, traceback)
    except HTTPException:
        raise
    except Exception as exc:
        tb = traceback.format_exc()
        logger.error(f"Issues digest unhandled error: {exc}\n{tb}")
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


async def _issues_digest_body(cfg, asyncio, _re, timedelta, datetime, timezone, GraphClient, traceback):
    now       = datetime.now(timezone.utc)
    yesterday = now - timedelta(hours=24)
    today_str = now.strftime("%B %d, %Y")

    def _pdt(s):
        if not s: return None
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
        except Exception:
            return None

    # ── Fetch raw activities ──────────────────────────────────────────────────
    raw = await _aspire._get_all("Activities", {
        "$select": (
            "ActivityID,Subject,ActivityType,Status,Priority,Notes,"
            "DueDate,CompleteDate,CreatedDate,ModifiedDate,"
            "PropertyID,OpportunityID,WorkTicketID,ActivityCategoryName,IsMileStone"
        ),
        "$filter": "CreatedDate ge 2026-01-01T00:00:00Z",
        "$top":    "500",
        "$orderby": "ModifiedDate desc",
    })

    # ── Parse HTML notes ─────────────────────────────────────────────────────
    def _parse_html(html: str) -> dict:
        out = {"issue_number": None, "issue_url": None, "assigned_to": [],
               "status": "", "priority": "", "comments": [], "due_date_str": None}
        if not html: return out
        m = _re.search(r'<b>Issue\s*#</b></td><td[^>]*><a\s+href="([^"]+)"[^>]*>(\d+)</a>',
                       html, _re.IGNORECASE | _re.DOTALL)
        if m:
            out["issue_url"]    = m.group(1)
            out["issue_number"] = int(m.group(2))
        def _cell(label):
            m2 = _re.search(rf'<b>{label}</b></td><td[^>]*>(.*?)</td>', html, _re.IGNORECASE | _re.DOTALL)
            return _re.sub(r'<[^>]+>', ' ', m2.group(1)).strip() if m2 else ""
        raw_asgn = _cell("Assigned To")
        out["assigned_to"] = [x.strip() for x in _re.split(r'[\n,]+', raw_asgn) if x.strip()]
        out["status"]   = _cell("Status") or "Open"
        out["priority"] = _cell("Priority")
        if _cell("Complete Date").strip():
            out["status"] = "Complete"
        raw_due = _cell("Due Date")
        if raw_due:
            try:
                from datetime import datetime as _dt2
                out["due_date_str"] = _dt2.strptime(raw_due.strip(), "%m/%d/%y").strftime("%Y-%m-%d")
            except Exception:
                pass
        # newest comment (first in list)
        cs = _re.search(r'Issue Comment History</h3>(.*)', html, _re.IGNORECASE | _re.DOTALL)
        if cs:
            rows = _re.findall(r'<tr>(.*?)</tr>', cs.group(1), _re.DOTALL)
            for row in rows:
                cells = _re.findall(r'<td[^>]*>(.*?)</td>', row, _re.DOTALL)
                if len(cells) >= 2:
                    comment = _re.sub(r'<[^>]+>', '', cells[1]).strip()
                    if comment and comment != 'Comment':
                        out["comments"].append(comment)
                        break
        return out

    # Pre-parse all
    parsed_cache: dict[int, dict] = {
        a["ActivityID"]: _parse_html(a.get("Notes") or "")
        for a in raw if a.get("ActivityID")
    }

    # Best assigned_to per issue_number
    _best_asgn: dict[int, list] = {}
    for aid in sorted(parsed_cache.keys(), reverse=True):
        p = parsed_cache[aid]
        inum = p.get("issue_number")
        if inum and p.get("assigned_to") and inum not in _best_asgn:
            _best_asgn[inum] = p["assigned_to"]

    # ── Deduplicate: keep highest-ID record (most recent) per issue_number ────
    # Also track the LOWEST-ID record — its CreatedDate is when the issue was
    # actually first opened (not when the latest comment was added).
    seen: dict[int, dict] = {}
    _first_seen: dict[int, dict] = {}  # issue_number → oldest activity record
    for a in raw:
        if _re.search(r'Time\s*Adjustment', a.get("Subject") or "", _re.IGNORECASE):
            continue
        pnum = parsed_cache.get(a.get("ActivityID"), {}).get("issue_number")
        if pnum is not None:
            aid = a.get("ActivityID") or 0
            existing = seen.get(pnum)
            if existing is None or aid > (existing.get("ActivityID") or 0):
                seen[pnum] = a
            first = _first_seen.get(pnum)
            if first is None or aid < (first.get("ActivityID") or 0):
                _first_seen[pnum] = a

    # ── Metadata fallback from native Issue records ───────────────────────────
    _nat_by_num: dict[int, dict] = {}
    _nat_by_subj: dict[str, dict] = {}
    for a in raw:
        if (a.get("ActivityType") or "").strip().lower() != "issue":
            continue
        pnum = parsed_cache.get(a.get("ActivityID"), {}).get("issue_number")
        if pnum is not None:
            _nat_by_num[pnum] = a
        else:
            s = (a.get("Subject") or "").strip().lower()
            if len(s) > 3:
                _nat_by_subj[s] = a

    _meta: dict[int, dict] = dict(_nat_by_num)
    for inum, erec in seen.items():
        if inum in _meta:
            continue
        stripped = _re.sub(r'^Issue\s*#\d+\s*[-–]\s*', '',
                           erec.get("Subject") or "", flags=_re.IGNORECASE).strip().lower()
        if stripped in _nat_by_subj:
            _meta[inum] = _nat_by_subj[stripped]
        else:
            for ns, nr in _nat_by_subj.items():
                if len(ns) > 5 and stripped.endswith(ns):
                    _meta[inum] = nr
                    break

    # ── Resolve property names ────────────────────────────────────────────────
    all_recs = list(seen.values()) + list(_meta.values())
    prop_ids = list({a.get("PropertyID") for a in all_recs if a.get("PropertyID")})
    opp_ids  = list({a.get("OpportunityID") for a in all_recs if a.get("OpportunityID")})
    wt_ids   = list({a.get("WorkTicketID") for a in all_recs if a.get("WorkTicketID") and not a.get("PropertyID")})

    async def _names(entity, id_f, name_f, ids):
        out: dict[int, str] = {}
        for i in range(0, len(ids), 50):
            chunk = ids[i:i+50]
            try:
                res = await _aspire._get(entity, {
                    "$filter": " or ".join(f"{id_f} eq {x}" for x in chunk),
                    "$select": f"{id_f},{name_f}", "$top": str(len(chunk)),
                })
                for r in _aspire._extract_list(res):
                    if r.get(id_f): out[r[id_f]] = r.get(name_f) or ""
            except Exception: pass
        return out

    async def _fetch_opp_names():
        if not opp_ids: return []
        results = []
        for i in range(0, len(opp_ids), 50):
            chunk = opp_ids[i:i+50]
            try:
                res = await _aspire._get("Opportunities", {
                    "$filter": " or ".join(f"OpportunityID eq {x}" for x in chunk),
                    "$select": "OpportunityID,OpportunityName,PropertyID",
                    "$top": str(len(chunk)),
                })
                results.extend(_aspire._extract_list(res))
            except Exception as e:
                logger.warning(f"Opp names chunk failed: {e}")
        return results

    prop_map, opp_raw_map = await asyncio.gather(
        _names("Properties", "PropertyID", "PropertyName", prop_ids),
        _fetch_opp_names(),
    )
    opp_name_map: dict[int, str] = {}
    opp_prop_map: dict[int, int] = {}
    for r in (opp_raw_map or []):
        oid = r.get("OpportunityID")
        if oid:
            opp_name_map[oid] = r.get("OpportunityName") or ""
            if r.get("PropertyID"): opp_prop_map[oid] = r["PropertyID"]

    wt_prop_map = await _names("WorkTickets", "WorkTicketID", "PropertyID", wt_ids)
    extra_pids  = list({pid for pid in list(opp_prop_map.values()) + list(wt_prop_map.values())
                        if pid not in prop_map})
    if extra_pids:
        prop_map.update(await _names("Properties", "PropertyID", "PropertyName", extra_pids))

    def _resolve_prop(a, meta):
        pid = a.get("PropertyID") or meta.get("PropertyID")
        if not pid:
            wt  = a.get("WorkTicketID") or meta.get("WorkTicketID")
            pid = wt_prop_map.get(wt) if wt else None
        if not pid:
            oid = a.get("OpportunityID") or meta.get("OpportunityID")
            pid = opp_prop_map.get(oid) if oid else None
        return prop_map.get(pid, "") if pid else ""

    # ── Fetch employee emails ─────────────────────────────────────────────────
    try:
        employees = await _aspire.get_aspire_employees()
        email_by_name = {e["FullName"].strip().lower(): e.get("Email") or ""
                         for e in employees if e.get("FullName")}
    except Exception:
        email_by_name = {}

    # ── Shape issues ──────────────────────────────────────────────────────────
    issues = []
    for inum, a in seen.items():
        parsed   = parsed_cache.get(a.get("ActivityID")) or {}
        meta     = _meta.get(inum) or {}
        prop_name = _resolve_prop(a, meta)
        category  = a.get("ActivityCategoryName") or meta.get("ActivityCategoryName") or ""
        assigned  = parsed.get("assigned_to") or _best_asgn.get(inum, [])
        priority  = parsed.get("priority") or a.get("Priority") or "Normal"
        status    = parsed.get("status") or a.get("Status") or "Open"
        due_str   = (a.get("DueDate") or "")[:10] or parsed.get("due_date_str") or ""
        eff_opp   = a.get("OpportunityID") or meta.get("OpportunityID")

        # Use the OLDEST activity record's CreatedDate as the true issue open date.
        # The kept record (highest ActivityID) may have been created today just
        # because a comment was added — that doesn't make it a "new" issue.
        first_rec   = _first_seen.get(inum) or a
        created_dt  = _pdt(first_rec.get("CreatedDate"))
        modified_dt = _pdt(a.get("ModifiedDate"))
        complete_dt = _pdt(a.get("CompleteDate"))

        # "Completed" is determined by status only — Complete / Closed / Cancelled
        is_completed = any(w in (status or "").lower() for w in ("complet", "closed", "cancel"))

        today_date    = now.date()
        touched_today = modified_dt and modified_dt.date() == today_date
        if created_dt and created_dt.date() == today_date and not is_completed:
            change_type = "new"
        elif is_completed and touched_today:
            change_type = "closed"
        elif touched_today:
            change_type = "updated"
        else:
            change_type = "unchanged"

        if due_str:
            try:
                from datetime import date as _d
                days_left = (_d.fromisoformat(due_str) - now.date()).days
            except Exception:
                days_left = None
        else:
            days_left = None

        issues.append({
            "issue_number": inum,
            "issue_url":    parsed.get("issue_url"),
            "subject":      a.get("Subject") or "(no subject)",
            "category":     category,
            "property":     prop_name,
            "assigned_to":  assigned,
            "priority":     priority,
            "status":       status,
            "due":          due_str,
            "days_left":    days_left,
            "change_type":  change_type,
            "is_completed": is_completed,
            "comment":      (parsed.get("comments") or [""])[0][:120] if parsed.get("comments") else "",
        })

    # ── Group changes by assignee ─────────────────────────────────────────────
    # Only include issues that changed in the last 24h per recipient
    by_person: dict[str, list] = {}
    for iss in issues:
        if iss["change_type"] == "unchanged":
            continue
        for name in (iss["assigned_to"] or ["Unassigned"]):
            name = name.strip()
            if not name:
                continue
            by_person.setdefault(name, []).append(iss)

    # ── AI-generated management summary ──────────────────────────────────────
    open_issues    = [i for i in issues if not i["is_completed"]]
    overdue_issues = [i for i in open_issues if (i["days_left"] or 0) < 0 and i["due"]]
    new_today      = [i for i in issues if i["change_type"] == "new"]
    closed_today   = [i for i in issues if i["change_type"] == "closed"]
    updated_today  = [i for i in issues if i["change_type"] == "updated"]
    high_priority  = [i for i in open_issues if (i["priority"] or "").lower() in ("high", "critical")]

    ai_summary = ""
    if cfg.ANTHROPIC_API_KEY:
        try:
            import anthropic as _ant
            _ant_client = _ant.AsyncAnthropic(api_key=cfg.ANTHROPIC_API_KEY)
            prompt_data = {
                "date": today_str,
                "total_open": len(open_issues),
                "overdue": len(overdue_issues),
                "new_today": len(new_today),
                "closed_today": len(closed_today),
                "updated_today": len(updated_today),
                "high_priority": len(high_priority),
                "top_overdue": [
                    f"Issue #{i['issue_number']} — {i['property'] or 'Unknown Property'}: {i['subject'][:80]} ({abs(i['days_left'])}d overdue)"
                    for i in sorted(overdue_issues, key=lambda x: x["days_left"] or 0)[:5]
                ],
                "top_high_priority": [
                    f"Issue #{i['issue_number']} — {i['property'] or 'Unknown Property'}: {i['subject'][:80]}"
                    for i in high_priority[:5]
                ],
                "new_issues": [
                    f"Issue #{i['issue_number']} — {i['property'] or 'Unknown Property'}: {i['subject'][:80]}"
                    for i in new_today[:5]
                ],
            }
            prompt = f"""You are writing a brief executive summary for the daily Issues digest email at Dario's Landscaping.
Write 2-3 sentences of plain English highlighting the most important things managers need to know.
Be direct, specific, and professional. No bullet points — flowing prose only.

Data for {today_str}:
- Total open issues: {prompt_data['total_open']}
- Overdue: {prompt_data['overdue']}
- New today: {prompt_data['new_today']}
- Closed today: {prompt_data['closed_today']}
- Updated today: {prompt_data['updated_today']}
- High priority open: {prompt_data['high_priority']}

Top overdue issues: {prompt_data['top_overdue']}
New issues opened today: {prompt_data['new_issues']}
High priority requiring attention: {prompt_data['top_high_priority']}

Write the summary now (2-3 sentences maximum):"""

            resp = await _ant_client.messages.create(
                model="claude-haiku-4-5",
                max_tokens=200,
                messages=[{"role": "user", "content": prompt}],
            )
            ai_summary = resp.content[0].text.strip()
        except Exception as e:
            logger.warning(f"AI summary failed: {e}")

    if not ai_summary:
        # Rule-based fallback
        parts = []
        if overdue_issues:
            parts.append(f"{len(overdue_issues)} issue(s) are overdue")
        if new_today:
            parts.append(f"{len(new_today)} new issue(s) opened today")
        if closed_today:
            parts.append(f"{len(closed_today)} closed")
        ai_summary = (
            f"As of {today_str}, there are {len(open_issues)} open issues across the team. "
            + (", ".join(parts) + "." if parts else "No urgent changes in the last 24 hours.")
        )

    # ── Build HTML helpers ────────────────────────────────────────────────────
    PRIORITY_COLOURS = {"High": "#dc2626", "Critical": "#7f1d1d", "Normal": "#6b7280", "Low": "#9ca3af"}
    STATUS_ICON = {"new": "🆕", "updated": "🔄", "closed": "✅"}

    def _due_badge(iss):
        if not iss["due"]: return ""
        dl = iss["days_left"]
        if dl is None: return f'<span style="color:#6b7280;font-size:11px">Due {iss["due"]}</span>'
        if dl < 0:   return f'<span style="background:#fee2e2;color:#dc2626;padding:2px 7px;border-radius:10px;font-size:11px">⛔ {abs(dl)}d overdue</span>'
        if dl <= 7:  return f'<span style="background:#fef3c7;color:#d97706;padding:2px 7px;border-radius:10px;font-size:11px">⚠️ Due in {dl}d</span>'
        return f'<span style="color:#6b7280;font-size:11px">Due {iss["due"]}</span>'

    def _issue_row(iss, show_assignee=False):
        icon   = STATUS_ICON.get(iss["change_type"], "")
        pcolor = PRIORITY_COLOURS.get(iss["priority"], "#6b7280")
        url    = iss["issue_url"] or "#"
        asgn   = ", ".join(iss["assigned_to"]) if show_assignee and iss["assigned_to"] else ""
        cat    = f'<span style="color:#6b7280;font-size:11px">{iss["category"]}</span>' if iss["category"] else ""
        prop_s = f'<span style="font-size:11px;color:#374151">{iss["property"]}</span> · ' if iss["property"] else ""
        comment_s = f'<div style="color:#6b7280;font-size:11px;margin-top:2px;font-style:italic">{iss["comment"]}…</div>' if iss["comment"] else ""
        asgn_s = f'<span style="color:#6b7280;font-size:11px"> → {asgn}</span>' if asgn else ""
        return f"""
        <tr>
          <td style="padding:10px 16px;border-bottom:1px solid #f3f4f6;vertical-align:top">
            <div>{icon} <a href="{url}" style="color:#1d4ed8;font-weight:600;text-decoration:none">
              Issue #{iss['issue_number']}
            </a>{asgn_s}
            <span style="margin-left:8px;background:{pcolor};color:#fff;font-size:10px;padding:1px 6px;border-radius:8px">{iss['priority']}</span>
            </div>
            <div style="margin-top:3px">{prop_s}{cat}</div>
            <div style="color:#374151;font-size:13px;margin-top:2px">{iss['subject'][:100]}</div>
            {comment_s}
          </td>
          <td style="padding:10px 16px;border-bottom:1px solid #f3f4f6;white-space:nowrap;vertical-align:top;text-align:right">
            {_due_badge(iss)}
          </td>
        </tr>"""

    def _section(title, colour, items, show_assignee=False):
        if not items: return ""
        rows = "".join(_issue_row(i, show_assignee) for i in items)
        return f"""
        <div style="margin-top:20px">
          <div style="background:{colour};color:#fff;padding:6px 16px;border-radius:6px 6px 0 0;font-weight:700;font-size:13px">{title} ({len(items)})</div>
          <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 6px 6px">
            {rows}
          </table>
        </div>"""

    # ── Management summary email ──────────────────────────────────────────────
    # Group by change type (not by person) — show assignees inline per row
    no_changes = not new_today and not updated_today and not closed_today
    mgmt_body_html = (
        '<p style="color:#6b7280;text-align:center;padding:24px">No issue changes in the last 24 hours.</p>'
        if no_changes else
        _section("🆕 New Issues", "#15803d", new_today, show_assignee=True) +
        _section("🔄 Updated Issues", "#2563eb", updated_today, show_assignee=True) +
        _section("✅ Marked Complete", "#6b7280", closed_today, show_assignee=True)
    )

    mgmt_html = f"""
    <div style="font-family:sans-serif;max-width:700px;margin:0 auto">

      <!-- Header -->
      <div style="background:#0f172a;padding:20px 24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;color:#fff;font-size:20px">🔔 Issues Digest — {today_str}</h2>
        <p style="margin:4px 0 0;color:#94a3b8;font-size:13px">Management summary · all assignees</p>
      </div>

      <!-- AI summary -->
      <div style="background:#f0f9ff;border:1px solid #bae6fd;border-top:none;padding:16px 24px">
        <div style="font-size:12px;color:#0369a1;font-weight:700;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">🧠 AI Summary</div>
        <p style="margin:0;color:#0c4a6e;font-size:14px;line-height:1.6">{ai_summary}</p>
      </div>

      <!-- Stats bar -->
      <div style="background:#f8fafc;border:1px solid #e5e7eb;border-top:none;padding:14px 24px;display:flex;gap:20px;flex-wrap:wrap">
        <span style="font-size:13px"><strong>{len(open_issues)}</strong> open</span>
        <span style="font-size:13px;color:#dc2626"><strong>{len(overdue_issues)}</strong> overdue</span>
        <span style="font-size:13px;color:#15803d"><strong>{len(new_today)}</strong> new today</span>
        <span style="font-size:13px;color:#6b7280"><strong>{len(closed_today)}</strong> completed today</span>
        <span style="font-size:13px;color:#2563eb"><strong>{len(updated_today)}</strong> updated today</span>
      </div>

      <!-- Changes grouped by type -->
      <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:16px 24px">
        {mgmt_body_html}
        <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;text-align:center">
          <a href="{cfg.ISSUES_DIGEST_ACTIVITIES_URL}" style="color:#2563eb">View full Activities Dashboard ↗</a>
          &nbsp;·&nbsp; Sent automatically each morning.
        </p>
      </div>
    </div>"""

    graph   = GraphClient()
    mailbox = cfg.MS_AP_INBOX
    sent_to: list[str] = []
    skipped: list[str] = []

    mgmt_recipients = [r.strip() for r in cfg.ISSUES_DIGEST_MGMT_RECIPIENTS.split(",") if r.strip()]
    if mgmt_recipients:
        try:
            await graph.send_email(
                mailbox=mailbox,
                to_addresses=mgmt_recipients,
                subject=f"🔔 Issues Digest {today_str} — {len(new_today)} new · {len(updated_today)} updated · {len(closed_today)} closed",
                body_html=mgmt_html,
            )
            sent_to.extend(mgmt_recipients)
            logger.info(f"Issues digest management email sent to {mgmt_recipients}")
        except Exception as e:
            logger.error(f"Issues digest management email failed: {e}")
            skipped.extend(mgmt_recipients)

    # ── Individual emails per assignee ────────────────────────────────────────
    # TODO: enable individual emails once digest is fully tested
    # for person_name, p_issues in by_person.items():
    for person_name, p_issues in []:  # disabled — management summary only for now
        p_email = email_by_name.get(person_name.lower(), "")
        if not p_email:
            logger.info(f"Issues digest: no email for {person_name}, skipping")
            skipped.append(person_name)
            continue

        p_new     = [i for i in p_issues if i["change_type"] == "new"]
        p_updated = [i for i in p_issues if i["change_type"] == "updated"]
        p_closed  = [i for i in p_issues if i["change_type"] == "closed"]

        first_name = person_name.split()[0]
        individual_html = f"""
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto">
          <div style="background:#0f172a;padding:20px 24px;border-radius:8px 8px 0 0">
            <h2 style="margin:0;color:#fff;font-size:18px">🔔 Your Issues — {today_str}</h2>
            <p style="margin:4px 0 0;color:#94a3b8;font-size:13px">Hi {first_name}, here are your issue updates from the last 24 hours</p>
          </div>
          <div style="background:#f8fafc;border:1px solid #e5e7eb;border-top:none;padding:10px 24px;display:flex;gap:16px">
            <span style="font-size:13px;color:#15803d"><strong>{len(p_new)}</strong> new</span>
            <span style="font-size:13px;color:#2563eb"><strong>{len(p_updated)}</strong> updated</span>
            <span style="font-size:13px;color:#6b7280"><strong>{len(p_closed)}</strong> closed</span>
          </div>
          <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:16px 24px">
            {_section("🆕 New Issues", "#15803d", p_new)}
            {_section("🔄 Updated Issues", "#2563eb", p_updated)}
            {_section("✅ Closed Issues", "#6b7280", p_closed)}
            <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;text-align:center">
              <a href="{cfg.ISSUES_DIGEST_ACTIVITIES_URL}" style="color:#2563eb">View Activities Dashboard ↗</a>
              &nbsp;·&nbsp; Sent automatically each morning.
            </p>
          </div>
        </div>"""

        try:
            await graph.send_email(
                mailbox=mailbox,
                to_addresses=[p_email],
                subject=f"🔔 Your Issues {today_str} — {len(p_new)} new · {len(p_updated)} updated · {len(p_closed)} closed",
                body_html=individual_html,
            )
            sent_to.append(f"{person_name} <{p_email}>")
            logger.info(f"Issues digest sent to {person_name} <{p_email}>")
        except Exception as e:
            logger.error(f"Issues digest failed for {person_name} <{p_email}>: {e}")
            skipped.append(person_name)

    return {
        "ok":            True,
        "date":          today_str,
        "open_issues":   len(open_issues),
        "new_today":     len(new_today),
        "updated_today": len(updated_today),
        "closed_today":  len(closed_today),
        "overdue":       len(overdue_issues),
        "sent_to":       sent_to,
        "skipped":       skipped,
        "ai_summary":    ai_summary,
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

@router.get("/activities/debug-issue/{issue_number}")
async def debug_issue(issue_number: int):
    """Return raw Notes HTML + parsed fields for a specific Issue number."""
    import re as _re
    raw = await _aspire._get_all("Activities", {
        "$select": "ActivityID,Subject,ActivityType,Status,Notes,CreatedDate,ModifiedDate",
        "$top": "500",
        "$orderby": "ModifiedDate desc",
    })
    matches = []
    for a in raw:
        html = a.get("Notes") or ""
        # Also check subject for the issue number as fallback
        subject_match = f"Issue #{issue_number}" in (a.get("Subject") or "")
        m = _re.search(r'<b>Issue\s*#</b></td><td[^>]*><a[^>]*>(\d+)</a>', html, _re.IGNORECASE | _re.DOTALL)
        if (m and int(m.group(1)) == issue_number) or subject_match:
            # Extract status cell raw
            s = _re.search(r'<b>Status</b></td><td[^>]*>(.*?)</td>', html, _re.IGNORECASE | _re.DOTALL)
            raw_status_html = s.group(1) if s else "(not found)"
            matches.append({
                "activity_id": a.get("ActivityID"),
                "subject": a.get("Subject"),
                "api_status": a.get("Status"),
                "raw_status_html": raw_status_html,
                "notes_snippet": html[:2000],
            })
    return {"issue_number": issue_number, "matches": matches}


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
async def get_activities_dashboard(show_completed: bool = False, include_emails: bool = False):
    from datetime import datetime, timezone, timedelta
    import asyncio
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
            "$filter": "CreatedDate ge 2026-01-01T00:00:00Z",
            "$top": "500",
            "$orderby": "ModifiedDate desc",
        })
        logger.info(f"Activities dashboard: fetched {len(raw)} total from Aspire")
    except Exception as e:
        logger.error(f"Activities fetch failed: {e}")
        raise HTTPException(status_code=502, detail=f"Aspire API error: {e}")

    import re as _re

    def _parse_issue_html(html: str) -> dict:
        """Extract issue fields and comments from Aspire Issue HTML notes."""
        result = {"issue_number": None, "issue_url": None, "assigned_to": [], "status": "", "priority": "", "comments": []}
        if not html:
            return result
        # Issue number + direct URL from the embedded <a href="...">
        m = _re.search(r'<b>Issue\s*#</b></td><td[^>]*><a\s+href="([^"]+)"[^>]*>(\d+)</a>', html, _re.IGNORECASE | _re.DOTALL)
        if m:
            result["issue_url"]    = m.group(1)
            result["issue_number"] = int(m.group(2))
        # Generic key→value extractor for the header table rows
        def _cell(label: str) -> str:
            m2 = _re.search(rf'<b>{label}</b></td><td[^>]*>(.*?)</td>', html, _re.IGNORECASE | _re.DOTALL)
            return _re.sub(r'<[^>]+>', ' ', m2.group(1)).strip() if m2 else ""
        # Assigned To (may have <br/> between names)
        raw_assigned = _cell("Assigned To")
        result["assigned_to"] = [x.strip() for x in _re.split(r'[\n,]+', raw_assigned) if x.strip()]
        # Status — may be in header table, or only in comment audit trail
        result["status"]   = _cell("Status") or "Open"
        result["priority"] = _cell("Priority")
        # If "Complete Date" cell is populated in the HTML, the issue is done —
        # override status regardless of what the Status cell says.
        # Aspire sometimes leaves Status="Open" while setting a Complete Date.
        complete_date_html = _cell("Complete Date")
        if complete_date_html and complete_date_html.strip():
            result["status"] = "Complete"
        # Due Date — parse from HTML (MM/DD/YY) since API DueDate is null for email activities
        raw_due = _cell("Due Date")
        if raw_due:
            try:
                from datetime import datetime as _dt
                result["due_date_str"] = _dt.strptime(raw_due.strip(), "%m/%d/%y").strftime("%Y-%m-%d")
            except Exception:
                result["due_date_str"] = None
        else:
            result["due_date_str"] = None
        # Comments — rows after "Issue Comment History" header
        comment_section = _re.search(r'Issue Comment History</h3>(.*)', html, _re.IGNORECASE | _re.DOTALL)
        if comment_section:
            rows = _re.findall(r'<tr>(.*?)</tr>', comment_section.group(1), _re.DOTALL)
            # Comments are in REVERSE chronological order (newest first).
            # We only want the MOST RECENT status change — take the first match and stop.
            _status_set_from_history = False
            for row in rows:
                cells = _re.findall(r'<td[^>]*>(.*?)</td>', row, _re.DOTALL)
                if len(cells) >= 2:
                    meta = _re.sub(r'<[^>]+>', ' ', cells[0]).strip()
                    comment = _re.sub(r'<[^>]+>', '', cells[1]).strip()
                    # Skip table header rows (meta="Created Date/By", text="Comment")
                    if not comment or comment == 'Comment' or meta == 'Created Date/By':
                        continue
                    result["comments"].append({"meta": meta, "text": comment})
                    # Detect status changes: "ChangesStatus | 'Old' to 'New'"
                    # Only apply the FIRST match (most recent, since newest-first order).
                    if not _status_set_from_history:
                        sm = _re.search(r"ChangesStatus\s*\|\s*'[^']*'\s*to\s*'([^']+)'", comment, _re.IGNORECASE)
                        if sm:
                            result["status"] = sm.group(1).strip()
                            _status_set_from_history = True
        return result

    # Pre-parse HTML so we can filter on parsed status
    _parsed_cache: dict[int, dict] = {}
    for a in raw:
        aid = a.get("ActivityID")
        if aid:
            _parsed_cache[aid] = _parse_issue_html(a.get("Notes") or "")

    # Build best-assigned_to map: for each issue number, find the highest-ID record
    # that actually has names. Some newer notification emails have empty assignee fields.
    _best_assigned: dict[int, list] = {}
    for aid in sorted(_parsed_cache.keys(), reverse=True):  # highest ID first
        p = _parsed_cache[aid]
        inum = p.get("issue_number")
        if inum and p.get("assigned_to") and inum not in _best_assigned:
            _best_assigned[inum] = p["assigned_to"]

    # Filter: keep Issues (Email with "Issue" in subject), drop plain emails/appointments/activity
    def is_active(a: dict) -> bool:
        subject = (a.get("Subject") or "")
        # Always drop Time Adjustment
        if _re.search(r'Time\s*Adjustment', subject, _re.IGNORECASE):
            return False
        atype = (a.get("ActivityType") or "").strip().lower()
        if atype in ("activity", "appointment"):
            return False
        if atype == "email" and not _re.search(r'Issue\s*#', subject, _re.IGNORECASE):
            return False
        # Filter completed — check API status, parsed HTML status, AND CompleteDate
        if not show_completed:
            api_status    = (a.get("Status") or "").strip().lower()
            parsed_status = (_parsed_cache.get(a.get("ActivityID"), {}).get("status") or "").strip().lower()
            combined      = api_status + " " + parsed_status
            if "complet" in combined or "closed" in combined or "cancel" in combined:
                return False
            # CompleteDate being set means the issue was resolved in Aspire,
            # even if the Status field still reads "Open"
            if a.get("CompleteDate"):
                return False
        return True

    # ── Deduplicate FIRST (before status filter) ─────────────────────────────
    # Aspire emits multiple Activity records per issue (one per comment, plus
    # one bare "Issue" record with no HTML). Only keep the record with the
    # highest ActivityID that has a parsed issue_number — it has the complete
    # comment history. Records without a parseable issue number are always
    # duplicates of a real issue record and are dropped.
    seen_issue_all: dict[int, dict] = {}
    for a in raw:
        subject = (a.get("Subject") or "")
        if _re.search(r'Time\s*Adjustment', subject, _re.IGNORECASE):
            continue
        parsed_num = _parsed_cache.get(a.get("ActivityID"), {}).get("issue_number")
        if parsed_num is not None:
            existing = seen_issue_all.get(parsed_num)
            if existing is None or (a.get("ActivityID") or 0) > (existing.get("ActivityID") or 0):
                seen_issue_all[parsed_num] = a

    deduped = list(seen_issue_all.values())

    # ── Build metadata fallback from native Issue-type records ────────────────
    # Email notification records (kept by dedup because they have HTML) do NOT
    # carry ActivityCategoryName, OpportunityID, or PropertyID from Aspire.
    # Native "Issue" type records DO have those fields but lack the HTML notes.
    # We match them by issue_number (if parseable) or by subject suffix.
    _native_by_num: dict[int, dict] = {}
    _native_by_subject: dict[str, dict] = {}
    for a in raw:
        if (a.get("ActivityType") or "").strip().lower() != "issue":
            continue
        nat_num = _parsed_cache.get(a.get("ActivityID"), {}).get("issue_number")
        if nat_num is not None:
            _native_by_num[nat_num] = a
        else:
            subj = (a.get("Subject") or "").strip().lower()
            if subj and len(subj) > 3:
                _native_by_subject[subj] = a

    # Debug: log a sample native Issue record to verify field availability
    _sample_natives = list(_native_by_subject.values())[:3] + list(_native_by_num.values())[:3]
    for _sn in _sample_natives[:2]:
        logger.info(
            f"[ACT-META] native Issue sample — cat={_sn.get('ActivityCategoryName')!r} "
            f"oppID={_sn.get('OpportunityID')!r} propID={_sn.get('PropertyID')!r} "
            f"wtID={_sn.get('WorkTicketID')!r} subj={(_sn.get('Subject') or '')[:60]!r}"
        )

    # Start with direct issue_number matches, then try subject matching
    _issue_meta: dict[int, dict] = dict(_native_by_num)
    for issue_num, email_rec in seen_issue_all.items():
        if issue_num in _issue_meta:
            continue
        stripped = _re.sub(
            r'^Issue\s*#\d+\s*[-–]\s*', '',
            email_rec.get("Subject") or "",
            flags=_re.IGNORECASE,
        ).strip().lower()
        if stripped in _native_by_subject:
            _issue_meta[issue_num] = _native_by_subject[stripped]
            continue
        for nat_subj, nat_rec in _native_by_subject.items():
            if len(nat_subj) > 5 and stripped.endswith(nat_subj):
                _issue_meta[issue_num] = nat_rec
                break

    # ── Now apply status filter on the deduplicated set ───────────────────────
    activities = [a for a in deduped if is_active(a)]

    # ── Batch-fetch property + opportunity names ──────────────────────────────
    async def _fetch_names(entity: str, id_field: str, name_field: str, ids: list) -> dict:
        result: dict[int, str] = {}
        chunk_size = 50
        for i in range(0, len(ids), chunk_size):
            chunk = ids[i:i + chunk_size]
            id_filter = " or ".join(f"{id_field} eq {eid}" for eid in chunk)
            try:
                res = await _aspire._get(entity, {
                    "$filter": id_filter,
                    "$select": f"{id_field},{name_field}",
                    "$top":    str(len(chunk)),
                })
                for rec in _aspire._extract_list(res):
                    eid = rec.get(id_field)
                    if eid:
                        result[eid] = rec.get(name_field) or ""
            except Exception as e:
                logger.warning(f"{entity} name lookup failed: {e}")
        return result

    # Primary: activities with PropertyID directly (also include meta fallbacks)
    _meta_values = list(_issue_meta.values())
    prop_ids = list({
        pid
        for src in (activities, _meta_values)
        for a in src
        for pid in [a.get("PropertyID")]
        if pid
    })
    property_name_map = await _fetch_names("Properties", "PropertyID", "PropertyName", prop_ids)

    # Opportunity names + PropertyIDs — for "Regarding" column and property fallback
    opp_ids = list({
        oid
        for src in (activities, _meta_values)
        for a in src
        for oid in [a.get("OpportunityID")]
        if oid
    })
    opp_name_map: dict[int, str] = {}
    opp_prop_map: dict[int, int] = {}   # OpportunityID → PropertyID
    if opp_ids:
        chunk_size = 50
        for i in range(0, len(opp_ids), chunk_size):
            chunk = opp_ids[i:i + chunk_size]
            id_filter = " or ".join(f"OpportunityID eq {oid}" for oid in chunk)
            try:
                res = await _aspire._get("Opportunities", {
                    "$filter": id_filter,
                    "$select": "OpportunityID,OpportunityName,PropertyID",
                    "$top": str(len(chunk)),
                })
                for rec in _aspire._extract_list(res):
                    oid = rec.get("OpportunityID")
                    if oid:
                        opp_name_map[oid] = rec.get("OpportunityName") or ""
                        if rec.get("PropertyID"):
                            opp_prop_map[oid] = rec["PropertyID"]
            except Exception as e:
                logger.warning(f"Opportunity name lookup failed: {e}")

    # Secondary: look up WorkTicketID → PropertyID for activities AND native meta records
    # Collect WorkTicketIDs from both sources (email records + native Issue records)
    all_wt_ids = {
        wid
        for src in (activities, _meta_values)
        for a in src
        for wid in [a.get("WorkTicketID")]
        if wid and not a.get("PropertyID")
    }
    wt_prop_map: dict[int, int] = {}
    if all_wt_ids:
        chunk_size = 50
        wt_id_list = list(all_wt_ids)
        for i in range(0, len(wt_id_list), chunk_size):
            chunk = wt_id_list[i:i + chunk_size]
            id_filter = " or ".join(f"WorkTicketID eq {wid}" for wid in chunk)
            try:
                res = await _aspire._get("WorkTickets", {
                    "$filter": id_filter,
                    "$select": "WorkTicketID,PropertyID",
                    "$top": str(len(chunk)),
                })
                for rec in _aspire._extract_list(res):
                    wid = rec.get("WorkTicketID")
                    pid = rec.get("PropertyID")
                    if wid and pid:
                        wt_prop_map[wid] = pid
            except Exception as e:
                logger.warning(f"WorkTickets name lookup failed: {e}")
        # Fetch property names for any new PropertyIDs from WorkTicket lookup
        new_prop_ids = list({pid for pid in wt_prop_map.values() if pid not in property_name_map})
        if new_prop_ids:
            extra = await _fetch_names("Properties", "PropertyID", "PropertyName", new_prop_ids)
            property_name_map.update(extra)

    # Tertiary: for activities with no PropertyID and no WorkTicketID, resolve via OpportunityID → PropertyID
    new_opp_prop_ids = list({pid for pid in opp_prop_map.values() if pid not in property_name_map})
    if new_opp_prop_ids:
        extra = await _fetch_names("Properties", "PropertyID", "PropertyName", new_opp_prop_ids)
        property_name_map.update(extra)

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
        urg        = urgency(due_dt)
        due_days   = int((due_dt - now).days) if due_dt else None
        parsed     = _parsed_cache.get(a.get("ActivityID")) or _parse_issue_html(a.get("Notes") or "")
        # Due date: prefer API field, fall back to HTML-parsed date
        effective_due = due_dt.date().isoformat() if due_dt else parsed.get("due_date_str")
        if effective_due and not due_dt:
            # Recalculate urgency from parsed date
            try:
                from datetime import date as _date
                d = (_date.fromisoformat(effective_due) - now.date()).days
                urg = "overdue" if d < 0 else "urgent" if d <= 7 else "soon" if d <= 30 else "ok"
                due_days = d
            except Exception:
                pass

        aid = a.get("ActivityID")
        issue_num = parsed.get("issue_number")
        # Native meta fallback: email notification records lack metadata fields
        meta = _issue_meta.get(issue_num) or {} if issue_num else {}

        # Resolve property: direct → meta fallback → WorkTicket (email or meta) → Opportunity
        direct_pid   = a.get("PropertyID") or meta.get("PropertyID")
        eff_opp_id   = a.get("OpportunityID") or meta.get("OpportunityID")
        if not direct_pid:
            wt_id  = a.get("WorkTicketID") or meta.get("WorkTicketID")
            wt_pid = wt_prop_map.get(wt_id) if wt_id else None
        else:
            wt_pid = None
        opp_pid      = opp_prop_map.get(eff_opp_id) if not direct_pid and not wt_pid else None
        resolved_pid = direct_pid or wt_pid or opp_pid
        prop_name = property_name_map.get(resolved_pid, "") if resolved_pid else ""

        shaped.append({
            "id":            aid,
            "issue_number":  issue_num,
            "issue_url":     parsed.get("issue_url"),
            "subject":       a.get("Subject") or "(no subject)",
            "activity_type": "Issue" if issue_num else (a.get("ActivityType") or "Unknown"),
            "status":        parsed.get("status") or a.get("Status") or "",
            "priority":      parsed.get("priority") or a.get("Priority") or "",
            "category":      a.get("ActivityCategoryName") or meta.get("ActivityCategoryName") or "",
            "assigned_to":   parsed["assigned_to"] or _best_assigned.get(issue_num, []),
            "comments":      parsed["comments"],
            "property_id":   resolved_pid,
            "property_name": prop_name,
            "due_date":      effective_due,
            "complete_date": parse_dt(a.get("CompleteDate")).date().isoformat() if parse_dt(a.get("CompleteDate")) else None,
            "created_date":  created_dt.date().isoformat()  if created_dt  else None,
            "opportunity_id": eff_opp_id,
            "regarding_name": opp_name_map.get(eff_opp_id, "") or "",
            "regarding_url":  (
                f"https://cloud.youraspire.com/app/opportunities/details/{eff_opp_id}"
                if eff_opp_id else None
            ),
            "work_ticket_id":a.get("WorkTicketID"),
            "is_milestone":  bool(a.get("IsMileStone")),
            "days_until_due":due_days,
            "urgency":       urg,
            "_is_overdue":   urg == "overdue",
            "_due_this_week":effective_due is not None and (
                urg in ("overdue", "urgent")
            ),
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
    categories      = sorted({s["category"]   for s in shaped if s["category"]})
    assigned_to_list= sorted({u for s in shaped for u in s["assigned_to"] if u})

    # Strip internal keys before returning
    def clean(a: dict) -> dict:
        return {k: v for k, v in a.items() if not k.startswith("_")}

    return {
        "summary":          summary,
        "activity_types":   activity_types,
        "statuses":         statuses,
        "priorities":       priorities,
        "categories":       categories,
        "assigned_to_list": assigned_to_list,
        "activities":       [clean(a) for a in shaped],
    }


# ── Daily Completion Report ───────────────────────────────────────────────────

@router.get("/daily-report/probe")
async def daily_report_probe(date: str = Query(None)):
    """
    Probe: fetch raw WorkTicketVisitNotes for a given date (default today)
    so we can inspect what the Note field looks like when photos are attached.
    Returns first 10 notes with non-empty Note fields.
    """
    from datetime import datetime, timezone, timedelta
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire not configured")

    if date:
        target = date
    else:
        tz_offset = getattr(settings, "REPORT_TZ_OFFSET", -4)
        target = datetime.now(timezone(timedelta(hours=tz_offset))).strftime("%Y-%m-%d")

    # First try with date filter
    date_filtered = []
    date_error = None
    try:
        date_filtered = await _aspire._get_all("WorkTicketVisitNotes", {
            "$filter": f"ScheduledDate ge {target}T00:00:00Z and ScheduledDate le {target}T23:59:59Z",
            "$top": "100",
        })
    except Exception as e:
        date_error = str(e)

    # Also fetch most recent 20 notes with NO filter to see real data + date format
    recent = []
    try:
        recent = await _aspire._get_all("WorkTicketVisitNotes", {
            "$orderby": "CreatedDateTime desc",
            "$top": "20",
        })
    except Exception:
        pass

    with_notes = [n for n in recent if (n.get("Note") or "").strip()]

    # Fetch today's tickets WITHOUT $select — inspect all returned fields
    today_tickets_raw: list[dict] = []
    today_ticket_ids: list[int] = []
    try:
        wt_batch = await _aspire._get_all("WorkTickets", {
            "$filter": f"CompleteDate ge {target}T00:00:00Z and CompleteDate le {target}T23:59:59Z",
            "$top": "5",  # small — we just want to see the fields
        })
        today_tickets_raw = wt_batch
        today_ticket_ids = [t["WorkTicketID"] for t in wt_batch if t.get("WorkTicketID")]
    except Exception as ex:
        pass

    # Also try scheduled if completed came back empty
    if not today_ticket_ids:
        try:
            wt_batch2 = await _aspire._get_all("WorkTickets", {
                "$filter": f"ScheduledStartDate ge {target}T00:00:00Z and ScheduledStartDate le {target}T23:59:59Z",
                "$top": "5",
            })
            today_tickets_raw = wt_batch2
            today_ticket_ids = [t["WorkTicketID"] for t in wt_batch2 if t.get("WorkTicketID")]
        except Exception:
            pass

    note_ticket_ids = [n.get("WorkTicketID") for n in recent if n.get("WorkTicketID")]
    overlap = list(set(today_ticket_ids) & set(note_ticket_ids))

    # Extract all field names from a WorkTicket to find property-related fields
    wt_all_fields = sorted(today_tickets_raw[0].keys()) if today_tickets_raw else []
    wt_property_fields = {
        k: today_tickets_raw[0].get(k)
        for k in wt_all_fields
        if any(kw in k.lower() for kw in ("prop", "site", "address", "location", "job"))
    } if today_tickets_raw else {}

    return {
        "target_date": target,
        "date_filter_results": len(date_filtered),
        "date_filter_error": date_error,
        "recent_total": len(recent),
        "recent_with_content": len(with_notes),
        "today_tickets_count": len(today_ticket_ids),
        "today_ticket_ids_sample": today_ticket_ids[:10],
        "note_ticket_ids_sample": note_ticket_ids[:10],
        "wt_id_overlap": overlap,
        # KEY: all fields returned on a WorkTicket (no $select) to find property linkage
        "worktticket_all_fields": wt_all_fields,
        "workticket_property_related_fields": wt_property_fields,
        "workticket_sample_record": {
            k: today_tickets_raw[0].get(k)
            for k in ["WorkTicketID", "WorkTicketNumber", "OpportunityID", "OpportunityNumber",
                      "PropertyID", "PropertyName", "SiteID", "SiteName"]
            if k in (today_tickets_raw[0] if today_tickets_raw else {})
        } if today_tickets_raw else {},
        "first_visit_note_fields": sorted(recent[0].keys()) if recent else [],
        "sample_with_notes": [
            {
                "WorkTicketID":     n.get("WorkTicketID"),
                "WorkTicketNumber": n.get("WorkTicketNumber"),
                "RouteName":        n.get("RouteName"),
                "ScheduledDate":    n.get("ScheduledDate"),
                "IsPublic":         n.get("IsPublic"),
                "Note_raw":         (n.get("Note") or "")[:200],
            }
            for n in with_notes[:5]
        ],
    }


@router.get("/daily-report/attachment-debug/{attachment_id}")
async def daily_report_attachment_debug(attachment_id: int):
    """Debug: show raw metadata for an attachment so we can find the download URL."""
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire not configured")
    token = await _aspire._get_token()
    results = {}

    # Fetch full metadata via filter (direct /{id} returns 404)
    meta_rec = {}
    try:
        r = await _aspire._http.get(
            f"{_aspire.base_url}/Attachments",
            params={"$filter": f"AttachmentID eq {attachment_id}", "$top": "1"},
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json;odata.metadata=minimal"},
        )
        results["meta_status"] = r.status_code
        if r.is_success:
            data = r.json()
            records = data if isinstance(data, list) else data.get("value", [])
            meta_rec = records[0] if records else {}
            results["full_record"] = meta_rec   # show everything including ExternalContentID
    except Exception as ex:
        results["meta_error"] = str(ex)

    # Test download paths
    ext_url = meta_rec.get("ExternalContentID") or ""
    results["ExternalContentID"] = ext_url

    for dl_path in [
        f"Attachments/{attachment_id}/Download",
        f"Attachments/{attachment_id}/Content",
    ]:
        try:
            r = await _aspire._http.get(
                f"{_aspire.base_url}/{dl_path}",
                headers={"Authorization": f"Bearer {token}"},
                follow_redirects=False,
            )
            results[dl_path] = {
                "status": r.status_code,
                "location": r.headers.get("location"),
                "content-type": r.headers.get("content-type"),
                "body_preview": r.text[:300],
            }
        except Exception as ex:
            results[dl_path] = {"error": str(ex)}

    # If ExternalContentID looks like a URL, test it
    if ext_url.startswith("http"):
        try:
            r = await _aspire._http.get(ext_url, follow_redirects=False)
            results["ExternalContentID_fetch"] = {
                "status": r.status_code,
                "location": r.headers.get("location"),
                "content-type": r.headers.get("content-type"),
                "content_length": len(r.content),
            }
        except Exception as ex:
            results["ExternalContentID_fetch"] = {"error": str(ex)}

    return {"attachment_id": attachment_id, "results": results}


@router.get("/daily-report/attachment/{attachment_id}")
async def daily_report_attachment(attachment_id: int):
    """
    Proxy an Aspire attachment binary.
    Direct /Attachments/{id} returns 404 — must use filter query to get metadata,
    then follow ExternalContentID URL to fetch the actual binary.
    """
    from fastapi.responses import Response
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire not configured")
    try:
        token = await _aspire._get_token()
        headers_auth = {"Authorization": f"Bearer {token}",
                        "Accept": "application/json;odata.metadata=minimal"}

        # Step 1: fetch attachment metadata via filter (direct /{id} returns 404)
        meta_resp = await _aspire._http.get(
            f"{_aspire.base_url}/Attachments",
            params={"$filter": f"AttachmentID eq {attachment_id}", "$top": "1"},
            headers=headers_auth,
        )
        if not meta_resp.is_success:
            raise HTTPException(status_code=404, detail=f"Attachment {attachment_id} metadata not found")

        data = meta_resp.json()
        records = data if isinstance(data, list) else data.get("value", [])
        rec = records[0] if records else {}
        ext_url = (rec.get("ExternalContentID") or "").strip()
        logger.info(f"Attachment {attachment_id} ExternalContentID={ext_url!r}")

        # Step 2: download from ExternalContentID (pre-signed S3/CDN URL)
        if ext_url.startswith("http"):
            img_resp = await _aspire._http.get(ext_url, follow_redirects=True)
            if img_resp.is_success and img_resp.content:
                ct = img_resp.headers.get("content-type", "image/jpeg")
                return Response(content=img_resp.content, media_type=ct)

        # Step 3: fallback — try Aspire binary sub-resources
        for sub in ["Download", "Content", "File"]:
            try:
                r = await _aspire._http.get(
                    f"{_aspire.base_url}/Attachments/{attachment_id}/{sub}",
                    headers={"Authorization": f"Bearer {token}"},
                    follow_redirects=True,
                )
                ct = r.headers.get("content-type", "")
                if r.is_success and r.content and "json" not in ct and "html" not in ct:
                    return Response(content=r.content, media_type=ct or "image/jpeg")
            except Exception:
                continue

    except HTTPException:
        raise
    except Exception as ex:
        logger.warning(f"Attachment proxy error for {attachment_id}: {ex}")
    raise HTTPException(status_code=404, detail=f"Attachment {attachment_id} not available")


@router.get("/daily-report")
async def daily_report_html(
    date: str = Query(None),
    division: str = Query(None, description="Filter to one division, e.g. 'Construction'"),
):
    """
    HTML daily completion report — open in browser and Print → Save as PDF/Word.
    Shows completed work tickets grouped by division then route, with visit notes.
    Pass ?division=Construction (or Residential Maintenance / Commercial Maintenance / Irrigation)
    to get a single-division report (useful for emailing).
    """
    from datetime import datetime, timezone, timedelta
    from fastapi.responses import HTMLResponse
    from urllib.parse import quote as _url_quote
    import asyncio, re

    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire not configured")

    # Default to Pacific time (UTC-7 PDT / UTC-8 PST).
    # Caller can pass ?date=YYYY-MM-DD to override.
    if date:
        target = date
    else:
        tz_offset = getattr(settings, "REPORT_TZ_OFFSET", -7)  # PDT; set -8 in winter
        now_local = datetime.now(timezone(timedelta(hours=tz_offset)))
        target = now_local.strftime("%Y-%m-%d")
    display_date = datetime.strptime(target, "%Y-%m-%d").strftime("%B %d, %Y")

    # Aspire stores WorkTicketTimes in UTC. Some entries (especially for tickets
    # scheduled the day before) have StartTimes in the early UTC hours of the target
    # date (e.g. T06:27Z = 11 PM PDT the night before).  Starting at T00:00:00Z
    # ensures we catch everything that falls on the target UTC date.
    # End at T12:00:00Z next day = 4 AM PST, covering crews finishing after midnight.
    from datetime import date as _date_cls, timedelta as _td
    _target_dt  = _date_cls.fromisoformat(target)
    _next_dt    = _target_dt + _td(days=1)
    next_day    = _next_dt.isoformat()          # YYYY-MM-DD of following calendar day
    day_start_z = f"{target}T00:00:00Z"         # midnight UTC on target date
    day_end_z   = f"{next_day}T12:00:00Z"       # 4 AM PST next day (noon UTC)

    # ── Fetch tickets + daily hours ───────────────────────────────────────────
    # Returns (unique_tickets, hours_today_by_wt, staff_hours_today)
    # hours_today_by_wt: WorkTicketID → hours clocked on target date specifically
    # staff_hours_today: ContactID → {name, hours, wt_ids}
    async def _fetch_tickets():
        results = []
        hours_today_by_wt: dict[int, float] = {}
        staff_hours_today: dict = {}

        # Pass 1 & 2: tickets completed or scheduled on target date
        for f in [
            f"CompleteDate ge {target}T00:00:00Z and CompleteDate le {target}T23:59:59Z",
            f"ScheduledStartDate ge {target}T00:00:00Z and ScheduledStartDate le {target}T23:59:59Z",
        ]:
            try:
                batch = await _aspire._get_all("WorkTickets", {
                    "$filter": f,
                    "$top": "200",
                })
                results.extend(batch)
            except Exception as e:
                logger.warning(f"WorkTickets fetch failed ({f[:40]}): {e}")

        # Pass 3: WorkTicketTimes for target date — used to catch off-schedule tickets,
        # build per-ticket daily hours, and build per-staff efficiency summary.
        try:
            time_entries = await _aspire._get_all("WorkTicketTimes", {
                "$filter": f"StartTime ge {day_start_z} and StartTime le {day_end_z}",
                "$top": "500",
            })

            from datetime import datetime as _dt
            for e in time_entries:
                wt_id = e.get("WorkTicketID")
                if not wt_id:
                    continue
                wt_id = int(wt_id)
                try:
                    start = _dt.fromisoformat(e["StartTime"].rstrip("Z"))
                    end   = _dt.fromisoformat(e["EndTime"].rstrip("Z")) if e.get("EndTime") else None
                    if end and end > start:
                        h = (end - start).total_seconds() / 3600
                        hours_today_by_wt[wt_id] = hours_today_by_wt.get(wt_id, 0.0) + h

                        # Build per-staff hours: ContactID → {name, hours, wt_ids}
                        cid  = e.get("ContactID")
                        name = (e.get("ContactName") or e.get("EmployeeName") or
                                e.get("FirstName", "") + " " + e.get("LastName", "")).strip()
                        if cid:
                            if cid not in staff_hours_today:
                                staff_hours_today[cid] = {"name": name or f"Staff #{cid}", "hours": 0.0, "wt_ids": set()}
                            elif name and staff_hours_today[cid]["name"].startswith("Staff #"):
                                staff_hours_today[cid]["name"] = name
                            staff_hours_today[cid]["hours"] += h
                            staff_hours_today[cid]["wt_ids"].add(wt_id)
                except Exception:
                    pass

            # Fetch full ticket records for IDs not already captured
            existing_ids = {r.get("WorkTicketID") for r in results}
            missing_ids  = [wid for wid in hours_today_by_wt if wid not in existing_ids]
            for i in range(0, len(missing_ids), 50):
                chunk   = missing_ids[i:i + 50]
                id_list = ",".join(str(x) for x in chunk)
                try:
                    batch = await _aspire._get_all("WorkTickets", {
                        "$filter": f"WorkTicketID in ({id_list})",
                        "$top": "200",
                    })
                    results.extend(batch)
                except Exception as e:
                    logger.warning(f"WorkTickets time-based fetch failed (chunk {i}): {e}")
        except Exception as e:
            logger.warning(f"WorkTicketTimes fetch failed: {e}")

        seen: set[int] = set()
        unique = []
        for t in results:
            wt_id = t.get("WorkTicketID")
            if wt_id and wt_id not in seen:
                # Skip tickets that are marked Complete but have zero labour hours
                # (e.g. Disposal Fees — admin completions with no crew on site).
                # Scheduled/in-progress tickets are kept even if hours aren't logged yet.
                status_name = (t.get("WorkTicketStatusName") or "").lower()
                is_complete = "complet" in status_name
                if is_complete and not float(t.get("HoursAct") or 0):
                    logger.debug(f"Skipping ticket {wt_id} — completed with no labour hours")
                    continue
                seen.add(wt_id)
                unique.append(t)
        return unique, hours_today_by_wt, staff_hours_today

    async def _fetch_visit_notes():
        for date_filter in [
            f"ScheduledDate ge {target}T00:00:00Z and ScheduledDate le {target}T23:59:59Z",
            f"ScheduledDate ge {target} and ScheduledDate le {target}T23:59:59",
            f"CreatedDateTime ge {target}T00:00:00Z and CreatedDateTime le {target}T23:59:59Z",
        ]:
            try:
                result = await _aspire._get_all("WorkTicketVisitNotes", {
                    "$filter": date_filter,
                    "$top": "500",
                })
                if result:
                    logger.info(f"visit_notes matched {len(result)}: {date_filter[:60]}")
                    return result
            except Exception as ex:
                logger.warning(f"visit_notes filter failed: {ex}")
        try:
            all_notes = await _aspire._get_all("WorkTicketVisitNotes", {
                "$orderby": "CreatedDateTime desc",
                "$top": "500",
            })
            matched = [
                n for n in all_notes
                if (n.get("ScheduledDate") or "").startswith(target)
                or (n.get("CreatedDateTime") or "").startswith(target)
            ]
            logger.info(f"visit_notes fallback: {len(matched)}/{len(all_notes)} matched {target}")
            return matched
        except Exception as ex:
            logger.warning(f"visit_notes fallback failed: {ex}")
            return []

    async def _fetch_attachments():
        try:
            return await _aspire._get_all("Attachments", {
                "$select": "AttachmentID,WorkTicketID,AttachmentName,FileExtension,DateUploaded,ExternalContentID",
                "$filter": f"DateUploaded ge {target}T00:00:00Z and DateUploaded le {day_end_z} and WorkTicketID ne null",
                "$top": "500",
            })
        except Exception as ex:
            logger.warning(f"Attachments fetch failed: {ex}")
            return []

    try:
        (tickets, hours_today_by_wt, staff_hours_today), visit_notes, attachments = await asyncio.gather(
            _fetch_tickets(), _fetch_visit_notes(), _fetch_attachments()
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Aspire API error: {e}")

    # ── Supplemental visit-note fetch by WorkTicketID ─────────────────────────
    # Visit notes inherit ScheduledDate from the ticket, so a ticket worked on a
    # different day than scheduled (e.g. scheduled 4/20, worked 4/21) will have
    # notes with ScheduledDate=4/20 — missed by the date filter above.
    # Fix: after we know which tickets are in scope, fetch notes for any ticket
    # that has no notes yet.
    noted_wt_ids = {n.get("WorkTicketID") for n in visit_notes}
    missing_note_ids = [
        t.get("WorkTicketID") for t in tickets
        if t.get("WorkTicketID") and t.get("WorkTicketID") not in noted_wt_ids
    ]
    if missing_note_ids:
        for i in range(0, len(missing_note_ids), 50):
            chunk = missing_note_ids[i:i + 50]
            id_list = ",".join(str(x) for x in chunk)
            try:
                extra = await _aspire._get_all("WorkTicketVisitNotes", {
                    "$filter": f"WorkTicketID in ({id_list})",
                    "$top": "200",
                })
                # Only keep notes actually written on the target date
                for n in extra:
                    created = (n.get("CreatedDateTime") or "")
                    scheduled = (n.get("ScheduledDate") or "")
                    if created.startswith(target) or scheduled.startswith(target):
                        visit_notes.append(n)
                logger.info(f"Supplemental visit notes: {len(extra)} fetched for {len(chunk)} tickets")
            except Exception as ex:
                logger.warning(f"Supplemental visit notes fetch failed: {ex}")

    # ── Property name resolution (3-pass) ────────────────────────────────────
    # Pass 1: PropertyName directly on WorkTicket full record (if field exists)
    property_by_wt: dict[int, str] = {}
    for t in tickets:
        wt_id = t.get("WorkTicketID")
        pname = (t.get("PropertyName") or "").strip()
        if wt_id and pname:
            property_by_wt[wt_id] = pname

    # Pass 2: OpportunityID → Opportunity
    # Fetch: PropertyName, PropertyID (for pass 3), OpportunityName (fallback display)
    # NOTE: opp_ids is built from ALL tickets so DivisionName is resolved for every
    # ticket — including those that already have PropertyName directly on the record.
    need_lookup = [t for t in tickets if t.get("WorkTicketID") and t["WorkTicketID"] not in property_by_wt]
    opp_ids = list({int(t["OpportunityID"]) for t in tickets if t.get("OpportunityID")})
    opp_name_by_wt: dict[int, str] = {}   # fallback: opportunity name when no PropertyName
    division_by_wt: dict[int, str] = {}   # WorkTicketID → DivisionName
    if opp_ids:
        opp_property_name: dict[int, str] = {}
        opp_name:          dict[int, str] = {}
        opp_division:      dict[int, str] = {}

        # Use OData `in` operator — one request per chunk of 200 IDs instead of
        # one request per ID. Much faster and avoids OR-filter silent failures.
        chunk_size = 200
        for i in range(0, len(opp_ids), chunk_size):
            chunk = opp_ids[i:i + chunk_size]
            id_list = ",".join(str(oid) for oid in chunk)
            try:
                res = await _aspire._get("Opportunities", {
                    "$filter": f"OpportunityID in ({id_list})",
                    "$top": "500",
                })
                for rec in _aspire._extract_list(res):
                    oid_val = rec.get("OpportunityID")
                    if not oid_val:
                        continue
                    oid_int = int(oid_val)
                    pname = (rec.get("PropertyName") or "").strip()
                    oname = (rec.get("OpportunityName") or "").strip()
                    dname = (rec.get("DivisionName") or "").strip()
                    if pname: opp_property_name[oid_int] = pname
                    if oname: opp_name[oid_int] = oname
                    if dname: opp_division[oid_int] = dname
            except Exception as e:
                logger.warning(f"Opportunity in() fetch failed for chunk starting {chunk[0]}: {e}")

        # Property + name: only needed for tickets that didn't have PropertyName directly
        for t in need_lookup:
            wt_id  = t.get("WorkTicketID")
            opp_id = t.get("OpportunityID")
            if not (wt_id and opp_id):
                continue
            oid = int(opp_id)
            if oid in opp_property_name:
                property_by_wt[wt_id] = opp_property_name[oid]
            if oid in opp_name:
                opp_name_by_wt[wt_id] = opp_name[oid]

        # Division: must be resolved for ALL tickets (including those with PropertyName)
        for t in tickets:
            wt_id  = t.get("WorkTicketID")
            opp_id = t.get("OpportunityID")
            if not (wt_id and opp_id):
                continue
            oid = int(opp_id)
            if oid in opp_division:
                division_by_wt[wt_id] = opp_division[oid]

    # ── Index visit notes and attachments ─────────────────────────────────────
    notes_by_wt: dict[int, list] = {}
    for n in visit_notes:
        wt_id = n.get("WorkTicketID")
        if wt_id:
            notes_by_wt.setdefault(wt_id, []).append(n)

    attachments_by_wt: dict[int, list] = {}
    attachment_by_id: dict[int, dict] = {}
    for a in attachments:
        wt_id = a.get("WorkTicketID")
        aid   = a.get("AttachmentID")
        if wt_id:
            attachments_by_wt.setdefault(wt_id, []).append(a)
        if aid:
            attachment_by_id[int(aid)] = a

    # ── Helper functions ──────────────────────────────────────────────────────
    IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp"}

    def hrs(h):
        if h is None: return "—"
        return f"{float(h):.1f}h"

    def bbcode_attachment_ids(note_text: str) -> list[int]:
        """Extract AttachmentIDs from [Attachments][Attachment]N[/Attachment][/Attachments]"""
        return [int(m) for m in re.findall(r'\[Attachment\](\d+)\[/Attachment\]', note_text)]

    _aspire_base = getattr(settings, "ASPIRE_WEB_URL", "").rstrip("/")
    _company_code = getattr(settings, "ASPIRE_COMPANY_CODE", "").strip()
    # If company code is set, ticket URLs include it: /app/DARIO1272/worktickets/details/N
    ASPIRE_APP = f"{_aspire_base}/{_company_code}" if _company_code else _aspire_base

    def render_note_text(note_text: str) -> str:
        """Render just the plain-text portion of a visit note (no photo badges here)."""
        if not note_text:
            return ""
        stripped = note_text.strip()
        plain = re.sub(r'\[/?[A-Za-z]+\]\d*', '', stripped).strip()
        if not plain:
            return ""
        if plain.lower().startswith("<") or "<img" in plain.lower():
            return f'<div class="note-html">{plain}</div>'
        safe = plain.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return f'<p class="note-text">{safe}</p>'

    def ticket_photo_section(wt_id: int, wt_num) -> str:
        """One consolidated photo badge for all photos on this ticket."""
        note_photo_ids: list[int] = []
        for n in notes_by_wt.get(wt_id, []):
            note_photo_ids.extend(bbcode_attachment_ids(n.get("Note") or ""))
        bbcode_set = set(note_photo_ids)
        attach_photo_count = sum(
            1 for a in attachments_by_wt.get(wt_id, [])
            if a.get("AttachmentID") and int(a["AttachmentID"]) not in bbcode_set
            and ("." + (a.get("FileExtension") or "")).lower() in IMAGE_EXTS
        )
        total_photos = len(note_photo_ids) + attach_photo_count
        other_files = [
            a for a in attachments_by_wt.get(wt_id, [])
            if ("." + (a.get("FileExtension") or "")).lower() not in IMAGE_EXTS
        ]
        out = ""
        if total_photos:
            label = f"📷 {total_photos} photo{'s' if total_photos != 1 else ''}"
            if ASPIRE_APP:
                url = f"{ASPIRE_APP}/worktickets/details/{wt_id}"
                out += f'<div class="photo-badge"><a href="{url}" target="_blank">{label} — view in Aspire</a></div>'
            else:
                out += f'<div class="photo-badge">{label}</div>'
        for a in other_files:
            fname = a.get("AttachmentName") or a.get("OriginalFileName") or "attachment"
            out += f'<div class="attach-file">📎 {fname}</div>'
        return out

    def build_ticket_row(t: dict) -> str:
        wt_id     = t.get("WorkTicketID")
        wt_num    = t.get("WorkTicketNumber") or "—"
        prop_name = property_by_wt.get(wt_id) or opp_name_by_wt.get(wt_id) or "—"
        wt_notes  = notes_by_wt.get(wt_id, [])
        aspire_ticket_url = f"{ASPIRE_APP}/worktickets/details/{wt_id}" if (ASPIRE_APP and wt_id) else ""
        logger.info(f"Ticket link: wt_id={wt_id!r} wt_num={wt_num!r} url={aspire_ticket_url!r} ASPIRE_APP={ASPIRE_APP!r}")
        ticket_link = (
            f'<a class="ticket-num" href="{aspire_ticket_url}" target="_blank">#{wt_num}</a>'
            if aspire_ticket_url else f'<span class="ticket-num">#{wt_num}</span>'
        )
        notes_html = "".join(render_note_text(n.get("Note") or "") for n in wt_notes)
        extra_attach = ticket_photo_section(wt_id, wt_num)
        status_name = (t.get("WorkTicketStatusName") or "").strip()
        is_complete = "complet" in status_name.lower()
        status_badge = (
            '<span class="badge-complete">✓ Complete</span>' if is_complete
            else f'<span class="badge-scheduled">{status_name or "Scheduled"}</span>'
        )
        css = "ticket-complete" if is_complete else "ticket-scheduled"

        # Hours display: today's logged hours vs estimate; fall back to total actual if no time entries
        today_h = hours_today_by_wt.get(wt_id)
        hrs_est = float(t.get("HoursEst") or 0)
        if today_h is not None:
            # Colour-code: red if today > est, green if on/under
            over = hrs_est and today_h > hrs_est * 1.1
            colour = "#ef4444" if over else "#16a34a"
            hours_html = (
                f'<span class="ticket-hours">'
                f'<span style="font-weight:700;color:{colour}">{today_h:.1f}h today</span>'
                f' / {hrs(hrs_est)} est'
                f'</span>'
            )
        else:
            hours_html = f'<span class="ticket-hours">{hrs(t.get("HoursAct"))} actual / {hrs(hrs_est)} est</span>'

        return f"""
            <div class="ticket {css}">
              <div class="ticket-header">
                {ticket_link}
                <span class="ticket-prop">{prop_name}</span>
                {status_badge}
                {hours_html}
              </div>
              {notes_html}{extra_attach}
            </div>"""

    def build_route_sections(ticket_list: list) -> str:
        """Build HTML route sections for a given list of tickets."""
        by_route: dict[str, list] = {}
        for t in ticket_list:
            route = (t.get("CrewLeaderName") or t.get("BranchName") or "Unassigned").strip()
            by_route.setdefault(route, []).append(t)
        html_out = ""
        for route in sorted(by_route.keys(), key=lambda r: (r == "Unassigned", r.lower())):
            rt = by_route[route]
            # Use today's logged hours if available, otherwise fall back to total actual
            ra = sum(
                hours_today_by_wt.get(t.get("WorkTicketID"), float(t.get("HoursAct") or 0))
                for t in rt
            )
            re_ = sum(float(t.get("HoursEst") or 0) for t in rt)
            rows = "".join(build_ticket_row(t) for t in sorted(rt, key=lambda x: x.get("WorkTicketNumber") or 0))
            html_out += f"""
        <div class="route-section">
          <div class="route-header">
            <h2>{route}</h2>
            <span class="route-stats">{len(rt)} ticket(s) &nbsp;·&nbsp; {hrs(ra)} today / {hrs(re_)} est</span>
          </div>
          {rows if rows else '<p class="empty">No tickets found.</p>'}
        </div>"""
        return html_out

    async def build_ai_summary(note_list: list, label: str = "") -> str:
        """Generate AI action-item summary HTML for a list of visit notes."""
        try:
            import anthropic as _anthropic
            text_notes = []
            for n in note_list:
                txt = (n.get("Note") or "").strip()
                if not txt:
                    continue
                clean = re.sub(r'\[/?[A-Za-z]+\]\d*', '', txt).strip()
                if not clean:
                    continue
                wt_id  = n.get("WorkTicketID") or "?"
                wt_num = n.get("WorkTicketNumber") or wt_id
                prop   = property_by_wt.get(wt_id) or opp_name_by_wt.get(wt_id) or f"Ticket #{wt_num}"
                text_notes.append(f"{prop}: {clean}")
            logger.info(
                f"AI summary [{label}]: {len(note_list)} notes in, "
                f"{len(text_notes)} with text content, "
                f"api_key_set={bool(settings.ANTHROPIC_API_KEY)}"
            )
            if not text_notes:
                return ""
            notes_block = "\n".join(text_notes)
            scope = f" ({label})" if label else ""
            _claude = _anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
            msg = await _claude.messages.create(
                model="claude-haiku-4-5",
                max_tokens=600,
                messages=[{
                    "role": "user",
                    "content": (
                        f"Below are field notes from today's work tickets{scope} ({display_date}). "
                        "Identify any action items, follow-ups, deficiencies, or issues needing management attention. "
                        "Format as a concise bulleted list. If none, say 'No action items identified.'\n\n"
                        f"{notes_block}"
                    ),
                }],
            )
            summary_text = msg.content[0].text.strip()
            html_lines = []
            for line in summary_text.split("\n"):
                line = line.strip()
                if not line:
                    continue
                if line.startswith(("- ", "* ", "• ")):
                    html_lines.append(f"<li>{line[2:].strip()}</li>")
                else:
                    html_lines.append(f"<p style='margin:4px 0'>{line}</p>")
            inner = "".join(html_lines)
            if "<li>" in inner:
                inner = f"<ul style='margin:4px 0;padding-left:20px'>{inner}</ul>"
            return f"""
            <div class="ai-summary">
              <div class="ai-summary-title">🤖 Action Items &amp; Follow-ups</div>
              {inner}
            </div>"""
        except Exception as ex:
            logger.warning(f"AI summary failed ({label}): {ex}")
            return ""

    # ── Division ordering & colours ───────────────────────────────────────────
    DIVISION_ORDER = [
        "Residential Maintenance",
        "Commercial Maintenance",
        "Construction",
        "Irrigation",
    ]
    DIVISION_COLOURS = {
        "Residential Maintenance": "#166534",   # green
        "Commercial Maintenance":  "#0369a1",   # blue
        "Construction":            "#92400e",   # amber
        "Irrigation":              "#6d28d9",   # purple
    }

    # ── Build WorkTicketID → DivisionName for tickets that have OpportunityID ─
    # (already done above via opp_division); for tickets without an opportunity,
    # fall back to the WorkTicket's own DivisionName field if present.
    for t in tickets:
        wt_id = t.get("WorkTicketID")
        if wt_id and wt_id not in division_by_wt:
            d = (t.get("DivisionName") or "").strip()
            if d:
                division_by_wt[wt_id] = d

    # ── Filter to one division if requested ───────────────────────────────────
    if division:
        div_filter = division.strip().lower()
        tickets = [
            t for t in tickets
            if div_filter in (division_by_wt.get(t.get("WorkTicketID")) or "").lower()
        ]
        # Also filter visit_notes to those tickets
        valid_wt_ids = {t.get("WorkTicketID") for t in tickets}
        visit_notes = [n for n in visit_notes if n.get("WorkTicketID") in valid_wt_ids]

    # ── Group tickets by division ─────────────────────────────────────────────
    by_division: dict[str, list] = {}
    for t in tickets:
        wt_id  = t.get("WorkTicketID")
        div    = division_by_wt.get(wt_id) or "Other"
        by_division.setdefault(div, []).append(t)

    # ── Also index notes by division for AI summaries ────────────────────────
    notes_by_division: dict[str, list] = {}
    for n in visit_notes:
        wt_id = n.get("WorkTicketID")
        # find which division this note's ticket belongs to
        div = division_by_wt.get(wt_id) or "Other"
        notes_by_division.setdefault(div, []).append(n)

    # ── Build per-division HTML sections (AI summaries run concurrently) ──────
    div_names_in_data = list(by_division.keys())
    ordered_divs = [d for d in DIVISION_ORDER if d in div_names_in_data] + \
                   [d for d in div_names_in_data if d not in DIVISION_ORDER]

    # Run all AI summaries concurrently
    ai_tasks = {
        div: build_ai_summary(notes_by_division.get(div, []), div)
        for div in ordered_divs
    }
    ai_results = dict(zip(
        ai_tasks.keys(),
        await asyncio.gather(*ai_tasks.values()),
    ))

    total_tickets   = len(tickets)
    total_hours_est = sum(float(t.get("HoursEst") or 0) for t in tickets)
    # Use today's logged hours where available; fall back to ticket total actual
    total_hours_act = sum(
        hours_today_by_wt.get(t.get("WorkTicketID"), float(t.get("HoursAct") or 0))
        for t in tickets
    )

    division_sections = ""
    for div in ordered_divs:
        div_tickets = by_division[div]
        # Use today's clocked hours (from WorkTicketTimes) where available;
        # fall back to lifetime HoursAct so scheduled-only tickets still show something.
        div_act = sum(
            hours_today_by_wt.get(t.get("WorkTicketID"), float(t.get("HoursAct") or 0))
            for t in div_tickets
        )
        div_est = sum(float(t.get("HoursEst") or 0) for t in div_tickets)
        colour  = DIVISION_COLOURS.get(div, "#334155")
        route_html   = build_route_sections(div_tickets)
        ai_html      = ai_results.get(div, "")

        division_sections += f"""
    <div class="division-section">
      <div class="division-header" style="background:{colour}">
        <h2>{div}</h2>
        <span class="div-stats">{len(div_tickets)} ticket(s) &nbsp;·&nbsp; {hrs(div_act)} today / {hrs(div_est)} est</span>
      </div>
      <div class="division-body">
        {ai_html}
        {route_html if route_html else '<p class="empty">No tickets found.</p>'}
      </div>
    </div>"""

    report_title = f"Daily Report — {division}" if division else "Daily Completion Report"
    # Pre-encode division for use in the date-picker JS (encodeURIComponent is JS, not Python)
    _div_qs = f"&division={_url_quote(division, safe='')}" if division else ""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>{report_title} — {display_date}</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         color: #111; max-width: 960px; margin: 0 auto; padding: 32px 24px; }}
  h1   {{ font-size: 22px; margin: 0 0 4px; color: #0f172a; }}
  .subtitle {{ color: #64748b; font-size: 14px; margin-bottom: 24px; }}
  .summary {{ display: flex; gap: 24px; margin-bottom: 24px; background: #f8fafc;
              border-radius: 8px; padding: 16px 20px; flex-wrap: wrap; }}
  .stat    {{ text-align: center; }}
  .stat-val {{ font-size: 28px; font-weight: 700; color: #0f172a; }}
  .stat-lbl {{ font-size: 12px; color: #64748b; }}
  .division-section {{ margin-bottom: 36px; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; }}
  .division-header {{ color: #fff; padding: 12px 18px;
                      display: flex; justify-content: space-between; align-items: center; }}
  .division-header h2 {{ margin: 0; font-size: 17px; font-weight: 700; }}
  .div-stats {{ font-size: 12px; color: rgba(255,255,255,0.75); }}
  .division-body {{ padding: 12px 0; }}
  .ai-summary {{ background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px;
                 padding: 14px 18px; margin: 8px 14px 16px; }}
  .ai-summary-title {{ font-weight: 700; font-size: 14px; color: #92400e; margin-bottom: 8px; }}
  .ai-summary li {{ font-size: 13px; color: #374151; margin-bottom: 4px; }}
  .route-section {{ margin: 0 14px 16px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }}
  .route-header {{ background: #334155; color: #fff; padding: 8px 14px;
                   display: flex; justify-content: space-between; align-items: center; }}
  .route-header h2 {{ margin: 0; font-size: 13px; font-weight: 600; }}
  .route-stats {{ font-size: 11px; color: #94a3b8; }}
  .ticket {{ padding: 12px 16px; border-bottom: 1px solid #f1f5f9; }}
  .ticket:last-child {{ border-bottom: none; }}
  .ticket-header {{ display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }}
  .ticket-num  {{ font-weight: 700; color: #2563eb; font-size: 13px; min-width: 55px;
                  text-decoration: none; }}
  .ticket-num:hover {{ text-decoration: underline; }}
  .ticket-prop {{ font-weight: 600; font-size: 14px; flex: 1; }}
  .ticket-hours {{ font-size: 12px; color: #64748b; white-space: nowrap; }}
  .badge-complete  {{ background:#dcfce7;color:#166534;font-size:11px;font-weight:700;
                     padding:1px 8px;border-radius:20px; white-space:nowrap; }}
  .badge-scheduled {{ background:#e0f2fe;color:#0369a1;font-size:11px;font-weight:700;
                     padding:1px 8px;border-radius:20px; white-space:nowrap; }}
  .ticket-scheduled {{ opacity: 0.88; }}
  .note-text  {{ margin: 4px 0; font-size: 13px; color: #374151;
                 background: #f8fafc; padding: 6px 10px; border-radius: 4px;
                 border-left: 3px solid #cbd5e1; }}
  .note-html  {{ margin: 4px 0; }}
  .note-html img {{ max-width: 100%; border-radius: 6px; margin: 4px 0; }}
  .photo-badge {{ display: inline-block; margin: 4px 0; font-size: 12px;
                  background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 20px;
                  padding: 2px 10px; }}
  .photo-badge a {{ color: #1d4ed8; text-decoration: none; font-weight: 600; }}
  .photo-badge a:hover {{ text-decoration: underline; }}
  .attach-file {{ font-size: 12px; color: #64748b; margin: 3px 0; }}
  .empty {{ color: #94a3b8; font-size: 13px; padding: 8px 16px; }}
  .efficiency-table {{ margin: 8px 14px 16px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }}
  .efficiency-title {{ background: #f1f5f9; font-weight: 700; font-size: 13px; color: #334155;
                       padding: 8px 14px; border-bottom: 1px solid #e2e8f0; }}
  .efficiency-table table {{ width: 100%; border-collapse: collapse; }}
  .efficiency-table th {{ font-size: 11px; color: #64748b; font-weight: 600; padding: 6px 12px;
                          background: #f8fafc; border-bottom: 1px solid #e2e8f0; }}
  .efficiency-table td {{ font-size: 13px; padding: 6px 12px; border-bottom: 1px solid #f1f5f9; }}
  .efficiency-table tr:last-child td {{ border-bottom: none; }}
  .eff-name {{ text-align: left; }}
  .eff-num  {{ text-align: right; }}
  .report-header {{ display:flex; justify-content:space-between; align-items:flex-end;
                    margin-bottom:20px; flex-wrap:wrap; gap:12px; }}
  .controls {{ display:flex; gap:16px; align-items:flex-end; flex-wrap:wrap; }}
  @media print {{
    body {{ padding: 0; max-width: 100%; }}
    .controls {{ display: none; }}
    .division-section {{ break-inside: avoid; }}
    .route-section {{ break-inside: avoid; }}
  }}
</style>
</head>
<body>
  <div class="report-header">
    <div>
      <h1>{report_title}</h1>
      <div class="subtitle">Generated {datetime.now(timezone.utc).strftime('%H:%M UTC')}</div>
    </div>
    <div class="controls">
      <div>
        <label style="font-size:12px;color:#64748b;display:block;margin-bottom:4px">Report date</label>
        <input type="date" id="report-date" value="{target}"
               style="font-size:14px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer"
               onchange="window.location.href='?date='+this.value+'{_div_qs}'">
      </div>
      <div>
        <label style="font-size:12px;color:#64748b;display:block;margin-bottom:4px">Search</label>
        <input type="search" id="search" placeholder="Property or route…"
               style="font-size:14px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;width:220px"
               oninput="filterReport(this.value)">
      </div>
    </div>
  </div>
  <div class="summary">
    <div class="stat"><div class="stat-val">{total_tickets}</div><div class="stat-lbl">Tickets</div></div>
    <div class="stat"><div class="stat-val">{total_hours_act:.1f}h</div><div class="stat-lbl">Hours Today</div></div>
    <div class="stat"><div class="stat-val">{total_hours_est:.1f}h</div><div class="stat-lbl">Est. Hours</div></div>
    <div class="stat"><div class="stat-val">{len(ordered_divs)}</div><div class="stat-lbl">Divisions</div></div>
    <div class="stat"><div class="stat-val">{len(visit_notes)}</div><div class="stat-lbl">Visit Notes</div></div>
    <div class="stat"><div class="stat-val">{len(attachments)}</div><div class="stat-lbl">Attachments</div></div>
  </div>
  {division_sections or '<p style="color:#94a3b8">No tickets found for this date.</p>'}
<script>
function filterReport(q) {{
  q = q.trim().toLowerCase();
  document.querySelectorAll('.ticket').forEach(function(el) {{
    var text = el.innerText.toLowerCase();
    el.style.display = (!q || text.includes(q)) ? '' : 'none';
  }});
  // Hide route sections that have no visible tickets
  document.querySelectorAll('.route-section').forEach(function(sec) {{
    var visible = Array.from(sec.querySelectorAll('.ticket')).some(function(t) {{ return t.style.display !== 'none'; }});
    sec.style.display = visible ? '' : 'none';
  }});
  // Hide division sections that have no visible route sections
  document.querySelectorAll('.division-section').forEach(function(sec) {{
    var visible = Array.from(sec.querySelectorAll('.route-section')).some(function(r) {{ return r.style.display !== 'none'; }});
    sec.style.display = visible ? '' : 'none';
  }});
}}
</script>
</body>
</html>"""

    return HTMLResponse(content=html)


# ── Daily Report Email Recipients ─────────────────────────────────────────────
# Add / edit divisions and recipients here; cron calls /daily-report/send-email
# with ?division=<key> for each entry.

# Always CC'd on every division report (management oversight)
DAILY_REPORT_CC: list[str] = [
    "paul@darios.ca",
]

DAILY_REPORT_RECIPIENTS: dict[str, list[str]] = {
    "Construction": [
        "rodger@darios.ca",
        "dustin@darios.ca",
        "keeland@darios.ca",
    ],
    "Commercial Maintenance": [
        "ipm@darios.ca",
        "vesna@darios.ca",
        "don.i.whyte@gmail.com",
        "clientcare@darios.ca",
    ],
    "Residential Maintenance": [
        "vesna@darios.ca",
        "becca@darios.ca",
        "ipm@darios.ca",
        "clientcare@darios.ca",
    ],
    "Irrigation": [
        "vesna@darios.ca",
        "becca@darios.ca",
        "ipm@darios.ca",
        "clientcare@darios.ca",
        "don.i.whyte@gmail.com",
    ],
}


@router.post("/daily-report/send-all")
async def send_all_daily_reports(date: str = Query(None)):
    """
    Send daily report emails for ALL configured divisions in one call.
    The Railway cron job should call this endpoint — no need for a separate
    cron entry per division.
    """
    results = []
    for division in DAILY_REPORT_RECIPIENTS:
        try:
            result = await send_daily_report_email(date=date, division=division)
            results.append(result)
        except Exception as e:
            logger.error(f"Daily report failed for {division!r}: {e}")
            results.append({"ok": False, "division": division, "error": str(e)})
    return {"results": results}


@router.post("/daily-report/send-email")
async def send_daily_report_email(
    date: str = Query(None),
    division: str = Query(..., description="Division name, e.g. 'Construction'"),
):
    """
    Generate the daily HTML report for one division and email it to configured recipients.
    Prefer calling /daily-report/send-all to send all divisions in one cron job.
    """
    from datetime import datetime, timezone, timedelta
    from app.services.email_intake import GraphClient

    recipients = DAILY_REPORT_RECIPIENTS.get(division)
    if not recipients:
        raise HTTPException(
            status_code=400,
            detail=f"No recipients configured for division '{division}'. "
                   f"Add it to DAILY_REPORT_RECIPIENTS in dashboard.py.",
        )

    if not settings.MS_TENANT_ID or not settings.MS_CLIENT_ID or not settings.MS_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="MS Graph credentials not configured")

    # Generate the report HTML by calling the existing endpoint directly
    response = await daily_report_html(date=date, division=division)
    html_body = response.body.decode("utf-8")

    # Skip sending if there are no tickets for this division today
    if "No tickets found" in html_body:
        logger.info(f"Daily report: no tickets for {division!r} on {date or 'today'} — skipping email")
        return {"ok": True, "division": division, "skipped": True, "reason": "no tickets"}

    # Work out the display date for the subject line
    if date:
        target = date
    else:
        tz_offset = getattr(settings, "REPORT_TZ_OFFSET", -4)
        target = datetime.now(timezone(timedelta(hours=tz_offset))).strftime("%Y-%m-%d")
    display_date = datetime.strptime(target, "%Y-%m-%d").strftime("%B %d, %Y")

    graph = GraphClient()
    await graph.send_email(
        mailbox=settings.MS_AP_INBOX,
        to_addresses=recipients,
        subject=f"📋 {division} Daily Report — {display_date}",
        body_html=html_body,
        cc_addresses=DAILY_REPORT_CC or None,
    )

    logger.info(
        f"Daily report emailed: division={division!r} date={target} "
        f"recipients={recipients}"
    )
    return {
        "ok":        True,
        "division":  division,
        "date":      target,
        "sent_to":   recipients,
    }
