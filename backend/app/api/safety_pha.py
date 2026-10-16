"""
Project Hazard Assessment (PHA) API — Phase 1 of the construction safety program.

A PHA is a pre-mobilization hazard assessment attached to a project (Aspire
opportunity). It is completed progressively (draft) from the field project page
or the office, then submitted (locked + emailed to the safety recipients).

POST   /safety/pha                 — create a new draft (optional opportunity_id + payload)
GET    /safety/pha                 — list PHAs (admin / project lookup)
GET    /safety/pha/{id}            — full detail incl. parsed payload + presigned photo URLs
PUT    /safety/pha/{id}            — update draft payload / core fields
POST   /safety/pha/{id}/submit     — lock + email notify
POST   /safety/pha/{id}/photo      — upload ONE reference photo (resilient per-file)
DELETE /safety/pha/{id}/photo      — remove a photo (draft)

The big structured sections (scope phases, site conditions, permits, hazards,
PPE, emergency prep, action items, sign-offs) live in a single JSON `payload`
so the form can evolve without a schema change. Only identity/listing fields are
real columns.
"""
import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.services import r2
from app.services.email_intake import GraphClient

router = APIRouter(prefix="/safety/pha", tags=["safety-pha"])
logger = logging.getLogger(__name__)

MAX_PHOTO_SIZE = 20 * 1024 * 1024  # 20 MB per photo


async def _get_db() -> Database:
    db = Database()
    await db.connect()
    return db


def _row(r) -> dict:
    return dict(r) if r else {}


def _loads(s, default):
    try:
        v = json.loads(s) if s else default
        return v if v is not None else default
    except Exception:
        return default


async def _pha_recipients() -> list[str]:
    from app.services.email_settings import get_email_settings, recipients as _rl
    cfg = await get_email_settings()
    rl = _rl(cfg.get("project_hazard_assessment", {}).get("recipients", ""))
    if not rl:
        # fall back to the safety-incident recipients, then the issues digest list
        rl = _rl(cfg.get("safety_incident", {}).get("recipients", ""))
    if not rl:
        rl = [e.strip() for e in (settings.ISSUES_DIGEST_MGMT_RECIPIENTS or "").split(",") if e.strip()]
    return rl


def _portal_base() -> str:
    return (getattr(settings, "PORTAL_BASE_URL", "") or "https://darios-ap.pages.dev").rstrip("/")


# ── Create ────────────────────────────────────────────────────────────────────

class CreateBody(BaseModel):
    opportunity_id: Optional[int] = None
    project_name:   Optional[str] = None
    site_address:   Optional[str] = None
    created_by:     Optional[str] = None
    payload:        Optional[dict] = None


@router.post("")
async def create_pha(body: CreateBody):
    """Create a new draft PHA. Returns the full record (with its generated PHA number)."""
    payload = body.payload or {}
    db = await _get_db()
    try:
        rows = await db._q(
            """INSERT INTO project_hazard_assessments
               (opportunity_id, project_name, site_address, status, payload, photo_r2_keys, created_by)
               VALUES (?, ?, ?, 'draft', ?, '[]', ?)
               RETURNING id""",
            [
                body.opportunity_id,
                (body.project_name or "").strip() or None,
                (body.site_address or "").strip() or None,
                json.dumps(payload),
                (body.created_by or "").strip() or None,
            ],
        )
        pha_id = rows[0]["id"]
        pha_number = f"PHA-{datetime.now(timezone.utc).year}-{pha_id:04d}"
        await db._x(
            "UPDATE project_hazard_assessments SET pha_number = ?, updated_at = datetime('now') WHERE id = ?",
            [pha_number, pha_id],
        )
    finally:
        await db.close()
    logger.info("PHA #%s created (opp=%s)", pha_id, body.opportunity_id)
    return await get_pha(pha_id)


# ── Update (draft) ──────────────────────────────────────────────────────────────

class UpdateBody(BaseModel):
    opportunity_id: Optional[int] = None
    project_name:   Optional[str] = None
    site_address:   Optional[str] = None
    payload:        Optional[dict] = None


@router.put("/{pha_id}")
async def update_pha(pha_id: int, body: UpdateBody):
    """Update a PHA's core fields and/or payload. Allowed on drafts and submitted
    records (edits after submit are permitted so the office can correct a record)."""
    db = await _get_db()
    try:
        rows = await db._q("SELECT id FROM project_hazard_assessments WHERE id = ?", [pha_id])
        if not rows:
            raise HTTPException(404, "PHA not found")
        sets, params = ["updated_at = datetime('now')"], []
        if body.payload is not None:
            sets.append("payload = ?"); params.append(json.dumps(body.payload))
        if body.project_name is not None:
            sets.append("project_name = ?"); params.append((body.project_name or "").strip() or None)
        if body.site_address is not None:
            sets.append("site_address = ?"); params.append((body.site_address or "").strip() or None)
        if body.opportunity_id is not None:
            sets.append("opportunity_id = ?"); params.append(body.opportunity_id)
        params.append(pha_id)
        await db._x(f"UPDATE project_hazard_assessments SET {', '.join(sets)} WHERE id = ?", params)
    finally:
        await db.close()
    return await get_pha(pha_id)


# ── Submit ──────────────────────────────────────────────────────────────────────

class SubmitBody(BaseModel):
    submitted_by: Optional[str] = None


@router.post("/{pha_id}/submit")
async def submit_pha(pha_id: int, body: SubmitBody):
    """Lock the PHA (status=submitted) and email the safety recipients. The email
    is best-effort — a send failure never blocks the submit."""
    db = await _get_db()
    try:
        rows = await db._q("SELECT * FROM project_hazard_assessments WHERE id = ?", [pha_id])
        if not rows:
            raise HTTPException(404, "PHA not found")
        rec = _row(rows[0])
        await db._x(
            """UPDATE project_hazard_assessments
               SET status = 'submitted', submitted_at = datetime('now'),
                   submitted_by = ?, updated_at = datetime('now')
               WHERE id = ?""",
            [(body.submitted_by or "").strip() or None, pha_id],
        )
    finally:
        await db.close()

    logger.info("PHA #%s submitted by %s", pha_id, body.submitted_by)

    try:
        recipients = await _pha_recipients()
        if recipients:
            payload = _loads(rec.get("payload"), {})
            keys = _loads(rec.get("photo_r2_keys"), [])
            html = _render_pha_email(rec, payload, photo_count=len(keys),
                                     submitted_by=(body.submitted_by or "").strip())
            pn = rec.get("project_name") or payload.get("project_name") or "Project"
            await GraphClient().send_email(
                mailbox=settings.ms_send_from,
                to_addresses=recipients,
                subject=f"🦺 Project Hazard Assessment — {pn} ({rec.get('pha_number') or ('#'+str(pha_id))})",
                body_html=html,
            )
    except Exception as e:
        logger.warning("PHA submit email failed (record still saved): %s", e)

    return await get_pha(pha_id)


def _render_pha_email(rec: dict, payload: dict, photo_count: int, submitted_by: str) -> str:
    base = _portal_base()
    pha_no = rec.get("pha_number") or f"#{rec.get('id')}"
    info = payload.get("project_info", {}) if isinstance(payload.get("project_info"), dict) else {}

    def g(*keys):
        for k in keys:
            v = info.get(k) or payload.get(k) or rec.get(k)
            if v:
                return v
        return ""

    def row(lbl, val):
        if not val:
            return ""
        return (f'<tr><td style="padding:6px 12px 6px 0;color:#6b7280;font-size:13px;vertical-align:top;white-space:nowrap">{lbl}</td>'
                f'<td style="padding:6px 0;color:#111827;font-size:14px;white-space:pre-wrap">{val}</td></tr>')

    # Scope phases selected
    phases = payload.get("scope_phases") or []
    sel_phases = [p.get("label") for p in phases if isinstance(p, dict) and p.get("included")]
    phases_txt = ", ".join([p for p in sel_phases if p][:30])

    # Hazards flagged
    hazards = payload.get("hazards") or []
    haz_flagged = [h for h in hazards if isinstance(h, dict) and h.get("present")]
    high = [h for h in haz_flagged if str(h.get("risk_after") or h.get("risk_before") or "").upper().startswith("H")]

    # Sign-offs
    signoffs = payload.get("signoffs") or []
    signed = [f"{s.get('role')}: {s.get('name')}" for s in signoffs if isinstance(s, dict) and s.get("name")]

    high_banner = ""
    if high:
        high_banner = (f'<div style="margin-bottom:10px"><span style="background:#991b1b;color:#fff;'
                       f'font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px">'
                       f'{len(high)} HIGH residual risk</span></div>')

    return f"""
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:660px">
      <div style="background:#1A5376;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">
        <div style="font-size:18px;font-weight:800">🦺 Project Hazard Assessment Submitted</div>
        <div style="font-size:13px;opacity:0.9;margin-top:2px">{pha_no} · submitted just now{(' by ' + submitted_by) if submitted_by else ''}</div>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:18px 20px">
        {high_banner}
        <table style="border-collapse:collapse;width:100%">
          {row("Project", g("project_name"))}
          {row("Job #", g("job_number"))}
          {row("Site address", g("site_address"))}
          {row("Client", g("client_name"))}
          {row("Project Manager", g("project_manager"))}
          {row("Crew Lead", g("crew_lead"))}
          {row("Planned start", g("planned_start"))}
          {row("Dario's role", g("darios_role"))}
          {row("Work types / phases", phases_txt)}
          {row("Hazards flagged", str(len(haz_flagged)) if haz_flagged else "")}
          {row("Sign-offs", "; ".join(signed))}
          {row("Reference photos", (f"{photo_count} attached — view in the portal" if photo_count else ""))}
        </table>
        <a href="{base}/ops/safety-pha" style="display:inline-block;margin-top:16px;background:#1A5376;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700">Open the PHA log →</a>
      </div>
    </div>"""


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("")
async def list_pha(
    opportunity_id: Optional[int] = None,
    status:         Optional[str] = None,
    limit:          int = 200,
):
    """List PHAs — for the admin log, or filtered by opportunity_id for a project tab."""
    db = await _get_db()
    try:
        where, params = ["1=1"], []
        if opportunity_id is not None:
            where.append("opportunity_id = ?"); params.append(opportunity_id)
        if status:
            where.append("status = ?"); params.append(status)
        params.append(limit)
        rows = await db._q(
            f"""SELECT id, opportunity_id, pha_number, project_name, site_address, status,
                       created_by, created_at, updated_at, submitted_at, submitted_by,
                       photo_r2_keys, payload
                FROM project_hazard_assessments
                WHERE {' AND '.join(where)}
                ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
                LIMIT ?""",
            params,
        )
        out = []
        for r in rows:
            d = _row(r)
            payload = _loads(d.get("payload"), {})
            hazards = payload.get("hazards") or []
            haz_flagged = [h for h in hazards if isinstance(h, dict) and h.get("present")]
            out.append({
                "id": d["id"],
                "opportunity_id": d.get("opportunity_id"),
                "pha_number": d.get("pha_number"),
                "project_name": d.get("project_name"),
                "site_address": d.get("site_address"),
                "status": d.get("status"),
                "created_by": d.get("created_by"),
                "created_at": d.get("created_at"),
                "updated_at": d.get("updated_at"),
                "submitted_at": d.get("submitted_at"),
                "submitted_by": d.get("submitted_by"),
                "photo_count": len(_loads(d.get("photo_r2_keys"), [])),
                "hazard_count": len(haz_flagged),
                "assessment_date": (payload.get("project_info") or {}).get("assessment_date"),
            })
        return {"assessments": out}
    finally:
        await db.close()


# ── Detail ──────────────────────────────────────────────────────────────────────

@router.get("/{pha_id}")
async def get_pha(pha_id: int):
    """Full PHA detail with parsed payload and short-lived presigned photo URLs."""
    db = await _get_db()
    try:
        rows = await db._q("SELECT * FROM project_hazard_assessments WHERE id = ?", [pha_id])
        if not rows:
            raise HTTPException(404, "PHA not found")
        rec = _row(rows[0])
    finally:
        await db.close()

    payload = _loads(rec.get("payload"), {})
    keys = _loads(rec.get("photo_r2_keys"), [])
    photos = []
    for key in keys:
        try:
            url = await r2.get_presigned_url(key, expires_in=3600)
            if url:
                photos.append({"key": key, "url": url})
        except Exception:
            pass
    return {
        "id": rec["id"],
        "opportunity_id": rec.get("opportunity_id"),
        "pha_number": rec.get("pha_number"),
        "project_name": rec.get("project_name"),
        "site_address": rec.get("site_address"),
        "status": rec.get("status"),
        "created_by": rec.get("created_by"),
        "created_at": rec.get("created_at"),
        "updated_at": rec.get("updated_at"),
        "submitted_at": rec.get("submitted_at"),
        "submitted_by": rec.get("submitted_by"),
        "payload": payload,
        "photos": photos,
    }


# ── Photos ──────────────────────────────────────────────────────────────────────

@router.post("/{pha_id}/photo")
async def upload_pha_photo(pha_id: int, file: UploadFile = File(...)):
    """Upload ONE reference photo and attach it to the PHA. Resilient per-file:
    the client uploads each photo on its own so one failure doesn't lose the rest."""
    db = await _get_db()
    try:
        rows = await db._q("SELECT photo_r2_keys FROM project_hazard_assessments WHERE id = ?", [pha_id])
        if not rows:
            raise HTTPException(404, "PHA not found")
        keys = _loads(_row(rows[0]).get("photo_r2_keys"), [])
    finally:
        await db.close()

    if not file or not file.filename:
        raise HTTPException(400, "No file provided")
    data = await file.read()
    if len(data) > MAX_PHOTO_SIZE:
        raise HTTPException(413, "Photo is too large — maximum 20 MB")
    if not data:
        raise HTTPException(400, "Empty file")
    if not r2._r2_available():
        raise HTTPException(503, "Photo storage is not configured")

    uid  = uuid.uuid4().hex[:8]
    safe = "".join(c if c.isalnum() or c in (".", "-", "_") else "_" for c in (file.filename or "photo.jpg"))
    key  = f"pha/{pha_id}/{uid}_{safe}"
    ctype = file.content_type or "image/jpeg"

    def _upload(k=key, b=data, ct=ctype):
        client = r2._make_client()
        client.put_object(Bucket=r2.settings.R2_BUCKET_NAME, Key=k, Body=b, ContentType=ct)
    await asyncio.get_event_loop().run_in_executor(None, _upload)

    keys.append(key)
    db = await _get_db()
    try:
        await db._x(
            "UPDATE project_hazard_assessments SET photo_r2_keys = ?, updated_at = datetime('now') WHERE id = ?",
            [json.dumps(keys), pha_id],
        )
    finally:
        await db.close()

    url = None
    try:
        url = await r2.get_presigned_url(key, expires_in=3600)
    except Exception:
        pass
    logger.info("PHA #%s photo uploaded: %s", pha_id, key)
    return {"key": key, "url": url}


class DeletePhotoBody(BaseModel):
    key: str


@router.delete("/{pha_id}/photo")
async def delete_pha_photo(pha_id: int, body: DeletePhotoBody):
    """Remove a photo reference from the PHA (the R2 object is left in place)."""
    db = await _get_db()
    try:
        rows = await db._q("SELECT photo_r2_keys FROM project_hazard_assessments WHERE id = ?", [pha_id])
        if not rows:
            raise HTTPException(404, "PHA not found")
        keys = _loads(_row(rows[0]).get("photo_r2_keys"), [])
        keys = [k for k in keys if k != body.key]
        await db._x(
            "UPDATE project_hazard_assessments SET photo_r2_keys = ?, updated_at = datetime('now') WHERE id = ?",
            [json.dumps(keys), pha_id],
        )
    finally:
        await db.close()
    return {"ok": True, "key": body.key}
