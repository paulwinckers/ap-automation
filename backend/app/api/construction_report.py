"""
Construction Nightly Work Ticket Report
GET  /construction/nightly-report        → HTML email preview
POST /construction/nightly-report/send   → send via MS Graph (coming soon)

Shows all work tickets that are actively being worked on:
  - HoursAct > 0  (actual labour has been posted)
  - Status is not Complete / Cancelled
Grouped by Opportunity (job), sorted by % budget used descending.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse

from app.core.config import settings
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/construction", tags=["construction"])

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

# ── Helpers ───────────────────────────────────────────────────────────────────

def _bar(pct: float, width: int = 120) -> str:
    """Return an inline HTML progress bar."""
    clamped = max(0.0, min(pct, 100.0))
    over    = pct > 100
    fill    = min(clamped, 100)
    colour  = "#ef4444" if over else ("#f59e0b" if clamped >= 80 else "#22c55e")
    return (
        f'<div style="background:#e2e8f0;border-radius:4px;height:8px;width:{width}px;overflow:hidden;">'
        f'<div style="background:{colour};width:{fill:.0f}%;height:100%;border-radius:4px;"></div>'
        f'</div>'
    )

def _fmt_hrs(h) -> str:
    if h is None: return "—"
    return f"{float(h):.1f}"

def _status_badge(status: str | None) -> str:
    s = (status or "").lower()
    if "complete"  in s: bg, fg = "#dcfce7", "#15803d"
    elif "progress" in s or "active" in s: bg, fg = "#dbeafe", "#1d4ed8"
    elif "hold"    in s: bg, fg = "#fef9c3", "#92400e"
    elif "cancel"  in s: bg, fg = "#fee2e2", "#dc2626"
    else:                bg, fg = "#f1f5f9", "#475569"
    return (
        f'<span style="background:{bg};color:{fg};padding:2px 8px;border-radius:12px;'
        f'font-size:11px;font-weight:700;white-space:nowrap;">{status or "Unknown"}</span>'
    )

def _variance_cell(variance) -> str:
    if variance is None: return '<td style="padding:8px 12px;text-align:right;color:#94a3b8;">—</td>'
    v = float(variance)
    colour = "#ef4444" if v < 0 else "#15803d"
    sign   = "+" if v > 0 else ""
    return f'<td style="padding:8px 12px;text-align:right;color:{colour};font-weight:600;">{sign}{v:.1f}h</td>'


# ── Main report builder ───────────────────────────────────────────────────────

async def _build_report_data() -> list[dict]:
    """
    Fetch work tickets with actual hours that are not yet complete.
    Returns list of tickets enriched with OpportunityName + PropertyName.
    """
    # 1. Fetch active work tickets (HoursAct > 0, not complete/cancelled)
    try:
        res = await _aspire._get("WorkTickets", {
            "$filter": (
                "HoursAct gt 0"
                " and WorkTicketStatusName ne 'Complete'"
                " and WorkTicketStatusName ne 'Cancelled'"
            ),
            "$top": "500",
        })
        tickets = _aspire._extract_list(res)
    except Exception as e:
        logger.error(f"WorkTickets fetch failed: {e}")
        return []

    if not tickets:
        return []

    # 2. Get unique OpportunityIDs and batch-fetch names + property names
    opp_ids = list({t.get("OpportunityID") for t in tickets if t.get("OpportunityID")})
    opp_map: dict = {}   # OpportunityID → {name, property}
    chunk_size = 15
    for i in range(0, len(opp_ids), chunk_size):
        chunk = opp_ids[i:i + chunk_size]
        or_filter = " or ".join(f"OpportunityID eq {oid}" for oid in chunk)
        try:
            opp_res = await _aspire._get("Opportunities", {
                "$filter": f"({or_filter})",
                "$select": "OpportunityID,OpportunityName,PropertyName,OpportunityNumber",
                "$top": "200",
            })
            for o in _aspire._extract_list(opp_res):
                oid = o.get("OpportunityID")
                if oid:
                    opp_map[oid] = {
                        "name":     o.get("OpportunityName") or f"Job #{oid}",
                        "property": o.get("PropertyName") or "",
                        "number":   o.get("OpportunityNumber"),
                    }
        except Exception as e:
            logger.warning(f"Opportunity batch fetch failed: {e}")

    # 3. Enrich tickets
    enriched = []
    for t in tickets:
        oid  = t.get("OpportunityID")
        info = opp_map.get(oid, {})
        hrs_est = float(t.get("HoursEst") or 0)
        hrs_act = float(t.get("HoursAct") or 0)
        remaining   = hrs_est - hrs_act
        pct_used    = (hrs_act / hrs_est * 100) if hrs_est else 0
        variance    = t.get("BudgetVariance")   # negative = over budget

        enriched.append({
            "opportunity_id":   oid,
            "opportunity_name": info.get("name", f"Job #{oid}"),
            "property_name":    info.get("property", ""),
            "opp_number":       info.get("number"),
            "ticket_id":        t.get("WorkTicketID"),
            "ticket_number":    t.get("WorkTicketNumber"),
            "status":           t.get("WorkTicketStatusName"),
            "crew_leader":      t.get("CrewLeaderName") or "—",
            "hrs_est":          hrs_est,
            "hrs_act":          hrs_act,
            "hrs_remaining":    remaining,
            "pct_used":         pct_used,
            "budget_variance":  float(variance) if variance is not None else None,
            "scheduled_date":   t.get("ScheduledStartDate"),
            "percent_complete": t.get("PercentComplete"),
        })

    return enriched


def _render_html(tickets: list[dict], generated_at: str) -> str:
    if not tickets:
        body = '<p style="padding:32px;text-align:center;color:#64748b;">No active work tickets found.</p>'
        jobs_html = body
    else:
        # Group by opportunity
        jobs: dict = {}
        for t in tickets:
            oid = t["opportunity_id"] or 0
            if oid not in jobs:
                jobs[oid] = {
                    "name":     t["opportunity_name"],
                    "property": t["property_name"],
                    "number":   t["opp_number"],
                    "tickets":  [],
                }
            jobs[oid]["tickets"].append(t)

        # Sort jobs: most hours used (highest total % used) first
        def job_sort_key(j):
            ts = j["tickets"]
            total_est = sum(t["hrs_est"] for t in ts)
            total_act = sum(t["hrs_act"] for t in ts)
            return -(total_act / total_est * 100) if total_est else 0

        sorted_jobs = sorted(jobs.values(), key=job_sort_key)

        # Summary totals
        total_est  = sum(t["hrs_est"] for t in tickets)
        total_act  = sum(t["hrs_act"] for t in tickets)
        total_rem  = total_est - total_act
        total_pct  = (total_act / total_est * 100) if total_est else 0

        summary_colour = "#ef4444" if total_pct > 100 else ("#f59e0b" if total_pct >= 80 else "#22c55e")

        summary_html = f"""
        <table style="width:100%;border-collapse:collapse;margin-bottom:28px;background:#f8fafc;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="padding:16px 20px;text-align:center;border-right:1px solid #e2e8f0;">
              <div style="font-size:28px;font-weight:700;color:#0f172a;">{len(jobs)}</div>
              <div style="font-size:12px;color:#64748b;margin-top:2px;">Active Jobs</div>
            </td>
            <td style="padding:16px 20px;text-align:center;border-right:1px solid #e2e8f0;">
              <div style="font-size:28px;font-weight:700;color:#0f172a;">{len(tickets)}</div>
              <div style="font-size:12px;color:#64748b;margin-top:2px;">Work Tickets</div>
            </td>
            <td style="padding:16px 20px;text-align:center;border-right:1px solid #e2e8f0;">
              <div style="font-size:28px;font-weight:700;color:#0f172a;">{total_est:.0f}h</div>
              <div style="font-size:12px;color:#64748b;margin-top:2px;">Est Hours</div>
            </td>
            <td style="padding:16px 20px;text-align:center;border-right:1px solid #e2e8f0;">
              <div style="font-size:28px;font-weight:700;color:#0f172a;">{total_act:.0f}h</div>
              <div style="font-size:12px;color:#64748b;margin-top:2px;">Actual Hours</div>
            </td>
            <td style="padding:16px 20px;text-align:center;">
              <div style="font-size:28px;font-weight:700;color:{summary_colour};">{total_rem:.0f}h</div>
              <div style="font-size:12px;color:#64748b;margin-top:2px;">Remaining</div>
            </td>
          </tr>
        </table>
        """

        jobs_html = summary_html

        for job in sorted_jobs:
            j_est  = sum(t["hrs_est"] for t in job["tickets"])
            j_act  = sum(t["hrs_act"] for t in job["tickets"])
            j_rem  = j_est - j_act
            j_pct  = (j_act / j_est * 100) if j_est else 0
            j_col  = "#ef4444" if j_pct > 100 else ("#f59e0b" if j_pct >= 80 else "#22c55e")

            # Sort tickets within job: most % used first
            job["tickets"].sort(key=lambda t: -t["pct_used"])

            rows = ""
            for t in job["tickets"]:
                pct    = t["pct_used"]
                r_col  = "#ef4444" if pct > 100 else ("#f59e0b" if pct >= 80 else "#22c55e")
                rows += f"""
                <tr style="border-top:1px solid #f1f5f9;">
                  <td style="padding:10px 12px;font-size:13px;color:#334155;font-weight:500;">
                    #{t['ticket_number'] or t['ticket_id']}
                  </td>
                  <td style="padding:10px 12px;">{_status_badge(t['status'])}</td>
                  <td style="padding:10px 12px;font-size:13px;color:#475569;">{t['crew_leader']}</td>
                  <td style="padding:10px 12px;text-align:right;font-size:13px;color:#0f172a;">{_fmt_hrs(t['hrs_est'])}</td>
                  <td style="padding:10px 12px;text-align:right;font-size:13px;font-weight:600;color:#0f172a;">{_fmt_hrs(t['hrs_act'])}</td>
                  <td style="padding:10px 12px;text-align:right;font-size:13px;color:{r_col};font-weight:600;">{_fmt_hrs(t['hrs_remaining'])}</td>
                  <td style="padding:10px 12px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                      {_bar(pct)}
                      <span style="font-size:12px;font-weight:700;color:{r_col};min-width:36px;">{pct:.0f}%</span>
                    </div>
                  </td>
                  {_variance_cell(t['budget_variance'])}
                </tr>
                """

            jobs_html += f"""
            <div style="margin-bottom:24px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
              <!-- Job header -->
              <div style="background:#1e293b;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;">
                <div>
                  <div style="color:#fff;font-size:15px;font-weight:700;">{job['name']}</div>
                  {f'<div style="color:#94a3b8;font-size:12px;margin-top:2px;">📍 {job["property"]}</div>' if job["property"] else ''}
                </div>
                <div style="text-align:right;">
                  <div style="color:{j_col};font-size:18px;font-weight:700;">{j_act:.1f} / {j_est:.1f}h</div>
                  <div style="color:#64748b;font-size:11px;">{j_rem:.1f}h remaining · {j_pct:.0f}% used</div>
                </div>
              </div>
              <!-- Tickets table -->
              <table style="width:100%;border-collapse:collapse;background:#fff;">
                <thead>
                  <tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                    <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Ticket</th>
                    <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Status</th>
                    <th style="padding:8px 12px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Crew Leader</th>
                    <th style="padding:8px 12px;text-align:right;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Est Hrs</th>
                    <th style="padding:8px 12px;text-align:right;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Actual</th>
                    <th style="padding:8px 12px;text-align:right;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Remaining</th>
                    <th style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Budget Used</th>
                    <th style="padding:8px 12px;text-align:right;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Variance</th>
                  </tr>
                </thead>
                <tbody>{rows}</tbody>
              </table>
            </div>
            """

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Construction Work Ticket Status</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:900px;margin:0 auto;padding:24px 16px;">

    <!-- Header -->
    <div style="background:#0f172a;border-radius:12px 12px 0 0;padding:20px 28px;margin-bottom:0;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="color:#fff;font-size:20px;font-weight:700;">🏗️ Construction Work Ticket Status</div>
          <div style="color:#64748b;font-size:13px;margin-top:4px;">Active tickets with labour posted · not yet complete</div>
        </div>
        <div style="text-align:right;">
          <div style="color:#94a3b8;font-size:12px;">Generated</div>
          <div style="color:#fff;font-size:13px;font-weight:600;">{generated_at}</div>
        </div>
      </div>
    </div>

    <!-- Legend -->
    <div style="background:#1e293b;padding:8px 28px;border-radius:0;margin-bottom:20px;display:flex;gap:20px;flex-wrap:wrap;">
      <span style="font-size:11px;color:#94a3b8;">
        <span style="color:#22c55e;font-weight:700;">●</span> On track (&lt;80%)
        &nbsp;&nbsp;
        <span style="color:#f59e0b;font-weight:700;">●</span> Watch (80–100%)
        &nbsp;&nbsp;
        <span style="color:#ef4444;font-weight:700;">●</span> Over budget (&gt;100%)
      </span>
    </div>

    <!-- Body -->
    {jobs_html}

    <!-- Footer -->
    <div style="text-align:center;padding:20px;color:#94a3b8;font-size:11px;">
      Darios Landscaping · Generated automatically from Aspire
    </div>
  </div>
</body>
</html>"""


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/nightly-report", response_class=HTMLResponse)
async def get_nightly_report(
    preview: bool = Query(False, description="If true, use sample data instead of live Aspire"),
):
    """
    Returns the HTML construction nightly report.
    Open in a browser to preview exactly what the email will look like.
    """
    generated_at = datetime.now(timezone.utc).strftime("%-d %b %Y, %-I:%M %p UTC")

    if preview:
        # ── Sample data for design preview ───────────────────────────────────
        tickets = [
            # Job 1 — over budget
            dict(opportunity_id=1001, opportunity_name="Downtown Plaza Renovation", property_name="123 Main St",
                 opp_number=None, ticket_id=24001, ticket_number=24001, status="In Progress",
                 crew_leader="Ryan Stolz", hrs_est=80, hrs_act=92, hrs_remaining=-12,
                 pct_used=115, budget_variance=-12.0, scheduled_date=None, percent_complete=85),
            dict(opportunity_id=1001, opportunity_name="Downtown Plaza Renovation", property_name="123 Main St",
                 opp_number=None, ticket_id=24002, ticket_number=24002, status="In Progress",
                 crew_leader="Kiano De Boeck", hrs_est=40, hrs_act=28, hrs_remaining=12,
                 pct_used=70, budget_variance=12.0, scheduled_date=None, percent_complete=60),
            # Job 2 — on track
            dict(opportunity_id=1002, opportunity_name="Orchard Walk Landscaping Phase 2", property_name="(Devon) Orchard Walk 1&2",
                 opp_number=None, ticket_id=24003, ticket_number=24003, status="In Progress",
                 crew_leader="Shantel Way", hrs_est=120, hrs_act=65, hrs_remaining=55,
                 pct_used=54, budget_variance=8.0, scheduled_date=None, percent_complete=50),
            dict(opportunity_id=1002, opportunity_name="Orchard Walk Landscaping Phase 2", property_name="(Devon) Orchard Walk 1&2",
                 opp_number=None, ticket_id=24004, ticket_number=24004, status="Scheduled",
                 crew_leader="Ryan Stolz", hrs_est=30, hrs_act=4, hrs_remaining=26,
                 pct_used=13, budget_variance=None, scheduled_date=None, percent_complete=10),
            # Job 3 — watch zone
            dict(opportunity_id=1003, opportunity_name="Kelowna Credit Union Hardscape", property_name="1450 KLO Rd",
                 opp_number=None, ticket_id=24005, ticket_number=24005, status="In Progress",
                 crew_leader="Kiano De Boeck", hrs_est=55, hrs_act=47, hrs_remaining=8,
                 pct_used=85, budget_variance=-3.5, scheduled_date=None, percent_complete=78),
        ]
        html = _render_html(tickets, generated_at + " (PREVIEW)")
    else:
        tickets = await _build_report_data()
        html = _render_html(tickets, generated_at)

    return HTMLResponse(content=html)
