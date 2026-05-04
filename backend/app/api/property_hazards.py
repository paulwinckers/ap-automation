"""
Property Hazard Intelligence API
──────────────────────────────────────────────────────────────────────────────
GET  /safety/properties/{property_id}/hazards   — list active hazards
POST /safety/properties/{property_id}/hazards   — report a hazard (photo → AI)
PATCH /safety/properties/{property_id}/hazards/{hazard_id} — dismiss/activate

When a photo is uploaded Claude Vision analyzes it and returns:
  { "description": "...", "severity": "low|medium|high", "mitigation": "..." }

If no photo is provided, the caller must supply a manual description.
"""
import base64
import json
import logging
import os
import uuid
from typing import Optional

import anthropic as _anthropic
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.services import r2

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/safety", tags=["property-hazards"])

MAX_PHOTO_BYTES = 20 * 1_024 * 1_024  # 20 MB

# ── AI client (lazy) ──────────────────────────────────────────────────────────

_ai: Optional[_anthropic.AsyncAnthropic] = None

def _get_ai() -> _anthropic.AsyncAnthropic:
    global _ai
    if _ai is None:
        _ai = _anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
    return _ai


# ── Schemas ───────────────────────────────────────────────────────────────────

class HazardOut(BaseModel):
    id:                 int
    property_id:        int
    property_name:      str
    hazard_description: str
    severity:           str
    mitigation:         Optional[str]
    photo_url:          Optional[str]
    ai_generated:       bool
    reported_by:        Optional[str]
    reported_date:      str
    active:             bool


# ── Helper ────────────────────────────────────────────────────────────────────

def _row_to_hazard(r: dict) -> HazardOut:
    return HazardOut(
        id=r["id"],
        property_id=r["property_id"],
        property_name=r["property_name"],
        hazard_description=r["hazard_description"],
        severity=r.get("severity", "medium"),
        mitigation=r.get("mitigation"),
        photo_url=r.get("photo_url"),
        ai_generated=bool(r.get("ai_generated", 0)),
        reported_by=r.get("reported_by"),
        reported_date=r.get("reported_date", ""),
        active=bool(r.get("active", 1)),
    )


def _file_ext(filename: str) -> str:
    _, ext = os.path.splitext(filename or "")
    return ext.lower() or ".jpg"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/properties/{property_id}/hazards", response_model=list[HazardOut])
async def list_hazards(property_id: int):
    """Return all active hazards for an Aspire property."""
    db = Database()
    await db.connect()
    try:
        rows = await db._q(
            "SELECT * FROM property_hazards WHERE property_id = ? AND active = 1 "
            "ORDER BY severity DESC, created_at DESC",
            [property_id],
        )
        return [_row_to_hazard(r) for r in (rows or [])]
    finally:
        await db.close()


@router.post("/properties/{property_id}/hazards", response_model=dict)
async def create_hazard(
    property_id:  int,
    property_name: str           = Form(...),
    description:   Optional[str] = Form(None),
    reported_by:   Optional[str] = Form(None),
    photo:         Optional[UploadFile] = File(None),
):
    """
    Report a hazard. If a photo is supplied, Claude Vision analyses it to
    generate a description, severity, and mitigation suggestion automatically.
    A manual description is required when no photo is provided.
    """
    photo_url     = None
    ai_generated  = False
    hazard_description = (description or "").strip()
    severity      = "medium"
    mitigation    = None

    # ── Upload photo & run AI ─────────────────────────────────────────────────
    if photo and photo.filename:
        photo_bytes = await photo.read()
        if len(photo_bytes) > MAX_PHOTO_BYTES:
            raise HTTPException(413, "Photo too large — maximum 20 MB")

        if photo_bytes:
            key = f"hazards/{property_id}/{uuid.uuid4().hex}{_file_ext(photo.filename)}"
            ct  = photo.content_type or "image/jpeg"

            try:
                photo_url = await r2.upload(key, photo_bytes, ct)
            except Exception as exc:
                logger.warning(f"R2 upload failed for hazard photo: {exc}")

            # Claude Vision analysis
            try:
                b64_data = base64.standard_b64encode(photo_bytes).decode()
                msg = await _get_ai().messages.create(
                    model="claude-opus-4-5",
                    max_tokens=400,
                    system=(
                        "You are a safety officer reviewing a photo from a landscaping "
                        "job site. Identify the specific hazard visible in the image, "
                        "rate its severity, and recommend practical mitigation steps. "
                        "Respond ONLY with valid JSON — no markdown, no explanation:\n"
                        '{"description":"...","severity":"low|medium|high","mitigation":"..."}'
                    ),
                    messages=[{
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type":       "base64",
                                    "media_type": ct,
                                    "data":       b64_data,
                                },
                            },
                            {
                                "type": "text",
                                "text": "Analyze this job site hazard photo and respond with JSON.",
                            },
                        ],
                    }],
                )
                raw = msg.content[0].text.strip()
                # Strip markdown fences if present
                if raw.startswith("```"):
                    parts = raw.split("```")
                    raw = parts[1].lstrip("json").strip() if len(parts) > 1 else raw
                parsed = json.loads(raw)
                hazard_description = parsed.get("description", hazard_description) or hazard_description
                severity           = parsed.get("severity", "medium")
                mitigation         = parsed.get("mitigation")
                ai_generated       = True
                logger.info(f"AI hazard analysis complete: severity={severity}")
            except Exception as exc:
                logger.warning(f"Claude Vision hazard analysis failed: {exc}")

    if not hazard_description:
        raise HTTPException(
            400,
            "Hazard description is required — either upload a photo (AI will generate one) "
            "or provide a manual description.",
        )

    if severity not in ("low", "medium", "high"):
        severity = "medium"

    # ── Persist ───────────────────────────────────────────────────────────────
    from datetime import date as _date
    today = _date.today().isoformat()

    db = Database()
    await db.connect()
    try:
        # _x() runs INSERT/UPDATE/DELETE and returns last_row_id as int
        new_id = await db._x(
            """
            INSERT INTO property_hazards
                (property_id, property_name, hazard_description, severity,
                 mitigation, photo_url, ai_generated, reported_by, reported_date, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            """,
            [
                property_id, property_name, hazard_description, severity,
                mitigation, photo_url, 1 if ai_generated else 0,
                reported_by, today,
            ],
        )
        # _q() runs SELECT and returns list[dict]
        rows = await db._q(
            "SELECT * FROM property_hazards WHERE id = ?",
            [new_id],
        ) if new_id else []
        hazard = _row_to_hazard(rows[0]) if rows else HazardOut(
            id=new_id or 0, property_id=property_id, property_name=property_name,
            hazard_description=hazard_description, severity=severity,
            mitigation=mitigation, photo_url=photo_url,
            ai_generated=ai_generated, reported_by=reported_by,
            reported_date=today, active=True,
        )
        return {"hazard": hazard.model_dump()}
    finally:
        await db.close()


@router.patch("/properties/{property_id}/hazards/{hazard_id}", response_model=dict)
async def update_hazard(
    property_id: int,
    hazard_id:   int,
    active:      Optional[bool] = Form(None),
):
    """Dismiss (active=false) or re-activate a hazard."""
    if active is None:
        raise HTTPException(400, "Provide active=true or active=false")

    db = Database()
    await db.connect()
    try:
        await db._x(
            "UPDATE property_hazards SET active = ? WHERE id = ? AND property_id = ?",
            [1 if active else 0, hazard_id, property_id],
        )
        return {"ok": True}
    finally:
        await db.close()
