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


async def _fetch_scope_notes(opp_id: int) -> str:
    """
    Fetch raw scope/estimator notes from Aspire for an opportunity and return
    a Claude-generated plain-English summary suitable for field crew.

    Sources:
      1. Opportunity record — any note-like fields (Notes, EstimatorNotes, etc.)
      2. OpportunityServices records — ServiceNotes / ServiceGroupNotes per service
    """
    import re as _re

    def _strip_html(s: str) -> str:
        if not s:
            return ""
        text = _re.sub(r"<[^>]+>", " ", s)
        text = _re.sub(r"&[a-zA-Z]+;", " ", text)
        return _re.sub(r"\s{2,}", " ", text).strip()

    # 1. Fetch opportunity without $select to get all fields
    opp_raw: dict = {}
    try:
        res = await _aspire._get("Opportunities", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$top":    "1",
        })
        rows = _aspire._extract_list(res)
        if rows:
            opp_raw = rows[0]
    except Exception as e:
        logger.warning(f"Scope notes: opportunity fetch failed for {opp_id}: {e}")

    # 2. Fetch OpportunityServices AND OpportunityServiceGroups in parallel
    svc_rows:   list[dict] = []
    group_rows: list[dict] = []

    async def _fetch_svc():
        try:
            res = await _aspire._get("OpportunityServices", {
                "$filter": f"OpportunityID eq {opp_id}",
                "$top":    "30",
            })
            return _aspire._extract_list(res)
        except Exception as e:
            logger.warning(f"Scope notes: OpportunityServices fetch failed for {opp_id}: {e}")
            return []

    async def _fetch_groups():
        try:
            res = await _aspire._get("OpportunityServiceGroups", {
                "$filter": f"OpportunityID eq {opp_id}",
                "$top":    "30",
            })
            return _aspire._extract_list(res)
        except Exception as e:
            logger.info(f"Scope notes: OpportunityServiceGroups not available for {opp_id}: {e}")
            return []

    svc_rows, group_rows = await asyncio.gather(_fetch_svc(), _fetch_groups())

    # Known non-note fields to skip (IDs, names, dates, statuses, numbers)
    SKIP_SUFFIXES = ("ID", "Id", "Name", "Abr", "Date", "Status", "Number",
                     "Code", "Type", "Color", "Sort", "Order", "Tax", "Rate",
                     "Hours", "Cost", "Price", "Revenue", "Dollars", "Percent")

    def _is_note_field(key: str, val) -> bool:
        if not isinstance(val, str) or len(val.strip()) < 10:
            return False
        if any(key.endswith(s) for s in SKIP_SUFFIXES):
            return False
        return True

    # 3. Collect all note-like text from opportunity (any string field that looks like prose)
    NOTE_KEYS = {
        "Notes", "EstimatorNotes", "SalesNotes", "InternalNotes",
        "Description", "CustomerNotes", "PrivateNotes", "Scope",
        "ScopeNotes", "WorkDescription", "JobDescription", "Comments",
        "ServiceGroupNotes", "ServiceGroupNote", "Memo", "OpportunityNotes",
    }
    opp_notes: list[str] = []
    for key, val in opp_raw.items():
        if not isinstance(val, str):
            continue
        # Accept explicit note keys OR any long string field that passes the exclusion filter
        if key in NOTE_KEYS or (len(val) > 30 and _is_note_field(key, val)):
            clean = _strip_html(val.strip())
            if clean:
                opp_notes.append(f"[{key}] {clean}")
                logger.info(f"Scope: opp field '{key}' has content ({len(clean)} chars)")

    # 4. Collect service-level notes — scan ALL string fields, not just hardcoded names
    svc_notes: list[str] = []
    for svc in svc_rows:
        svc_name = (
            svc.get("ServiceNameAbr") or svc.get("ServiceName") or svc.get("DisplayName") or "Service"
        )
        for key, val in svc.items():
            if _is_note_field(key, val):
                clean = _strip_html(str(val).strip())
                if clean:
                    svc_notes.append(f"[{svc_name} – {key}] {clean}")
                    logger.info(f"Scope: svc '{svc_name}' field '{key}' has content ({len(clean)} chars)")

    # 5. Scan OpportunityServiceGroups for note fields
    group_notes: list[str] = []
    for grp in group_rows:
        grp_name = (
            grp.get("ServiceGroupName") or grp.get("ServiceName") or grp.get("Name") or "Group"
        )
        for key, val in grp.items():
            if _is_note_field(key, val):
                clean = _strip_html(str(val).strip())
                if clean:
                    group_notes.append(f"[{grp_name}] {clean}")
                    logger.info(f"Scope: service group '{grp_name}' field '{key}' ({len(clean)} chars)")

    all_notes = opp_notes + group_notes + svc_notes
    if not all_notes:
        return ""

    raw_text = "\n\n".join(all_notes)
    # If very short, just return it without calling Claude
    if len(raw_text) < 120 and not any("<" in n for n in all_notes):
        return raw_text

    prompt = (
        "You are summarizing estimator and scope notes for a construction field crew lead. "
        "Below are raw notes from the project estimator and service descriptions. "
        "Rewrite them as a single clear paragraph (3-6 sentences) in plain English that a field lead "
        "can read quickly. Focus on: what work is being done, any special conditions or materials, "
        "and key things the crew needs to know. Remove any HTML, redundant formatting, and internal "
        "business jargon. Do not use bullet points or headings — just flowing sentences.\n\n"
        "Raw notes:\n" + raw_text + "\n\nScope summary:"
    )

    try:
        client = _anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        msg = await client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=250,
            messages=[{"role": "user", "content": prompt}],
        )
        return (msg.content[0].text or "").strip()
    except Exception as e:
        logger.warning(f"Scope summary AI call failed for opp {opp_id}: {e}")
        # Return the raw cleaned notes as fallback
        return raw_text[:600]


async def _generate_project_summary(
    opp_name: str,
    property_name: str,
    opp: dict,
    tickets: list[dict],
) -> str:
    """
    Generate a concise project summary for the crew lead using Claude.
    Covers overall status, hours, active work, and what's coming next.
    """
    COMPLETE = {"complete", "completed"}
    ACTIVE   = {"open", "in progress", "scheduled", "in production", "in queue"}

    total_est  = sum(float(t.get("HoursEst") or 0) for t in tickets)
    total_act  = sum(float(t.get("HoursAct") or 0) for t in tickets)
    pct_used   = (total_act / total_est * 100) if total_est > 0 else 0
    remaining  = max(total_est - total_act, 0)

    active_tickets = [t for t in tickets if (t.get("WorkTicketStatusName") or "").lower() in ACTIVE]
    done_tickets   = [t for t in tickets if (t.get("WorkTicketStatusName") or "").lower() in COMPLETE]

    def tk_line(t: dict) -> str:
        name = t.get("ServiceName") or f"#{t.get('WorkTicketNumber')}"
        est  = float(t.get("HoursEst") or 0)
        act  = float(t.get("HoursAct") or 0)
        date = (t.get("ScheduledStartDate") or "")[:10]
        status = t.get("WorkTicketStatusName") or ""
        over = f" [OVER by {act-est:.1f}h]" if est > 0 and act > est * 1.05 else ""
        return f"  - {name}: {act:.1f}h actual / {est:.1f}h est, status={status}, date={date}{over}"

    # Sort active by scheduled date
    active_sorted = sorted(active_tickets, key=lambda t: t.get("ScheduledStartDate") or "")

    context = (
        f"Project: {opp_name}" + (f" at {property_name}" if property_name else "") + "\n"
        f"Overall status: {opp.get('OpportunityStatusName', 'Unknown')}\n"
        f"Budget: {total_act:.1f}h actual vs {total_est:.1f}h estimated ({pct_used:.0f}% used), ~{remaining:.1f}h remaining\n"
        f"Tickets complete: {len(done_tickets)} of {len(tickets)}\n"
        f"\nActive / upcoming tickets ({len(active_sorted)}):\n" +
        "\n".join(tk_line(t) for t in active_sorted[:8]) +
        (f"\n\n(plus {len(active_sorted)-8} more active tickets)" if len(active_sorted) > 8 else "")
    )

    prompt = (
        "You are a construction project manager writing a quick briefing for a field crew lead. "
        "Write a short project summary (3-5 sentences, plain language, no bullet points) covering:\n"
        "1. Where the project stands overall (hours used vs budget, how many tickets done)\n"
        "2. What's currently active or next on site\n"
        "3. Any concern worth flagging (over-budget tickets, tight schedule, etc.)\n"
        "Be direct and practical — this is for a crew lead checking in from their phone. "
        "Do not use headings or lists. Just flowing sentences.\n\n"
        + context + "\n\nProject summary:"
    )

    try:
        client = _anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        msg = await client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=200,
            messages=[{"role": "user", "content": prompt}],
        )
        return msg.content[0].text.strip()
    except Exception as e:
        logger.warning(f"Project summary generation failed: {e}")
        # Fallback: plain text summary
        lines = []
        lines.append(f"You've used {total_act:.1f}h of {total_est:.1f}h estimated ({pct_used:.0f}%), with ~{remaining:.1f}h remaining across {len(tickets)} tickets ({len(done_tickets)} complete).")
        if active_sorted:
            next_names = [t.get("ServiceName") or f"#{t.get('WorkTicketNumber')}" for t in active_sorted[:3]]
            lines.append(f"Active work: {', '.join(next_names)}.")
        over = [t for t in tickets if float(t.get("HoursEst") or 0) > 0 and float(t.get("HoursAct") or 0) > float(t.get("HoursEst") or 0) * 1.05]
        if over:
            over_names = [t.get("ServiceName") or f"#{t.get('WorkTicketNumber')}" for t in over[:2]]
            lines.append(f"Heads up: {', '.join(over_names)} {'is' if len(over)==1 else 'are'} over budget.")
        return " ".join(lines)


async def _generate_smart_prompts(
    opp_name: str,
    property_name: str,
    tickets: list[dict],
) -> list[dict]:
    """
    Analyse ticket data and return structured prompts for the Update tab.
    Each prompt has: id, type, icon, situation, question, options (list of strings).
    """
    prompts: list[dict] = []

    COMPLETE = {"complete", "completed"}
    ACTIVE   = {"open", "in progress", "scheduled", "in production", "in queue"}

    # ── 1. Over-budget tickets ────────────────────────────────────────────────
    over_tickets = []
    for t in tickets:
        est = float(t.get("HoursEst") or 0)
        act = float(t.get("HoursAct") or 0)
        status = (t.get("WorkTicketStatusName") or "").strip().lower()
        name   = t.get("ServiceName") or f"#{t.get('WorkTicketNumber')}"
        if est > 0 and act > est * 1.05 and status not in COMPLETE:
            over_tickets.append({
                "name":  name,
                "num":   t.get("WorkTicketNumber"),
                "over":  round(act - est, 1),
                "est":   round(est, 1),
                "act":   round(act, 1),
            })

    for tk in over_tickets:
        prompts.append({
            "id":        f"over_{tk['num']}",
            "type":      "over_hours",
            "icon":      "⚠️",
            "situation": f"{tk['name']} is {tk['over']}h over budget ({tk['act']}h actual vs {tk['est']}h est)",
            "question":  "What's the reason for the extra hours?",
            "actHours":  tk['act'],   # used by frontend to detect if hours changed since last answer
            "options": [
                "Some hours should be reallocated to a different ticket",
                "Change order needed — unexpected site conditions discovered",
                "Change order needed — client requested additional scope",
                "Estimate was too aggressive for this scope",
                "Other — I'll explain in my notes",
            ],
        })

    # ── 2. Upcoming / next tickets ────────────────────────────────────────────
    upcoming = sorted(
        [t for t in tickets if (t.get("WorkTicketStatusName") or "").strip().lower() in ACTIVE],
        key=lambda t: t.get("ScheduledStartDate") or "",
    )
    if upcoming:
        names = [
            t.get("ServiceName") or f"#{t.get('WorkTicketNumber')}"
            for t in upcoming[:3]
        ]
        prompts.append({
            "id":        "next_tickets",
            "type":      "upcoming",
            "icon":      "📅",
            "situation": "Coming up: " + ", ".join(names),
            "question":  "What needs to happen before these tickets can start?",
            "options": [
                "All clear — crew and materials are ready",
                "Need to order materials — I'll detail below",
                "Waiting on subcontractor or delivery",
                "Site prep still required",
                "Other — I'll explain in my notes",
            ],
        })

    # ── 3. Materials / ordering prompt ───────────────────────────────────────
    prompts.append({
        "id":        "materials",
        "type":      "materials",
        "icon":      "📦",
        "situation": "Materials check",
        "question":  "Any materials that need to be ordered for upcoming work?",
        "options": [
            "All materials on order or on site",
            "Need to order — I'll list below",
            "Waiting on supplier to confirm availability",
        ],
    })

    return prompts


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
async def my_project_lookup(name: str = "", show_all: bool = False, db: Database = Depends(get_db)):
    """
    Return the list of known leads (for the name-picker dropdown) and,
    when a name is given, all opportunities where that person is crew leader
    (past ~12 months + future).  When show_all=true, returns projects for ALL
    known leads with a lead_name field on each project.
    Sorted: In Progress first, then Scheduled, then recently Completed.
    """
    from app.api.construction_plan import _fetch_opp_actuals

    name = (name or "").strip()

    # Always return lead list so the dropdown can populate
    lead_rows = await db._q(
        "SELECT aspire_name, display_name FROM construction_leads ORDER BY aspire_name", []
    )
    leads = [
        {"name": r["aspire_name"], "display": r["display_name"] or r["aspire_name"]}
        for r in lead_rows
    ]

    if not name and not show_all:
        return {"leads": leads, "projects": []}

    # Known lead names for filtering when show_all=True
    known_leads = {l["name"].strip().lower(): l["name"] for l in leads}

    # Fetch work tickets via paginated requests (500 per page, WorkTicketID desc).
    # Aspire rejects $orderby on non-ID fields and large $top values, so we page
    # through using $skip.  We stop early once we've seen enough tickets or have
    # covered the range where this lead's active jobs would appear.
    PAGE = 500
    MAX_PAGES = 20   # 20 × 500 = 10 000 tickets max
    SELECT = (
        "WorkTicketID,WorkTicketNumber,WorkTicketStatusName,"
        "OpportunityID,OpportunityNumber,ScheduledStartDate,CompleteDate,"
        "HoursEst,HoursAct,CrewLeaderName,PercentComplete"
    )

    all_tickets: list[dict] = []
    for page in range(MAX_PAGES):
        skip = page * PAGE
        try:
            res = await _aspire._get("WorkTickets", {
                "$select":  SELECT,
                "$orderby": "WorkTicketID desc",
                "$top":     str(PAGE),
                "$skip":    str(skip),
            })
            batch = _aspire._extract_list(res)
            if not batch:
                logger.info(f"my-project: no more tickets at skip={skip}, stopping pagination")
                break
            all_tickets.extend(batch)
            logger.info(f"my-project: page {page + 1} — {len(batch)} tickets (total so far: {len(all_tickets)})")
            if len(batch) < PAGE:
                break   # last page
        except Exception as e:
            logger.warning(f"my-project WorkTickets page {page + 1} (skip={skip}) failed: {e}")
            break

    # Filter to matching crew leader(s)
    if show_all:
        leader_tickets = [
            t for t in all_tickets
            if (t.get("CrewLeaderName") or "").strip().lower() in known_leads
        ]
        logger.info(f"my-project show_all: {len(leader_tickets)} tickets across {len(known_leads)} leads")
    else:
        leader_tickets = [
            t for t in all_tickets
            if (t.get("CrewLeaderName") or "").strip().lower() == name.lower()
        ]
        if not leader_tickets:
            logger.warning(f"my-project '{name}': 0 tickets matched after CrewLeaderName filter")

    # Status filter — exclude cancelled/void only; include everything else
    # (In Production, In Queue, Scheduled, Open, In Progress, Complete/recent, etc.)
    EXCLUDED_STATUSES = {"cancelled", "canceled", "void", "voided"}
    cutoff_date = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")

    def _keep_ticket(t: dict) -> bool:
        status = (t.get("WorkTicketStatusName") or "").strip().lower()
        if status in EXCLUDED_STATUSES:
            return False
        # Keep completed tickets only if finished within the last 90 days
        if status in {"complete", "completed"}:
            complete_date = (t.get("CompleteDate") or t.get("ScheduledStartDate") or "")[:10]
            return complete_date >= cutoff_date
        return True  # all other statuses shown

    tickets = [t for t in leader_tickets if _keep_ticket(t)]
    logger.info(f"my-project: {len(tickets)} tickets after status filter")

    if not tickets:
        return {"leads": leads, "projects": []}

    COMPLETE_TICKET_STATUSES = {"complete", "completed"}

    # Group by OpportunityNumber (consolidates change orders sharing the same base job).
    # Track all OpportunityIDs in the group; use the highest for _fetch_opp_actuals.
    opp_num_map: dict[tuple, dict] = {}
    for t in tickets:
        oid      = t.get("OpportunityID")
        opp_num  = t.get("OpportunityNumber")
        crew     = (t.get("CrewLeaderName") or "").strip()
        if not oid:
            continue
        opp_key = opp_num if opp_num is not None else float(oid)
        key = (opp_key, crew)  # unique per opp+lead so show_all doesn't merge across leads
        if key not in opp_num_map:
            opp_num_map[key] = {
                "opp_ids":       set(),
                "primary_oid":   oid,   # highest ID = most recent change order
                "lead_name":     crew,
                "hrs_est":       0.0,
                "hrs_act":       0.0,
                "ticket_count":  0,
                "latest_date":   "",
                "active_tickets": 0,    # tickets NOT complete
            }
        e = opp_num_map[key]
        e["opp_ids"].add(oid)
        if oid > e["primary_oid"]:
            e["primary_oid"] = oid      # keep highest OpportunityID as representative
        e["hrs_est"]      += float(t.get("HoursEst") or 0)
        e["hrs_act"]      += float(t.get("HoursAct") or 0)
        e["ticket_count"] += 1
        d = (t.get("ScheduledStartDate") or "")[:10]
        if d > e["latest_date"]:
            e["latest_date"] = d
        t_status = (t.get("WorkTicketStatusName") or "").strip().lower()
        if t_status not in COMPLETE_TICKET_STATUSES:
            e["active_tickets"] += 1

    # Fetch opportunity details using the primary (highest) OpportunityID per group
    primary_ids = [e["primary_oid"] for e in opp_num_map.values()]
    actuals     = await _fetch_opp_actuals(primary_ids)

    # Build enriched project list — filter to Construction division, log others
    projects = []
    for key, e in opp_num_map.items():
        oid      = e["primary_oid"]
        opp      = actuals.get(oid, {})
        opp_name = opp.get("OpportunityName") or f"Job #{oid}"
        prop     = opp.get("PropertyName") or ""
        division = opp.get("DivisionName") or ""

        # Skip non-construction divisions (log so we can debug)
        if division and "construction" not in division.lower():
            logger.info(f"my-project: skipping '{opp_name}' — division='{division}'")
            continue

        # Use ticket activity to determine if job is active or complete
        # (opportunity status like 'Won' doesn't reliably indicate work is ongoing)
        all_done = e["active_tickets"] == 0
        status   = "Complete" if all_done else (opp.get("OpportunityStatusName") or "Active")

        projects.append({
            "opp_id":       oid,
            "opp_number":   opp.get("OpportunityNumber"),
            "opp_name":     opp_name,
            "property":     prop,
            "status":       status,
            "all_done":     all_done,
            "hrs_est":      round(e["hrs_est"], 1),
            "hrs_act":      round(e["hrs_act"], 1),
            "ticket_count": e["ticket_count"],
            "latest_date":  e["latest_date"],
            "lead_name":    e["lead_name"],
        })

    label = "ALL" if show_all else name
    logger.info(f"my-project '{label}': returning {len(projects)} construction projects")
    # Active jobs first (all_done=False), then completed; within each group newest first
    projects.sort(key=lambda x: (x["all_done"], x["latest_date"]), reverse=True)
    projects.sort(key=lambda x: x["all_done"])   # stable: False (active) before True (done)

    return {"leads": leads, "projects": projects}


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

async def _fetch_all_opp_tickets(opp_id: int) -> list[dict]:
    """Fetch ALL work tickets for an opportunity (all months).

    Uses only confirmed-valid field names from the Aspire WorkTickets OData spec.
    Tries with $expand for service name first; falls back to base fields only.
    """
    SELECT = (
        "WorkTicketID,WorkTicketNumber,WorkTicketStatusName,OpportunityServiceID,"
        "OpportunityID,ScheduledStartDate,CompleteDate,"
        "HoursEst,HoursAct,HoursScheduled,HoursUnscheduled,"
        "CrewLeaderName,PercentComplete,"
        "Revenue,EarnedRevenue,Price"
    )
    try:
        res = await _aspire._get("WorkTickets", {
            "$filter":  f"OpportunityID eq {opp_id}",
            "$orderby": "WorkTicketID asc",
            "$top":     "200",
            "$select":  SELECT,
        })
        rows = _aspire._extract_list(res)
        logger.info(f"Project page tickets: {len(rows)} for opp {opp_id}")
    except Exception as e:
        logger.warning(f"Project page tickets fetch failed: {e}")
        return []

    # Fetch service names via OpportunityServices (same approach as PO page)
    service_map: dict = {}
    try:
        svc_res = await _aspire._get("OpportunityServices", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$top": "50",
        })
        for svc in _aspire._extract_list(svc_res):
            sid = svc.get("OpportunityServiceID")
            if sid:
                service_map[sid] = (
                    svc.get("ServiceNameAbr")
                    or svc.get("DisplayName")
                    or svc.get("ServiceName")
                    or ""
                )
        logger.info(f"OpportunityServices: {len(service_map)} services for opp {opp_id}")
    except Exception as e:
        logger.warning(f"OpportunityServices fetch failed (non-fatal): {e}")

    # Attach service name to each ticket
    for t in rows:
        svc_id = t.get("OpportunityServiceID")
        t["ServiceName"] = service_map.get(svc_id) or "" if svc_id else ""

    return rows


@public_router.get("/project/{opp_id}")
async def get_project_page(opp_id: int, db: Database = Depends(get_db)):
    """
    Return live project data for the permanent project page.
    Fetches ALL work tickets from Aspire + check-in history from D1.
    No token required — bookmarkable by lead.
    """
    from app.api.construction_plan import _fetch_opp_actuals

    tz    = ZoneInfo(settings.CONSTRUCTION_REPORT_TIMEZONE or "America/Vancouver")
    month = datetime.now(tz).strftime("%Y-%m")

    # Live Aspire data — all tickets for this opportunity
    actuals = await _fetch_opp_actuals([opp_id])
    opp     = actuals.get(opp_id, {})
    tickets = await _fetch_all_opp_tickets(opp_id)

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

    # Smart prompts + project summary + scope notes + attachments — all in parallel
    smart_prompts:    list[dict] = []
    project_summary:  str        = ""
    scope_summary:    str        = ""
    opp_name_str = opp.get("OpportunityName") or f"Job #{opp_id}"
    prop_str     = opp.get("PropertyName") or ""

    async def _fetch_opp_attachments() -> list[dict]:
        """
        Fetch files attached to this opportunity in Aspire.
        Field names confirmed from Aspire API docs (Oct 2025).
        """
        rows: list[dict] = []
        try:
            res = await _aspire._get("Attachments", {
                "$filter": f"OpportunityID eq {opp_id}",
                "$top":    "50",
                "$orderby": "DateUploaded desc",
            })
            rows = _aspire._extract_list(res)
            logger.info(f"Attachments: {len(rows)} rows for opp {opp_id}")
        except Exception as e:
            logger.warning(f"Attachments fetch failed for opp {opp_id}: {e}")

        out = []
        for r in rows:
            att_id   = r.get("AttachmentID")
            ext      = (r.get("FileExtension") or "").lstrip(".").lower()
            name     = r.get("AttachmentName") or r.get("OriginalFileName") or "File"
            # ExternalContentID may be a SharePoint/OneDrive URL for linked files
            ext_url  = r.get("ExternalContentID") or ""
            file_url = ext_url if ext_url.startswith("http") else ""
            out.append({
                "attachment_id":   att_id,
                "file_name":       name,
                "file_extension":  ext,
                "file_url":        file_url,
                "attachment_type": r.get("AttachmentTypeName") or "",
                "type_id":         r.get("AttachmentTypeID"),
                "expose_to_crew":  bool(r.get("ExposeToCrew")),
                "created_date":    (r.get("DateUploaded") or "")[:10],
                "note":            r.get("Note") or "",
            })
        return out

    if tickets:
        project_summary, smart_prompts, scope_summary, attachments = await asyncio.gather(
            _generate_project_summary(opp_name_str, prop_str, opp, tickets),
            _generate_smart_prompts(opp_name_str, prop_str, tickets),
            _fetch_scope_notes(opp_id),
            _fetch_opp_attachments(),
        )
    else:
        scope_summary, attachments = await asyncio.gather(
            _fetch_scope_notes(opp_id),
            _fetch_opp_attachments(),
        )

    # Aspire activities for this opportunity
    activities: list[dict] = []
    try:
        res = await _aspire._get("Activities", {
            "$filter":  f"OpportunityID eq {opp_id}",
            "$orderby": "CreatedDate desc",
            "$top":     "50",
            "$select":  (
                "ActivityID,Subject,ActivityType,ActivityCategoryName,"
                "Status,Notes,CreatedDate,CompleteDate,CreatedByUserName,IsMileStone"
            ),
        })
        activities = _aspire._extract_list(res)
    except Exception as e:
        logger.warning(f"Activities fetch failed for opp {opp_id}: {e}")

    # Fetch comments for each activity separately
    async def _fetch_activity_comments(activity_id: int) -> list[dict]:
        try:
            res = await _aspire._get("ActivityComments", {
                "$filter":  f"ActivityID eq {activity_id}",
                "$orderby": "CreatedDate asc",
                "$select":  "Comment,CreatedDate,CreatedByUserName",
            })
            batch = _aspire._extract_list(res)
            logger.info(f"ActivityComments for activity {activity_id}: {len(batch)} results")
            if batch:
                logger.info(f"ActivityComments sample keys: {list(batch[0].keys())}")
            return batch
        except Exception as e:
            logger.warning(f"ActivityComments fetch failed for activity {activity_id}: {e}")
            return []

    if activities:
        comment_tasks = [_fetch_activity_comments(a["ActivityID"]) for a in activities if a.get("ActivityID")]
        comment_results = await asyncio.gather(*comment_tasks)
        for a, comments in zip(activities, comment_results):
            a["_comments"] = [c for c in comments if c.get("Comment")]

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
        "tickets": [{
            "WorkTicketID":         t.get("WorkTicketID"),
            "WorkTicketNumber":     t.get("WorkTicketNumber"),
            "ServiceName":          t.get("ServiceName") or "",
            "WorkTicketStatusName": t.get("WorkTicketStatusName"),
            "ScheduledStartDate":   (t.get("ScheduledStartDate") or "")[:10],
            "HoursEst":             t.get("HoursEst"),
            "HoursAct":             t.get("HoursAct"),
            "HoursScheduled":       t.get("HoursScheduled"),
            "HoursUnscheduled":     t.get("HoursUnscheduled"),
            "CrewLeaderName":       t.get("CrewLeaderName"),
            "Revenue":              t.get("Revenue"),
            "EarnedRevenue":        t.get("EarnedRevenue"),
        } for t in tickets],
        "ai_tip":          ai_tip,
        "scope_summary":   scope_summary,
        "attachments":     attachments,
        "project_summary": project_summary,
        "smart_prompts":   smart_prompts,
        "history": [dict(r) for r in history_rows],
        "activities": [{
            "ActivityID":           a.get("ActivityID"),
            "Subject":              a.get("Subject") or "",
            "ActivityType":         a.get("ActivityType") or "",
            "ActivityCategoryName": a.get("ActivityCategoryName") or "",
            "Status":               a.get("Status") or "",
            "Notes":                a.get("Notes") or "",
            "CreatedDate":          (a.get("CreatedDate") or "")[:10],
            "CompleteDate":         (a.get("CompleteDate") or "")[:10],
            "CreatedByUserName":    a.get("CreatedByUserName") or "",
            "IsMileStone":          bool(a.get("IsMileStone")),
            "comments": [
                {
                    "Comment":           c.get("Comment") or "",
                    "CreatedDate":       (c.get("CreatedDate") or "")[:10],
                    "CreatedByUserName": c.get("CreatedByUserName") or "",
                }
                for c in (a.get("_comments") or [])
            ],
        } for a in activities],
    }


@public_router.get("/project/{opp_id}/scope-probe")
async def scope_probe(opp_id: int):
    """
    Dev endpoint: returns raw field names + values from every entity that might
    hold Service Group Notes for this opportunity. Used to identify the correct
    field/endpoint so _fetch_scope_notes can be fixed.
    """
    import asyncio as _asyncio

    results: dict = {}

    async def _try(label: str, endpoint: str, params: dict):
        try:
            res = await _aspire._get(endpoint, params)
            rows = _aspire._extract_list(res)
            if rows:
                results[label] = {
                    "count": len(rows),
                    "keys":  sorted(rows[0].keys()),
                    # All non-empty string values longer than 15 chars (likely notes)
                    "strings": {
                        k: v for k, v in rows[0].items()
                        if isinstance(v, str) and len(v) > 15
                    },
                    "sample": rows[:2],
                }
            else:
                results[label] = {"count": 0, "keys": [], "strings": {}}
        except Exception as e:
            results[label] = {"error": str(e)}

    await _asyncio.gather(
        _try("Opportunity",              "Opportunities",              {"$filter": f"OpportunityID eq {opp_id}", "$top": "1"}),
        _try("OpportunityServices",      "OpportunityServices",        {"$filter": f"OpportunityID eq {opp_id}", "$top": "10"}),
        _try("OpportunityServiceGroups", "OpportunityServiceGroups",   {"$filter": f"OpportunityID eq {opp_id}", "$top": "10"}),
        _try("EstimateServiceGroups",    "EstimateServiceGroups",      {"$filter": f"OpportunityID eq {opp_id}", "$top": "10"}),
        _try("ServiceGroups",            "ServiceGroups",              {"$top": "3"}),
        # Attachment probes — try different filter field name conventions
        _try("Attachments_ObjectId",     "Attachments",                {"$filter": f"ObjectId eq {opp_id} and ObjectCode eq 'Opportunity'", "$top": "10"}),
        _try("Attachments_ObjectID",     "Attachments",                {"$filter": f"ObjectID eq {opp_id} and ObjectCode eq 'Opportunity'", "$top": "10"}),
        _try("Attachments_OpportunityID","Attachments",                {"$filter": f"OpportunityID eq {opp_id}", "$top": "10"}),
        _try("Attachments_nofilter",     "Attachments",                {"$top": "3"}),  # just get fields
    )

    return results


@public_router.get("/project/{opp_id}/materials")
async def get_project_materials(opp_id: int):
    """
    Return PO/Receipt summary for all work tickets in this opportunity.
    Used by the Materials tab on the project page.
    """
    # 1. Get work tickets (reuses the same helper as get_project_page)
    tickets = await _fetch_all_opp_tickets(opp_id)
    ticket_map: dict[int, dict] = {
        t.get("WorkTicketID"): {
            "WorkTicketID":     t.get("WorkTicketID"),
            "WorkTicketNumber": t.get("WorkTicketNumber"),
            "ServiceName":      t.get("ServiceName") or f"#{t.get('WorkTicketNumber')}",
        }
        for t in tickets if t.get("WorkTicketID")
    }
    ticket_ids = list(ticket_map.keys())

    if not ticket_ids:
        return {"pos": [], "tickets_without_po": []}

    # 2. Fetch Receipts for those work tickets (chunked OR filter)
    all_receipts: list[dict] = []
    chunk_size = 8  # keep filter URL short to avoid 400
    for i in range(0, len(ticket_ids), chunk_size):
        chunk = ticket_ids[i : i + chunk_size]
        or_filter = " or ".join(f"WorkTicketID eq {tid}" for tid in chunk)
        try:
            res = await _aspire._get("Receipts", {
                "$filter":  f"({or_filter})",
                "$top":     "200",
                "$orderby": "ReceiptID desc",
            })
            all_receipts.extend(_aspire._extract_list(res))
        except Exception as e:
            logger.warning(f"Receipts fetch for opp {opp_id} chunk {chunk} failed (non-fatal): {e}")

    # 3. Deduplicate
    seen_ids: set[int] = set()
    deduped: list[dict] = []
    for r in all_receipts:
        rid = r.get("ReceiptID")
        if rid and rid not in seen_ids:
            seen_ids.add(rid)
            deduped.append(r)

    # 4. Which tickets have at least one receipt?
    tickets_with_po: set[int] = {
        r.get("WorkTicketID") for r in deduped if r.get("WorkTicketID")
    }
    tickets_without_po = [
        v for k, v in ticket_map.items() if k not in tickets_with_po
    ]

    import re as _re

    def _strip_html(s: str) -> str:
        """Strip HTML tags and collapse whitespace."""
        if not s:
            return ""
        text = _re.sub(r"<[^>]+>", " ", s)
        text = _re.sub(r"\s{2,}", " ", text)
        return text.strip()

    # 5. Format receipts
    pos: list[dict] = []
    for r in deduped:
        rid = r.get("ReceiptID")
        display_number = (rid - 1) if rid else None

        # Extract line items — Aspire returns ReceiptItems inline.
        # Log field names on first receipt to help debug description/total keys.
        raw_items = r.get("ReceiptItems") or []
        if raw_items:
            logger.info(f"ReceiptItem sample keys: {sorted(raw_items[0].keys())}")

        items: list[dict] = []
        for item in raw_items:
            qty      = float(item.get("ItemQuantity") or item.get("Quantity") or 0)
            unit_cost = float(item.get("ItemUnitCost") or item.get("UnitCost") or item.get("ItemEstUnitCost") or 0)
            total    = float(
                item.get("ItemExtendedCost")
                or item.get("ReceiptItemPrice")
                or item.get("ItemTotal")
                or item.get("TotalCost")
                or item.get("ReceiptItemCost")
                or item.get("ItemTotalCost")
                or (qty * unit_cost)   # fallback: calculate from qty × unit_cost
                or 0
            )
            desc = (
                item.get("ItemName")
                or item.get("CatalogItemName")
                or item.get("Description")
                or item.get("ReceiptItemDescription")
                or item.get("ItemDescription")
                or item.get("Name")
                or ""
            )
            items.append({
                "description": desc or "—",
                "quantity":    qty,
                "unit_cost":   unit_cost,
                "total":       total,
            })

        wt_id       = r.get("WorkTicketID")
        ticket_info = ticket_map.get(wt_id, {})

        raw_note = (r.get("ReceiptNote") or "").strip()
        clean_note = _strip_html(raw_note)[:160]

        pos.append({
            "receipt_id":     rid,
            "display_number": display_number,
            "work_ticket_id": wt_id,
            "ticket_number":  ticket_info.get("WorkTicketNumber"),
            "service_name":   ticket_info.get("ServiceName") or "",
            "vendor_name":    r.get("VendorName") or str(r.get("VendorID") or "Unknown Vendor"),
            "received_date":  (r.get("ReceivedDate") or "")[:10],
            "total":          r.get("ReceiptTotalCost") or 0,
            "status":         r.get("ReceiptStatusName") or "",
            "note":           clean_note,
            "items":          items,
        })

    return {
        "pos":                pos,
        "tickets_without_po": tickets_without_po,
    }


@public_router.get("/attachment/{attachment_id}")
async def proxy_attachment(attachment_id: int):
    """
    Stream an Aspire attachment to the browser.
    Tries multiple strategies: single-entity OData GET (often includes FileData),
    list-filter GET, OData binary patterns, and download endpoint variants.
    """
    MIME_MAP = {
        "pdf":  "application/pdf",
        "png":  "image/png",
        "jpg":  "image/jpeg",
        "jpeg": "image/jpeg",
        "gif":  "image/gif",
        "webp": "image/webp",
        "bmp":  "image/bmp",
        "doc":  "application/msword",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls":  "application/vnd.ms-excel",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "dwg":  "application/acad",
        "dxf":  "image/vnd.dxf",
        "svg":  "image/svg+xml",
    }

    import base64
    import httpx
    from fastapi.responses import Response as _Resp

    token = await _aspire._get_token()
    auth_headers = {"Authorization": f"Bearer {token}"}

    # Helper: resolve filename/ext/content-type from a record dict
    def _meta_from_record(rec: dict):
        fn  = rec.get("AttachmentName") or rec.get("OriginalFileName") or "attachment"
        ex  = (rec.get("FileExtension") or "").lstrip(".").lower()
        ct  = MIME_MAP.get(ex, "application/octet-stream")
        return fn, ex, ct

    # Helper: attempt to decode + return base64 FileData
    def _try_base64(rec: dict, fn, ct):
        b64 = rec.get("FileData") or rec.get("fileData") or rec.get("File")
        if b64 and isinstance(b64, str):
            try:
                data = base64.b64decode(b64)
                logger.info(f"Attachment {attachment_id}: serving {len(data)} bytes (base64, {ct})")
                return _Resp(content=data, media_type=ct,
                             headers={"Content-Disposition": f'inline; filename="{fn}"'})
            except Exception as e:
                logger.warning(f"Attachment {attachment_id}: base64 decode failed: {e}")
        return None

    # Strategy 1a: single-entity OData GET — /Attachments(123)
    # (direct single-entity requests often include all fields incl. FileData)
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(
                f"{_aspire.base_url}/Attachments({attachment_id})",
                headers=auth_headers,
            )
            if r.status_code == 200:
                rec = r.json()
                fn, ex, ct = _meta_from_record(rec)
                result = _try_base64(rec, fn, ct)
                if result:
                    return result
                # Also check ExternalContentID — might be a full URL
                ext_url = rec.get("ExternalContentID") or ""
                if ext_url.startswith("http"):
                    logger.info(f"Attachment {attachment_id}: redirecting to ExternalContentID URL")
                    from fastapi.responses import RedirectResponse
                    return RedirectResponse(url=ext_url)
            else:
                logger.info(f"Attachment {attachment_id}: single-entity GET → {r.status_code}")
    except Exception as e:
        logger.info(f"Attachment {attachment_id}: single-entity GET failed: {e}")

    # Strategy 1b: list-filter GET with $select=* to force all fields
    try:
        res = await _aspire._get("Attachments", {
            "$filter": f"AttachmentID eq {attachment_id}",
            "$top":    "1",
        })
        rows = _aspire._extract_list(res)
    except Exception as e:
        logger.warning(f"Attachment list-fetch failed for id {attachment_id}: {e}")
        rows = []

    record = rows[0] if rows else {}
    fn, ex, ct = _meta_from_record(record) if record else ("attachment", "", "application/octet-stream")
    result = _try_base64(record, fn, ct) if record else None
    if result:
        return result

    if not record:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Strategy 2: probe every plausible Aspire download URL pattern
    # We log the status code for each so we can identify which one works.
    probe_results: list[str] = []
    probe_patterns = [
        # OData stream
        f"{_aspire.base_url}/Attachments({attachment_id})/$value",
        f"{_aspire.base_url}/Attachments({attachment_id})/FileData/$value",
        # REST-style helpers Aspire may expose
        f"{_aspire.base_url}/Attachments({attachment_id})/Download",
        f"{_aspire.base_url}/Attachments({attachment_id})/Content",
        f"{_aspire.base_url}/Attachments/{attachment_id}/Download",
        f"{_aspire.base_url}/Attachments/{attachment_id}/Content",
        f"{_aspire.base_url}/Attachments/{attachment_id}/File",
        # Aspire-specific non-OData paths
        f"{_aspire.base_url}/AttachmentFile({attachment_id})",
        f"{_aspire.base_url}/AttachmentFile/{attachment_id}",
        f"{_aspire.base_url}/AttachmentFiles({attachment_id})",
        f"{_aspire.base_url}/AttachmentDownload/{attachment_id}",
        f"{_aspire.base_url}/File/Attachment/{attachment_id}",
    ]
    async with httpx.AsyncClient(timeout=30) as client:
        for url_pattern in probe_patterns:
            try:
                resp = await client.get(url_pattern, headers=auth_headers)
                probe_results.append(f"{resp.status_code}:{url_pattern.split(str(attachment_id))[1] or '/'}")
                if resp.status_code == 200 and resp.content:
                    resp_ct = resp.headers.get("content-type", ct)
                    logger.info(f"Attachment {attachment_id}: served via {url_pattern}")
                    return _Resp(
                        content=resp.content,
                        media_type=resp_ct,
                        headers={"Content-Disposition": f'inline; filename="{fn}"'},
                    )
            except Exception as e:
                probe_results.append(f"ERR:{url_pattern.split(str(attachment_id))[1] or '/'}")
                logger.info(f"Attachment {attachment_id}: {url_pattern} failed: {e}")

    raise HTTPException(
        status_code=404,
        detail=f"Attachment {attachment_id} ({fn}): no download URL found. "
               f"Probe results: {probe_results}"
    )


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
