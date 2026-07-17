"""
Customer Dashboard — an internal report for a commercial customer (an Aspire
Company) that owns multiple properties.

The customer link is BillingCompanyID / BillingCompanyName on the Opportunity
(confirmed via live probe — there is no CompanyID on Opportunities). One Company
(e.g. "Devon Properties", CompanyID 30) bills many Opportunities across divisions,
each tied to a Property.

Sections:
  1. This week  — completed work tickets, grouped by division (excl. Construction)
  2. Next week  — scheduled look-ahead, grouped by division (excl. Construction)
  3. Construction — the customer's won/committed construction projects (start/end,
     % complete) plus completed + scheduled construction visits.

Photos: crew site photos are pulled from the D1 `job_attachments` table
(work_ticket_id / opp_id → r2_key) and served as R2 presigned thumbnails.

This module is self-contained and does NOT touch the invoice-routing core.
"""

import logging
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.api.construction_plan import _aspire, get_db
from app.api.daily_schedule import _DIV_ORDER
from app.services import r2

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/customer", tags=["customer-dashboard"])

# Non-construction divisions, in _DIV_ORDER order, for the weekly sections.
_MAINT_DIVISIONS = [d for d in _DIV_ORDER if d.lower() != "construction"]


def _div_sort_key(div: str):
    try:
        return (0, _DIV_ORDER.index(div))
    except ValueError:
        return (1, div.lower())


def _tz() -> ZoneInfo:
    return ZoneInfo(settings.CONSTRUCTION_REPORT_TIMEZONE or "America/Vancouver")


def _week_bounds(week_start: str | None):
    """Return (this_mon, next_mon, next_end) as date objects; Mon–Sun weeks."""
    tz = _tz()
    if week_start:
        try:
            anchor = datetime.strptime(week_start, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="week_start must be YYYY-MM-DD")
    else:
        anchor = datetime.now(tz)
    d = anchor.date() if hasattr(anchor, "date") else anchor
    this_mon = d - timedelta(days=d.weekday())
    return this_mon, this_mon + timedelta(days=7), this_mon + timedelta(days=14)


# ── Aspire fetch helpers ──────────────────────────────────────────────────────

async def _search_companies(q: str) -> list[dict]:
    q_safe = (q or "").replace("'", "''")
    rows = _aspire._extract_list(await _aspire._get("Companies", {
        "$filter": f"contains(CompanyName,'{q_safe}') and Active eq true",
        "$select": "CompanyID,CompanyName,Active",
        "$orderby": "CompanyName asc",
        "$top": "25",
    }))
    return [{"company_id": r.get("CompanyID"), "company_name": r.get("CompanyName")}
            for r in rows if r.get("CompanyID")]


async def _fetch_customer_opps(company_id: int) -> list[dict]:
    """All opportunities billed to this company, across divisions."""
    rows = _aspire._extract_list(await _aspire._get("Opportunities", {
        "$filter": f"BillingCompanyID eq {company_id}",
        "$select": (
            "OpportunityID,OpportunityName,OpportunityNumber,BillingCompanyName,"
            "DivisionName,PropertyID,PropertyName,OpportunityType,SalesTypeName,"
            "OpportunityStatusName,StartDate,EndDate,CompleteDate,WonDate,"
            "PercentComplete,WonDollars,ActualEarnedRevenue"
        ),
        "$top": "500",
    }))
    return rows


async def _fetch_customer_tickets(opp_ids: list[int], since: str, until: str) -> list[dict]:
    """Work tickets for the given opportunities scheduled in [since, until).
    Customer-scoped (by OpportunityID) so we never hit the company-wide $top cap."""
    if not opp_ids:
        return []
    tickets: list[dict] = []
    for i in range(0, len(opp_ids), 15):
        chunk = opp_ids[i:i + 15]
        or_f = " or ".join(f"OpportunityID eq {x}" for x in chunk)
        try:
            rows = _aspire._extract_list(await _aspire._get("WorkTickets", {
                "$filter": f"({or_f}) and ScheduledStartDate ge {since} and ScheduledStartDate lt {until}",
                "$select": ("WorkTicketID,WorkTicketNumber,OpportunityID,OpportunityServiceID,"
                            "WorkTicketStatusName,ScheduledStartDate,CompleteDate,"
                            "CrewLeaderName,Notes"),
                "$orderby": "ScheduledStartDate asc",
                "$top": "500",
            }))
            tickets.extend(rows)
        except Exception as e:
            logger.warning(f"Customer ticket fetch failed for chunk {chunk}: {e}")
    return tickets


async def _fetch_service_names(opp_ids: list[int]) -> dict[int, str]:
    """OpportunityServiceID → service label."""
    out: dict[int, str] = {}
    for i in range(0, len(opp_ids), 10):
        chunk = opp_ids[i:i + 10]
        or_f = " or ".join(f"OpportunityID eq {x}" for x in chunk)
        try:
            for svc in _aspire._extract_list(await _aspire._get("OpportunityServices", {
                "$filter": f"({or_f})", "$top": "300",
            })):
                sid = svc.get("OpportunityServiceID")
                if sid:
                    out[sid] = (svc.get("ServiceNameAbr") or svc.get("DisplayName")
                                or svc.get("ServiceName") or "")
        except Exception as e:
            logger.warning(f"Service name fetch failed: {e}")
    return out


async def _fetch_ticket_photos(db: Database, ticket_ids: list[int]) -> dict[int, list[dict]]:
    """work_ticket_id → [{url, file_name}] from job_attachments (R2 presigned).
    Degrades gracefully to {} if D1/R2 is unavailable."""
    if not ticket_ids:
        return {}
    out: dict[int, list[dict]] = defaultdict(list)
    try:
        ph = ",".join("?" for _ in ticket_ids)
        rows = await db._q(
            f"""SELECT work_ticket_id, r2_key, file_name, file_extension
                FROM job_attachments
                WHERE work_ticket_id IN ({ph}) AND is_active = 1
                ORDER BY uploaded_at DESC""",
            ticket_ids,
        )
    except Exception as e:
        logger.warning(f"job_attachments lookup failed (photos omitted): {e}")
        return {}

    for r in rows:
        ext = (r.get("file_extension") or "").lstrip(".").lower()
        if ext and ext not in ("jpg", "jpeg", "png", "heic", "webp", "gif"):
            continue  # only image attachments become thumbnails
        try:
            url = await r2.get_presigned_url(r["r2_key"], expires_in=6 * 3600)
        except Exception as e:
            logger.warning(f"presign failed for {r.get('r2_key')}: {e}")
            url = None
        if url:
            out[r["work_ticket_id"]].append({"url": url, "file_name": r.get("file_name")})
    return dict(out)


# ── Report assembly ───────────────────────────────────────────────────────────

def _is_construction(div: str) -> bool:
    return (div or "").strip().lower() == "construction"


def _pct(v) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f * 100, 1) if f <= 1.0 else round(f, 1)


async def get_customer_report(company_id: int, week_start: str | None, db: Database) -> dict:
    this_mon, next_mon, next_end = _week_bounds(week_start)
    # Fetch window: 30 days back (to catch tickets completed this week but scheduled
    # earlier) through 60 days out (construction look-ahead).
    fetch_since = (this_mon - timedelta(days=30)).strftime("%Y-%m-%d")
    fetch_until = (this_mon + timedelta(days=60)).strftime("%Y-%m-%d")

    opps = await _fetch_customer_opps(company_id)
    if not opps:
        raise HTTPException(status_code=404, detail="No opportunities found for this customer")

    company_name = next((o.get("BillingCompanyName") for o in opps if o.get("BillingCompanyName")), "")
    opp_ids = [o["OpportunityID"] for o in opps if o.get("OpportunityID")]
    opp_by_id = {o["OpportunityID"]: o for o in opps}

    tickets = await _fetch_customer_tickets(opp_ids, fetch_since, fetch_until)
    svc_ids = [t.get("OpportunityServiceID") for t in tickets if t.get("OpportunityServiceID")]
    service_map = await _fetch_service_names(list({o["OpportunityID"] for o in opps})) if svc_ids else {}
    photo_map = await _fetch_ticket_photos(db, [t["WorkTicketID"] for t in tickets if t.get("WorkTicketID")])

    def _shape(t: dict) -> dict:
        opp = opp_by_id.get(t.get("OpportunityID"), {})
        wt = t.get("WorkTicketID")
        return {
            "work_ticket_id":     wt,
            "work_ticket_number": t.get("WorkTicketNumber"),
            "opp_id":             t.get("OpportunityID"),
            "property":           opp.get("PropertyName") or "",
            "division":           opp.get("DivisionName") or "",
            "service":            service_map.get(t.get("OpportunityServiceID"), ""),
            "status":             t.get("WorkTicketStatusName") or "",
            "scheduled_date":     (t.get("ScheduledStartDate") or "")[:10],
            "complete_date":      (t.get("CompleteDate") or "")[:10],
            "crew":               t.get("CrewLeaderName") or "",
            "notes":              (t.get("Notes") or "").strip(),
            "photos":             photo_map.get(wt, []),
        }

    shaped = [_shape(t) for t in tickets]
    this_s, next_s = this_mon.strftime("%Y-%m-%d"), next_mon.strftime("%Y-%m-%d")
    next_e = next_end.strftime("%Y-%m-%d")

    def _group_by_division(items: list[dict]) -> list[dict]:
        by_div: dict[str, list] = defaultdict(list)
        for it in items:
            by_div[it["division"]].append(it)
        out = []
        for div in sorted(by_div.keys(), key=_div_sort_key):
            rows = sorted(by_div[div], key=lambda x: (x["property"].lower(), x["scheduled_date"]))
            out.append({"division": div, "count": len(rows), "tickets": rows})
        return out

    # 1. This week — completed, non-construction (CompleteDate in this week)
    this_week = [s for s in shaped
                 if not _is_construction(s["division"])
                 and s["complete_date"] and this_s <= s["complete_date"] < next_s]
    # 2. Next week — scheduled, non-construction (ScheduledStartDate in next week)
    next_week = [s for s in shaped
                 if not _is_construction(s["division"])
                 and s["scheduled_date"] and next_s <= s["scheduled_date"] < next_e]

    # 3. Construction — projects + visits (completed this week + scheduled out)
    constr_opps = [o for o in opps if _is_construction(o.get("DivisionName"))
                   and (o.get("OpportunityStatusName") or "").lower() in ("won", "delivered", "in progress", "in production")]
    constr_projects = [{
        "opp_id":         o.get("OpportunityID"),
        "name":           o.get("OpportunityName") or "",
        "property":       o.get("PropertyName") or "",
        "status":         o.get("OpportunityStatusName") or "",
        "start_date":     (o.get("StartDate") or "")[:10],
        "end_date":       (o.get("EndDate") or "")[:10],
        "percent_complete": _pct(o.get("PercentComplete")),
    } for o in sorted(constr_opps, key=lambda x: (x.get("StartDate") or ""))]

    constr_completed = [s for s in shaped if _is_construction(s["division"])
                        and s["complete_date"] and this_s <= s["complete_date"] < next_s]
    constr_scheduled = [s for s in shaped if _is_construction(s["division"])
                        and s["scheduled_date"] and s["scheduled_date"] >= this_s
                        and s["status"].lower() not in ("complete", "completed", "canceled", "cancelled")]

    photo_count = sum(len(s["photos"]) for s in shaped)
    return {
        "company_id":   company_id,
        "company_name": company_name,
        "week_start":   this_s,
        "week_end":     (next_mon - timedelta(days=1)).strftime("%Y-%m-%d"),
        "next_week_start": next_s,
        "next_week_end":   (next_end - timedelta(days=1)).strftime("%Y-%m-%d"),
        "property_count":  len({o.get("PropertyName") for o in opps if o.get("PropertyName")}),
        "this_week":    _group_by_division(this_week),
        "next_week":    _group_by_division(next_week),
        "construction": {
            "projects":  constr_projects,
            "completed": sorted(constr_completed, key=lambda x: x["complete_date"]),
            "scheduled": sorted(constr_scheduled, key=lambda x: x["scheduled_date"]),
        },
        "summary": {
            "this_week_visits":  len(this_week),
            "next_week_visits":  len(next_week),
            "construction_projects": len(constr_projects),
            "photos": photo_count,
        },
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/search")
async def search_customers(q: str = Query(..., min_length=2)):
    """Search Aspire Companies (commercial customers) by name for the picker."""
    return {"customers": await _search_companies(q)}


@router.get("/{company_id}/report")
async def customer_report(company_id: int, week_start: str | None = None, db: Database = Depends(get_db)):
    return await get_customer_report(company_id, week_start, db)


class EmailBody(BaseModel):
    to: list[str] | str
    subject: str | None = None


@router.get("/{company_id}/email-preview", response_class=None)
async def email_preview(company_id: int, week_start: str | None = None, db: Database = Depends(get_db)):
    from fastapi.responses import HTMLResponse
    report = await get_customer_report(company_id, week_start, db)
    return HTMLResponse(_render_report_html(report))


@router.post("/{company_id}/email")
async def email_report(company_id: int, body: EmailBody, week_start: str | None = None,
                       db: Database = Depends(get_db)):
    """Send the customer report by email. The frontend previews and requires an
    explicit confirm before calling this — never auto-sent."""
    recipients = [body.to] if isinstance(body.to, str) else list(body.to)
    recipients = [r.strip() for r in recipients if r and r.strip()]
    if not recipients:
        raise HTTPException(status_code=400, detail="At least one recipient is required")
    if not settings.MS_AP_INBOX:
        raise HTTPException(status_code=503, detail="Email is not configured (MS_AP_INBOX unset)")

    report = await get_customer_report(company_id, week_start, db)
    html = _render_report_html(report)
    subject = body.subject or f"Service Report — {report['company_name']} — week of {report['week_start']}"

    from app.services.email_intake import GraphClient
    graph = GraphClient()
    try:
        await graph.send_email(mailbox=settings.MS_AP_INBOX, to_addresses=recipients,
                               subject=subject, body_html=html)
    finally:
        await graph.close()
    logger.info(f"Customer report emailed: company={company_id} to={recipients}")
    return {"ok": True, "recipients": recipients, "subject": subject}


# ── HTML render (shared by email + print preview) ─────────────────────────────

_DIV_EMOJI = {
    "Commercial Maintenance": "🏢", "Residential Maintenance": "🏡",
    "Irrigation/Lighting": "💧", "Snow": "❄️", "Construction": "🏗️",
}


def _render_report_html(r: dict) -> str:
    def esc(s):
        return (str(s or "")).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def ticket_row(t: dict) -> str:
        photos = "".join(
            f'<img src="{p["url"]}" alt="" style="width:64px;height:64px;object-fit:cover;'
            f'border-radius:6px;margin:2px" />' for p in t.get("photos", [])
        )
        meta = " · ".join(x for x in [t.get("crew"), t.get("service")] if x)
        date = t.get("complete_date") or t.get("scheduled_date") or ""
        return f"""
        <tr>
          <td style="padding:8px 10px;border-top:1px solid #eef2f7;vertical-align:top;width:120px">
            <div style="font-weight:700;color:#111827">{esc(t.get('property'))}</div>
            <div style="font-size:12px;color:#6b7280">{esc(date)}</div>
          </td>
          <td style="padding:8px 10px;border-top:1px solid #eef2f7;vertical-align:top">
            <span style="font-size:11px;font-weight:700;color:#15803d">{esc(t.get('status'))}</span>
            {f'<span style="font-size:12px;color:#6b7280"> — {esc(meta)}</span>' if meta else ''}
            {f'<div style="font-size:13px;color:#374151;margin-top:3px">{esc(t.get("notes"))}</div>' if t.get('notes') else ''}
            <div style="margin-top:4px">{photos}</div>
          </td>
        </tr>"""

    def division_block(section: list[dict]) -> str:
        blocks = []
        for grp in section:
            div = grp["division"]
            rows = "".join(ticket_row(t) for t in grp["tickets"])
            blocks.append(f"""
            <div style="margin:14px 0">
              <div style="font-size:15px;font-weight:800;color:#111827;margin-bottom:4px">
                {_DIV_EMOJI.get(div,'📍')} {esc(div)}
                <span style="font-size:12px;font-weight:600;color:#9ca3af"> · {grp['count']} visit{'s' if grp['count']!=1 else ''}</span>
              </div>
              <table style="width:100%;border-collapse:collapse">{rows}</table>
            </div>""")
        return "".join(blocks) or '<div style="color:#9ca3af;font-size:13px;padding:6px 0">No visits.</div>'

    c = r["construction"]
    constr_projects = "".join(
        f"""<tr>
          <td style="padding:6px 10px;border-top:1px solid #eef2f7"><b>{esc(p['name'])}</b><br>
            <span style="font-size:12px;color:#6b7280">{esc(p['property'])}</span></td>
          <td style="padding:6px 10px;border-top:1px solid #eef2f7;font-size:12px">{esc(p['start_date'])} → {esc(p['end_date'] or '—')}</td>
          <td style="padding:6px 10px;border-top:1px solid #eef2f7;text-align:right;font-weight:700">
            {('%.0f%%' % p['percent_complete']) if p['percent_complete'] is not None else '—'}</td>
        </tr>""" for p in c["projects"]
    ) or '<tr><td style="padding:6px 10px;color:#9ca3af;font-size:13px">No active construction projects.</td></tr>'

    constr_visits = "".join(ticket_row(t) for t in (c["completed"] + c["scheduled"]))

    return f"""<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:0 auto;color:#111827">
  <div style="background:#14532d;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0">
    <div style="font-size:22px;font-weight:800">{esc(r['company_name'])}</div>
    <div style="opacity:.85;font-size:14px">Service Report · week of {esc(r['week_start'])} – {esc(r['week_end'])} · {r['property_count']} properties</div>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:20px 24px;border-radius:0 0 10px 10px">
    <h2 style="font-size:17px;margin:4px 0 2px">This week</h2>
    {division_block(r['this_week'])}
    <h2 style="font-size:17px;margin:22px 0 2px">Next week (scheduled)</h2>
    {division_block(r['next_week'])}
    <h2 style="font-size:17px;margin:22px 0 6px">🏗️ Construction</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:10px">
      <tr style="font-size:11px;text-transform:uppercase;color:#6b7280;text-align:left">
        <th style="padding:4px 10px">Project</th><th style="padding:4px 10px">Timeline</th><th style="padding:4px 10px;text-align:right">Complete</th></tr>
      {constr_projects}
    </table>
    {f'<table style="width:100%;border-collapse:collapse">{constr_visits}</table>' if constr_visits else ''}
  </div>
</div>"""
