"""
Invoice Summary Report — weekly progress per service category.

GET /invoice-summary/search?q=...       Opportunity typeahead
GET /invoice-summary/report?opp_id=X&week_start=YYYY-MM-DD
"""
import logging
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/invoice-summary", tags=["invoice-summary"])


def _snap_to_monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


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


@router.get("/search")
async def search_opportunities(q: str = Query(..., min_length=2)):
    aspire = AspireClient()
    try:
        results = await aspire.search_opportunities_field(q, limit=20)
        return {"results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await aspire.close()


@router.get("/report")
async def get_weekly_report(
    opp_id:     int = Query(...),
    week_start: str = Query(..., description="Any date in the week (YYYY-MM-DD)"),
):
    # Snap to Monday/Sunday
    d = date.fromisoformat(week_start)
    monday = _snap_to_monday(d)
    sunday = monday + timedelta(days=6)
    week_mon = monday.isoformat()
    week_sun = sunday.isoformat()
    week_days = [(monday + timedelta(days=i)).isoformat() for i in range(7)]

    aspire = AspireClient()
    try:
        # 1. Opportunity details
        opp_result = await aspire._get("Opportunities", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$select": "OpportunityID,OpportunityName,PropertyName,WonDollars",
            "$top": "1",
        })
        opps = aspire._extract_list(opp_result)
        if not opps:
            raise HTTPException(status_code=404, detail=f"Opportunity {opp_id} not found")
        opp = opps[0]

        # 2. Service categories
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
                svc.get("ServiceName")
                or svc.get("ServiceNameAbr")
                or svc.get("DisplayName")
                or f"Service {sid}"
            )
            # Try various field names for budgeted hours
            est_h = (
                svc.get("EstimatedLaborHours")
                or svc.get("BudgetedLaborHours")
                or svc.get("EstimatedHours")
                or svc.get("BudgetHours")
                or 0
            )
            service_map[sid] = {
                "service_id": sid,
                "service_name": str(name),
                "estimated_hours": float(est_h),
            }

        # 3. Work tickets — actual hours, service linkage
        ticket_result = await aspire._get("WorkTickets", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$select": (
                "WorkTicketID,OpportunityID,OpportunityServiceID,"
                "ActualLaborHours,EstimatedLaborHours,WorkTicketStatusName"
            ),
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
                "actual_hours": float(t.get("ActualLaborHours") or 0),
                "estimated_hours": float(t.get("EstimatedLaborHours") or 0),
            }

        # 4. WorkTicketTimes — fetch all for these tickets, filter by date in Python
        hours_by_day: dict[int, dict[str, float]] = {}      # service_id -> day -> hours
        hours_this_week_by_service: dict[int, float] = {}
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
                        if not day_str or day_str < week_mon or day_str > week_sun:
                            continue  # outside this week
                        hours = float(entry.get("Hours") or entry.get("ActualHours") or 0)
                        if not hours:
                            hours = _compute_hours(entry.get("StartTime"), entry.get("EndTime"))
                        hours_this_week_by_service[svc_id] = hours_this_week_by_service.get(svc_id, 0) + hours
                        hours_by_day.setdefault(svc_id, {})
                        hours_by_day[svc_id][day_str] = hours_by_day[svc_id].get(day_str, 0) + hours
                except Exception as e:
                    logger.warning(f"WorkTicketTimes fetch failed: {e}")

        # 5. Receipts (materials) — fetch all, filter by VendorInvoiceDate in Python
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
                        # Filter by invoice date within week
                        inv_date = (r.get("VendorInvoiceDate") or r.get("ReceivedDate") or "")[:10]
                        if inv_date < week_mon or inv_date > week_sun:
                            continue
                        vendor = r.get("VendorName") or ""
                        note   = r.get("ReceiptNote") or ""
                        receipts_by_service.setdefault(svc_id, []).append({
                            "receipt_id":     r.get("ReceiptID"),
                            "vendor_name":    vendor,
                            "invoice_number": r.get("VendorInvoiceNum") or "",
                            "invoice_date":   inv_date,
                            "amount":         float(r.get("ReceiptTotalCost") or 0),
                            "note":           note,
                            "status":         r.get("ReceiptStatusName") or "",
                        })
                except Exception as e:
                    logger.warning(f"Receipts fetch failed: {e}")

        # 6. Compute per-service totals from WorkTickets
        actual_by_svc:   dict[int, float] = {}
        est_by_svc_wt:   dict[int, float] = {}
        for t in ticket_map.values():
            sid = t.get("service_id")
            if not sid:
                continue
            sid = int(sid)
            actual_by_svc[sid]  = actual_by_svc.get(sid, 0)  + t["actual_hours"]
            est_by_svc_wt[sid]  = est_by_svc_wt.get(sid, 0)  + t["estimated_hours"]

        # 7. Build sections — include ALL services, skip empty ones with no hours and no materials
        sections = []
        for svc_id, svc_info in sorted(service_map.items(), key=lambda x: x[1]["service_name"]):
            est_h    = svc_info["estimated_hours"] or est_by_svc_wt.get(svc_id, 0)
            this_wk  = round(hours_this_week_by_service.get(svc_id, 0), 2)
            total_act = round(actual_by_svc.get(svc_id, 0), 2)
            to_date  = round(max(0.0, total_act - this_wk), 2)
            remaining = round(max(0.0, est_h - total_act), 2)
            daily    = {day: round(hours_by_day.get(svc_id, {}).get(day, 0), 2) for day in week_days}
            mats     = receipts_by_service.get(svc_id, [])
            mat_total = round(sum(m["amount"] for m in mats), 2)

            # Skip sections with nothing to show
            if est_h == 0 and total_act == 0 and not mats:
                continue

            sections.append({
                "service_id":      svc_id,
                "service_name":    svc_info["service_name"],
                "estimated_hours": round(est_h, 2),
                "hours_to_date":   to_date,
                "hours_this_week": this_wk,
                "hours_by_day":    daily,
                "remaining_hours": remaining,
                "materials":       mats,
                "materials_total": mat_total,
            })

        totals = {
            "estimated_hours": round(sum(s["estimated_hours"] for s in sections), 2),
            "hours_to_date":   round(sum(s["hours_to_date"]   for s in sections), 2),
            "hours_this_week": round(sum(s["hours_this_week"] for s in sections), 2),
            "remaining_hours": round(sum(s["remaining_hours"] for s in sections), 2),
            "materials_total": round(sum(s["materials_total"] for s in sections), 2),
        }

        return {
            "opportunity_id":   opp_id,
            "opportunity_name": opp.get("OpportunityName") or "",
            "property_name":    opp.get("PropertyName") or "",
            "week_start":       week_mon,
            "week_end":         week_sun,
            "week_days":        week_days,
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
