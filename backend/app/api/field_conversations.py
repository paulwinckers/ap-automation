"""
Field Conversations
==================
Threaded crew issue logs for maintenance contracts and construction projects.
Public — no login required (field crew access).

Routes:
  GET   /field/conversations/{opp_id}                    — list conversations
  POST  /field/conversations/{opp_id}                    — create conversation + first message
  GET   /field/conversations/{opp_id}/{conv_id}          — get thread with messages
  POST  /field/conversations/{opp_id}/{conv_id}/messages — add message (optionally AI)
  PATCH /field/conversations/{opp_id}/{conv_id}/resolve  — mark resolved
"""
import asyncio
import logging
import uuid
from typing import Optional

import anthropic as _anthropic
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.core.config import settings
from app.core.database import Database
from app.services import r2 as _r2

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/field/conversations", tags=["field-conversations"])

_db = Database()

VALID_TAGS = {"Irrigation", "Turf", "Pest", "Safety", "Materials", "Schedule", "Quality", "Other"}

_MIME_OVERRIDE = {
    "pdf":  "application/pdf",
    "png":  "image/png",
    "jpg":  "image/jpeg",
    "jpeg": "image/jpeg",
    "gif":  "image/gif",
    "webp": "image/webp",
    "heic": "image/heic",
}

AI_SYSTEM = """You are an expert landscape management advisor helping field crews at Dario's Landscaping.
You are participating in a crew conversation thread about a site issue or question.
Provide practical, concise, actionable advice that a field worker can act on immediately.
Be direct and clear — avoid jargon. If you need more info to give good advice, ask one focused question."""


async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


# ── WhatsApp helper ───────────────────────────────────────────────────────────

def _whatsapp_recipients(context_type: str) -> list[str]:
    if context_type == "construction":
        raw = settings.TWILIO_WHATSAPP_TO_CONSTRUCTION or settings.TWILIO_WHATSAPP_TO
    else:
        raw = settings.TWILIO_WHATSAPP_TO
    return [t.strip() for t in raw.split(",") if t.strip()]


def _send_whatsapp_conversation(
    context_type: str,
    opp_id: int,
    property_name: str,
    crew_name: str,
    title: str,
    tag: Optional[str],
) -> None:
    sid     = settings.TWILIO_ACCOUNT_SID
    token   = settings.TWILIO_AUTH_TOKEN
    frm     = settings.TWILIO_WHATSAPP_FROM
    to_list = _whatsapp_recipients(context_type)

    if not (sid and token and frm and to_list):
        logger.info("Twilio not configured — skipping conversation WhatsApp.")
        return

    try:
        from twilio.rest import Client as TwilioClient
        client = TwilioClient(sid, token)

        ctx_label  = "🏗️ Construction" if context_type == "construction" else "🌿 Maintenance"
        tag_label  = f"  [{tag}]" if tag else ""
        crew_label = crew_name.strip() if crew_name and crew_name.strip() else "Unknown"
        deep_link  = (
            f"https://darios-ap.pages.dev/field/project/{opp_id}"
            if context_type == "construction"
            else f"https://darios-ap.pages.dev/field/maintenance/{opp_id}"
        )

        body = (
            f"{ctx_label} *New Conversation Started*\n"
            f"Property: {property_name}\n"
            f"Crew: {crew_label}\n"
            f"Topic: {title}{tag_label}\n\n"
            f"🔗 {deep_link}"
        )
        for to in to_list:
            client.messages.create(body=body, from_=frm, to=to)
            logger.info(f"WhatsApp sent to {to} (new conversation, opp {opp_id})")
    except Exception as e:
        logger.warning(f"WhatsApp conversation notification failed: {e}")


# ── Photo upload helper ───────────────────────────────────────────────────────

async def _upload_photo(photo: UploadFile, opp_id: int, conv_id: int) -> tuple[str | None, int]:
    """Upload a photo to R2. Returns (r2_key, has_photo)."""
    if not (photo and photo.filename):
        return None, 0
    try:
        ext         = (photo.filename.rsplit(".", 1)[-1] or "jpg").lower()
        r2_key      = f"conversations/{opp_id}/{conv_id}/{uuid.uuid4().hex[:8]}.{ext}"
        raw         = await photo.read()
        content_type = _MIME_OVERRIDE.get(ext, "image/jpeg")

        def _up():
            _r2.s3_client().put_object(
                Bucket=settings.R2_BUCKET_NAME,
                Key=r2_key, Body=raw, ContentType=content_type,
            )
        await asyncio.get_event_loop().run_in_executor(None, _up)
        return r2_key, 1
    except Exception as e:
        logger.warning(f"Conversations photo upload failed: {e}")
        return None, 0


# ── AI helper ─────────────────────────────────────────────────────────────────

async def _ask_ai(title: str, tag: Optional[str], messages: list[dict]) -> str:
    """Call Claude with conversation history. Returns AI text."""
    try:
        client = _anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        system = AI_SYSTEM + f"\n\nConversation topic: {title}"
        if tag:
            system += f"\nCategory: {tag}"

        resp = await client.messages.create(
            model="claude-opus-4-5",
            max_tokens=1024,
            system=system,
            messages=messages,
        )
        return resp.content[0].text
    except Exception as e:
        logger.error(f"Field conversations AI call failed: {e}")
        return "Sorry, I couldn't reach the AI advisor right now. Please try again."


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/all/dashboard")
async def all_conversations_dashboard(
    status:       str = "open",
    context_type: str = "",
    tag:          str = "",
    db:           Database = Depends(get_db),
):
    """Return all conversations for the ops manager dashboard."""
    conditions = []
    params: list = []

    if status and status != "all":
        conditions.append("status = ?")
        params.append(status)

    if context_type and context_type != "all":
        conditions.append("context_type = ?")
        params.append(context_type)

    if tag and tag != "all":
        conditions.append("tag = ?")
        params.append(tag)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    rows = await db._q(
        f"""SELECT * FROM field_conversations
           {where}
           ORDER BY
             CASE WHEN status = 'open' THEN 0 ELSE 1 END,
             COALESCE(updated_at, created_at) DESC""",
        params,
    )
    return {"conversations": rows or []}


@router.get("/{opp_id}")
async def list_conversations(
    opp_id:       int,
    context_type: str = "maintenance",
    db:           Database = Depends(get_db),
):
    rows = await db._q(
        """SELECT * FROM field_conversations
           WHERE opp_id = ? AND context_type = ?
           ORDER BY
             CASE WHEN status = 'open' THEN 0 ELSE 1 END,
             created_at DESC""",
        [opp_id, context_type],
    )
    return {"conversations": rows or []}


@router.post("/{opp_id}")
async def create_conversation(
    opp_id:        int,
    title:         str                  = Form(...),
    context_type:  str                  = Form(default="maintenance"),
    tag:           Optional[str]        = Form(default=None),
    first_message: str                  = Form(...),
    crew_name:     Optional[str]        = Form(default=None),
    property_name: Optional[str]        = Form(default=None),
    use_ai:        int                  = Form(default=0),
    photo:         Optional[UploadFile] = File(default=None),
    db:            Database             = Depends(get_db),
):
    """Create a new conversation thread with an initial crew message."""
    tag = tag if tag in VALID_TAGS else None

    # 1. Create conversation record
    prop = (property_name or f"Opp #{opp_id}").strip()
    conv_id = await db._x(
        """INSERT INTO field_conversations
             (opp_id, context_type, title, tag, created_by, message_count, last_message, property_name, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, datetime('now'))""",
        [opp_id, context_type, title.strip(), tag, crew_name, first_message.strip()[:120], prop],
    )

    # 2. Upload photo if provided
    photo_r2_key, has_photo = await _upload_photo(photo, opp_id, conv_id)

    # 3. Save first crew message
    await db._x(
        """INSERT INTO field_conversation_messages
             (conversation_id, role, crew_name, content, has_photo, photo_r2_key)
           VALUES (?, 'crew', ?, ?, ?, ?)""",
        [conv_id, crew_name, first_message.strip(), has_photo, photo_r2_key],
    )

    # 4. Optionally get AI response
    ai_response = None
    if use_ai:
        ai_response = await _ask_ai(
            title=title,
            tag=tag,
            messages=[{"role": "user", "content": first_message.strip()}],
        )
        await db._x(
            """INSERT INTO field_conversation_messages
                 (conversation_id, role, crew_name, content)
               VALUES (?, 'ai', 'Field Advisor', ?)""",
            [conv_id, ai_response],
        )
        await db._x(
            """UPDATE field_conversations
               SET message_count = message_count + 1, last_message = ?, updated_at = datetime('now')
               WHERE id = ?""",
            [ai_response[:120], conv_id],
        )

    # 5. WhatsApp notification (non-blocking)
    prop = property_name or f"Opp #{opp_id}"
    crew = crew_name or ""
    asyncio.get_event_loop().run_in_executor(
        None, _send_whatsapp_conversation,
        context_type, opp_id, prop, crew, title.strip(), tag,
    )

    return {"conv_id": conv_id, "ai_response": ai_response}


@router.get("/{opp_id}/{conv_id}")
async def get_conversation(
    opp_id:  int,
    conv_id: int,
    db:      Database = Depends(get_db),
):
    rows = await db._q(
        "SELECT * FROM field_conversations WHERE id = ? AND opp_id = ?",
        [conv_id, opp_id],
    )
    if not rows:
        raise HTTPException(404, "Conversation not found")
    msgs = await db._q(
        """SELECT * FROM field_conversation_messages
           WHERE conversation_id = ? ORDER BY created_at ASC""",
        [conv_id],
    )
    return {"conversation": rows[0], "messages": msgs or []}


@router.post("/{opp_id}/{conv_id}/messages")
async def add_message(
    opp_id:    int,
    conv_id:   int,
    content:   str                  = Form(...),
    crew_name: Optional[str]        = Form(default=None),
    use_ai:    int                  = Form(default=0),
    photo:     Optional[UploadFile] = File(default=None),
    db:        Database             = Depends(get_db),
):
    """Add a crew message to an existing conversation, optionally with AI reply."""
    rows = await db._q(
        "SELECT * FROM field_conversations WHERE id = ? AND opp_id = ?",
        [conv_id, opp_id],
    )
    if not rows:
        raise HTTPException(404, "Conversation not found")
    conv = rows[0]

    # Upload photo
    photo_r2_key, has_photo = await _upload_photo(photo, opp_id, conv_id)

    # Save crew message
    await db._x(
        """INSERT INTO field_conversation_messages
             (conversation_id, role, crew_name, content, has_photo, photo_r2_key)
           VALUES (?, 'crew', ?, ?, ?, ?)""",
        [conv_id, crew_name, content.strip(), has_photo, photo_r2_key],
    )
    await db._x(
        """UPDATE field_conversations
           SET message_count = message_count + 1, last_message = ?, updated_at = datetime('now')
           WHERE id = ?""",
        [content.strip()[:120], conv_id],
    )

    ai_response = None
    if use_ai:
        # Build message history for Claude
        history_rows = await db._q(
            """SELECT role, content FROM field_conversation_messages
               WHERE conversation_id = ? ORDER BY created_at ASC""",
            [conv_id],
        )
        messages: list[dict] = []
        for row in history_rows:
            claude_role = "assistant" if row["role"] == "ai" else "user"
            # Claude requires alternating roles — merge consecutive same-role messages
            if messages and messages[-1]["role"] == claude_role:
                messages[-1]["content"] += "\n\n" + row["content"]
            else:
                messages.append({"role": claude_role, "content": row["content"]})

        ai_response = await _ask_ai(
            title=conv["title"],
            tag=conv.get("tag"),
            messages=messages,
        )
        await db._x(
            """INSERT INTO field_conversation_messages
                 (conversation_id, role, crew_name, content)
               VALUES (?, 'ai', 'Field Advisor', ?)""",
            [conv_id, ai_response],
        )
        await db._x(
            """UPDATE field_conversations
               SET message_count = message_count + 1, last_message = ?, updated_at = datetime('now')
               WHERE id = ?""",
            [ai_response[:120], conv_id],
        )

    return {"saved": True, "ai_response": ai_response}


@router.patch("/{opp_id}/{conv_id}/resolve")
async def resolve_conversation(
    opp_id:  int,
    conv_id: int,
    db:      Database = Depends(get_db),
):
    await db._x(
        """UPDATE field_conversations
           SET status = 'resolved', resolved_at = datetime('now')
           WHERE id = ? AND opp_id = ?""",
        [conv_id, opp_id],
    )
    return {"resolved": True}


@router.patch("/{opp_id}/{conv_id}/reopen")
async def reopen_conversation(
    opp_id:  int,
    conv_id: int,
    db:      Database = Depends(get_db),
):
    await db._x(
        """UPDATE field_conversations
           SET status = 'open', resolved_at = NULL
           WHERE id = ? AND opp_id = ?""",
        [conv_id, opp_id],
    )
    return {"reopened": True}
