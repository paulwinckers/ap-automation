"""
Daily visit recaps — client email drafts for yesterday's Residential Maintenance visits.

Every day at RUN_HOUR (Vancouver time) the portal:
  1. finds the Residential Maintenance work tickets COMPLETED the day before (Aspire),
  2. skips visits with no crew photos,
  3. gathers the crew's visit notes and the property's primary contact email,
  4. asks Claude to pick up to 6 photos that show finished work and write a short client note,
  5. builds a "Completed work" collage and saves a DRAFT in the reviewer's Outlook (Vesna).

Nothing is ever sent. A visit with no client email in Aspire still gets a draft, with no
recipient and a warning line at the top, so the reviewer sees it in the same place. Every visit
handled is logged in `visit_recaps`, so re-running a day never makes duplicate drafts.

  GET  /admin/visit-recaps?days=7          the log
  POST /admin/visit-recaps/run?date=&dry_run=   run now for a day (dry_run: pick + write, no draft)
  GET/PUT /admin/visit-recaps/settings     enabled, reviewer mailbox, run hour
"""
import asyncio
import base64
import html
import io
import json
import logging
from datetime import datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

import anthropic
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.api.auth import _require_admin, get_db
from app.api.aspire_attachments import _aspire
from app.api.customer_dashboard import _fetch_property_contacts, _fetch_visit_notes_bulk
from app.api.mail_drafts import _collage, _graph_call
from app.core.config import settings
from app.core.database import Database
from app.services.d1_settings import get_setting, set_setting

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin/visit-recaps", tags=["visit-recaps"])

DIVISION = "Residential Maintenance"
MODEL = "claude-opus-5-5"
MAX_PHOTOS_TO_REVIEW = 12        # photos Claude looks at per visit
MAX_IN_COLLAGE = 6
_CFG_KEY = "visit_recaps"
_TZ = ZoneInfo(settings.CONSTRUCTION_REPORT_TIMEZONE or "America/Vancouver")


def _cfg_defaults() -> dict:
    return {"enabled": True, "reviewer_email": "vesna@darios.ca", "run_hour": 11}


async def get_cfg() -> dict:
    cfg = _cfg_defaults()
    try:
        raw = await get_setting(_CFG_KEY)
        if raw:
            cfg.update({k: v for k, v in json.loads(raw).items() if k in cfg})
    except Exception as e:
        logger.warning(f"visit recap settings load failed — defaults: {e}")
    return cfg


# ── Aspire lookups ────────────────────────────────────────────────────────────

async def _completed_tickets(day: str) -> list[dict]:
    """Residential Maintenance tickets completed on `day` (YYYY-MM-DD), with property + service."""
    nxt = (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    rows = _aspire._extract_list(await _aspire._get("WorkTickets", {
        "$filter": f"CompleteDate ge {day}T00:00:00Z and CompleteDate lt {nxt}T00:00:00Z",
        "$select": "WorkTicketID,WorkTicketNumber,OpportunityID,OpportunityServiceID,CompleteDate,"
                   "CrewLeaderName,WorkTicketStatusName,Notes",
        "$top": "1000",
    }))
    opp_ids = sorted({r["OpportunityID"] for r in rows if r.get("OpportunityID")})
    opps: dict[int, dict] = {}
    for i in range(0, len(opp_ids), 20):
        f = " or ".join(f"OpportunityID eq {o}" for o in opp_ids[i:i + 20])
        for o in _aspire._extract_list(await _aspire._get("Opportunities", {
                "$filter": f"({f})", "$select": "OpportunityID,OpportunityName,PropertyID,PropertyName,DivisionName",
                "$top": "1000"})):
            opps[o["OpportunityID"]] = o
    svc_ids = sorted({r["OpportunityServiceID"] for r in rows if r.get("OpportunityServiceID")})
    svc: dict[int, str] = {}
    for i in range(0, len(svc_ids), 20):
        f = " or ".join(f"OpportunityServiceID eq {s}" for s in svc_ids[i:i + 20])
        for s in _aspire._extract_list(await _aspire._get("OpportunityServices", {
                "$filter": f"({f})", "$select": "OpportunityServiceID,DisplayName", "$top": "1000"})):
            svc[s["OpportunityServiceID"]] = (s.get("DisplayName") or "").strip()
    out = []
    for r in rows:
        o = opps.get(r.get("OpportunityID")) or {}
        if (o.get("DivisionName") or "").strip().lower() != DIVISION.lower():
            continue
        out.append({**r, "property_id": o.get("PropertyID"), "property": o.get("PropertyName") or "",
                    "opportunity": o.get("OpportunityName") or "",
                    "service": svc.get(r.get("OpportunityServiceID"), "")})
    return out


async def _photos_for(ticket_id: int, day: str) -> list[dict]:
    """The ticket's crew photos, preferring ones uploaded on the visit day."""
    atts = await _aspire.get_work_ticket_attachments(ticket_id, images_only=True)
    same_day = [a for a in atts if (a.get("date_uploaded") or "")[:10] in
                (day, (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d"))]
    return (same_day or atts)[-MAX_PHOTOS_TO_REVIEW:]


async def _photo_raw(aid: int) -> Optional[bytes]:
    d = await _aspire.get_attachment_file_data(aid)
    if not d or not d.get("file_data"):
        return None
    try:
        return base64.b64decode(d["file_data"])
    except Exception:
        return None


def _preview_jpeg(raw: bytes, edge: int = 900) -> Optional[str]:
    """Small base64 JPEG for Claude to look at (keeps the request light)."""
    try:
        from PIL import Image, ImageOps
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
        img.thumbnail((edge, edge))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=80)
        return base64.standard_b64encode(buf.getvalue()).decode()
    except Exception:
        return None


# ── Claude: pick photos + write the note ──────────────────────────────────────

_SCHEMA = {
    "type": "object",
    "properties": {
        "photo_ids": {"type": "array", "items": {"type": "integer"},
                      "description": "Up to 6 photo ids that show finished work, best first"},
        "subject": {"type": "string"},
        "body_html": {"type": "string"},
        "notes_for_reviewer": {"type": "string",
                               "description": "Anything the reviewer should check before sending; empty if none"},
    },
    "required": ["photo_ids", "subject", "body_html", "notes_for_reviewer"],
    "additionalProperties": False,
}

_SYSTEM = """You prepare a short client update email for Dario's Landscape Services, a landscaping
company in Kelowna, BC. A Residential Maintenance crew visited the client's property yesterday.
An office reviewer will read your draft and send it, so write it ready to send.

Choose the photos:
- Pick up to 6 photos that show the FINISHED result: clean, tidy and showing the work well.
- Leave out in-progress shots, bare dirt, debris or leaf piles, tools, trucks and equipment,
  people or hands, and blurry, dark or near-duplicate photos.
- Prefer variety: different areas and angles. If no photo looks finished, return an empty list.

Write the email:
- Warm, plain and brief: 3-5 short sentences, then a sign-off. No hard sell.
- Greet the client by first name if one is given, otherwise "Hi there,".
- Say what the crew did, from the service name and the crew's visit notes. Translate crew
  shorthand into client-friendly language. Mention a concern or follow-up only if the notes
  raise one the client should know about (e.g. a dry area or a broken part). Never mention
  billing, hours or internal issues such as clock-ins or equipment trouble.
- Put the literal text [[PHOTOS]] on its own line where the collage should appear.
- Sign off with "The Dario's Landscape Services team".
- body_html uses only <p>, <br>, <ul>, <li> and <b>.
- subject: short, e.g. "Your property visit – Thursday, Nov 12".
- notes_for_reviewer: anything worth checking before sending (unclear notes, a concern you
  mentioned, a photo choice you weren't sure about). Empty if nothing."""


async def _ask_claude(visit: dict, contact_name: Optional[str], notes: list[str],
                      previews: list[tuple[int, str]]) -> dict:
    content: list[dict] = []
    for aid, b64 in previews:
        content.append({"type": "text", "text": f"Photo id {aid}:"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}})
    d = datetime.strptime(visit["day"], "%Y-%m-%d")
    visit_day = f"{d.strftime('%A, %b')} {d.day}"
    content.append({"type": "text", "text": (
        f"Property: {visit['property']}\n"
        f"Client first name: {contact_name or '(unknown)'}\n"
        f"Visit date: {visit_day}\n"
        f"Service: {visit['service'] or visit['opportunity']}\n"
        f"Crew lead: {visit.get('lead') or '(unknown)'}\n"
        f"Crew visit notes:\n" + ("\n".join(f"- {n}" for n in notes) if notes else "(none)")
    )})
    client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY, timeout=180, max_retries=1)
    resp = await client.messages.create(
        model=MODEL,
        max_tokens=4000,
        system=_SYSTEM,
        messages=[{"role": "user", "content": content}],
        extra_body={"output_config": {"effort": "medium",
                                      "format": {"type": "json_schema", "schema": _SCHEMA}}},
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("Claude declined this visit")
    text = next((b.text for b in resp.content if getattr(b, "type", "") == "text"), "")
    data = json.loads(text)
    allowed = {aid for aid, _ in previews}
    data["photo_ids"] = [p for p in dict.fromkeys(data.get("photo_ids") or []) if p in allowed][:MAX_IN_COLLAGE]
    return data


# ── One visit ─────────────────────────────────────────────────────────────────

async def _log(db: Database, t: dict, day: str, status: str, reason: str = "",
               contact_email: str = "", draft_id: str = "", photos: int = 0) -> None:
    await db._x(
        "INSERT OR REPLACE INTO visit_recaps (work_ticket_id, work_ticket_number, visit_date, property, "
        "service, crew_lead, contact_email, status, reason, draft_id, photos_used) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [t["WorkTicketID"], t.get("WorkTicketNumber"), day, t.get("property"), t.get("service"),
         t.get("CrewLeaderName"), contact_email or None, status, reason or None, draft_id or None, photos])


async def _do_visit(db: Database, t: dict, day: str, reviewer: str, dry_run: bool) -> dict:
    base = {"work_ticket": t.get("WorkTicketNumber"), "property": t.get("property"), "service": t.get("service")}
    photos = await _photos_for(t["WorkTicketID"], day)
    if not photos:
        if not dry_run:
            await _log(db, t, day, "skipped", "no photos")
        return {**base, "status": "skipped", "reason": "no photos"}

    notes_map = await _fetch_visit_notes_bulk([t["WorkTicketID"]], public_only=False)
    notes = [n["note"] for n in notes_map.get(t["WorkTicketID"], []) if n.get("note")]
    if (t.get("Notes") or "").strip():
        notes.insert(0, t["Notes"].strip())

    contacts = await _fetch_property_contacts([t["property_id"]]) if t.get("property_id") else []
    contact = next((c for c in contacts if c.get("primary") and c.get("email")), None) \
        or next((c for c in contacts if c.get("email")), None)
    email = (contact or {}).get("email") or ""
    first = ((contact or {}).get("name") or "").split(" ")[0] or None

    raws: dict[int, bytes] = {}
    previews: list[tuple[int, str]] = []
    for p in photos:
        raw = await _photo_raw(p["attachment_id"])
        b64 = _preview_jpeg(raw) if raw else None
        if b64:
            raws[p["attachment_id"]] = raw
            previews.append((p["attachment_id"], b64))
    if not previews:
        if not dry_run:
            await _log(db, t, day, "skipped", "photos unreadable")
        return {**base, "status": "skipped", "reason": "photos unreadable"}

    picked = await _ask_claude({**t, "day": day, "lead": t.get("CrewLeaderName")}, first, notes, previews)
    if not picked["photo_ids"]:
        if not dry_run:
            await _log(db, t, day, "skipped", "no finished-work photos", email)
        return {**base, "status": "skipped", "reason": "no finished-work photos", "contact_email": email}

    out = {**base, "contact_email": email or None, "photos": picked["photo_ids"],
           "subject": picked["subject"], "body_html": picked["body_html"],
           "notes_for_reviewer": picked.get("notes_for_reviewer") or ""}
    if dry_run:
        return {**out, "status": "dry_run"}

    collage = _collage([raws[a] for a in picked["photo_ids"]], "Completed work")
    body = picked["body_html"]
    flags = []
    if not email:
        flags.append("No client email in Aspire for this property — add the recipient before sending.")
    if picked.get("notes_for_reviewer"):
        flags.append(picked["notes_for_reviewer"])
    if flags:
        body = ("<p><b>⚠ For the reviewer (delete before sending):</b> "
                + html.escape(" ".join(flags)) + "</p><hr>") + body
    img = '<p><img src="cid:collage1" alt="Completed work" width="600" style="max-width:100%;height:auto"></p>'
    body = body.replace("[[PHOTOS]]", img, 1) if "[[PHOTOS]]" in body else body + img

    msg = await _graph_call("POST", f"users/{reviewer}/messages", {
        "subject": picked["subject"],
        "body": {"contentType": "HTML", "content": ""},
        "toRecipients": [{"emailAddress": {"address": email}}] if email else [],
    })
    await _graph_call("POST", f"users/{reviewer}/messages/{msg['id']}/attachments", {
        "@odata.type": "#microsoft.graph.fileAttachment", "name": "completed-work.jpg",
        "contentType": "image/jpeg", "contentBytes": base64.b64encode(collage).decode(),
        "isInline": True, "contentId": "collage1",
    })
    await _graph_call("PATCH", f"users/{reviewer}/messages/{msg['id']}",
                      {"body": {"contentType": "HTML", "content": body}})
    await _log(db, t, day, "drafted", "no client email" if not email else "", email, msg["id"],
               len(picked["photo_ids"]))
    return {**out, "status": "drafted", "draft_id": msg["id"], "web_link": msg.get("webLink")}


async def run_recaps(day: Optional[str] = None, dry_run: bool = False) -> dict:
    cfg = await get_cfg()
    day = day or (datetime.now(_TZ) - timedelta(days=1)).strftime("%Y-%m-%d")
    reviewer = (cfg.get("reviewer_email") or "").strip().lower()
    if not reviewer.endswith("@darios.ca"):
        raise HTTPException(status_code=400, detail="The reviewer must have a darios.ca mailbox.")
    db = await get_db()
    done = {r["work_ticket_id"] for r in await db._q(
        "SELECT work_ticket_id FROM visit_recaps WHERE visit_date = ? AND status IN ('drafted','skipped')", [day])}
    tickets = [t for t in await _completed_tickets(day) if dry_run or t["WorkTicketID"] not in done]
    results = []
    for t in tickets:
        try:
            results.append(await _do_visit(db, t, day, reviewer, dry_run))
        except Exception as e:
            logger.warning(f"visit recap failed for WT {t.get('WorkTicketNumber')}: {e}")
            if not dry_run:
                try:
                    await _log(db, t, day, "error", str(e)[:300])
                except Exception:
                    pass
            results.append({"work_ticket": t.get("WorkTicketNumber"), "property": t.get("property"),
                            "status": "error", "reason": str(e)[:300]})
    counts: dict[str, int] = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    logger.info(f"visit recaps for {day}: {counts}")
    return {"date": day, "reviewer": reviewer, "already_done": len(done) if not dry_run else 0,
            "counts": counts, "visits": results}


# ── Admin endpoints ───────────────────────────────────────────────────────────

@router.post("/run")
async def run_now(date: Optional[str] = None, dry_run: bool = False, _a: dict = Depends(_require_admin)):
    if date:
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    return await run_recaps(date, dry_run)


@router.get("")
async def recap_log(days: int = Query(7, ge=1, le=90), _a: dict = Depends(_require_admin),
                    db: Database = Depends(get_db)):
    since = (datetime.now(_TZ) - timedelta(days=days)).strftime("%Y-%m-%d")
    rows = await db._q("SELECT * FROM visit_recaps WHERE visit_date >= ? ORDER BY visit_date DESC, property",
                       [since])
    return {"since": since, "rows": rows, "settings": await get_cfg()}


class CfgIn(BaseModel):
    enabled: Optional[bool] = None
    reviewer_email: Optional[str] = None
    run_hour: Optional[int] = None


@router.get("/settings")
async def read_cfg(_a: dict = Depends(_require_admin)):
    return await get_cfg()


@router.put("/settings")
async def save_cfg(body: CfgIn, _a: dict = Depends(_require_admin)):
    cfg = await get_cfg()
    if body.enabled is not None:
        cfg["enabled"] = body.enabled
    if body.reviewer_email is not None:
        e = body.reviewer_email.strip().lower()
        if not e.endswith("@darios.ca"):
            raise HTTPException(status_code=400, detail="The reviewer must have a darios.ca mailbox.")
        cfg["reviewer_email"] = e
    if body.run_hour is not None:
        if not 0 <= body.run_hour <= 23:
            raise HTTPException(status_code=400, detail="run_hour must be 0–23")
        cfg["run_hour"] = body.run_hour
    await set_setting(_CFG_KEY, json.dumps(cfg))
    return cfg


# ── Scheduler ─────────────────────────────────────────────────────────────────

_task = None


async def _loop():
    """Polls every 5 minutes; fires once a day in the first half hour of run_hour. Re-runs are
    safe — visits already in the log are skipped."""
    last = ""
    while True:
        await asyncio.sleep(5 * 60)
        now = datetime.now(_TZ)
        today = now.strftime("%Y-%m-%d")
        try:
            cfg = await get_cfg()
        except Exception:
            cfg = _cfg_defaults()
        if not cfg.get("enabled") or last == today:
            continue
        if not (now.hour == int(cfg.get("run_hour", 11)) and now.minute < 30):
            continue
        last = today
        try:
            await run_recaps()
        except Exception as e:
            logger.error(f"visit recap run failed: {e}")


def start_visit_recap_scheduler():
    global _task
    _task = asyncio.ensure_future(_loop())
    logger.info("Visit recap scheduler started")


def stop_visit_recap_scheduler():
    global _task
    if _task:
        _task.cancel()
        _task = None
