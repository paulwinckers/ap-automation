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
import time as _time
from datetime import datetime, timedelta, timezone, date as _date
from typing import Optional
from zoneinfo import ZoneInfo

import mimetypes
import uuid

import anthropic as _anthropic
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.services import r2 as _r2
from app.services.aspire import AspireClient
from app.services.email_intake import GraphClient

logger = logging.getLogger(__name__)

router        = APIRouter(prefix="/construction/checkin", tags=["project-checkin"])
public_router = APIRouter(prefix="/checkin",             tags=["project-checkin-public"])

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)
_db     = Database()

# ── My-Projects in-memory cache (show_all=True only) ─────────────────────────
_my_projects_cache:    dict | None = None
_my_projects_cache_ts: float       = 0.0
_MY_PROJECTS_TTL = 10 * 60  # 10 minutes


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
        "You are a construction project coach at a landscaping company. "
        "A field crew lead is about to fill in their daily check-in. "
        "Based on the data below, write exactly 3 bullet points — one action per bullet. "
        "Each bullet must be under 12 words. Start each with '• '. "
        "Be direct and practical. No fluff, no preamble, no numbering.\n\n"
        + context + "\nTips:"
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
            f"• ~{rem_str}h remaining — walk the site and confirm it's accurate.\n"
            "• Flag any changes early so the team can adjust quickly.\n"
            "• Keep ticket statuses current as tasks are completed."
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
        "Rewrite them as 3-5 bullet points in plain English. Each bullet must be under 15 words. "
        "Focus on: what work is being done, special conditions or materials, key crew requirements. "
        "Remove HTML, jargon, and redundant info. Start each line with '• '. No headings, no preamble.\n\n"
        "Raw notes:\n" + raw_text + "\n\nScope bullets:"
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
        "You are briefing a construction field crew lead. "
        "Write 3-4 bullet points covering: hours used vs budget, active tickets, anything over budget or urgent. "
        "Each bullet must be under 15 words. Start each with '• '. No preamble, no headings.\n\n"
        + context + "\n\nStatus bullets:"
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
        # Fallback: bullet format
        lines = [f"• {total_act:.1f}h used of {total_est:.1f}h estimated ({pct_used:.0f}%) — ~{remaining:.1f}h remaining."]
        if active_sorted:
            next_names = [t.get("ServiceName") or f"#{t.get('WorkTicketNumber')}" for t in active_sorted[:3]]
            lines.append(f"• Active: {', '.join(next_names)}.")
        over = [t for t in tickets if float(t.get("HoursEst") or 0) > 0 and float(t.get("HoursAct") or 0) > float(t.get("HoursEst") or 0) * 1.05]
        if over:
            over_names = [t.get("ServiceName") or f"#{t.get('WorkTicketNumber')}" for t in over[:2]]
            lines.append(f"• ⚠ Over budget: {', '.join(over_names)}.")
        return "\n".join(lines)


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
    """Render the daily check-in email in a card style matching the check-in history UI."""

    # ── Bucket tickets ────────────────────────────────────────────────────────
    complete, over_budget, near_budget, normal, upcoming = [], [], [], [], []
    hours_lines: list[str] = []

    for t in tickets:
        est    = float(t.get("HoursEst") or 0)
        act    = float(t.get("HoursAct") or 0)
        rem    = est - act
        pct    = (act / est * 100) if est else 0
        status = (t.get("WorkTicketStatusName") or "").lower()
        name   = t.get("ServiceName") or f"#{t.get('WorkTicketNumber')}"

        if "complete" in status:
            complete.append(name)
            continue

        # Hours remaining line (for non-complete tickets)
        hours_lines.append(f"{name}: {rem:.0f}h")

        if rem < 0:
            over_budget.append((name, abs(rem), act, est))
        elif pct >= 80:
            near_budget.append((name, rem, pct))
        else:
            normal.append((name, rem))

        sched = (t.get("ScheduledStartDate") or "")[:10]
        if sched:
            upcoming.append((name, sched))

    # ── Build ticket section HTML ─────────────────────────────────────────────
    ticket_rows = ""

    # Hours remaining summary line
    if hours_lines:
        ticket_rows += f"""
        <div style="font-size:13px;color:#374151;padding:10px 0 14px;border-bottom:1px solid #f1f5f9;margin-bottom:12px;">
          Hours remaining — {', '.join(hours_lines)}
        </div>"""

    # Over budget warnings (amber)
    for name, over, act, est in over_budget:
        ticket_rows += f"""
        <div style="margin-bottom:10px;padding:10px 14px;background:#fffbeb;border-left:3px solid #f59e0b;border-radius:6px;">
          <div style="font-size:13px;color:#92400e;font-weight:600;">
            ⚠ {name} is {over:.1f}h over budget ({act:.1f}h actual vs {est:.1f}h est)
          </div>
        </div>"""

    # Near budget warnings (orange)
    for name, rem, pct in near_budget:
        ticket_rows += f"""
        <div style="margin-bottom:10px;padding:10px 14px;background:#fff7ed;border-left:3px solid #fb923c;border-radius:6px;">
          <div style="font-size:13px;color:#9a3412;font-weight:600;">
            ⚠ {name} is at {pct:.0f}% of budget ({rem:.1f}h remaining)
          </div>
        </div>"""

    # Normal tickets (green)
    for name, rem in normal:
        ticket_rows += f"""
        <div style="margin-bottom:8px;padding:8px 14px;background:#f0fdf4;border-left:3px solid #4ade80;border-radius:6px;">
          <div style="font-size:13px;color:#15803d;">✅ {name} — {rem:.1f}h remaining</div>
        </div>"""

    # Complete tickets (collapsed into one line)
    if complete:
        ticket_rows += f"""
        <div style="margin-bottom:8px;padding:8px 14px;background:#f8fafc;border-radius:6px;">
          <div style="font-size:12px;color:#64748b;">✓ Complete: {', '.join(complete)}</div>
        </div>"""

    # Upcoming scheduled
    if upcoming:
        up_names = ", ".join(n for n, _ in upcoming[:4])
        ticket_rows += f"""
        <div style="margin-top:4px;margin-bottom:8px;padding:8px 14px;background:#eff6ff;border-left:3px solid #60a5fa;border-radius:6px;">
          <div style="font-size:13px;color:#1d4ed8;">🗓 Scheduled: {up_names}</div>
        </div>"""

    if not ticket_rows:
        ticket_rows = '<div style="font-size:13px;color:#94a3b8;padding:8px 0;">No active tickets found for this month.</div>'

    # ── AI coaching tip ───────────────────────────────────────────────────────
    import re as _re
    tip_lines = ""
    for line in ai_tip.splitlines():
        line = line.strip()
        if not line:
            continue
        # Strip leading bullet chars / numbering
        clean = _re.sub(r"^[•\-\*]\s*", "", _re.sub(r"^\d+\.\s*", "", line))
        if not clean:
            continue
        tip_lines += f"""
        <div style="margin-bottom:6px;padding:7px 12px 7px 10px;background:#fff;border-left:3px solid #4ade80;border-radius:6px;font-size:13px;color:#374151;line-height:1.5;">
          • {clean}
        </div>"""

    first_name    = (lead_name or "").split()[0] or "Hi"
    display_title = property_name or opp_name

    return f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.09);">

  <!-- Header -->
  <div style="background:#14532d;padding:22px 28px;">
    <div style="color:#86efac;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Daily Project Check-in</div>
    <div style="color:#fff;font-size:20px;font-weight:800;margin-top:5px;">{display_title}</div>
    <div style="color:#4ade80;font-size:12px;margin-top:2px;">{opp_name} · {today_str}</div>
  </div>

  <div style="padding:22px 28px;">

    <!-- Greeting -->
    <p style="margin:0 0 18px;font-size:14px;color:#374151;line-height:1.5;">
      Hi {first_name} 👋 — here's today's snapshot. Please submit your update using the button below.
    </p>

    <!-- Ticket snapshot card -->
    <div style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px;">

      <!-- Card header -->
      <div style="background:#f8fafc;padding:10px 14px;border-bottom:1px solid #e2e8f0;">
        <span style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;">Work Tickets</span>
      </div>

      <!-- Card body -->
      <div style="padding:14px 14px 6px;">
        {ticket_rows}
      </div>
    </div>

    <!-- Coaching tips card -->
    <div style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:24px;">
      <div style="background:#f8fafc;padding:10px 14px;border-bottom:1px solid #e2e8f0;">
        <span style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;">Today's Tips</span>
      </div>
      <div style="padding:14px 14px 6px;">
        {tip_lines}
      </div>
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin-bottom:8px;">
      <a href="{checkin_url}"
         style="display:inline-block;background:#16a34a;color:#fff;font-weight:800;
                font-size:16px;padding:15px 48px;border-radius:12px;text-decoration:none;">
        Submit Your Update →
      </a>
    </div>
    <p style="text-align:center;font-size:11px;color:#94a3b8;margin-top:10px;margin-bottom:0;">
      Opens on your phone · Bookmark the page to check in any time
    </p>

  </div>

  <div style="background:#f8fafc;padding:12px 28px;border-top:1px solid #e2e8f0;text-align:center;">
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
            logger.info(f"Checkin prompt sent → {lead_email} for opp {opp_id} ({opp_name})")
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
async def my_project_lookup(db: Database = Depends(get_db)):
    """
    Return construction projects: active = Opp status Won + any ticket In Production.
    Completed = Won + all tickets Complete, within last 90 days.
    Results are cached for 10 minutes.
    """
    global _my_projects_cache, _my_projects_cache_ts
    from app.api.construction_plan import _fetch_opp_actuals

    try:
        # ── Cache check ──────────────────────────────────────────────────────────
        if _my_projects_cache is not None:
            age = _time.time() - _my_projects_cache_ts
            if age < _MY_PROJECTS_TTL:
                logger.info(f"my-project: cache hit (age={age:.0f}s)")
                return _my_projects_cache

        SELECT = "WorkTicketID,WorkTicketStatusName,OpportunityID,OpportunityNumber,ScheduledStartDate,CompleteDate,HoursEst,HoursAct"

        # Fetch all tickets scheduled within the last 12 months + future.
        # Aspire OData doesn't reliably support status-name filters, so we
        # fetch a broad window and filter by status in Python.
        date_cutoff = (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")
        all_tickets: list[dict] = []
        for skip in range(0, 3000, 500):
            try:
                res = await _aspire._get("WorkTickets", {
                    "$select":  SELECT,
                    "$filter":  f"ScheduledStartDate ge {date_cutoff}",
                    "$orderby": "WorkTicketID desc",
                    "$top":     "500",
                    "$skip":    str(skip),
                })
                batch = _aspire._extract_list(res)
                if not batch:
                    break
                all_tickets.extend(batch)
                logger.info(f"my-project: fetched {len(batch)} tickets (total {len(all_tickets)})")
                if len(batch) < 500:
                    break
            except Exception as e:
                logger.warning(f"my-project: ticket page skip={skip} failed: {e}")
                break

        # Python-side status filter
        ACTIVE_STATUSES   = {"in production", "in queue", "scheduled", "open"}
        COMPLETE_STATUSES = {"complete", "completed"}
        cutoff_90 = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")

        def _keep(t: dict) -> bool:
            status = (t.get("WorkTicketStatusName") or "").strip().lower()
            if status in ACTIVE_STATUSES:
                return True
            if status in COMPLETE_STATUSES:
                done = (t.get("CompleteDate") or t.get("ScheduledStartDate") or "")[:10]
                return done >= cutoff_90
            return False

        tickets = [t for t in all_tickets if _keep(t)]
        logger.info(f"my-project: {len(tickets)} tickets after status filter")

        if not tickets:
            return {"projects": []}

        # ── Group by OpportunityID (use OpportunityNumber as key when available) ──
        opp_map: dict = {}
        for t in all_tickets:
            oid     = t.get("OpportunityID")
            opp_num = t.get("OpportunityNumber")
            if not oid:
                continue
            key = opp_num if opp_num is not None else float(oid)
            if key not in opp_map:
                opp_map[key] = {
                    "primary_oid":    oid,
                    "hrs_est":        0.0,
                    "hrs_act":        0.0,
                    "ticket_count":   0,
                    "latest_date":    "",
                    "active_tickets": 0,
                }
            e = opp_map[key]
            if oid > e["primary_oid"]:
                e["primary_oid"] = oid
            e["hrs_est"]      += float(t.get("HoursEst") or 0)
            e["hrs_act"]      += float(t.get("HoursAct") or 0)
            e["ticket_count"] += 1
            d = (t.get("ScheduledStartDate") or "")[:10]
            if d > e["latest_date"]:
                e["latest_date"] = d
            if (t.get("WorkTicketStatusName") or "").strip().lower() in ACTIVE_STATUSES:
                e["active_tickets"] += 1

        # ── Fetch opportunity details ─────────────────────────────────────────────
        primary_ids = [e["primary_oid"] for e in opp_map.values()]
        actuals     = await _fetch_opp_actuals(primary_ids)

        # ── Build project list — construction + Won only ──────────────────────────
        projects = []
        for e in opp_map.values():
            oid        = e["primary_oid"]
            opp        = actuals.get(oid, {})
            division   = (opp.get("DivisionName") or "").lower()
            opp_status = (opp.get("OpportunityStatusName") or "").lower()

            if "construction" not in division:
                continue
            if opp_status != "won":
                continue

            all_done = e["active_tickets"] == 0
            projects.append({
                "opp_id":       oid,
                "opp_number":   opp.get("OpportunityNumber"),
                "opp_name":     opp.get("OpportunityName") or f"Job #{oid}",
                "property":     opp.get("PropertyName") or "",
                "status":       "Complete" if all_done else "In Production",
                "all_done":     all_done,
                "hrs_est":      round(e["hrs_est"], 1),
                "hrs_act":      round(e["hrs_act"], 1),
                "ticket_count": e["ticket_count"],
                "latest_date":  e["latest_date"],
            })

        logger.info(f"my-project: returning {len(projects)} construction projects")
        projects.sort(key=lambda x: x["latest_date"], reverse=True)
        projects.sort(key=lambda x: x["all_done"])   # active first, completed last

        result = {"projects": projects}
        _my_projects_cache    = result
        _my_projects_cache_ts = _time.time()
        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"my-project unhandled error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to load projects: {e}") from e


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

    # Return any photos already stored for this check-in
    photo_rows = await db._q(
        "SELECT id, file_name, file_extension, file_size, uploaded_at "
        "FROM checkin_photos WHERE checkin_id = ? ORDER BY uploaded_at",
        [c["id"]],
    )
    photos = [dict(p) for p in photo_rows]

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
        "photos":            photos,
    }


@public_router.post("/{token}/respond")
async def submit_checkin_response(
    token:           str,
    approach_notes:  str              = Form(...),
    remaining_hours: Optional[float]  = Form(default=None),
    blockers:        Optional[str]    = Form(default=None),
    photos:          list[UploadFile] = File(default=[]),
    db:              Database         = Depends(get_db),
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

    if not approach_notes or not approach_notes.strip():
        raise HTTPException(status_code=422, detail="approach_notes is required")

    # Save response
    response_id = await db._x(
        """INSERT INTO project_checkin_responses
           (checkin_id, remaining_hours, approach_notes, blockers)
           VALUES (?,?,?,?)""",
        [c["id"], remaining_hours, approach_notes.strip(), blockers or None],
    )

    await db._x(
        "UPDATE project_checkins SET responded_at = datetime('now') WHERE id = ?", [c["id"]]
    )

    # Upload photos/videos to R2 and record in checkin_photos
    _PHOTO_MAX_BYTES = 30 * 1024 * 1024   # 30 MB per file
    photo_ids: list[int] = []
    if _r2._r2_available():
        for upload in (photos or []):
            if not upload:
                continue
            try:
                file_bytes = await upload.read()
                if not file_bytes or len(file_bytes) > _PHOTO_MAX_BYTES:
                    logger.warning(f"Skipping photo: empty or too large ({len(file_bytes) if file_bytes else 0} bytes)")
                    continue
                # Derive filename — mobile browsers sometimes send an empty filename
                ct_header = (upload.content_type or "").lower()
                if upload.filename:
                    filename = upload.filename
                    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
                else:
                    ext = ct_header.split("/")[-1].replace("jpeg", "jpg") if "/" in ct_header else "jpg"
                    filename = f"photo_{uuid.uuid4().hex[:8]}.{ext}"
                safe   = "".join(ch if ch.isalnum() or ch in (".", "-", "_") else "_" for ch in filename)
                r2_key = f"checkin-photos/{c['id']}/{uuid.uuid4().hex[:8]}_{safe}"
                ct     = _MIME_OVERRIDE.get(ext) or mimetypes.guess_type(filename)[0] or "application/octet-stream"
                def _up(key=r2_key, body=file_bytes, content_type=ct):
                    _r2._make_client().put_object(
                        Bucket=settings.R2_BUCKET_NAME,
                        Key=key, Body=body, ContentType=content_type,
                    )
                await asyncio.get_event_loop().run_in_executor(None, _up)
                photo_row_id = await db._x(
                    """INSERT INTO checkin_photos
                       (checkin_id, response_id, file_name, file_extension, r2_key, file_size)
                       VALUES (?,?,?,?,?,?)""",
                    [c["id"], response_id, filename, ext, r2_key, len(file_bytes)],
                )
                photo_ids.append(photo_row_id)
                logger.info(f"Checkin photo #{photo_row_id} saved: {filename} ({len(file_bytes)} bytes)")
            except Exception as photo_err:
                logger.error(f"Failed to save photo: {photo_err}", exc_info=True)

    # Notify the full construction team + the lead when a check-in is submitted
    today_str    = datetime.now().strftime("%B %d, %Y")
    cc_list      = [e.strip() for e in settings.CONSTRUCTION_CHECKIN_CC.split(",") if e.strip()]
    if not cc_list:
        cc_list  = [e.strip() for e in settings.ISSUES_DIGEST_MGMT_RECIPIENTS.split(",") if e.strip()]
    lead_email   = c.get("lead_email") or ""
    notify_emails = list({lead_email, *cc_list} - {""})  # deduplicate, drop blanks
    html = _render_mgmt_email(
        opp_name        = c["opportunity_name"] or "",
        property_name   = c["property_name"] or "",
        lead_name       = c["lead_name"] or "",
        response_notes  = approach_notes.strip(),
        remaining_hours = remaining_hours,
        blockers        = blockers,
        ai_tip          = c["ai_tip"] or "",
        today_str       = today_str,
    )
    try:
        graph = GraphClient()
        await graph.send_email(
            mailbox=settings.MS_AP_INBOX,
            to_addresses=notify_emails,
            subject=f"✅ Project Update: {c['lead_name']} — {c['property_name'] or c['opportunity_name']}",
            body_html=html,
        )
    except Exception as e:
        logger.warning(f"Management notification failed after checkin submit: {e}")

    return {"ok": True, "message": "Thanks — your update has been sent to the team.", "photo_ids": photo_ids}


@public_router.get("/photo/{photo_id}/file")
async def serve_checkin_photo(photo_id: int, db: Database = Depends(get_db)):
    """Stream a check-in photo from R2. Public endpoint — photo IDs are non-guessable UUIDs."""
    rows = await db._q(
        "SELECT r2_key, file_name, file_extension FROM checkin_photos WHERE id = ?",
        [photo_id],
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Photo not found")

    r2_key   = rows[0]["r2_key"]
    filename = rows[0]["file_name"]
    ext      = (rows[0]["file_extension"] or "").lower()
    ct       = _MIME_OVERRIDE.get(ext) or mimetypes.guess_type(filename)[0] or "application/octet-stream"

    file_bytes = await _r2.get_file_bytes(r2_key)
    if file_bytes is None:
        raise HTTPException(status_code=404, detail="File not found in storage")

    return StreamingResponse(
        iter([file_bytes]),
        media_type=ct,
        headers={
            "Content-Disposition": f'inline; filename="{filename.replace(chr(34), "")}"',
            "Content-Length":      str(len(file_bytes)),
        },
    )


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

        # Build a deep-link to Aspire web portal for this opportunity's attachments.
        # Aspire's web app URL format: {ASPIRE_WEB_URL}/#/opportunity/{opp_id}
        aspire_base = (settings.ASPIRE_WEB_URL or "https://cloud.youraspire.com/app").rstrip("/")
        aspire_opp_url = f"{aspire_base}/opportunities/details/{opp_id}"

        out = []
        for r in rows:
            att_id   = r.get("AttachmentID")
            ext      = (r.get("FileExtension") or "").lstrip(".").lower()
            name     = r.get("AttachmentName") or r.get("OriginalFileName") or "File"
            # ExternalContentID may be a direct URL (SharePoint/OneDrive linked file)
            ext_url  = r.get("ExternalContentID") or ""
            file_url = ext_url if ext_url.startswith("http") else ""
            out.append({
                "attachment_id":   att_id,
                "file_name":       name,
                "file_extension":  ext,
                "file_url":        file_url,          # direct URL if available
                "aspire_url":      aspire_opp_url,    # fallback: open opportunity in Aspire
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
    # Comments are embedded in the Notes HTML (Aspire has no separate comments endpoint).
    # We parse them from the "Issue Comment History" table in the Notes field —
    # the same approach used by the ActivitiesDashboard.
    import re as _re

    def _parse_comments_from_notes(notes_html: str) -> list[dict]:
        """Extract comment rows from the HTML Aspire embeds in Notes."""
        if not notes_html:
            return []
        # Try multiple heading patterns Aspire uses across activity types
        section = (
            _re.search(r'Issue Comment History</h3>(.*)',  notes_html, _re.IGNORECASE | _re.DOTALL) or
            _re.search(r'Comment History</h3>(.*)',        notes_html, _re.IGNORECASE | _re.DOTALL) or
            _re.search(r'Comments?</h\d>(.*)',             notes_html, _re.IGNORECASE | _re.DOTALL) or
            _re.search(r'Comment History</(?:div|p)>(.*)',notes_html, _re.IGNORECASE | _re.DOTALL)
        )
        if not section:
            return []
        comments = []
        rows = _re.findall(r'<tr>(.*?)</tr>', section.group(1), _re.DOTALL)
        for row in rows:
            cells = _re.findall(r'<td[^>]*>(.*?)</td>', row, _re.DOTALL)
            if len(cells) < 2:
                continue
            meta    = _re.sub(r'<[^>]+>', ' ', cells[0]).strip()
            comment = _re.sub(r'<[^>]+>', '', cells[1]).strip()
            # Skip header rows
            if not comment or comment == 'Comment' or meta in ('Created Date/By', ''):
                continue
            # meta format: "MM/DD/YY Author Name" — split date from name
            date_str = ""
            author   = meta
            dm = _re.match(r'^(\d{1,2}/\d{1,2}/\d{2,4})\s*(.*)', meta)
            if dm:
                try:
                    from datetime import datetime as _dt
                    date_str = _dt.strptime(dm.group(1), "%m/%d/%y").strftime("%Y-%m-%d")
                except Exception:
                    date_str = dm.group(1)
                author = dm.group(2).strip()
            comments.append({
                "Comment":           comment,
                "CreatedDate":       date_str,
                "CreatedByUserName": author,
            })
        return comments

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

    # Aspire strips the Notes field when filtering by OpportunityID — re-fetch
    # individual records for any activity that came back with empty Notes so we
    # can parse the embedded comment history HTML.
    async def _refetch_notes(activity_id: int) -> str:
        try:
            r = await _aspire._get("Activities", {
                "$filter": f"ActivityID eq {activity_id}",
                "$select": "ActivityID,Notes",
                "$top":    "1",
            })
            rows = _aspire._extract_list(r)
            return rows[0].get("Notes") or "" if rows else ""
        except Exception as e:
            logger.debug(f"Re-fetch Notes for activity {activity_id} failed: {e}")
            return ""

    # Only re-fetch activities with empty Notes (avoids extra calls for normal activities)
    missing = [a for a in activities if not (a.get("Notes") or "").strip()]
    if missing:
        refetched = await asyncio.gather(*[_refetch_notes(a["ActivityID"]) for a in missing])
        for a, notes in zip(missing, refetched):
            a["Notes"] = notes

    # Parse comments from each activity's Notes HTML
    for a in activities:
        a["_comments"] = _parse_comments_from_notes(a.get("Notes") or "")

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

    # Fetch photos for all history checkins and attach them
    photo_map: dict[int, list] = {}
    try:
        checkin_ids = [r["id"] for r in history_rows if r.get("id")]
        if checkin_ids:
            placeholders = ",".join("?" * len(checkin_ids))
            photo_rows = await db._q(
                f"SELECT id, checkin_id, file_name, file_extension, file_size, uploaded_at "
                f"FROM checkin_photos WHERE checkin_id IN ({placeholders}) ORDER BY uploaded_at",
                checkin_ids,
            )
            for p in photo_rows:
                cid = p["checkin_id"]
                photo_map.setdefault(cid, []).append({
                    "id":            p["id"],
                    "file_name":     p["file_name"],
                    "file_extension": p["file_extension"],
                    "file_size":     p["file_size"],
                    "uploaded_at":   p["uploaded_at"],
                    "url":           f"/checkin/photo/{p['id']}/file",
                })
    except Exception as pe:
        logger.warning(f"Could not fetch checkin photos: {pe}")

    # Field Advisor Q&A log for this project (most recent first)
    try:
        advisor_rows = await db._q(
            """SELECT id, question, answer, has_photo, photo_r2_key, asked_at
               FROM field_advisor_log
               WHERE opp_id = ?
               ORDER BY asked_at DESC
               LIMIT 50""",
            [opp_id],
        )
    except Exception:
        advisor_rows = []  # table may not exist yet on older deployments

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
        "history": [{**dict(r), "photos": photo_map.get(r["id"], [])} for r in history_rows],
        "advisor_log": [dict(r) for r in advisor_rows],
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


@public_router.get("/project/{opp_id}/activity-probe")
async def activity_probe(opp_id: int):
    """Dev endpoint: returns raw Notes HTML for each activity so we can see Aspire's comment format."""
    try:
        res = await _aspire._get("Activities", {
            "$filter":  f"OpportunityID eq {opp_id}",
            "$orderby": "CreatedDate desc",
            "$top":     "10",
        })
        activities = _aspire._extract_list(res)
        return {
            "count": len(activities),
            "available_fields": sorted(activities[0].keys()) if activities else [],
            "activities": [
                {
                    "ActivityID":   a.get("ActivityID"),
                    "Subject":      a.get("Subject"),
                    "ActivityType": a.get("ActivityType"),
                    "Notes_raw":    a.get("Notes") or "",
                    "Notes_length": len(a.get("Notes") or ""),
                    # All string fields longer than 20 chars to spot comment containers
                    "long_strings": {k: v for k, v in a.items() if isinstance(v, str) and len(v) > 20},
                }
                for a in activities[:5]
            ],
        }
    except Exception as e:
        raise HTTPException(500, str(e))


@public_router.get("/debug/job-search")
async def debug_job_search(name: str = "", opp_number: int = None):
    """
    Dev endpoint: search Aspire for opportunities matching a name or number, then fetch
    their work tickets (no date filter) and show exactly why each ticket
    passes or fails the my-project filters.
    """
    from app.api.construction_plan import _fetch_opp_actuals

    # 1. Find matching opportunities
    try:
        if opp_number:
            # Direct lookup by OpportunityNumber (the human-readable job number)
            opp_res = await _aspire._get("Opportunities", {
                "$filter": f"OpportunityNumber eq {opp_number}",
                "$select": "OpportunityID,OpportunityName,PropertyName,DivisionName,OpportunityStatusName,OpportunityNumber",
                "$top":    "10",
            })
            opps = _aspire._extract_list(opp_res)
        else:
            # Name search — fetch most-recent 2000 and filter in Python
            opp_res = await _aspire._get("Opportunities", {
                "$select":  "OpportunityID,OpportunityName,PropertyName,DivisionName,OpportunityStatusName,OpportunityNumber",
                "$orderby": "OpportunityID desc",
                "$top":     "2000",
            })
            all_opps = _aspire._extract_list(opp_res)
            query    = name.lower()
            opps     = [o for o in all_opps if query in (o.get("OpportunityName") or "").lower()
                                            or query in (o.get("PropertyName")    or "").lower()]
    except Exception as e:
        raise HTTPException(500, f"Opportunity search failed: {e}")

    if not opps:
        return {"message": f"No opportunities found matching '{name}'", "opportunities": []}

    results = []
    for opp in opps:
        oid      = opp.get("OpportunityID")
        division = opp.get("DivisionName") or ""
        div_pass = "construction" in division.lower()

        # 2. Fetch ALL tickets for this opp (no date filter)
        try:
            tk_res  = await _aspire._get("WorkTickets", {
                "$filter":  f"OpportunityID eq {oid}",
                "$select":  "WorkTicketID,WorkTicketStatusName,ScheduledStartDate,CompleteDate,HoursEst,HoursAct",
                "$orderby": "WorkTicketID desc",
                "$top":     "50",
            })
            tickets = _aspire._extract_list(tk_res)
        except Exception as e:
            tickets = []

        EXCLUDED   = {"cancelled", "canceled", "void", "voided"}
        COMPLETE   = {"complete", "completed"}
        date_api   = (datetime.now() - timedelta(days=548)).strftime("%Y-%m-%d")   # 18-month API cutoff
        date_comp  = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")   # completed retention

        ticket_debug = []
        for t in tickets:
            status  = (t.get("WorkTicketStatusName") or "").strip().lower()
            sched   = (t.get("ScheduledStartDate")   or "")[:10]
            done    = (t.get("CompleteDate") or sched or "")[:10]

            reasons = []
            if not sched:
                reasons.append("NO ScheduledStartDate → excluded by API date filter")
            elif sched < date_api:
                reasons.append(f"ScheduledStartDate {sched} < 18-month cutoff {date_api} → excluded by API filter")
            if status in EXCLUDED:
                reasons.append(f"Status '{status}' is in excluded set")
            if status in COMPLETE and done < date_comp:
                reasons.append(f"Complete but done={done} older than 180-day cutoff {date_comp}")

            ticket_debug.append({
                "WorkTicketID":           t.get("WorkTicketID"),
                "status":                 status,
                "ScheduledStartDate":     sched,
                "CompleteDate":           (t.get("CompleteDate") or "")[:10],
                "would_pass_all_filters": len(reasons) == 0 and div_pass,
                "filter_failures":        reasons,
            })

        results.append({
            "OpportunityID":     oid,
            "OpportunityName":   opp.get("OpportunityName"),
            "PropertyName":      opp.get("PropertyName"),
            "DivisionName":      division,
            "division_passes":   div_pass,
            "OpportunityStatus": opp.get("OpportunityStatusName"),
            "ticket_count":      len(tickets),
            "tickets":           ticket_debug,
        })

    # 3. Simulate what my_project_lookup does — fetch page 0 of tickets with the
    #    real date+order filter and check if the expected ticket IDs are present.
    expected_ticket_ids = {t["WorkTicketID"] for r in results for t in r["tickets"]}
    date_cutoff_sim = (datetime.now() - timedelta(days=548)).strftime("%Y-%m-%d")
    try:
        sim_res = await _aspire._get("WorkTickets", {
            "$select":  "WorkTicketID,WorkTicketStatusName,OpportunityID,OpportunityNumber,ScheduledStartDate",
            "$filter":  f"ScheduledStartDate ge {date_cutoff_sim}",
            "$orderby": "WorkTicketID desc",
            "$top":     "500",
            "$skip":    "0",
        })
        sim_tickets = _aspire._extract_list(sim_res)
        sim_ids     = {t.get("WorkTicketID") for t in sim_tickets}
        found_in_page0  = expected_ticket_ids & sim_ids
        missing_in_page0 = expected_ticket_ids - sim_ids
    except Exception as e:
        sim_ids = set(); found_in_page0 = set(); missing_in_page0 = set()
        sim_res = {"error": str(e)}

    # 3b. Also run _fetch_opp_actuals to see what the batch lookup returns
    found_ids = [o["OpportunityID"] for o in opps]
    try:
        actuals = await _fetch_opp_actuals(found_ids)
        actuals_debug = {
            oid: {
                "OpportunityName": d.get("OpportunityName"),
                "DivisionName":    d.get("DivisionName"),
                "OpportunityStatus": d.get("OpportunityStatusName"),
                "found_in_actuals": True,
            }
            for oid, d in actuals.items()
        }
        missing_from_actuals = [oid for oid in found_ids if oid not in actuals]
    except Exception as e:
        actuals_debug       = {"error": str(e)}
        missing_from_actuals = []

    return {
        "query":                name or f"opp_number={opp_number}",
        "opportunities":        results,
        "page0_simulation": {
            "date_cutoff":       date_cutoff_sim,
            "tickets_returned":  len(sim_ids),
            "found_in_page0":    list(found_in_page0),
            "missing_in_page0":  list(missing_in_page0),
        },
        "actuals_lookup":       actuals_debug,
        "missing_from_actuals": missing_from_actuals,
    }


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

    # 2. Fetch Receipts AND WorkTicketItems in parallel
    import asyncio as _aio

    async def _fetch_receipts_all() -> list[dict]:
        out: list[dict] = []
        for i in range(0, len(ticket_ids), 8):
            chunk = ticket_ids[i : i + 8]
            or_filter = " or ".join(f"WorkTicketID eq {tid}" for tid in chunk)
            try:
                res = await _aspire._get("Receipts", {
                    "$filter":  f"({or_filter})",
                    "$top":     "200",
                    "$orderby": "ReceiptID desc",
                })
                out.extend(_aspire._extract_list(res))
            except Exception as e:
                logger.warning(f"Receipts fetch chunk {chunk} failed: {e}")
        return out

    async def _fetch_wt_items_all() -> list[dict]:
        """WorkTicketItems — material/sub/other line items from the estimate."""
        out: list[dict] = []
        PURCHASABLE = {"material", "sub", "other"}
        for i in range(0, len(ticket_ids), 8):
            chunk = ticket_ids[i : i + 8]
            or_filter = " or ".join(f"WorkTicketID eq {tid}" for tid in chunk)
            try:
                res = await _aspire._get("WorkTicketItems", {
                    "$filter": f"({or_filter})",
                    "$top":    "500",
                })
                for item in _aspire._extract_list(res):
                    if (item.get("ItemType") or "").lower() in PURCHASABLE:
                        qty  = float(item.get("ItemQuantityExtended") or 0)
                        unit = float(item.get("ItemCost") or 0)
                        out.append({
                            "work_ticket_id": item.get("WorkTicketID"),
                            "item_name":      item.get("ItemName") or "",
                            "item_type":      item.get("ItemType") or "",
                            "quantity":       qty,
                            "uom":            item.get("AllocationUnitTypeName") or "",
                            "unit_cost":      unit,
                            "total_cost_est": round(qty * unit, 2),
                            "do_not_purchase": item.get("DoNotPurchase") or False,
                        })
            except Exception as e:
                logger.warning(f"WorkTicketItems fetch chunk {chunk} failed: {e}")
        return out

    all_receipts, all_wt_items = await _aio.gather(
        _fetch_receipts_all(),
        _fetch_wt_items_all(),
    )

    # Group WorkTicketItems by ticket ID
    items_by_ticket: dict[int, list[dict]] = {}
    for it in all_wt_items:
        tid = it.get("work_ticket_id")
        if tid:
            items_by_ticket.setdefault(tid, []).append(it)

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
        {**v, "items": items_by_ticket.get(k, [])}
        for k, v in ticket_map.items() if k not in tickets_with_po
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

    # ── Restructured response: all tickets with items + their POs ────────────
    # Each ticket carries its items and any POs so the frontend can show
    # "No PO" or the PO status alongside every material line.
    tickets_combined = []
    for wt_id, ticket_info in ticket_map.items():
        ticket_pos = [p for p in pos if p.get("work_ticket_id") == wt_id]
        ticket_items = items_by_ticket.get(wt_id, [])
        tickets_combined.append({
            "WorkTicketID":     ticket_info["WorkTicketID"],
            "WorkTicketNumber": ticket_info["WorkTicketNumber"],
            "ServiceName":      ticket_info["ServiceName"],
            "has_po":           wt_id in tickets_with_po,
            "pos":              ticket_pos,
            "items":            ticket_items,
        })

    return {
        "pos":                pos,                   # legacy — kept for any existing consumers
        "tickets_without_po": tickets_without_po,    # legacy
        "tickets":            tickets_combined,      # new: all tickets with items + PO status
    }


@public_router.get("/attachment/{attachment_id}")
async def proxy_attachment(attachment_id: int):
    """
    Aspire files are stored internally and not downloadable via OData.
    Look up the attachment's OpportunityID and redirect to Aspire web portal.
    """
    from fastapi.responses import RedirectResponse

    aspire_base = (settings.ASPIRE_WEB_URL or "https://cloud.youraspire.com/app").rstrip("/")

    # Fetch attachment record to get OpportunityID for a better deep-link
    try:
        res = await _aspire._get("Attachments", {
            "$filter": f"AttachmentID eq {attachment_id}",
            "$top":    "1",
        })
        rows = _aspire._extract_list(res)
        if rows:
            record = rows[0]
            # Direct external URL (SharePoint/OneDrive) — use it straight
            ext_url = record.get("ExternalContentID") or ""
            if ext_url.startswith("http"):
                return RedirectResponse(url=ext_url)
            # Deep-link to the opportunity's page in Aspire
            opp_id = record.get("OpportunityID")
            if opp_id:
                return RedirectResponse(url=f"{aspire_base}/opportunities/details/{opp_id}")
    except Exception as e:
        logger.warning(f"Attachment {attachment_id} lookup failed: {e}")

    # Fallback: Aspire homepage
    return RedirectResponse(url=aspire_base)


# ── Job Attachment endpoints ──────────────────────────────────────────────────

_ATT_TYPES = [
    "Design Plan", "Site Plan", "Property Info", "Irrigation Map",
    "Photo", "Contract", "Permit", "Other",
]

_MIME_OVERRIDE = {
    "pdf":  "application/pdf",
    "png":  "image/png",
    "jpg":  "image/jpeg",
    "jpeg": "image/jpeg",
    "gif":  "image/gif",
    "webp": "image/webp",
    "heic": "image/heic",
    "doc":  "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls":  "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "dwg":  "application/acad",
}


@public_router.get("/project/{opp_id}/job-attachments")
async def list_job_attachments(opp_id: int, db: Database = Depends(get_db)):
    """List all active attachments we store for this opportunity."""
    rows = await db._q(
        "SELECT id, opp_id, work_ticket_id, attachment_type, file_name, "
        "file_extension, file_size, note, uploaded_by, uploaded_at "
        "FROM job_attachments WHERE opp_id = ? AND is_active = 1 "
        "ORDER BY attachment_type, uploaded_at DESC",
        [opp_id],
    )
    return [dict(r) for r in rows]


@public_router.post("/project/{opp_id}/job-attachments")
async def upload_job_attachment(
    opp_id:          int,
    file:            UploadFile      = File(...),
    attachment_type: str             = Form("General"),
    note:            str             = Form(""),
    uploaded_by:     str             = Form(""),
    work_ticket_id:  Optional[int]   = Form(None),
    db:              Database        = Depends(get_db),
):
    """Upload a file to R2 and register it for this opportunity."""
    MAX_BYTES = 30 * 1024 * 1024  # 30 MB
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(400, "Empty file")
    if len(file_bytes) > MAX_BYTES:
        raise HTTPException(413, "File too large — 30 MB maximum")

    if not _r2._r2_available():
        raise HTTPException(503, "File storage not configured (R2 credentials missing)")

    filename  = file.filename or "attachment"
    ext       = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    safe_name = "".join(c if c.isalnum() or c in (".", "-", "_") else "_" for c in filename)
    r2_key    = f"job-attachments/{opp_id}/{uuid.uuid4().hex[:8]}_{safe_name}"
    ct        = _MIME_OVERRIDE.get(ext) or mimetypes.guess_type(filename)[0] or "application/octet-stream"

    def _upload():
        client = _r2._make_client()
        client.put_object(
            Bucket=settings.R2_BUCKET_NAME,
            Key=r2_key,
            Body=file_bytes,
            ContentType=ct,
        )

    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, _upload)
    except Exception as exc:
        logger.error(f"R2 upload failed for opp {opp_id} file {filename}: {exc}", exc_info=True)
        raise HTTPException(502, f"File storage error: {exc}") from exc

    try:
        att_id = await db._x(
            "INSERT INTO job_attachments "
            "(opp_id, work_ticket_id, attachment_type, file_name, file_extension, r2_key, file_size, note, uploaded_by) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            [opp_id, work_ticket_id, attachment_type or "General",
             filename, ext, r2_key, len(file_bytes),
             (note or "").strip() or None,
             (uploaded_by or "").strip() or None],
        )
    except Exception as exc:
        logger.error(f"DB insert failed for job attachment opp {opp_id}: {exc}", exc_info=True)
        raise HTTPException(500, f"Database error: {exc}") from exc

    logger.info(f"Job attachment #{att_id} uploaded for opp {opp_id}: {filename} ({len(file_bytes)} bytes)")
    return {"id": att_id, "file_name": filename, "r2_key": r2_key}


@public_router.get("/job-attachment/{att_id}/file")
async def serve_job_attachment(att_id: int, db: Database = Depends(get_db)):
    """Stream a stored attachment from R2."""
    rows = await db._q(
        "SELECT r2_key, file_name, file_extension FROM job_attachments WHERE id = ? AND is_active = 1",
        [att_id],
    )
    if not rows:
        raise HTTPException(404, "Attachment not found")

    r2_key    = rows[0]["r2_key"]
    filename  = rows[0]["file_name"]
    ext       = (rows[0]["file_extension"] or "").lower()
    ct        = _MIME_OVERRIDE.get(ext) or mimetypes.guess_type(filename)[0] or "application/octet-stream"

    file_bytes = await _r2.get_file_bytes(r2_key)
    if file_bytes is None:
        raise HTTPException(404, "File not found in storage")

    return StreamingResponse(
        iter([file_bytes]),
        media_type=ct,
        headers={
            "Content-Disposition": f'inline; filename="{filename.replace(chr(34), "")}"',
            "Content-Length":      str(len(file_bytes)),
        },
    )


@public_router.delete("/job-attachment/{att_id}")
async def delete_job_attachment(att_id: int, db: Database = Depends(get_db)):
    """Soft-delete an attachment (sets is_active = 0)."""
    await db._q(
        "UPDATE job_attachments SET is_active = 0 WHERE id = ?", [att_id]
    )
    return {"ok": True}


@public_router.post("/project/{opp_id}/respond")
async def submit_project_response(
    opp_id:          int,
    approach_notes:  str              = Form(...),
    remaining_hours: Optional[float]  = Form(default=None),
    blockers:        Optional[str]    = Form(default=None),
    photos:          list[UploadFile] = File(default=[]),
    db:              Database         = Depends(get_db),
):
    """Submit a check-in response from the permanent project page (no token)."""
    try:
        return await _do_submit_project_response(
            opp_id=opp_id,
            approach_notes=approach_notes,
            remaining_hours=remaining_hours,
            blockers=blockers,
            photos=photos,
            db=db,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"submit_project_response unhandled error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


async def _do_submit_project_response(
    opp_id:          int,
    approach_notes:  str,
    remaining_hours: Optional[float],
    blockers:        Optional[str],
    photos:          list[UploadFile],
    db:              Database,
):
    if not approach_notes or not approach_notes.strip():
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
        lead_email = rows[0]["lead_email"] or ""
        ai_tip     = rows[0]["ai_tip"] or ""
    else:
        # No email sent today — create a stub record so history is preserved
        from app.api.construction_plan import _fetch_opp_actuals
        actuals   = await _fetch_opp_actuals([opp_id])
        opp       = actuals.get(opp_id, {})
        opp_name  = opp.get("OpportunityName") or f"Job #{opp_id}"
        prop_name = opp.get("PropertyName") or ""
        tickets   = await _fetch_project_tickets(opp_id, month)

        # Lead name + email from tickets / lead directory
        lead_name = next(
            ((t.get("CrewLeaderName") or "").strip() for t in tickets if t.get("CrewLeaderName")),
            "Lead",
        )
        lead_rows  = await db._q("SELECT email FROM construction_leads WHERE lower(aspire_name) = ?", [lead_name.lower()])
        lead_email = lead_rows[0]["email"] if lead_rows else ""
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
    response_id = await db._x(
        """INSERT INTO project_checkin_responses
           (checkin_id, remaining_hours, approach_notes, blockers)
           VALUES (?,?,?,?)""",
        [checkin_id, remaining_hours, approach_notes.strip(), blockers or None],
    )

    await db._x(
        "UPDATE project_checkins SET responded_at = datetime('now') WHERE id = ?", [checkin_id]
    )

    # Upload photos/videos to R2
    _PHOTO_MAX_BYTES = 30 * 1024 * 1024
    _saved_photo_ids: list[int] = []
    if _r2._r2_available():
        for upload in (photos or []):
            if not upload:
                continue
            try:
                file_bytes = await upload.read()
                if not file_bytes or len(file_bytes) > _PHOTO_MAX_BYTES:
                    logger.warning(f"Skipping photo: empty or too large ({len(file_bytes) if file_bytes else 0} bytes)")
                    continue
                # Derive filename — mobile browsers sometimes send an empty filename
                ct_header = (upload.content_type or "").lower()
                if upload.filename:
                    filename = upload.filename
                    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
                else:
                    ext = ct_header.split("/")[-1].replace("jpeg", "jpg") if "/" in ct_header else "jpg"
                    filename = f"photo_{uuid.uuid4().hex[:8]}.{ext}"
                safe   = "".join(ch if ch.isalnum() or ch in (".", "-", "_") else "_" for ch in filename)
                r2_key = f"checkin-photos/{checkin_id}/{uuid.uuid4().hex[:8]}_{safe}"
                ct     = _MIME_OVERRIDE.get(ext) or mimetypes.guess_type(filename)[0] or "application/octet-stream"
                def _up(key=r2_key, body=file_bytes, content_type=ct):
                    _r2._make_client().put_object(
                        Bucket=settings.R2_BUCKET_NAME,
                        Key=key, Body=body, ContentType=content_type,
                    )
                await asyncio.get_event_loop().run_in_executor(None, _up)
                photo_row_id = await db._x(
                    """INSERT INTO checkin_photos
                       (checkin_id, response_id, file_name, file_extension, r2_key, file_size)
                       VALUES (?,?,?,?,?,?)""",
                    [checkin_id, response_id, filename, ext, r2_key, len(file_bytes)],
                )
                _saved_photo_ids.append(photo_row_id)
                logger.info(f"Checkin photo #{photo_row_id} saved: {filename} ({len(file_bytes)} bytes)")
            except Exception as photo_err:
                logger.error(f"Failed to save photo: {photo_err}", exc_info=True)
    elif photos:
        logger.warning("R2 not configured — skipping photo upload for project response")

    # Notify the full construction team + the lead when a check-in is submitted
    today_str    = datetime.now().strftime("%B %d, %Y")
    cc_list      = [e.strip() for e in settings.CONSTRUCTION_CHECKIN_CC.split(",") if e.strip()]
    if not cc_list:
        cc_list  = [e.strip() for e in settings.ISSUES_DIGEST_MGMT_RECIPIENTS.split(",") if e.strip()]
    notify_emails = list({lead_email, *cc_list} - {""})  # deduplicate, drop blanks
    html = _render_mgmt_email(
        opp_name=opp_name, property_name=prop_name, lead_name=lead_name,
        response_notes=approach_notes.strip(),
        remaining_hours=remaining_hours,
        blockers=blockers,
        ai_tip=ai_tip,
        today_str=today_str,
    )
    try:
        graph = GraphClient()
        await graph.send_email(
            mailbox=settings.MS_AP_INBOX,
            to_addresses=notify_emails,
            subject=f"✅ Project Update: {lead_name} — {prop_name or opp_name}",
            body_html=html,
        )
    except Exception as e:
        logger.warning(f"Management notification failed: {e}")

    return {
        "ok": True,
        "message": "Thanks — your update has been sent to the team.",
        "photos_saved": len(_saved_photo_ids),
    }


@public_router.get("/project/{opp_id}/employees")
async def get_project_employees(opp_id: int):
    """Return active employee list for the Change Order assignee dropdown."""
    try:
        employees = await _aspire.get_aspire_employees()
    except Exception as e:
        logger.warning(f"Employee list fetch failed: {e}")
        employees = []
    return {
        "employees": [
            {
                "id":         e["ContactID"],   # ContactID — what Aspire AssignedTo expects
                "name":       e["FullName"],
                "username":   e.get("UserName") or "",
            }
            for e in employees
            if e.get("ContactID") and e.get("FullName")
        ]
    }


_CO_MAX_FILES = 10
_CO_MAX_PHOTO = 15 * 1024 * 1024   # 15 MB
_CO_MAX_VIDEO = 200 * 1024 * 1024  # 200 MB


@public_router.post("/project/{opp_id}/change-order")
async def create_change_order(
    opp_id:            int,
    submitter_name:    str              = Form(...),
    scope:             str              = Form(...),
    assigned_to_id:    Optional[int]    = Form(default=None),
    assigned_username: str              = Form(default=""),  # login/username for AssignedTo
    files:             list[UploadFile] = File(default=[]),
    db:                Database         = Depends(get_db),
):
    """
    Create a Change Order Request as an Aspire Issue linked to this opportunity.
    Photos/videos are uploaded to R2 and embedded as links in the Issue notes.
    """
    from app.api.construction_plan import _fetch_opp_actuals

    if len(files) > _CO_MAX_FILES:
        raise HTTPException(status_code=400, detail=f"Maximum {_CO_MAX_FILES} files allowed")

    # ── Fetch opportunity details ─────────────────────────────────────────────
    actuals      = await _fetch_opp_actuals([opp_id])
    opp          = actuals.get(opp_id, {})
    opp_name     = opp.get("OpportunityName") or f"Job #{opp_id}"
    property_name = opp.get("PropertyName") or ""

    # ── Read uploaded files ───────────────────────────────────────────────────
    file_data: list[tuple[str, bytes]] = []
    for i, f in enumerate(files):
        raw      = await f.read()
        is_video = (f.filename or "").lower().rsplit(".", 1)[-1] in {"mp4", "mov", "avi", "mkv", "webm"}
        max_size = _CO_MAX_VIDEO if is_video else _CO_MAX_PHOTO
        if len(raw) > max_size:
            label = "200 MB per video" if is_video else "15 MB per photo"
            raise HTTPException(status_code=413, detail=f"File {i + 1} too large (max {label})")
        file_data.append((f.filename or f"file_{i + 1}", raw))

    # ── Upload to R2 + store in job_attachments for clean URLs ───────────────
    api_base   = (settings.APP_BASE_URL or "https://ap-automation-production.up.railway.app").rstrip("/")
    file_links: list[tuple[str, str]] = []   # (display_name, url)

    for fname, raw in file_data:
        ext = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
        try:
            result = await _r2.upload_field_photo(
                file_bytes=raw,
                filename=fname,
                submitter=submitter_name,
                entity_type="change_order",
                entity_id=f"opp{opp_id}",
            )
            if result:
                r2_key, _ = result
                # Store in job_attachments so we can serve via a clean URL
                await db._x(
                    """INSERT INTO job_attachments
                       (opp_id, attachment_type, file_name, file_extension, r2_key,
                        file_size, note, uploaded_by)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    [opp_id, "Change Order", fname, ext, r2_key,
                     len(raw), "Change Order Request attachment", submitter_name],
                )
                rows = await db._q(
                    "SELECT id FROM job_attachments WHERE r2_key = ? LIMIT 1", [r2_key]
                )
                if rows and api_base:
                    att_id = rows[0]["id"]
                    url    = f"{api_base}/checkin/job-attachment/{att_id}/file"
                    file_links.append((fname, url))
                else:
                    file_links.append((fname, ""))
        except Exception as e:
            logger.warning(f"CO: R2 upload failed for {fname}: {e}")
            file_links.append((fname, ""))

    # ── Build Issue notes (HTML — photos embed inline, videos as links) ──────
    VIDEO_EXTS = {"mp4", "mov", "avi", "mkv", "webm"}
    parts = [f"<p>{scope.strip()}</p>"]
    for orig_name, url in file_links:
        ext = orig_name.rsplit(".", 1)[-1].lower() if "." in orig_name else ""
        if not url:
            parts.append(f"<p>{orig_name}</p>")
        elif ext in VIDEO_EXTS:
            parts.append(f'<p><a href="{url}">{orig_name}</a></p>')
        else:
            # Embed photo inline so it displays directly in Aspire
            parts.append(f'<p><img src="{url}" alt="{orig_name}" style="max-width:600px;"/></p>')
    notes_text = "".join(parts)

    # ── POST Issue to Aspire ──────────────────────────────────────────────────
    # Aspire AssignedTo expects a comma-delimited list of ContactIDs (integers as strings).
    # assigned_to_id is the ContactID from the employee dropdown.
    today_dt     = _date.today()
    due_date_str = f"{today_dt.isoformat()}T00:00:00Z"

    subject = f"Change Order Request — {property_name or opp_name}"
    # Aspire only allows ONE of OpportunityID / PropertyID / WorkTicketID per request.
    # Category is NOT settable via the API (confirmed: no category field in POST /Issues spec).
    # Priority accepts string values; "High" is the documented field name.
    issue_body: dict = {
        "Subject":      subject,
        "Notes":        notes_text,
        "Priority":     "High",
        "OpportunityID": opp_id,
        "DueDate":      due_date_str,
        "PublicComment": False,
        "IncludeClient": False,
    }
    # AssignedTo must be a comma-delimited list of ContactIDs (integers as strings).
    # Omit entirely when no assignee selected (Aspire accepts missing field).
    if assigned_to_id:
        issue_body["AssignedTo"] = str(assigned_to_id)

    logger.info(f"CO issue body: {issue_body}")
    try:
        result = await _aspire.create_issue(issue_body)
        logger.info(f"CO issue Aspire response: {result}")
    except Exception as e:
        logger.error(f"CO issue creation failed: {e}")
        raise HTTPException(status_code=502, detail=f"Failed to create change order in Aspire: {e}")

    # Parse IssueID from response
    if isinstance(result, (int, float)):
        issue_id = int(result)
    else:
        raw_id = result.get("IssueID") or result.get("Id") or result.get("id")
        try:
            issue_id = int(raw_id) if raw_id is not None else None
        except (ValueError, TypeError):
            issue_id = None

    logger.info(f"CO issue created: IssueID={issue_id} for opp {opp_id}")

    return {
        "ok":       True,
        "issue_id": issue_id,
        "message":  "Change Order Request created in Aspire.",
    }


# ── Field Advisor — AI Q&A for jobsite problems ───────────────────────────────

@public_router.post("/project/{opp_id}/field-advisor")
async def field_advisor(
    opp_id:   int,
    question: str                  = Form(...),
    photo:    Optional[UploadFile] = File(default=None),
    db:       Database             = Depends(get_db),
):
    """
    AI field advisor for crew leads.
    Accepts a text question + optional site photo; returns practical field advice.
    Logs every Q&A to field_advisor_log so management can see what crews flag.
    Every error path raises HTTPException so CORS headers are always present.
    """
    import base64 as _b64

    try:
        if not settings.ANTHROPIC_API_KEY:
            raise HTTPException(503, "AI advisor not configured")

        SYSTEM = (
            "You are an experienced landscape construction advisor helping crew leads solve real "
            "jobsite problems. Your expertise covers: slope stabilization and erosion control, "
            "grading and drainage, retaining walls and hardscape, irrigation troubleshooting, "
            "plant installation and soil prep, concrete and paving, crew coordination, and "
            "BC Landscape & Nursery Association best practices.\n\n"
            "Give practical, field-ready advice a crew lead can act on today. "
            "Use short bullet points or numbered steps where helpful. "
            "If a photo is provided, describe what you observe before giving advice. "
            "Keep responses focused and under 300 words unless the problem requires more detail.\n\n"
            "IMPORTANT: Never ask clarifying questions. Always give your best practical answer "
            "based on the information provided. If details are vague, state your assumptions "
            "briefly and proceed with actionable advice."
        )

        # ── Build message content ───────────────────────────────────────────
        content:   list[dict] = []
        photo_raw: bytes | None = None
        photo_ext: str = ""
        photo_mime: str = "image/jpeg"

        logger.info(
            f"Field advisor request — opp={opp_id} "
            f"photo_field={'present' if photo else 'absent'} "
            f"filename={getattr(photo, 'filename', None)!r} "
            f"content_type={getattr(photo, 'content_type', None)!r}"
        )

        if photo:
            raw = await photo.read()
            size_kb = len(raw) // 1024 if raw else 0
            logger.info(f"Field advisor: photo read — {size_kb} KB")
            # Claude vision limit: 20 MB base64-encoded; keep raw under 8 MB
            if raw and len(raw) <= 8 * 1024 * 1024:
                photo_raw = raw
                # Derive format from filename first, fall back to content_type
                fname = (photo.filename or "").strip()
                photo_ext = (fname.rsplit(".", 1)[-1] if "." in fname else "").lower()
                if not photo_ext:
                    # e.g. content_type = "image/jpeg" → "jpeg"
                    ct = (photo.content_type or "image/jpeg").lower()
                    photo_ext = ct.split("/")[-1] if "/" in ct else "jpeg"
                photo_mime = {
                    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                    "webp": "image/webp", "heic": "image/jpeg", "gif": "image/gif",
                }.get(photo_ext, "image/jpeg")
                content.append({
                    "type": "image",
                    "source": {
                        "type":       "base64",
                        "media_type": photo_mime,
                        "data":       _b64.b64encode(raw).decode("ascii"),
                    },
                })
                logger.info(f"Field advisor: image block added to Claude request ({size_kb} KB, {photo_mime})")
            elif raw:
                logger.warning(f"Field advisor: photo too large ({size_kb} KB > 8192 KB), skipping")
            else:
                logger.warning("Field advisor: photo.read() returned empty bytes — file may not have been uploaded")
        else:
            logger.info("Field advisor: no photo field in request")

        content.append({
            "type": "text",
            "text": question.strip() or "What do you observe and what should I know?",
        })

        logger.info(f"Field advisor: content blocks → {[b['type'] for b in content]}")

        # ── Call Claude ─────────────────────────────────────────────────────
        client   = _anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        response = await client.messages.create(
            model="claude-opus-4-5",
            max_tokens=1024,
            system=SYSTEM,
            messages=[{"role": "user", "content": content}],
        )
        answer = response.content[0].text if response.content else "No response generated."
        logger.info(f"Field advisor: answered for opp {opp_id} ({len(answer)} chars)")

        # ── Save photo to R2 (best-effort) ──────────────────────────────────
        photo_r2_key: str | None = None
        if photo_raw and _r2._r2_available():
            try:
                safe_ext  = photo_ext or "jpg"
                r2_key    = f"advisor-photos/{opp_id}/{uuid.uuid4().hex[:8]}.{safe_ext}"
                ct        = photo_mime
                def _up(key=r2_key, body=photo_raw, content_type=ct):
                    _r2._make_client().put_object(
                        Bucket=settings.R2_BUCKET_NAME,
                        Key=key, Body=body, ContentType=content_type,
                    )
                await asyncio.get_event_loop().run_in_executor(None, _up)
                photo_r2_key = r2_key
                logger.info(f"Field advisor: photo saved to R2 → {r2_key}")
            except Exception as r2_err:
                logger.warning(f"Field advisor: R2 photo save failed (non-fatal): {r2_err}")

        # NOTE: We do NOT auto-save to the DB here.
        # The frontend asks the crew lead "Save to project file?" and calls
        # /field-advisor/save only if they confirm.
        return {
            "answer":         answer,
            "photo_r2_key":   photo_r2_key,
            "has_photo":      1 if photo_raw else 0,
            # Let the frontend know if the photo was actually sent to Claude
            # (helps diagnose "photo not recognised" issues without checking logs)
            "photo_received": photo_raw is not None,
        }

    except HTTPException:
        raise  # propagate our own HTTP errors unchanged
    except Exception as e:
        logger.error(f"Field advisor unhandled error for opp {opp_id}: {e}", exc_info=True)
        raise HTTPException(500, f"Advisor error: {e}") from e


@public_router.post("/project/{opp_id}/field-advisor/save")
async def field_advisor_save(
    opp_id:       int,
    question:     str            = Form(...),
    answer:       str            = Form(...),
    has_photo:    int            = Form(default=0),
    photo_r2_key: Optional[str] = Form(default=None),
    db:           Database       = Depends(get_db),
):
    """
    Persist a Field Advisor Q&A to the project file.
    Called only when the crew lead explicitly confirms they want it saved.
    """
    try:
        log_id = await db._x(
            """INSERT INTO field_advisor_log
               (opp_id, question, answer, has_photo, photo_r2_key)
               VALUES (?,?,?,?,?)""",
            [opp_id, question.strip(), answer.strip(), has_photo, photo_r2_key or None],
        )
        logger.info(f"Field advisor: crew lead saved Q&A #{log_id} for opp {opp_id}")
        return {"saved": True, "log_id": log_id}
    except Exception as e:
        logger.error(f"Field advisor save failed for opp {opp_id}: {e}", exc_info=True)
        raise HTTPException(500, f"Save failed: {e}") from e


# ── Scheduler: fires at 06:00 Pacific daily ───────────────────────────────────

_scheduler_task: asyncio.Task | None = None


async def _scheduler_loop():
    """Fire project check-ins every day at 06:00 in the configured timezone.

    Polls every 5 minutes so restarts near 6 AM don't cause a 24-hour miss.
    """
    tz = ZoneInfo(settings.CONSTRUCTION_REPORT_TIMEZONE or "America/Vancouver")
    _last_run_date: str = ""
    FIRE_HOUR   = 6
    WINDOW_MINS = 30

    while True:
        await asyncio.sleep(5 * 60)
        now       = datetime.now(tz)
        today_str = now.strftime("%Y-%m-%d")
        in_window = (now.hour == FIRE_HOUR and now.minute < WINDOW_MINS)
        if not in_window or _last_run_date == today_str:
            continue
        _last_run_date = today_str
        logger.info(f"Check-in scheduler: firing for {today_str} at {now.strftime('%H:%M %Z')}")
        month = now.strftime("%Y-%m")
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
