"""
Client Experience (comms) engine — Phase C of the Construction Plan overhaul.

Templated client emails for the Sales→Construction journey, sent manually with a
preview from the pipeline. Templates are editable in-app (D1); each email is sent
"as" the right person (Graph send-from their mailbox). Merge fields are pre-filled
from Aspire + the schedule board (the window), and every send is logged.

GET  /construction/cx/settings                 — staff roles, survey/review links, phone
PUT  /construction/cx/settings
GET  /construction/cx/templates                — the editable templates
PUT  /construction/cx/templates/{id}
GET  /construction/cx/project/{opp_id}         — merge context + per-template sent status
POST /construction/cx/project/{opp_id}/render  — merged preview (subject/body/to/from)
POST /construction/cx/project/{opp_id}/send    — send via Graph + log
"""
import html as _html
import json
import logging
import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.services.aspire import AspireClient
from app.services.d1_settings import get_setting, set_setting

router = APIRouter(prefix="/construction/cx", tags=["client-experience"])
logger = logging.getLogger(__name__)

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)
_DB = Database()
_CFG_KEY = "CX_SETTINGS"


async def _db() -> Database:
    if _DB._db is None:
        await _DB.connect()
    return _DB


def _row(r) -> dict:
    return dict(r) if r else {}


# ── Settings (staff roles + links) ────────────────────────────────────────────

def _cfg_defaults() -> dict:
    return {
        # Per-role sender identity + signature details
        "scheduler_name": "Keeland Kannan", "scheduler_email": "keeland@darios.ca",
        "scheduler_title": "Construction Project Scheduler", "scheduler_phone": "", "scheduler_mobile": "",
        "supervisor_name": "Dustin Nikkel",  "supervisor_email": "dustin@darios.ca",
        "supervisor_title": "Construction Supervisor", "supervisor_phone": "", "supervisor_mobile": "",
        "designer_name": "Jenna Hindley",     "designer_email": "jenna@darios.ca",
        "designer_title": "Design", "designer_phone": "", "designer_mobile": "",
        "sales_name": "",                     "sales_email": "",
        "sales_title": "", "sales_phone": "", "sales_mobile": "",
        "company_phone": "",
        # Company-wide signature card
        "company_name": "Dario's Landscape Services Ltd.",
        "company_website": "http://darioslandscapeservices.ca/",
        "company_logo_url": "https://darios-ap.pages.dev/darios-logo.png",
        "brand_color": "#2f6b3f",
        "email_disclaimer": (
            "This email is intended for the addressee(s) only. It is privileged and may also be confidential.\n"
            "Any review, retransmission or other use of this information by persons other than the addressee is prohibited.\n"
            "If you are not the addressee and/or received this in error, please contact the sender and delete the material from all computers."
        ),
        "survey_link": "https://docs.google.com/forms/d/e/1FAIpQLScrQMdZ6Z7wQgTAO1B6vmuc3zRxTMJVl0wuPtormDSGfUroDQ/viewform",
        "review_link": "",
    }


async def get_cx_settings() -> dict:
    merged = _cfg_defaults()
    try:
        raw = await get_setting(_CFG_KEY)
        if raw:
            stored = json.loads(raw)
            if isinstance(stored, dict):
                merged.update({k: v for k, v in stored.items() if k in merged})
    except Exception as e:
        logger.warning(f"cx settings load failed — defaults: {e}")
    return merged


@router.get("/settings")
async def read_settings():
    return await get_cx_settings()


class SettingsBody(BaseModel):
    scheduler_name: Optional[str] = None; scheduler_email: Optional[str] = None
    scheduler_title: Optional[str] = None; scheduler_phone: Optional[str] = None; scheduler_mobile: Optional[str] = None
    supervisor_name: Optional[str] = None; supervisor_email: Optional[str] = None
    supervisor_title: Optional[str] = None; supervisor_phone: Optional[str] = None; supervisor_mobile: Optional[str] = None
    designer_name: Optional[str] = None; designer_email: Optional[str] = None
    designer_title: Optional[str] = None; designer_phone: Optional[str] = None; designer_mobile: Optional[str] = None
    sales_name: Optional[str] = None; sales_email: Optional[str] = None
    sales_title: Optional[str] = None; sales_phone: Optional[str] = None; sales_mobile: Optional[str] = None
    company_phone: Optional[str] = None
    company_name: Optional[str] = None; company_website: Optional[str] = None
    company_logo_url: Optional[str] = None; brand_color: Optional[str] = None; email_disclaimer: Optional[str] = None
    survey_link: Optional[str] = None; review_link: Optional[str] = None


@router.put("/settings")
async def save_settings(body: SettingsBody):
    cfg = await get_cx_settings()
    for k in _cfg_defaults():
        v = getattr(body, k, None)
        if v is not None:
            cfg[k] = v
    await set_setting(_CFG_KEY, json.dumps({k: cfg[k] for k in _cfg_defaults()}))
    return cfg


# ── Templates ─────────────────────────────────────────────────────────────────

# Seeded from the Sales→Construction email templates. Body is plain text with
# {{tokens}} (auto-filled) and [bracketed] bits the sender fills in the preview.
_SEED = [
    {"key": "handoff", "stage_order": 1, "from_role": "sales", "optional": 0,
     "subject": "Welcome to Dario's — your landscape construction project",
     "body": "Hello {{client_name}}!\n\nThank you for choosing Dario's for your landscape construction project! We're excited to get started and bring your vision to life.\n\nI'd like to introduce you to {{scheduler}}, our Construction Project Scheduler, and {{supervisor}}, our Construction Supervisor. {{scheduler}} coordinates your schedule, and {{supervisor}} oversees the project and ensures it meets our standards.\n\nWhat happens next:\n- Within 3 working days: {{scheduler}} will be in touch with your approximate start date.\n- Within 2 weeks of your start date: we'll reconnect to confirm the date and any final details.\n- If your project is more than 2 weeks away: {{scheduler}} checks in every 2 weeks with an update.\n- Before or on Day 1: {{supervisor}} meets with the project lead to review the scope.\n\nOur goal is simple — you should always know where your project stands and what happens next. If you have any questions along the way, please reach out!"},
    {"key": "scheduling_intro", "stage_order": 2, "from_role": "scheduler", "optional": 0,
     "subject": "Scheduling your Dario's project",
     "body": "Hello {{client_name}}!\n\nI'm your point of contact for scheduling and I'll keep you updated on when we expect to start your project.\n\nIf you have any timing constraints or important dates we haven't discussed, please let me know so we can do our best to accommodate them.\n\nRight now we have your project tentatively scheduled for the {{window}}, and expect it will take about {{duration}} to complete.\n\nWhat to expect from here:\n- Once we're within a two-week window of your start date, I'll reach out to confirm timing and give you a specific start date.\n- Timelines can shift due to weather, materials, or changes to other projects. We'll always let you know if your timing changes.\n\nWe're looking forward to getting your project underway!"},
    {"key": "design_intro", "stage_order": 3, "from_role": "designer", "optional": 1,
     "subject": "Getting your design started",
     "body": "Hello {{client_name}}!\n\nI'll be looking after the design portion of your project. [Briefly: what's included — consultation, sketch, site visit, and by when.]\n\nA couple of things that help us get started:\n- Any measurements or a rough (even napkin) sketch of what you have in mind.\n- Any must-haves or inspiration photos.\n\nI'll be in touch to set up the next step. Looking forward to working with you!"},
    {"key": "start_confirm", "stage_order": 4, "from_role": "scheduler", "optional": 0,
     "subject": "Confirming your start date",
     "body": "Hello {{client_name}}!\n\nWe're confirming the start of your project on {{start_date}} and expect it to take about {{duration}}.\n\nBefore we get started, please make sure [access instructions — gates unlocked / vehicles moved / pets secured / irrigation access / any neighbour considerations].\n\nAs a reminder, {{supervisor}}, our Construction Supervisor, will meet with your team lead to hand over the project on site. Your Team Lead is [name], responsible for safely running the work on site and end-of-day cleanup.\n\nWho to contact:\n- {{supervisor}} ({{supervisor_email}}) — your point of contact for scheduling, scope, or changes.\n- Your on-site Team Lead — day-to-day contact while the crew is on site.\n\nIf anything comes up during the project outside the agreed scope, your Team Lead will bring it to {{supervisor}}, and we'll discuss any scope or cost changes with you and get your approval before starting additional work.\n\nWe're looking forward to getting started!"},
    {"key": "periodic_update", "stage_order": 5, "from_role": "scheduler", "optional": 1,
     "subject": "Update on your Dario's project",
     "body": "Hello {{client_name}}!\n\nA quick update on your project: we currently have it scheduled for the {{window}}. [Anything changed, or confirm it's on track.]\n\nI'll continue to keep you posted and will reach out to confirm the exact start date once we're within two weeks of it. Thanks for your patience!"},
    {"key": "exit", "stage_order": 6, "from_role": "supervisor", "optional": 0,
     "subject": "{{project_name}} is complete — thank you!",
     "body": "Hello {{client_name}}!\n\nWe're all wrapped up at your place — thank you for having our crew, it was a great project to work on!\n\nHere's what's left on our end:\n- Plant list: within the next week we'll send a list of everything that was planted, with simple care notes.\n- Follow-up visit: I'll swing by within two weeks to check everything over, look over the plants (anything not settling in we'll replace this season, or in spring if we're out of season), and turn your watering schedule down to normal.\n\nWe'd really value your feedback. If you have a couple of minutes, please fill out this short survey: {{survey_link}}\n\nAnd if you were happy with the work, a Google review means a lot to our team: {{review_link}}\n\nIf anything comes up before my visit, just reply here or give me a call at {{company_phone}}.\n\nThanks again!"},
]


async def _ensure_templates(db: Database) -> None:
    try:
        existing = await db._q("SELECT COUNT(*) AS n FROM cx_templates", [])
        if existing and (existing[0].get("n") or 0) > 0:
            return
        for t in _SEED:
            await db._x(
                """INSERT INTO cx_templates (key, title, stage_order, subject, body, from_role, cc, optional, active)
                   VALUES (?, ?, ?, ?, ?, ?, '', ?, 1)""",
                [t["key"], t["key"].replace("_", " ").title(), t["stage_order"], t["subject"], t["body"], t["from_role"], t["optional"]],
            )
        logger.info("cx: seeded %d templates", len(_SEED))
    except Exception as e:
        logger.warning(f"cx template seed skipped: {e}")


@router.get("/templates")
async def list_templates():
    db = await _db()
    await _ensure_templates(db)
    rows = await db._q("SELECT * FROM cx_templates ORDER BY stage_order, id", [])
    return {"templates": [_row(r) for r in rows]}


class TemplateBody(BaseModel):
    title: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    from_role: Optional[str] = None
    cc: Optional[str] = None
    active: Optional[bool] = None


@router.put("/templates/{tid}")
async def update_template(tid: int, body: TemplateBody):
    sets, params = ["updated_at = datetime('now')"], []
    for col in ("title", "subject", "body", "from_role", "cc"):
        v = getattr(body, col)
        if v is not None:
            sets.append(f"{col} = ?"); params.append(v)
    if body.active is not None:
        sets.append("active = ?"); params.append(1 if body.active else 0)
    params.append(tid)
    db = await _db()
    await db._x(f"UPDATE cx_templates SET {', '.join(sets)} WHERE id = ?", params)
    return {"ok": True, "id": tid}


# ── Merge context (Aspire + board) ────────────────────────────────────────────

def _fmt_date(iso: str) -> str:
    try:
        return datetime.strptime((iso or "")[:10], "%Y-%m-%d").strftime("%B %-d, %Y")
    except Exception:
        try:
            return datetime.strptime((iso or "")[:10], "%Y-%m-%d").strftime("%B %d, %Y").replace(" 0", " ")
        except Exception:
            return iso or ""


def _monday(iso: str) -> str:
    from datetime import timedelta
    try:
        d = datetime.strptime(iso[:10], "%Y-%m-%d").date()
        return (d - timedelta(days=d.weekday())).isoformat()
    except Exception:
        return iso


async def _resolve_context(db: Database, opp_id: int) -> dict:
    cfg = await get_cx_settings()
    ctx = {
        "client_name": "", "client_email": "", "project_name": "", "property_name": "",
        "pm": "", "window": "", "start_date": "", "duration": "",
        "scheduler": cfg["scheduler_name"], "supervisor": cfg["supervisor_name"],
        "designer": cfg["designer_name"], "sales": cfg["sales_name"],
        "scheduler_email": cfg["scheduler_email"], "supervisor_email": cfg["supervisor_email"],
        "designer_email": cfg["designer_email"],
        "survey_link": cfg["survey_link"], "review_link": cfg["review_link"],
        "company_phone": cfg["company_phone"],
    }
    # Opportunity + property + primary contact (client name/email)
    prop = {}
    try:
        rows = _aspire._extract_list(await _aspire._get("Opportunities", {"$filter": f"OpportunityID eq {opp_id}", "$top": "1"}))
        if rows:
            o = rows[0]
            ctx["project_name"] = o.get("OpportunityName") or ""
            ctx["property_name"] = o.get("PropertyName") or ""
            ctx["pm"] = o.get("OperationsManagerContactName") or ""
            ctx["client_name"] = o.get("BillingCompanyName") or o.get("CompanyName") or ""
            pid = o.get("PropertyID")
            if pid:
                prows = _aspire._extract_list(await _aspire._get("Properties", {"$filter": f"PropertyID eq {pid}", "$top": "1"}))
                if prows:
                    prop = prows[0]
    except Exception as e:
        logger.warning(f"cx context: opp {opp_id} fetch failed: {e}")
    primary = None
    for pc in (prop.get("PropertyContacts") or []):
        if pc.get("PrimaryContact"):
            primary = pc; break
    if not primary and (prop.get("PropertyContacts") or []):
        primary = prop["PropertyContacts"][0]
    if primary:
        cname = (primary.get("ContactName") or "").strip()
        if not ctx["client_name"]:
            ctx["client_name"] = cname
        cid = primary.get("ContactID")
        if cid:
            try:
                crows = _aspire._extract_list(await _aspire._get("Contacts", {"$filter": f"ContactID eq {cid}", "$select": "ContactID,Email", "$top": "1"}))
                if crows:
                    ctx["client_email"] = (crows[0].get("Email") or "").strip()
            except Exception:
                pass
    # Schedule window from the board
    try:
        from app.api.schedule import _budget_days  # local import avoids any cycle
        sb = await db._q("SELECT start_date, status, hours, hours_per_day, employees, extra_days FROM schedule_blocks WHERE opportunity_id = ?", [opp_id])
        if sb:
            # confirmed beats tentative; earliest start
            best = None
            for r in sb:
                st = (r.get("status") or "tentative"); sd = (r.get("start_date") or "")[:10]
                if not best or (best["status"] != "confirmed" and st == "confirmed") or (best["status"] == st and sd < best["start"]):
                    best = {"status": st, "start": sd, "row": r}
            if best:
                r = best["row"]
                try:
                    emps = json.loads(r.get("employees") or "[]")
                except Exception:
                    emps = []
                days = _budget_days(r.get("hours"), len(emps), r.get("hours_per_day")) + int(r.get("extra_days") or 0)
                ctx["duration"] = f"{days} day{'s' if days != 1 else ''}"
                if best["status"] == "confirmed":
                    ctx["start_date"] = _fmt_date(best["start"])
                    ctx["window"] = f"week of {_fmt_date(_monday(best['start']))}"
                else:
                    ctx["window"] = f"week of {_fmt_date(_monday(best['start']))}"
                    ctx["start_date"] = _fmt_date(best["start"])
    except Exception as e:
        logger.info(f"cx context: schedule window skipped for {opp_id}: {e}")
    return ctx


def _render(text: str, ctx: dict) -> str:
    def repl(m):
        key = m.group(1).strip()
        val = ctx.get(key)
        return str(val) if val not in (None, "") else f"[{key}]"
    return re.sub(r"\{\{\s*([a-z_]+)\s*\}\}", repl, text or "")


def _from_identity(from_role: str, cfg: dict) -> tuple[str, str]:
    role = (from_role or "scheduler").lower()
    if role == "sales":
        return cfg.get("sales_email") or settings.ms_send_from, cfg.get("sales_name") or "Dario's Landscape Services"
    if role == "supervisor":
        return cfg.get("supervisor_email") or settings.ms_send_from, cfg.get("supervisor_name") or "Construction Supervisor"
    if role == "designer":
        return cfg.get("designer_email") or settings.ms_send_from, cfg.get("designer_name") or "Design"
    return cfg.get("scheduler_email") or settings.ms_send_from, cfg.get("scheduler_name") or "Construction Scheduler"


def _role_title(role: str) -> str:
    return {"sales": "Dario's Landscape Services Ltd.", "supervisor": "Construction Supervisor",
            "designer": "Design — Dario's Landscape Services", "scheduler": "Construction Project Scheduler"}.get((role or "").lower(), "Dario's Landscape Services Ltd.")


def _signature_html(role: str, cfg: dict, name: str = "", email: str = "") -> str:
    """Branded signature card (table-based, inline styles, hosted logo) rendered
    for the sending role — plus the confidentiality disclaimer."""
    e = _html.escape
    r = (role or "scheduler").lower()
    name = name or cfg.get(f"{r}_name") or ""
    email = email or cfg.get(f"{r}_email") or ""
    title = cfg.get(f"{r}_title") or _role_title(role)
    phone = cfg.get(f"{r}_phone") or cfg.get("company_phone") or ""
    mobile = cfg.get(f"{r}_mobile") or ""
    green = cfg.get("brand_color") or "#2f6b3f"
    company = cfg.get("company_name") or "Dario's Landscape Services Ltd."
    website = cfg.get("company_website") or ""
    logo = cfg.get("company_logo_url") or ""
    web_disp = re.sub(r"^https?://", "", website).rstrip("/") if website else ""

    phone_line = ""
    if phone:
        phone_line = f'<span style="color:#333">P:</span> {e(phone)}'
        if mobile:
            phone_line += f'&nbsp;&nbsp;<span style="font-size:11px;color:#333">M:</span> <span style="font-size:12px">{e(mobile)}</span>'
    we = []
    if website:
        we.append(f'<span style="color:#333">W:</span> <a href="{e(website)}" style="color:{green};text-decoration:underline">{e(web_disp)}</a>')
    if email:
        we.append(f'<span style="color:#333">E:</span> <a href="mailto:{e(email)}" style="color:{green};text-decoration:underline">{e(email)}</a>')
    we_line = "&nbsp;&nbsp;&nbsp;".join(we)

    logo_cell = f'<td valign="top" style="padding-right:14px"><img src="{e(logo)}" alt="{e(company)}" width="120" style="display:block;border:0;width:120px;height:auto"></td>' if logo else ""

    card = (
        '<table cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;font-family:Arial,Helvetica,sans-serif"><tr>'
        f'{logo_cell}'
        f'<td valign="top" style="border-left:3px solid {green};padding-left:14px;font-size:13px;color:#333;line-height:1.45">'
        f'<div style="font-weight:bold;font-size:16px;color:{green}">{e(name)}</div>'
        f'<div style="color:#666">{e(title)}</div>'
        f'<div style="font-weight:bold;color:#333">{e(company)}</div>'
        f'{("<div>" + phone_line + "</div>") if phone_line else ""}'
        f'{("<div>" + we_line + "</div>") if we_line else ""}'
        '</td></tr></table>'
    )
    disc = cfg.get("email_disclaimer") or ""
    disc_html = ""
    if disc.strip():
        lines = "<br>".join(e(l) for l in disc.split("\n") if l.strip())
        disc_html = f'<div style="margin-top:18px;font-size:11px;color:#999;line-height:1.5;font-family:Arial,Helvetica,sans-serif">{lines}</div>'
    return card + disc_html


def _body_to_html(body_text: str, role: str, cfg: dict, name: str = "", email: str = "") -> str:
    esc = _html.escape(body_text)
    esc = re.sub(r"(https?://[^\s<]+)", r'<a href="\1">\1</a>', esc)
    para = esc.replace("\n", "<br>")
    sig = _signature_html(role, cfg, name, email)
    return f'<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;font-size:14px;line-height:1.5;color:#111;max-width:640px">{para}{sig}</div>'


# ── Project view (context + per-template status) ───────────────────────────────

@router.get("/project/{opp_id}")
async def project_cx(opp_id: int):
    db = await _db()
    await _ensure_templates(db)
    ctx = await _resolve_context(db, opp_id)
    tmpl_rows = await db._q("SELECT * FROM cx_templates WHERE active = 1 ORDER BY stage_order, id", [])
    sends = await db._q("SELECT template_key, subject, to_addresses, from_name, sent_by, sent_at FROM cx_sends WHERE opportunity_id = ? ORDER BY id DESC", [opp_id])
    sent_by_key: dict = {}
    for s in sends:
        sent_by_key.setdefault(s["template_key"], []).append(_row(s))
    templates = []
    for t in tmpl_rows:
        d = _row(t)
        hist = sent_by_key.get(d["key"], [])
        templates.append({
            "id": d["id"], "key": d["key"], "title": d["title"], "subject": d["subject"],
            "from_role": d["from_role"], "optional": bool(d.get("optional")),
            "stage_order": d["stage_order"],
            "sent_count": len(hist), "last_sent_at": hist[0]["sent_at"] if hist else None,
        })
    return {"opportunity_id": opp_id, "context": ctx, "templates": templates,
            "sends": [_row(s) for s in sends]}


class SkipBody(BaseModel):
    opportunity_id: int
    action_key: str
    skipped_by: Optional[str] = None


@router.post("/skip")
async def skip_action(body: SkipBody):
    """Mark a next-action 'not necessary' for a job so it stops showing as due."""
    db = await _db()
    await db._x(
        "INSERT OR IGNORE INTO cx_action_skips (opportunity_id, action_key, skipped_by) VALUES (?, ?, ?)",
        [body.opportunity_id, body.action_key.strip(), (body.skipped_by or "").strip() or None],
    )
    return {"ok": True}


@router.delete("/skip/{opp_id}/{action_key}")
async def unskip_action(opp_id: int, action_key: str):
    db = await _db()
    await db._x("DELETE FROM cx_action_skips WHERE opportunity_id = ? AND action_key = ?", [opp_id, action_key])
    return {"ok": True}


@router.get("/skips")
async def list_skips():
    db = await _db()
    rows = await db._q("SELECT opportunity_id, action_key, skipped_by, skipped_at FROM cx_action_skips", [])
    return {"skips": [_row(r) for r in rows]}


class RenderBody(BaseModel):
    template_key: str
    overrides: Optional[dict] = None


@router.post("/project/{opp_id}/render")
async def render_email(opp_id: int, body: RenderBody):
    db = await _db()
    await _ensure_templates(db)
    rows = await db._q("SELECT * FROM cx_templates WHERE key = ?", [body.template_key])
    if not rows:
        raise HTTPException(404, "Template not found")
    t = _row(rows[0])
    cfg = await get_cx_settings()
    ctx = await _resolve_context(db, opp_id)
    if body.overrides:
        ctx.update({k: v for k, v in body.overrides.items() if isinstance(k, str)})
    from_email, from_name = _from_identity(t["from_role"], cfg)
    return {
        "template_key": t["key"],
        "subject": _render(t["subject"], ctx),
        "body": _render(t["body"], ctx),
        "to": ctx.get("client_email") or "",
        "cc": t.get("cc") or "",
        "from_email": from_email, "from_name": from_name, "from_role": t["from_role"],
    }


class SendBody(BaseModel):
    template_key: str
    subject: str
    body: str          # plain text (what the sender reviewed)
    to: str
    cc: Optional[str] = None
    from_email: str
    from_name: str
    from_role: Optional[str] = "scheduler"
    sent_by: Optional[str] = None


@router.post("/project/{opp_id}/send")
async def send_email(opp_id: int, body: SendBody):
    to_list = [e.strip() for e in (body.to or "").replace(";", ",").split(",") if e.strip()]
    if not to_list:
        raise HTTPException(400, "A recipient email is required")
    cfg = await get_cx_settings()
    html = _body_to_html(body.body, body.from_role or "scheduler", cfg, body.from_name, body.from_email)
    cc_list = [e.strip() for e in (body.cc or "").replace(";", ",").split(",") if e.strip()]
    try:
        from app.services.email_intake import GraphClient
        await GraphClient().send_email(
            mailbox=body.from_email, to_addresses=to_list, subject=body.subject,
            body_html=html, cc_addresses=cc_list or None,
        )
    except Exception as e:
        logger.error(f"cx send failed for opp {opp_id} ({body.template_key}): {e}")
        raise HTTPException(502, f"Email send failed: {e}")
    db = await _db()
    await db._x(
        """INSERT INTO cx_sends (opportunity_id, template_key, subject, to_addresses, cc, from_email, from_name, sent_by, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
        [opp_id, body.template_key, body.subject, ", ".join(to_list), ", ".join(cc_list) or None,
         body.from_email, body.from_name, (body.sent_by or "").strip() or None],
    )
    logger.info("cx sent %s for opp %s to %s as %s", body.template_key, opp_id, to_list, body.from_email)
    return {"ok": True, "template_key": body.template_key, "to": to_list}
