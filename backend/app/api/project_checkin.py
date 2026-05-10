"""
Project Check-in System
=======================
Daily coaching loop for construction leads.
Each morning the system emails active project leads a snapshot of their
work ticket hours (est vs actual), an AI coaching tip, and a tokenised
link to a mobile-friendly response form.

Protected routes (Cloudflare Access):
  GET    /construction/checkin/leads          — list lead directory
  POST   /construction/checkin/leads          — upsert lead (name → email)
  DELETE /construction/checkin/leads/{id}     — remove lead
  POST   /construction/checkin/send           — manually fire today's emails
  GET    /construction/checkin/status         — sent/response status for month

Public routes (token-gated, no login needed):
  GET    /checkin/{token}                     — form data for lead
  POST   /checkin/{token}/respond             — submit response
"""
import asyncio
import json
import logging
import secrets
from datetime import datetime, timedelta, timezone, date as _date
from typing import Optional
from zoneinfo import ZoneInfo

import anthropic as _anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.services.aspire import AspireClient
from app.services.email_intake import GraphClient

logger = logging.getLogger(__name__)

router        = APIRouter(prefix="/construction/checkin", tags=["project-checkin"])
public_router = APIRouter(prefix="/checkin",             tags=["project-checkin-public"])

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)
_db     = Database()


async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


# ── Pydantic models ───────────────────────────────────────────────────────────

class LeadIn(BaseModel):
    aspire_name:  str            # must match CrewLeaderName on work ticket
    email:        str
    display_name: Optional[str] = None


class CheckinResponseIn(BaseModel):
    remaining_hours: Optional[float] = None
    approach_notes:  str
    blockers:        Optional[str]   = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _portal_base() -> str:
    url = settings.CONSTRUCTION_DASHBOARD_URL or ""
    if "/dashboards" in url:
        return url.rsplit("/dashboards", 1)[0]
    return url.rstrip("/") or "https://darios-accounting.pages.dev"


def _fmt_hrs(h) -> str:
    if h is None:
        return "—"
    try:
        v = float(h)
        return f"{v:.1f}h"
    except Exception:
        return str(h)


def _bar_html(pct: float, width: int = 90) -> str:
    p = max(0.0, min(pct, 100.0))
    c = "#ef4444" if pct > 100 else ("#f59e0b" if p >= 80 else "#22c55e")
    return (
        f'<div style="background:#e2e8f0;border-radius:4px;height:6px;'
        f'width:{width}px;display:inline-block;vertical-align:middle;">'
        f'<div style="background:{c};width:{p:.0f}%;height:100%;border-radius:4px;"></div>'
        f'</div>'
    )


async def _fetch_project_tickets(opp_id: int, month: str) -> list[dict]:
    """Fetch all work tickets for an opportunity in the given YYYY-MM."""
    y, m = int(month[:4]), int(month[5:7])
    next_m = f"{y + 1}-01" if m == 12 else f"{y}-{str(m + 1).zfill(2)}"
    start, end = f"{month}-01", f"{next_m}-01"

    for date_fmt in (
        f"OpportunityID eq {opp_id} and ScheduledStartDate ge {start} and ScheduledStartDate lt {end}",
        f"OpportunityID eq {opp_id} and ScheduledStartDate ge {start}T00:00:00Z and ScheduledStartDate lt {end}T00:00:00Z",
        f"OpportunityID eq {opp_id}",   # fallback: all tickets for the opportunity
    ):
        try:
            res = await _aspire._get("WorkTickets", {
                "$filter": date_fmt,
                "$orderby": "ScheduledStartDate asc",
                "$top": "100",
                "$select": (
                    "WorkTicketID,WorkTicketNumber,WorkTicketStatusName,"
                    "OpportunityID,ScheduledStartDate,"
                    "HoursEst,HoursAct,CrewLeaderName,PercentComplete"
                ),
            })
            rows = _aspire._extract_list(res)
            if rows:
                logger.info(f"Checkin tickets: {len(rows)} for opp {opp_id} ({month})")
                return rows
        except Exception as e:
            logger.warning(f"Checkin ticket fetch ({date_fmt[:50]}): {e}")
    return []


async def _generate_ai_tip(
    opp_name: str,
    property_name: str,
    tickets: list[dict],
) -> str:
    """Generate 2-3 coaching tips via Claude Haiku."""
    total_est  = sum(float(t.get("HoursEst") or 0) for t in tickets)
    total_act  = sum(float(t.get("HoursAct") or 0) for t in tickets)
    remaining  = total_est - total_act
    pct_used   = (total_act / total_est * 100) if total_est else 0
    n_complete = sum(
        1 for t in tickets
        if "complete" in (t.get("WorkTicketStatusName") or "").lower()
    )

    context = (
        f"Project: {opp_name}" + (f" at {property_name}" if property_name else "") + "\n"
        f"Work tickets this month: {len(tickets)} total, {n_complete} complete\n"
        f"Hours: {total_act:.1f} actual vs {total_est:.1f} estimated ({pct_used:.0f}% of budget used)\n"
        f"Estimated hours remaining: {remaining:.1f}h\n"
    )
    if pct_used > 100:
        context += "Note: The project is currently over its hour budget.\n"
    elif pct_used >= 80:
        context += "Note: The project is approaching its hour budget limit.\n"

    prompt = (
        "You are a supportive construction project coach at a landscaping company. "
        "A field lead is about to fill in their daily project check-in. "
        "Based on the data below, write exactly 3 short coaching tips to help them "
        "finish on time and on budget. Be warm, practical, and specific. "
        "Each tip should be 1-2 sentences. Number them 1, 2, 3. "
        "Do not use bullet points. Never be alarming — stay encouraging and action-focused.\n\n"
        + context + "\nCoaching tips:"
    )

    try:
        client = _anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        msg = await client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=350,
            messages=[{"role": "user", "content": prompt}],
        )
        return msg.content[0].text.strip()
    except Exception as e:
        logger.warning(f"AI tip generation failed: {e}")
        rem_str = f"{remaining:.0f}" if total_est else "unknown"
        return (
            f"1. You have roughly {rem_str} hours estimated remaining — "
            "take a moment today to walk the site and confirm that feels right.\n\n"
            "2. If anything has changed since the last update, flag it early — "
            "the team can adjust much more easily when they hear about it right away.\n\n"
            "3. Keep your work ticket statuses current as you complete tasks; "
            "it makes the whole team's planning more accurate."
        )


# ── Email templates ───────────────────────────────────────────────────────────

def _render_checkin_email(
    opp_name: str,
    property_name: str,
    lead_name: str,
    tickets: list[dict],
    ai_tip: str,
    checkin_url: str,
    today_str: str,
) -> str:
    rows_html = ""
    for t in tickets:
        est    = float(t.get("HoursEst") or 0)
        act    = float(t.get("HoursAct") or 0)
        rem    = est - act
        pct    = (act / est * 100) if est else 0
        status = t.get("WorkTicketStatusName") or "—"
        sched  = (t.get("ScheduledStartDate") or "")[:10] or "—"

        if "complete" in status.lower():
            bb, bf = "#dcfce7", "#15803d"
        elif "progress" in status.lower():
            bb, bf = "#dbeafe", "#1d4ed8"
        else:
            bb, bf = "#fef3c7", "#92400e"

        rem_col = "#ef4444" if rem < 0 else ("#f59e0b" if pct >= 80 else "#0f172a")
        rows_html += f"""
        <tr style="border-top:1px solid #f1f5f9;">
          <td style="padding:9px 10px;font-size:12px;color:#64748b;white-space:nowrap;">
            #{t.get('WorkTicketNumber') or t.get('WorkTicketID')}
          </td>
          <td style="padding:9px 10px;">
            <span style="background:{bb};color:{bf};padding:2px 7px;border-radius:10px;
                         font-size:10px;font-weight:700;white-space:nowrap;">{status}</span>
          </td>
          <td style="padding:9px 10px;font-size:12px;color:#64748b;">{sched}</td>
          <td style="padding:9px 10px;font-size:12px;text-align:right;">{_fmt_hrs(est)}</td>
          <td style="padding:9px 10px;font-size:12px;font-weight:700;text-align:right;">{_fmt_hrs(act)}</td>
          <td style="padding:9px 10px;text-align:right;">
            <span style="font-size:12px;font-weight:700;color:{rem_col};">{_fmt_hrs(rem)}</span>
          </td>
          <td style="padding:9px 10px;">
            {_bar_html(pct, 70)}
            <span style="font-size:10px;color:#64748b;margin-left:3px;">{pct:.0f}%</span>
          </td>
        </tr>"""

    tip_paras = "".join(
        f'<p style="margin:0 0 10px;font-size:14px;color:#1e293b;line-height:1.65;">{p.strip()}</p>'
        for p in ai_tip.split("\n\n") if p.strip()
    )
    first_name = (lead_name or "").split()[0] or "Hi"
    display_title = property_name or opp_name

    return f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:680px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.09);">

  <div style="background:#14532d;padding:26px 32px;">
    <div style="color:#86efac;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;">Daily Project Check-in</div>
    <div style="color:#fff;font-size:22px;font-weight:800;margin-top:6px;">{display_title}</div>
    <div style="color:#4ade80;font-size:13px;margin-top:3px;">{opp_name} · {today_str}</div>
  </div>

  <div style="padding:28px 32px;">

    <p style="margin:0 0 22px;font-size:15px;color:#1e293b;line-height:1.5;">
      Hi {first_name} 👋 — here's today's snapshot of your project.
      Please take 2 minutes to submit your update at the bottom.
    </p>

    <!-- Work tickets -->
    <div style="margin-bottom:24px;">
      <div style="font-weight:700;font-size:11px;color:#64748b;margin-bottom:8px;
                  text-transform:uppercase;letter-spacing:.06em;">Work Tickets This Month</div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:7px 10px;text-align:left;font-size:10px;color:#94a3b8;font-weight:700;">#</th>
            <th style="padding:7px 10px;text-align:left;font-size:10px;color:#94a3b8;font-weight:700;">Status</th>
            <th style="padding:7px 10px;text-align:left;font-size:10px;color:#94a3b8;font-weight:700;">Scheduled</th>
            <th style="padding:7px 10px;text-align:right;font-size:10px;color:#94a3b8;font-weight:700;">Est</th>
            <th style="padding:7px 10px;text-align:right;font-size:10px;color:#94a3b8;font-weight:700;">Actual</th>
            <th style="padding:7px 10px;text-align:right;font-size:10px;color:#94a3b8;font-weight:700;">Remaining</th>
            <th style="padding:7px 10px;font-size:10px;color:#94a3b8;font-weight:700;">Budget</th>
          </tr>
        </thead>
        <tbody>
          {rows_html or '<tr><td colspan="7" style="padding:14px;text-align:center;color:#94a3b8;font-size:12px;">No tickets found for this month</td></tr>'}
        </tbody>
      </table>
    </div>

    <!-- AI tip -->
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
      <div style="font-weight:700;font-size:12px;color:#15803d;margin-bottom:12px;
                  text-transform:uppercase;letter-spacing:.04em;">💡 Today's Coaching Tips</div>
      {tip_paras}
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin-bottom:8px;">
      <a href="{checkin_url}"
         style="display:inline-block;background:#16a34a;color:#fff;font-weight:800;
                font-size:17px;padding:16px 52px;border-radius:12px;text-decoration:none;">
        Submit Your Update →
      </a>
    </div>
    <p style="text-align:center;font-size:12px;color:#94a3b8;margin-top:10px;margin-bottom:0;">
      Opens on your phone · Bookmark this page to check in any time
    </p>

  </div>

  <div style="background:#f8fafc;padding:14px 32px;border-top:1px solid #e2e8f0;text-align:center;">
    <span style="font-size:11px;color:#94a3b8;">Darios Landscaping · Project Management Portal</span>
  </div>

</div>
</body>
</html>"""


def _render_mgmt_email(
    opp_name: str,
    property_name: str,
    lead_name: str,
    response_notes: str,
    remaining_hours: Optional[float],
    blockers: Optional[str],
    ai_tip: str,
    today_str: str,
) -> str:
    rem_str = f"{remaining_hours:.1f}h" if remaining_hours is not None else "Not provided"
    blockers_html = ""
    if blockers and blockers.strip():
        blockers_html = (
            '<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;'
            'padding:14px 18px;margin-top:16px;">'
            '<div style="font-weight:700;font-size:11px;color:#c2410c;margin-bottom:6px;'
            'text-transform:uppercase;letter-spacing:.04em;">⚠️ Blockers Reported</div>'
            f'<p style="margin:0;font-size:14px;color:#1e293b;line-height:1.5;">{blockers}</p>'
            '</div>'
        )

    display_title = property_name or opp_name
    return f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:580px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.09);">

  <div style="background:#16a34a;padding:22px 28px;">
    <div style="color:#bbf7d0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">✅ Check-in Submitted</div>
    <div style="color:#fff;font-size:20px;font-weight:800;margin-top:5px;">{display_title}</div>
    <div style="color:#86efac;font-size:13px;margin-top:2px;">{lead_name} · {today_str}</div>
  </div>

  <div style="padding:24px 28px;">

    <div style="font-weight:700;font-size:11px;color:#64748b;margin-bottom:8px;
                text-transform:uppercase;letter-spacing:.05em;">Lead's Plan / Approach</div>
    <div style="background:#f8fafc;border-radius:8px;padding:16px 20px;font-size:14px;
                color:#1e293b;line-height:1.65;white-space:pre-wrap;">{response_notes}</div>

    <div style="margin-top:16px;background:#f0fdf4;border:1px solid #bbf7d0;
                border-radius:8px;padding:16px 20px;text-align:center;">
      <div style="font-size:32px;font-weight:800;color:#15803d;">{rem_str}</div>
      <div style="font-size:12px;color:#64748b;margin-top:3px;">Estimated Hours Remaining</div>
    </div>

    {blockers_html}

    <div style="margin-top:20px;background:#f8fafc;border-radius:8px;padding:14px 18px;">
      <div style="font-weight:700;font-size:11px;color:#94a3b8;margin-bottom:6px;
                  text-transform:uppercase;letter-spacing:.04em;">Coaching Tip That Was Sent</div>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.5;">
        {(ai_tip[:400] + '...') if len(ai_tip) > 400 else ai_tip}
      </p>
    </div>

  </div>

  <div style="background:#f8fafc;padding:12px 28px;border-top:1px solid #e2e8f0;text-align:center;">
    <span style="font-size:11px;color:#94a3b8;">Darios Landscaping · Project Management</span>
  </div>

</div>
</body>
</html>"""


# ── Core send orchestrator ────────────────────────────────────────────────────

async def _send_project_checkins(month: str) -> dict:
    """
    For each active construction job this month that has a known lead,
    send a daily check-in email. Skips jobs already sent today.
    """
    db       = await get_db()
    today    = _date.today().isoformat()
    today_str = datetime.now().strftime("%B %d, %Y")

    # Load lead directory (aspire_name → {email, display_name})
    lead_rows = await db._q("SELECT aspire_name, email, display_name FROM construction_leads", [])
    lead_map: dict[str, dict] = {
        r["aspire_name"].lower(): {
            "email":        r["email"],
            "display_name": r["display_name"] or r["aspire_name"],
        }
        for r in lead_rows
    }
    if not lead_map:
        logger.info("Checkin: lead directory is empty — add leads via /construction/checkin/leads")
        return {"sent": 0, "skipped": 0, "reason": "no leads configured"}

    # Get this month's scheduled Construction work tickets grouped by opportunity
    from app.api.construction_plan import _fetch_scheduled_opp_ids, _fetch_opp_actuals
    opp_tickets: dict[int, list[dict]] = await _fetch_scheduled_opp_ids(month)

    # Also include manually committed jobs (they may have tickets outside the schedule filter)
    manual_rows = await db._q(
        "SELECT opportunity_id FROM construction_job_targets WHERE month = ?", [month]
    )
    for row in manual_rows:
        oid = row["opportunity_id"]
        if oid not in opp_tickets:
            opp_tickets[oid] = []

    if not opp_tickets:
        return {"sent": 0, "skipped": 0, "reason": "no active construction jobs this month"}

    actuals = await _fetch_opp_actuals(list(opp_tickets.keys()))

    graph        = GraphClient()
    portal_base  = _portal_base()
    mgmt_emails  = [e.strip() for e in settings.ISSUES_DIGEST_MGMT_RECIPIENTS.split(",") if e.strip()]
    sent = skipped = 0

    for opp_id, base_tickets in opp_tickets.items():
        opp           = actuals.get(opp_id, {})
        opp_name      = opp.get("OpportunityName") or f"Job #{opp_id}"
        property_name = opp.get("PropertyName") or ""

        # Get full ticket list if base_tickets is empty (manual job with no scheduled filter match)
        tickets = base_tickets or await _fetch_project_tickets(opp_id, month)

        # Find CrewLeaderName from active (non-complete) tickets first, then any ticket
        lead_name = None
        for t in tickets:
            if "complete" not in (t.get("WorkTicketStatusName") or "").lower():
                name = (t.get("CrewLeaderName") or "").strip()
                if name:
                    lead_name = name
                    break
        if not lead_name:
            for t in tickets:
                name = (t.get("CrewLeaderName") or "").strip()
                if name:
                    lead_name = name
                    break

        if not lead_name:
            logger.info(f"Checkin: no CrewLeaderName for opp {opp_id} ({opp_name}) — skipping")
            skipped += 1
            continue

        lead_info = lead_map.get(lead_name.lower())
        if not lead_info:
            logger.info(f"Checkin: '{lead_name}' not in lead directory for opp {opp_id} — skipping")
            skipped += 1
            continue

        lead_email   = lead_info["email"]
        display_name = lead_info["display_name"]

        # Skip if already sent today for this opportunity
        existing = await db._q(
            "SELECT id FROM project_checkins WHERE opportunity_id = ? AND date(sent_at) = ?",
            [opp_id, today],
        )
        if existing:
            logger.info(f"Checkin: already sent today for opp {opp_id} — skipping")
            skipped += 1
            continue

        # Generate AI coaching tip
        ai_tip = await _generate_ai_tip(opp_name, property_name, tickets)

        # Create token + store in D1
        token      = secrets.token_urlsafe(32)
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=48)).isoformat()
        snapshot   = json.dumps([{
            "WorkTicketID":         t.get("WorkTicketID"),
            "WorkTicketNumber":     t.get("WorkTicketNumber"),
            "WorkTicketStatusName": t.get("WorkTicketStatusName"),
            "ScheduledStartDate":   (t.get("ScheduledStartDate") or "")[:10],
            "HoursEst":             t.get("HoursEst"),
            "HoursAct":             t.get("HoursAct"),
            "CrewLeaderName":       t.get("CrewLeaderName"),
        } for t in tickets])

        await db._x(
            """INSERT INTO project_checkins
               (token, opportunity_id, opportunity_name, property_name,
                lead_name, lead_email, month, ai_tip, ticket_snapshot, expires_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            [token, opp_id, opp_name, property_name,
             display_name, lead_email, month, ai_tip, snapshot, expires_at],
        )

        # Permanent project page — leads can bookmark this
        project_url = f"{portal_base}/field/project/{opp_id}"
        html    = _render_checkin_email(
            opp_name, property_name, display_name, tickets, ai_tip, project_url, today_str
        )
        subject = f"📋 Daily Check-in: {property_name or opp_name} — {today_str}"

        try:
            await graph.send_email(
                mailbox=settings.MS_AP_INBOX,
                to_addresses=[lead_email],
                subject=subject,
                body_html=html,
            )
            logger.info(f"Checkin sent → {lead_email} for opp {opp_id} ({opp_name})")
            sent += 1
        except Exception as e:
            logger.error(f"Checkin email failed for opp {opp_id}: {e}")
            skipped += 1

    return {"sent": sent, "skipped": skipped, "month": month}


# ── Lead directory ────────────────────────────────────────────────────────────

@router.get("/leads")
async def list_leads(db: Database = Depends(get_db)):
    rows = await db._q("SELECT * FROM construction_leads ORDER BY aspire_name", [])
    return [dict(r) for r in rows]


@router.post("/leads")
async def upsert_lead(body: LeadIn, db: Database = Depends(get_db)):
    await db._x(
        """INSERT INTO construction_leads (aspire_name, email, display_name)
           VALUES (?,?,?)
           ON CONFLICT(aspire_name) DO UPDATE SET
             email        = excluded.email,
             display_name = excluded.display_name""",
        [body.aspire_name, body.email, body.display_name or body.aspire_name],
    )
    return {"ok": True}


@router.delete("/leads/{lead_id}")
async def delete_lead(lead_id: int, db: Database = Depends(get_db)):
    await db._x("DELETE FROM construction_leads WHERE id = ?", [lead_id])
    return {"ok": True}


# ── Manual trigger + status ───────────────────────────────────────────────────

@router.post("/send")
async def trigger_checkins(month: Optional[str] = None):
    tz = ZoneInfo(settings.CONSTRUCTION_REPORT_TIMEZONE or "America/Vancouver")
    m  = month or datetime.now(tz).strftime("%Y-%m")
    return await _send_project_checkins(m)


@router.get("/status")
async def checkin_status(month: Optional[str] = None, db: Database = Depends(get_db)):
    tz = ZoneInfo(settings.CONSTRUCTION_REPORT_TIMEZONE or "America/Vancouver")
    m  = month or datetime.now(tz).strftime("%Y-%m")
    rows = await db._q(
        """SELECT c.id, c.opportunity_name, c.property_name, c.lead_name, c.lead_email,
                  c.sent_at, c.responded_at,
                  r.remaining_hours, r.approach_notes, r.blockers, r.submitted_at
           FROM project_checkins c
           LEFT JOIN project_checkin_responses r ON r.checkin_id = c.id
           WHERE c.month = ?
           ORDER BY c.sent_at DESC""",
        [m],
    )
    return [dict(r) for r in rows]


# ── My-project lookup — must be defined BEFORE /{token} to avoid capture ──────

@public_router.get("/my-project")
async def my_project_lookup(name: str = "", db: Database = Depends(get_db)):
    """
    Return the list of known leads (for the name-picker dropdown) and,
    when a name is given, all opportunities where that person is crew leader
    (past ~12 months + future).  Sorted: In Progress first, then Scheduled,
    then recently Completed, then anything else.
    """
    from app.api.construction_plan import _fetch_opp_actuals
    from datetime import timedelta

    name = (name or "").strip()

    # Always return lead list so the dropdown can populate
    lead_rows = await db._q(
        "SELECT aspire_name, display_name FROM construction_leads ORDER BY aspire_name", []
    )
    leads = [
        {"name": r["aspire_name"], "display": r["display_name"] or r["aspire_name"]}
        for r in lead_rows
    ]

    if not name:
        return {"leads": leads, "projects": []}

    # Fetch recent work tickets — no date filter (Aspire date range filters can
    # silently return empty).  Sort by WorkTicketID desc (newest first), take
    # top 500, then filter by CrewLeaderName in Python.
    all_tickets: list[dict] = []
    try:
        res = await _aspire._get("WorkTickets", {
            "$select":  (
                "WorkTicketID,WorkTicketNumber,WorkTicketStatusName,"
                "OpportunityID,ScheduledStartDate,CompleteDate,"
                "HoursEst,HoursAct,CrewLeaderName,PercentComplete"
            ),
            "$orderby": "WorkTicketID desc",
            "$top":     "500",
        })
        all_tickets = _aspire._extract_list(res)
        logger.info(f"my-project: fetched {len(all_tickets)} total tickets, filtering for '{name}'")
    except Exception as e:
        logger.warning(f"my-project WorkTickets fetch failed: {e}")

    # Filter to this crew leader first — log branches/statuses so we can tune
    leader_tickets = [
        t for t in all_tickets
        if (t.get("CrewLeaderName") or "").strip().lower() == name.lower()
    ]
    if leader_tickets:
        branches  = {(t.get("BranchName") or "").strip() for t in leader_tickets}
        statuses  = {(t.get("WorkTicketStatusName") or "").strip() for t in leader_tickets}
        logger.info(f"my-project '{name}': {len(leader_tickets)} tickets — branches={branches} statuses={statuses}")

    # Status filter: In Production + In Queue always; Complete within last 90 days
    ACTIVE_STATUSES   = {"in production", "in queue"}
    COMPLETE_STATUSES = {"complete", "completed"}
    cutoff_date = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")

    def _keep_ticket(t: dict) -> bool:
        status = (t.get("WorkTicketStatusName") or "").strip().lower()
        if status in ACTIVE_STATUSES:
            return True
        if status in COMPLETE_STATUSES:
            complete_date = (t.get("CompleteDate") or t.get("ScheduledStartDate") or "")[:10]
            return complete_date >= cutoff_date
        return False

    tickets = [t for t in leader_tickets if _keep_ticket(t)]
    logger.info(
        f"my-project '{name}': {len(tickets)} tickets after status filter "
        f"(active/queue + complete ≥{cutoff_date})"
    )

    if not tickets:
        return {"leads": leads, "projects": []}

    # Group by OpportunityID — collect ticket-level hour totals
    opp_map: dict[int, dict] = {}
    for t in tickets:
        oid = t.get("OpportunityID")
        if not oid:
            continue
        if oid not in opp_map:
            opp_map[oid] = {
                "opp_id":        oid,
                "hrs_est":       0.0,
                "hrs_act":       0.0,
                "ticket_count":  0,
                "latest_date":   "",
                "statuses":      set(),
            }
        e = opp_map[oid]
        e["hrs_est"]      += float(t.get("HoursEst") or 0)
        e["hrs_act"]      += float(t.get("HoursAct") or 0)
        e["ticket_count"] += 1
        d = (t.get("ScheduledStartDate") or "")[:10]
        if d > e["latest_date"]:
            e["latest_date"] = d
        status = (t.get("WorkTicketStatusName") or "").lower()
        e["statuses"].add(status)

    # Fetch opportunity details (name, property, status) in bulk
    opp_ids  = list(opp_map.keys())
    actuals  = await _fetch_opp_actuals(opp_ids)

    # Build enriched project list
    _STATUS_ORDER = {"in progress": 0, "scheduled": 1, "active": 0, "complete": 3, "completed": 3}

    projects = []
    for oid, e in opp_map.items():
        opp      = actuals.get(oid, {})
        opp_name = opp.get("OpportunityName") or f"Job #{oid}"
        prop     = opp.get("PropertyName") or ""
        status   = opp.get("OpportunityStatusName") or ""
        sort_key = _STATUS_ORDER.get(status.lower(), 2)
        projects.append({
            "opp_id":       oid,
            "opp_name":     opp_name,
            "property":     prop,
            "status":       status,
            "hrs_est":      round(e["hrs_est"], 1),
            "hrs_act":      round(e["hrs_act"], 1),
            "ticket_count": e["ticket_count"],
            "latest_date":  e["latest_date"],
            "_sort":        (sort_key, e["latest_date"]),
        })

    projects.sort(key=lambda x: (x.pop("_sort")[0], x["latest_date"]), reverse=False)
    # Re-sort: active/in-progress first (ascending sort_key), then by latest_date desc within group
    projects.sort(key=lambda x: (
        _STATUS_ORDER.get((x["status"] or "").lower(), 2),
        x["latest_date"]
    ), reverse=False)
    # Reverse date within each status group — most recent first
    from itertools import groupby
    final: list[dict] = []
    for _, grp in groupby(projects, key=lambda x: _STATUS_ORDER.get((x["status"] or "").lower(), 2)):
        final.extend(sorted(grp, key=lambda x: x["latest_date"], reverse=True))

    return {"leads": leads, "projects": final}


# ── Public token routes ───────────────────────────────────────────────────────

@public_router.get("/{token}")
async def get_checkin_form(token: str, db: Database = Depends(get_db)):
    rows = await db._q("SELECT * FROM project_checkins WHERE token = ?", [token])
    if not rows:
        raise HTTPException(status_code=404, detail="Check-in link not found")
    c = dict(rows[0])

    try:
        expires = datetime.fromisoformat(c["expires_at"].replace("Z", "+00:00"))
        if datetime.now(timezone.utc) > expires:
            raise HTTPException(status_code=410, detail="This check-in link has expired")
    except HTTPException:
        raise
    except Exception:
        pass

    resp_rows = await db._q(
        "SELECT * FROM project_checkin_responses WHERE checkin_id = ?", [c["id"]]
    )
    tickets = json.loads(c.get("ticket_snapshot") or "[]")
    return {
        "opportunity_name":  c["opportunity_name"],
        "property_name":     c["property_name"],
        "lead_name":         c["lead_name"],
        "month":             c["month"],
        "ai_tip":            c["ai_tip"],
        "tickets":           tickets,
        "already_responded": bool(resp_rows),
        "prior_response":    dict(resp_rows[0]) if resp_rows else None,
        "sent_at":           c["sent_at"],
    }


@public_router.post("/{token}/respond")
async def submit_checkin_response(
    token: str, body: CheckinResponseIn, db: Database = Depends(get_db)
):
    rows = await db._q("SELECT * FROM project_checkins WHERE token = ?", [token])
    if not rows:
        raise HTTPException(status_code=404, detail="Check-in link not found")
    c = dict(rows[0])

    try:
        expires = datetime.fromisoformat(c["expires_at"].replace("Z", "+00:00"))
        if datetime.now(timezone.utc) > expires:
            raise HTTPException(status_code=410, detail="This check-in link has expired")
    except HTTPException:
        raise
    except Exception:
        pass

    if not body.approach_notes or not body.approach_notes.strip():
        raise HTTPException(status_code=422, detail="approach_notes is required")

    # Save response
    await db._x(
        """INSERT INTO project_checkin_responses
           (checkin_id, remaining_hours, approach_notes, blockers)
           VALUES (?,?,?,?)""",
        [c["id"], body.remaining_hours, body.approach_notes.strip(), body.blockers],
    )
    await db._x(
        "UPDATE project_checkins SET responded_at = datetime('now') WHERE id = ?", [c["id"]]
    )

    # Notify management
    today_str   = datetime.now().strftime("%B %d, %Y")
    mgmt_emails = [e.strip() for e in settings.ISSUES_DIGEST_MGMT_RECIPIENTS.split(",") if e.strip()]
    html = _render_mgmt_email(
        opp_name        = c["opportunity_name"] or "",
        property_name   = c["property_name"] or "",
        lead_name       = c["lead_name"] or "",
        response_notes  = body.approach_notes.strip(),
        remaining_hours = body.remaining_hours,
        blockers        = body.blockers,
        ai_tip          = c["ai_tip"] or "",
        today_str       = today_str,
    )
    try:
        graph = GraphClient()
        await graph.send_email(
            mailbox=settings.MS_AP_INBOX,
            to_addresses=mgmt_emails,
            subject=f"✅ Project Update: {c['lead_name']} — {c['property_name'] or c['opportunity_name']}",
            body_html=html,
        )
    except Exception as e:
        logger.warning(f"Management notification failed after checkin submit: {e}")

    return {"ok": True, "message": "Thanks — your update has been sent to the team."}


# ── Permanent project page endpoints (no token, bookmarkable) ─────────────────

@public_router.get("/project/{opp_id}")
async def get_project_page(opp_id: int, db: Database = Depends(get_db)):
    """
    Return live project data for the permanent project page.
    Fetches current month's work tickets from Aspire + check-in history from D1.
    No token required — bookmarkable by lead.
    """
    from app.api.construction_plan import _fetch_opp_actuals

    tz    = ZoneInfo(settings.CONSTRUCTION_REPORT_TIMEZONE or "America/Vancouver")
    month = datetime.now(tz).strftime("%Y-%m")

    # Live Aspire data
    actuals = await _fetch_opp_actuals([opp_id])
    opp     = actuals.get(opp_id, {})
    tickets = await _fetch_project_tickets(opp_id, month)

    # Most recent AI tip from D1 (avoid regenerating every page load)
    tip_rows = await db._q(
        "SELECT ai_tip, sent_at FROM project_checkins WHERE opportunity_id = ? ORDER BY sent_at DESC LIMIT 1",
        [opp_id],
    )
    ai_tip = tip_rows[0]["ai_tip"] if tip_rows else None

    # If no tip exists yet, generate one now
    if not ai_tip and tickets:
        ai_tip = await _generate_ai_tip(
            opp.get("OpportunityName") or f"Job #{opp_id}",
            opp.get("PropertyName") or "",
            tickets,
        )

    # Check-in history for this project (all months, most recent first)
    history_rows = await db._q(
        """SELECT c.id, c.lead_name, c.sent_at, c.month,
                  r.approach_notes, r.remaining_hours, r.blockers, r.submitted_at
           FROM project_checkins c
           LEFT JOIN project_checkin_responses r ON r.checkin_id = c.id
           WHERE c.opportunity_id = ?
           ORDER BY c.sent_at DESC
           LIMIT 30""",
        [opp_id],
    )

    return {
        "opportunity_id":   opp_id,
        "opportunity_name": opp.get("OpportunityName") or f"Job #{opp_id}",
        "property_name":    opp.get("PropertyName") or "",
        "opp_number":       opp.get("OpportunityNumber"),
        "status":           opp.get("OpportunityStatusName"),
        "hrs_est":          opp.get("EstimatedLaborHours"),
        "hrs_act":          opp.get("ActualLaborHours"),
        "revenue_est":      opp.get("WonDollars") or opp.get("EstimatedDollars"),
        "revenue_act":      opp.get("ActualEarnedRevenue"),
        "pct_complete":     opp.get("PercentComplete"),
        "month":            month,
        "tickets":          [{
            "WorkTicketID":         t.get("WorkTicketID"),
            "WorkTicketNumber":     t.get("WorkTicketNumber"),
            "WorkTicketStatusName": t.get("WorkTicketStatusName"),
            "ScheduledStartDate":   (t.get("ScheduledStartDate") or "")[:10],
            "HoursEst":             t.get("HoursEst"),
            "HoursAct":             t.get("HoursAct"),
            "CrewLeaderName":       t.get("CrewLeaderName"),
        } for t in tickets],
        "ai_tip":  ai_tip,
        "history": [dict(r) for r in history_rows],
    }


@public_router.post("/project/{opp_id}/respond")
async def submit_project_response(
    opp_id: int, body: CheckinResponseIn, db: Database = Depends(get_db)
):
    """Submit a check-in response from the permanent project page (no token)."""
    if not body.approach_notes or not body.approach_notes.strip():
        raise HTTPException(status_code=422, detail="approach_notes is required")

    tz    = ZoneInfo(settings.CONSTRUCTION_REPORT_TIMEZONE or "America/Vancouver")
    month = datetime.now(tz).strftime("%Y-%m")

    # Find or create a today-scoped checkin record for this opp
    today = _date.today().isoformat()
    rows  = await db._q(
        "SELECT * FROM project_checkins WHERE opportunity_id = ? AND date(sent_at) = ?",
        [opp_id, today],
    )

    if rows:
        checkin_id = rows[0]["id"]
        opp_name   = rows[0]["opportunity_name"] or f"Job #{opp_id}"
        prop_name  = rows[0]["property_name"] or ""
        lead_name  = rows[0]["lead_name"] or "Lead"
        ai_tip     = rows[0]["ai_tip"] or ""
    else:
        # No email sent today — create a stub record so history is preserved
        from app.api.construction_plan import _fetch_opp_actuals
        actuals   = await _fetch_opp_actuals([opp_id])
        opp       = actuals.get(opp_id, {})
        opp_name  = opp.get("OpportunityName") or f"Job #{opp_id}"
        prop_name = opp.get("PropertyName") or ""
        tickets   = await _fetch_project_tickets(opp_id, month)

        # Lead name from tickets
        lead_name = next(
            ((t.get("CrewLeaderName") or "").strip() for t in tickets if t.get("CrewLeaderName")),
            "Lead",
        )
        ai_tip    = ""
        token     = secrets.token_urlsafe(32)
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
        snapshot   = json.dumps([{
            "WorkTicketID": t.get("WorkTicketID"),
            "WorkTicketNumber": t.get("WorkTicketNumber"),
            "WorkTicketStatusName": t.get("WorkTicketStatusName"),
            "ScheduledStartDate": (t.get("ScheduledStartDate") or "")[:10],
            "HoursEst": t.get("HoursEst"),
            "HoursAct": t.get("HoursAct"),
        } for t in tickets])

        await db._x(
            """INSERT INTO project_checkins
               (token, opportunity_id, opportunity_name, property_name,
                lead_name, lead_email, month, ai_tip, ticket_snapshot, expires_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            [token, opp_id, opp_name, prop_name, lead_name, "", month, ai_tip, snapshot, expires_at],
        )
        new_rows  = await db._q("SELECT id FROM project_checkins WHERE token = ?", [token])
        checkin_id = new_rows[0]["id"]

    # Save response
    await db._x(
        """INSERT INTO project_checkin_responses
           (checkin_id, remaining_hours, approach_notes, blockers)
           VALUES (?,?,?,?)""",
        [checkin_id, body.remaining_hours, body.approach_notes.strip(), body.blockers],
    )
    await db._x(
        "UPDATE project_checkins SET responded_at = datetime('now') WHERE id = ?", [checkin_id]
    )

    # Notify management
    today_str   = datetime.now().strftime("%B %d, %Y")
    mgmt_emails = [e.strip() for e in settings.ISSUES_DIGEST_MGMT_RECIPIENTS.split(",") if e.strip()]
    html = _render_mgmt_email(
        opp_name=opp_name, property_name=prop_name, lead_name=lead_name,
        response_notes=body.approach_notes.strip(),
        remaining_hours=body.remaining_hours,
        blockers=body.blockers,
        ai_tip=ai_tip,
        today_str=today_str,
    )
    try:
        graph = GraphClient()
        await graph.send_email(
            mailbox=settings.MS_AP_INBOX,
            to_addresses=mgmt_emails,
            subject=f"✅ Project Update: {lead_name} — {prop_name or opp_name}",
            body_html=html,
        )
    except Exception as e:
        logger.warning(f"Management notification failed: {e}")

    return {"ok": True, "message": "Thanks — your update has been sent to the team."}


# ── Scheduler: fires at 06:00 Pacific daily ───────────────────────────────────

_scheduler_task: asyncio.Task | None = None


async def _scheduler_loop():
    tz = ZoneInfo(settings.CONSTRUCTION_REPORT_TIMEZONE or "America/Vancouver")
    while True:
        now    = datetime.now(tz)
        target = now.replace(hour=6, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        wait = (target - now).total_seconds()
        logger.info(
            f"Check-in scheduler fires in {wait / 3600:.1f}h "
            f"({target.strftime('%a %b %d %H:%M %Z')})"
        )
        await asyncio.sleep(wait)
        month = datetime.now(tz).strftime("%Y-%m")
        try:
            result = await _send_project_checkins(month)
            logger.info(f"Daily check-ins result: {result}")
        except Exception as e:
            logger.error(f"Check-in scheduler error: {e}")


def start_checkin_scheduler():
    global _scheduler_task
    _scheduler_task = asyncio.ensure_future(_scheduler_loop())
    logger.info("Project check-in scheduler started (fires 6 AM Pacific)")


def stop_checkin_scheduler():
    global _scheduler_task
    if _scheduler_task:
        _scheduler_task.cancel()
