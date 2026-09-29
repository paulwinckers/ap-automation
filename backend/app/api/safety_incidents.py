"""
Field Safety Incident Reports API

POST  /safety/incidents           — submit a new incident report (multipart) + email notify
GET   /safety/incidents           — list incidents (admin)
GET   /safety/incidents/{id}      — full detail incl. presigned photo URLs
PATCH /safety/incidents/{id}/status — set review status (open|reviewed|closed)
"""
import asyncio
import json
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.services import r2
from app.services.email_intake import GraphClient

router = APIRouter(prefix="/safety/incidents", tags=["safety-incidents"])
logger = logging.getLogger(__name__)

MAX_PHOTO_SIZE = 20 * 1024 * 1024  # 20 MB per photo
INCIDENT_TYPES = ("injury", "near_miss", "property_damage", "environmental", "other")
SEVERITIES     = ("minor", "moderate", "serious", "critical")
STATUSES       = ("open", "reviewed", "closed")


async def _get_db() -> Database:
    db = Database()
    await db.connect()
    return db


def _row(r) -> dict:
    return dict(r) if r else {}


def _incident_recipients() -> list[str]:
    raw = (getattr(settings, "SAFETY_INCIDENT_RECIPIENTS", "") or "").strip()
    if not raw:
        raw = settings.ISSUES_DIGEST_MGMT_RECIPIENTS or ""
    return [e.strip() for e in raw.split(",") if e.strip()]


def _portal_base() -> str:
    return (getattr(settings, "PORTAL_BASE_URL", "") or "https://darios-ap.pages.dev").rstrip("/")


# ── Submit ──────────────────────────────────────────────────────────────────────

@router.post("")
async def submit_incident(
    incident_date:    str           = Form(...),
    reporter_name:    str           = Form(...),
    description:      str           = Form(...),
    incident_time:    Optional[str] = Form(default=None),
    location:         Optional[str] = Form(default=None),
    incident_type:    str           = Form(default="other"),
    severity:         str           = Form(default="minor"),
    people_involved:  Optional[str] = Form(default=None),
    injury_description: Optional[str] = Form(default=None),
    immediate_action: Optional[str] = Form(default=None),
    witnesses:        Optional[str] = Form(default=None),
    photos:           list[UploadFile] = File(default=[]),
):
    """Submit a field safety incident report. Saves the record, stores any photos in R2,
    and emails the safety recipients. The email is best-effort — a send failure never
    blocks the report from being saved."""
    if not description.strip():
        raise HTTPException(400, "A description of what happened is required")
    itype = incident_type if incident_type in INCIDENT_TYPES else "other"
    sev   = severity if severity in SEVERITIES else "minor"

    # Upload photos to R2
    photo_keys: list[str] = []
    for photo in (photos or []):
        if not photo or not photo.filename:
            continue
        photo_bytes = await photo.read()
        if len(photo_bytes) > MAX_PHOTO_SIZE:
            raise HTTPException(413, "A photo is too large — maximum 20 MB each")
        if not photo_bytes:
            continue
        uid  = uuid.uuid4().hex[:8]
        safe = "".join(c if c.isalnum() or c in (".", "-", "_") else "_" for c in (photo.filename or "photo.jpg"))
        key  = f"incidents/{uid}_{safe}"
        ctype = photo.content_type or "image/jpeg"
        if r2._r2_available():
            def _upload(k=key, b=photo_bytes, ct=ctype):
                client = r2._make_client()
                client.put_object(Bucket=r2.settings.R2_BUCKET_NAME, Key=k, Body=b, ContentType=ct)
            await asyncio.get_event_loop().run_in_executor(None, _upload)
            photo_keys.append(key)
            logger.info("Incident photo uploaded: %s", key)

    db = await _get_db()
    try:
        rows = await db._q(
            """INSERT INTO safety_incidents
               (incident_date, incident_time, reporter_name, location, incident_type,
                severity, people_involved, injury_description, description,
                immediate_action, witnesses, photo_r2_keys)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING id""",
            [
                incident_date, (incident_time or "").strip() or None, reporter_name.strip(),
                (location or "").strip() or None, itype, sev,
                (people_involved or "").strip() or None,
                (injury_description or "").strip() or None,
                description.strip(),
                (immediate_action or "").strip() or None,
                (witnesses or "").strip() or None,
                json.dumps(photo_keys),
            ],
        )
        incident_id = rows[0]["id"]
    finally:
        await db.close()

    logger.info("Safety incident #%s submitted by %s (%s / %s)",
                incident_id, reporter_name, itype, sev)

    # Email notification — best effort
    try:
        recipients = _incident_recipients()
        if recipients:
            html = _render_incident_email(
                incident_id=incident_id, incident_date=incident_date, incident_time=incident_time,
                reporter_name=reporter_name, location=location, incident_type=itype, severity=sev,
                people_involved=people_involved, injury_description=injury_description,
                description=description, immediate_action=immediate_action, witnesses=witnesses,
                photo_count=len(photo_keys),
            )
            sev_tag = "‼️ " if sev in ("serious", "critical") else ""
            await GraphClient().send_email(
                mailbox=settings.ms_send_from,
                to_addresses=recipients,
                subject=f"🚨 {sev_tag}Safety Incident — {location or 'Field'} — {reporter_name}",
                body_html=html,
            )
    except Exception as e:
        logger.warning("Safety incident email failed (report still saved): %s", e)

    return {"id": incident_id, "status": "submitted"}


def _render_incident_email(**k) -> str:
    base = _portal_base()
    label = {
        "injury": "Injury", "near_miss": "Near miss", "property_damage": "Property damage",
        "environmental": "Environmental", "other": "Other",
    }.get(k["incident_type"], "Other")
    sev = (k["severity"] or "minor").capitalize()
    sev_color = {"minor": "#16a34a", "moderate": "#d97706", "serious": "#dc2626", "critical": "#991b1b"}.get(k["severity"], "#6b7280")

    def row(lbl, val):
        if not val:
            return ""
        return (f'<tr><td style="padding:6px 12px 6px 0;color:#6b7280;font-size:13px;vertical-align:top;white-space:nowrap">{lbl}</td>'
                f'<td style="padding:6px 0;color:#111827;font-size:14px;white-space:pre-wrap">{val}</td></tr>')

    when = k["incident_date"] + (f" {k['incident_time']}" if k.get("incident_time") else "")
    photos = f"{k['photo_count']} photo(s) attached — view in the portal" if k.get("photo_count") else ""
    return f"""
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px">
      <div style="background:#7f1d1d;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">
        <div style="font-size:18px;font-weight:800">🚨 Safety Incident Reported</div>
        <div style="font-size:13px;opacity:0.9;margin-top:2px">Report #{k['incident_id']} · submitted just now</div>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:18px 20px">
        <div style="margin-bottom:10px">
          <span style="background:{sev_color};color:#fff;font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px">{sev}</span>
          <span style="background:#f1f5f9;color:#475569;font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;margin-left:6px">{label}</span>
        </div>
        <table style="border-collapse:collapse;width:100%">
          {row("When", when)}
          {row("Location", k.get("location"))}
          {row("Reported by", k["reporter_name"])}
          {row("People involved", k.get("people_involved"))}
          {row("Injury", k.get("injury_description"))}
          {row("What happened", k["description"])}
          {row("Immediate action", k.get("immediate_action"))}
          {row("Witnesses", k.get("witnesses"))}
          {row("Photos", photos)}
        </table>
        <a href="{base}/ops/safety-incidents" style="display:inline-block;margin-top:16px;background:#111827;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700">Open the incident log →</a>
      </div>
    </div>"""


# ── List (admin) ────────────────────────────────────────────────────────────────

@router.get("")
async def list_incidents(
    start_date: Optional[str] = None,
    end_date:   Optional[str] = None,
    status:     Optional[str] = None,
    severity:   Optional[str] = None,
    limit:      int = 200,
):
    """List incident reports for the admin log."""
    db = await _get_db()
    try:
        where, params = ["1=1"], []
        if start_date:
            where.append("incident_date >= ?"); params.append(start_date)
        if end_date:
            where.append("incident_date <= ?"); params.append(end_date)
        if status:
            where.append("status = ?"); params.append(status)
        if severity:
            where.append("severity = ?"); params.append(severity)
        params.append(limit)
        rows = await db._q(
            f"""SELECT id, incident_date, incident_time, reporter_name, location,
                       incident_type, severity, description, status, created_at, photo_r2_keys
                FROM safety_incidents
                WHERE {' AND '.join(where)}
                ORDER BY incident_date DESC, id DESC
                LIMIT ?""",
            params,
        )
        out = []
        for r in rows:
            d = _row(r)
            try:
                d["photo_count"] = len(json.loads(d.get("photo_r2_keys") or "[]"))
            except Exception:
                d["photo_count"] = 0
            d.pop("photo_r2_keys", None)
            out.append(d)
        return {"incidents": out}
    finally:
        await db.close()


# ── Detail ──────────────────────────────────────────────────────────────────────

@router.get("/{incident_id}")
async def get_incident(incident_id: int):
    """Full incident detail, with short-lived presigned photo URLs."""
    db = await _get_db()
    try:
        rows = await db._q("SELECT * FROM safety_incidents WHERE id = ?", [incident_id])
        if not rows:
            raise HTTPException(404, "Incident not found")
        inc = _row(rows[0])
    finally:
        await db.close()

    keys = []
    try:
        keys = json.loads(inc.get("photo_r2_keys") or "[]")
    except Exception:
        keys = []
    inc.pop("photo_r2_keys", None)
    photo_urls = []
    for key in keys:
        try:
            url = await r2.get_presigned_url(key, expires_in=3600)
            if url:
                photo_urls.append(url)
        except Exception:
            pass
    inc["photo_urls"] = photo_urls
    return inc


# ── Status ──────────────────────────────────────────────────────────────────────

class StatusBody(BaseModel):
    status: str
    reviewed_by: Optional[str] = None


@router.patch("/{incident_id}/status")
async def set_incident_status(incident_id: int, body: StatusBody):
    """Set review status: open | reviewed | closed."""
    if body.status not in STATUSES:
        raise HTTPException(400, f"status must be one of {STATUSES}")
    db = await _get_db()
    try:
        await db._x(
            """UPDATE safety_incidents
               SET status = ?, reviewed_by = ?, reviewed_at = datetime('now')
               WHERE id = ?""",
            [body.status, (body.reviewed_by or "").strip() or None, incident_id],
        )
        return {"id": incident_id, "status": body.status}
    finally:
        await db.close()
