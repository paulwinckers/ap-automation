"""
Invoice Summary Report — progress per service category over a date range.

GET /invoice-summary/search?q=...              Property name typeahead
GET /invoice-summary/property-opps?property_id=X  Opportunities for a property
GET /invoice-summary/report?opp_id=X&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
"""
import logging
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/invoice-summary", tags=["invoice-summary"])


def _compute_hours(start: Optional[str], end: Optional[str]) -> float:
    if not start or not end:
        return 0.0
    try:
        s = start.rstrip("Z").split("+")[0].split(".")[0]
        e = end.rstrip("Z").split("+")[0].split(".")[0]
        diff = datetime.fromisoformat(e) - datetime.fromisoformat(s)
        return max(0.0, round(diff.total_seconds() / 3600, 2))
    except Exception:
        return 0.0


# ── Search by property name ───────────────────────────────────────────────────

@router.get("/search")
async def search_properties(q: str = Query(..., min_length=2)):
    """Search Aspire Properties endpoint directly by PropertyName."""
    aspire = AspireClient()
    try:
        escaped = q.replace("'", "''")

        # Primary: search the Properties endpoint directly
        try:
            prop_result = await aspire._get("Properties", {
                "$filter": f"contains(PropertyName, '{escaped}')",
                "$select": "PropertyID,PropertyName",
                "$top": "25",
            })
            props = aspire._extract_list(prop_result)
            if props:
                return {
                    "results": [
                        {"PropertyID": p.get("PropertyID"), "PropertyName": p.get("PropertyName")}
                        for p in props
                        if p.get("PropertyID") and p.get("PropertyName")
                    ]
                }
        except Exception as e:
            logger.warning(f"Properties search failed, falling back to Opportunities: {e}")

        # Fallback: search via Opportunities (deduplicated by PropertyID)
        results = await aspire.search_all_opportunities_field(q, limit=25)
        return {"results": results}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await aspire.close()


# ── Contracts listing ────────────────────────────────────────────────────────

@router.get("/contracts")
async def list_contracts():
    """All Won and In Production opportunities — lightweight, no ticket data."""
    aspire = AspireClient()
    try:
        result = await aspire._get("Opportunities", {
            "$filter": (
                "OpportunityStatusName eq 'Won'"
                " or OpportunityStatusName eq 'In Production'"
            ),
            "$select": (
                "OpportunityID,OpportunityName,PropertyName,PropertyID,"
                "OpportunityStatusName,WonDollars,StartDate,EndDate"
            ),
            "$top": "300",
            "$orderby": "PropertyName asc",
        })
        contracts = aspire._extract_list(result)
        return {"contracts": contracts}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await aspire.close()


# ── Debug: raw Aspire fields for an opportunity ──────────────────────────────

@router.get("/debug")
async def debug_opportunity(opp_id: int = Query(...)):
    """Return raw first records from OpportunityServices and WorkTickets so field names can be confirmed."""
    aspire = AspireClient()
    try:
        svc_result = await aspire._get("OpportunityServices", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$top": "2",
        })
        svcs = aspire._extract_list(svc_result)

        ticket_result = await aspire._get("WorkTickets", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$top": "2",
        })
        tickets = aspire._extract_list(ticket_result)

        # If we have a ticket, fetch a WorkTicketTime for it
        times = []
        if tickets:
            tid = tickets[0].get("WorkTicketID")
            if tid:
                times_result = await aspire._get("WorkTicketTimes", {
                    "$filter": f"WorkTicketID eq {tid}",
                    "$top": "2",
                })
                times = aspire._extract_list(times_result)

        return {
            "opportunity_services_sample": svcs[:1],
            "work_tickets_sample": tickets[:1],
            "work_ticket_times_sample": times[:1],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await aspire.close()


# ── Opportunities for a property ──────────────────────────────────────────────

@router.get("/property-opps")
async def get_property_opportunities(property_id: int = Query(...)):
    """Return all opportunities for a given PropertyID, newest first."""
    aspire = AspireClient()
    try:
        result = await aspire._get("Opportunities", {
            "$filter": (
                f"PropertyID eq {property_id}"
                " and (OpportunityStatusName eq 'Won' or OpportunityStatusName eq 'In Production')"
            ),
            "$select": (
                "OpportunityID,OpportunityName,PropertyName,"
                "OpportunityStatusName,WonDollars,StartDate,EndDate"
            ),
            "$top": "50",
            "$orderby": "StartDate desc",
        })
        opps = aspire._extract_list(result)
        return {"opportunities": opps}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await aspire.close()


# ── Main report ───────────────────────────────────────────────────────────────

@router.get("/report")
async def get_report(
    opp_id:    int = Query(...),
    date_from: str = Query(..., description="Start date (YYYY-MM-DD)"),
    date_to:   str = Query(..., description="End date (YYYY-MM-DD)"),
):
    """
    Build the Invoice Summary Report for a given opportunity and date range.
    Returns service sections with hours breakdown and materials.
    """
    d_from = date.fromisoformat(date_from)
    d_to   = date.fromisoformat(date_to)
    if d_to < d_from:
        d_from, d_to = d_to, d_from
    period_start = d_from.isoformat()
    period_end   = d_to.isoformat()
    period_days  = [
        (d_from + timedelta(days=i)).isoformat()
        for i in range((d_to - d_from).days + 1)
    ]

    aspire = AspireClient()
    try:
        # ── 1. Opportunity details ────────────────────────────────────────────
        opp_result = await aspire._get("Opportunities", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$select": "OpportunityID,OpportunityName,PropertyName,WonDollars",
            "$top": "1",
        })
        opps = aspire._extract_list(opp_result)
        if not opps:
            raise HTTPException(status_code=404, detail=f"Opportunity {opp_id} not found")
        opp = opps[0]

        # ── 2. Service categories ─────────────────────────────────────────────
        svc_result = await aspire._get("OpportunityServices", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$top": "100",
        })
        services = aspire._extract_list(svc_result)
        service_map: dict[int, dict] = {}
        for svc in services:
            sid = svc.get("OpportunityServiceID")
            if not sid:
                continue
            sid = int(sid)
            name = (
                svc.get("DisplayName")
                or svc.get("ServiceName")
                or svc.get("ServiceNameAbr")
                or f"Service {sid}"
            )
            est_h = float(
                svc.get("ExtendedHours")       # confirmed field name
                or svc.get("PerHours")
                or svc.get("EstimatedLaborHours")
                or svc.get("BudgetedLaborHours")
                or svc.get("EstimatedHours")
                or svc.get("BudgetHours")
                or 0
            )
            service_map[sid] = {
                "service_id":      sid,
                "service_name":    str(name),
                "estimated_hours": est_h,
            }

        # ── 3. Work tickets ───────────────────────────────────────────────────
        # No $select — some field names vary by Aspire version; fetch all and pick what exists
        ticket_result = await aspire._get("WorkTickets", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$top": "200",
        })
        tickets = aspire._extract_list(ticket_result)
        ticket_map: dict[int, dict] = {}
        ticket_ids: list[int] = []
        for t in tickets:
            tid = t.get("WorkTicketID")
            if not tid:
                continue
            tid = int(tid)
            ticket_ids.append(tid)
            ticket_map[tid] = {
                "service_id": t.get("OpportunityServiceID"),
                "actual_hours": float(
                    t.get("HoursAct")           # confirmed field name
                    or t.get("ActualLaborHours")
                    or t.get("ActualHours")
                    or t.get("TotalActualHours")
                    or 0
                ),
                "estimated_hours": float(
                    t.get("HoursEst")           # confirmed field name
                    or t.get("EstimatedLaborHours")
                    or t.get("EstimatedHours")
                    or t.get("BudgetedLaborHours")
                    or t.get("BudgetHours")
                    or 0
                ),
            }

        # ── 4. WorkTicketTimes — fetch all, filter by date in Python ──────────
        hours_by_day: dict[int, dict[str, float]] = {}
        hours_in_period_by_service: dict[int, float] = {}

        if ticket_ids:
            for chunk_start in range(0, len(ticket_ids), 15):
                chunk = ticket_ids[chunk_start:chunk_start + 15]
                or_filter = " or ".join(f"WorkTicketID eq {tid}" for tid in chunk)
                try:
                    times_result = await aspire._get("WorkTicketTimes", {
                        "$filter": f"({or_filter})",
                        "$top": "2000",
                    })
                    for entry in aspire._extract_list(times_result):
                        tid = entry.get("WorkTicketID")
                        if not tid or int(tid) not in ticket_map:
                            continue
                        svc_id = ticket_map[int(tid)].get("service_id")
                        if not svc_id:
                            continue
                        svc_id = int(svc_id)
                        start_str = entry.get("StartTime") or ""
                        day_str = start_str[:10] if len(start_str) >= 10 else ""
                        if not day_str or day_str < period_start or day_str > period_end:
                            continue
                        hours = float(entry.get("Hours") or entry.get("ActualHours") or 0)
                        if not hours:
                            hours = _compute_hours(entry.get("StartTime"), entry.get("EndTime"))
                        hours_in_period_by_service[svc_id] = (
                            hours_in_period_by_service.get(svc_id, 0) + hours
                        )
                        hours_by_day.setdefault(svc_id, {})
                        hours_by_day[svc_id][day_str] = hours_by_day[svc_id].get(day_str, 0) + hours
                except Exception as e:
                    logger.warning(f"WorkTicketTimes fetch failed: {e}")

        # ── 5. Receipts (materials) — fetch all, filter by invoice date ───────
        receipts_by_service: dict[int, list[dict]] = {}

        if ticket_ids:
            for chunk_start in range(0, len(ticket_ids), 15):
                chunk = ticket_ids[chunk_start:chunk_start + 15]
                or_filter = " or ".join(f"WorkTicketID eq {tid}" for tid in chunk)
                try:
                    rec_result = await aspire._get("Receipts", {
                        "$filter": f"({or_filter})",
                        "$select": (
                            "ReceiptID,WorkTicketID,VendorID,VendorName,"
                            "VendorInvoiceNum,VendorInvoiceDate,ReceivedDate,"
                            "ReceiptTotalCost,ReceiptNote,ReceiptStatusName"
                        ),
                        "$top": "500",
                    })
                    for r in aspire._extract_list(rec_result):
                        tid = r.get("WorkTicketID")
                        if not tid or int(tid) not in ticket_map:
                            continue
                        svc_id = ticket_map[int(tid)].get("service_id")
                        if not svc_id:
                            continue
                        svc_id = int(svc_id)
                        inv_date = (
                            r.get("VendorInvoiceDate") or r.get("ReceivedDate") or ""
                        )[:10]
                        if inv_date < period_start or inv_date > period_end:
                            continue
                        receipts_by_service.setdefault(svc_id, []).append({
                            "receipt_id":     r.get("ReceiptID"),
                            "vendor_name":    r.get("VendorName") or "",
                            "invoice_number": r.get("VendorInvoiceNum") or "",
                            "invoice_date":   inv_date,
                            "amount":         float(r.get("ReceiptTotalCost") or 0),
                            "note":           r.get("ReceiptNote") or "",
                            "status":         r.get("ReceiptStatusName") or "",
                        })
                except Exception as e:
                    logger.warning(f"Receipts fetch failed: {e}")

        # ── 6. Per-service totals from WorkTickets ────────────────────────────
        actual_by_svc: dict[int, float] = {}
        est_by_svc_wt: dict[int, float] = {}
        for t in ticket_map.values():
            sid = t.get("service_id")
            if not sid:
                continue
            sid = int(sid)
            actual_by_svc[sid] = actual_by_svc.get(sid, 0) + t["actual_hours"]
            est_by_svc_wt[sid] = est_by_svc_wt.get(sid, 0) + t["estimated_hours"]

        # ── 7. Build sections ─────────────────────────────────────────────────
        sections = []
        for svc_id, svc_info in sorted(service_map.items(), key=lambda x: x[1]["service_name"]):
            est_h     = svc_info["estimated_hours"] or est_by_svc_wt.get(svc_id, 0)
            in_period = round(hours_in_period_by_service.get(svc_id, 0), 2)
            total_act = round(actual_by_svc.get(svc_id, 0), 2)
            to_date   = round(max(0.0, total_act - in_period), 2)
            remaining = round(max(0.0, est_h - total_act), 2)
            daily     = {
                day: round(hours_by_day.get(svc_id, {}).get(day, 0), 2)
                for day in period_days
            }
            mats      = receipts_by_service.get(svc_id, [])
            mat_total = round(sum(m["amount"] for m in mats), 2)

            if est_h == 0 and total_act == 0 and not mats:
                continue

            sections.append({
                "service_id":       svc_id,
                "service_name":     svc_info["service_name"],
                "estimated_hours":  round(est_h, 2),
                "hours_to_date":    to_date,
                "hours_in_period":  in_period,
                "hours_by_day":     daily,
                "remaining_hours":  remaining,
                "materials":        mats,
                "materials_total":  mat_total,
            })

        totals = {
            "estimated_hours": round(sum(s["estimated_hours"] for s in sections), 2),
            "hours_to_date":   round(sum(s["hours_to_date"]   for s in sections), 2),
            "hours_in_period": round(sum(s["hours_in_period"] for s in sections), 2),
            "remaining_hours": round(sum(s["remaining_hours"] for s in sections), 2),
            "materials_total": round(sum(s["materials_total"] for s in sections), 2),
        }

        return {
            "opportunity_id":   opp_id,
            "opportunity_name": opp.get("OpportunityName") or "",
            "property_name":    opp.get("PropertyName") or "",
            "period_start":     period_start,
            "period_end":       period_end,
            "period_days":      period_days,
            "sections":         sections,
            "totals":           totals,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Invoice summary report failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await aspire.close()
