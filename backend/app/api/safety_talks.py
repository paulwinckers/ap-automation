"""
Safety Talks API.
Field crew leaders submit toolbox / safety talk records from their phones.
Data is stored in the local D1/SQLite database (not Aspire).
"""
import json as _json
import logging
import uuid
from typing import List, Optional

import anthropic as _anthropic
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.services import r2

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/safety", tags=["safety"])

# ── AI client (lazy singleton) ────────────────────────────────────────────────

_ai_client: Optional[_anthropic.AsyncAnthropic] = None

def _get_ai() -> _anthropic.AsyncAnthropic:
    global _ai_client
    if _ai_client is None:
        _ai_client = _anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
    return _ai_client

MAX_PHOTO_SIZE = 15 * 1024 * 1024  # 15 MB


# ── DB dependency ─────────────────────────────────────────────────────────────

_db = Database()

async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


# ── Schemas ───────────────────────────────────────────────────────────────────

class SafetyTalkOut(BaseModel):
    id:             int
    talk_date:      str
    topic:          str
    presenter_name: str
    job_site:       Optional[str]
    notes:          Optional[str]
    photo_url:      Optional[str]
    attendee_count: int
    created_at:     str

class SafetyTalkDetail(SafetyTalkOut):
    attendees: List[str]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/talks", response_model=SafetyTalkDetail)
async def create_safety_talk(
    talk_date:      str               = Form(...),
    topic:          str               = Form(...),
    presenter_name: str               = Form(...),
    job_site:       Optional[str]     = Form(default=None),
    notes:          Optional[str]     = Form(default=None),
    attendees_json: str               = Form(...),   # JSON array of names
    photo:          Optional[UploadFile] = File(default=None),
    db: Database = Depends(get_db),
):
    """Create a new safety talk record with attendees and optional group photo."""
    import json as _json

    if not topic.strip():
        raise HTTPException(status_code=400, detail="Topic is required")
    if not presenter_name.strip():
        raise HTTPException(status_code=400, detail="Presenter name is required")

    try:
        attendee_names: list[str] = _json.loads(attendees_json)
    except Exception:
        raise HTTPException(status_code=400, detail="attendees_json must be a valid JSON array")

    clean_names = [n.strip() for n in attendee_names if n.strip()]
    if not clean_names:
        raise HTTPException(status_code=400, detail="At least one attendee is required")

    # ── Upload group photo to R2 if provided ──────────────────────────────────
    photo_url: Optional[str] = None
    if photo and photo.filename:
        raw = await photo.read()
        if len(raw) > MAX_PHOTO_SIZE:
            raise HTTPException(status_code=413, detail="Photo too large (max 15 MB)")
        try:
            result = await r2.upload_field_photo(
                file_bytes=raw,
                filename=photo.filename,
                submitter=presenter_name.strip(),
                entity_type="safety-talk",
                entity_id=str(uuid.uuid4())[:8],
                expires_in=365 * 24 * 3600,
            )
            if result:
                _, photo_url = result
                logger.info(f"Safety talk group photo uploaded: {photo_url[:60]}…")
        except Exception as e:
            logger.warning(f"Safety talk photo upload failed: {e}")

    # ── Insert talk — use RETURNING id to get reliable ID from D1 ────────────
    rows = await db._q(
        """INSERT INTO safety_talks (talk_date, topic, presenter_name, job_site, notes, photo_url)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id, created_at""",
        [
            talk_date,
            topic.strip(),
            presenter_name.strip(),
            (job_site or "").strip() or None,
            (notes or "").strip() or None,
            photo_url,
        ],
    )
    if not rows:
        raise HTTPException(status_code=500, detail="Failed to create safety talk record")

    talk_id   = rows[0]["id"]
    created_at = rows[0]["created_at"]

    # ── Insert attendees ──────────────────────────────────────────────────────
    for name in clean_names:
        await db._x(
            "INSERT INTO safety_talk_attendees (talk_id, name) VALUES (?, ?)",
            [talk_id, name],
        )

    logger.info(
        f"Safety talk created: id={talk_id} topic='{topic}' "
        f"presenter='{presenter_name}' attendees={len(clean_names)} photo={'yes' if photo_url else 'no'}"
    )

    return SafetyTalkDetail(
        id=talk_id,
        talk_date=talk_date,
        topic=topic.strip(),
        presenter_name=presenter_name.strip(),
        job_site=(job_site or "").strip() or None,
        notes=(notes or "").strip() or None,
        photo_url=photo_url,
        attendee_count=len(clean_names),
        created_at=created_at,
        attendees=clean_names,
    )


@router.get("/talks", response_model=List[SafetyTalkOut])
async def list_safety_talks(
    start_date: Optional[str] = Query(default=None, description="YYYY-MM-DD"),
    end_date:   Optional[str] = Query(default=None, description="YYYY-MM-DD"),
    limit:      int           = Query(default=100, le=500),
    db: Database = Depends(get_db),
):
    """List safety talks, newest first, with attendee counts."""
    where_clauses = []
    params: list = []

    if start_date:
        where_clauses.append("t.talk_date >= ?")
        params.append(start_date)
    if end_date:
        where_clauses.append("t.talk_date <= ?")
        params.append(end_date)

    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    rows = await db._q(
        f"""SELECT t.id, t.talk_date, t.topic, t.presenter_name, t.job_site,
                   t.notes, t.photo_url, t.created_at,
                   COUNT(a.id) AS attendee_count
            FROM safety_talks t
            LEFT JOIN safety_talk_attendees a ON a.talk_id = t.id
            {where_sql}
            GROUP BY t.id
            ORDER BY t.talk_date DESC, t.created_at DESC
            LIMIT ?""",
        params + [limit],
    )

    return [
        SafetyTalkOut(
            id=r["id"],
            talk_date=r["talk_date"],
            topic=r["topic"],
            presenter_name=r["presenter_name"],
            job_site=r["job_site"],
            notes=r["notes"],
            photo_url=r.get("photo_url"),
            attendee_count=r["attendee_count"],
            created_at=r["created_at"],
        )
        for r in rows
    ]


@router.get("/talks/{talk_id}", response_model=SafetyTalkDetail)
async def get_safety_talk(talk_id: int, db: Database = Depends(get_db)):
    """Get a single safety talk with full attendee list."""
    talk_rows = await db._q(
        """SELECT t.id, t.talk_date, t.topic, t.presenter_name, t.job_site,
                  t.notes, t.photo_url, t.created_at
           FROM safety_talks t WHERE t.id = ?""",
        [talk_id],
    )
    if not talk_rows:
        raise HTTPException(status_code=404, detail="Safety talk not found")
    row = talk_rows[0]

    attendee_rows = await db._q(
        "SELECT name FROM safety_talk_attendees WHERE talk_id = ? ORDER BY id",
        [talk_id],
    )
    attendees = [r["name"] for r in attendee_rows]

    return SafetyTalkDetail(
        id=row["id"],
        talk_date=row["talk_date"],
        topic=row["topic"],
        presenter_name=row["presenter_name"],
        job_site=row["job_site"],
        notes=row["notes"],
        photo_url=row.get("photo_url"),
        attendee_count=len(attendees),
        created_at=row["created_at"],
        attendees=attendees,
    )


# ── AI: topic talking points ──────────────────────────────────────────────────

TIPS_PROMPT = """\
You are a safety trainer for a Canadian landscaping and grounds maintenance company.
Generate exactly 5 concise toolbox talk bullet points for the topic: "{topic}"

Rules:
- Be specific to outdoor landscaping / grounds maintenance field work
- Each point is 1–2 short sentences — crew leaders read these aloud on site
- Use plain, everyday language (no jargon)
- Cover what to do, what to watch for, and one consequence/why it matters
- Return ONLY a JSON array of 5 strings, no markdown, no commentary

Example format: ["Tip one.", "Tip two.", "Tip three.", "Tip four.", "Tip five."]"""


@router.get("/topic-tips")
async def get_topic_tips(topic: str = Query(..., min_length=2, max_length=120)):
    """Return 5 AI-generated talking points for a given safety topic."""
    ai = _get_ai()
    try:
        msg = await ai.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=512,
            messages=[{"role": "user", "content": TIPS_PROMPT.format(topic=topic)}],
        )
        raw = msg.content[0].text.strip()
        start, end = raw.find("["), raw.rfind("]") + 1
        tips: list[str] = _json.loads(raw[start:end]) if start != -1 else []
        tips = [t for t in tips if isinstance(t, str)][:5]
        logger.info(f"Generated {len(tips)} tips for topic: {topic!r}")
        return {"topic": topic, "tips": tips}
    except Exception as e:
        logger.warning(f"AI tip generation failed for '{topic}': {e}")
        raise HTTPException(status_code=503, detail="Could not generate tips — please try again")
