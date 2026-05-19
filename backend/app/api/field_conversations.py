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
import base64
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


# ── WhatsApp helpers ──────────────────────────────────────────────────────────

def _format_whatsapp_number(raw: str) -> str:
    """Normalise a phone number to whatsapp:+1XXXXXXXXXX format."""
    raw = raw.strip()
    if raw.startswith("whatsapp:"):
        return raw
    digits = "".join(c for c in raw if c.isdigit())
    if len(digits) == 10:          # bare Canadian/US number
        digits = "1" + digits
    return f"whatsapp:+{digits}"


def _twilio_send(body: str, to: str) -> None:
    """Fire a single WhatsApp message via Twilio (call from executor)."""
    sid   = settings.TWILIO_ACCOUNT_SID
    token = settings.TWILIO_AUTH_TOKEN
    frm   = settings.TWILIO_WHATSAPP_FROM
    if not (sid and token and frm and to and to.strip()):
        return
    try:
        from twilio.rest import Client as TwilioClient
        TwilioClient(sid, token).messages.create(body=body, from_=frm, to=to)
        logger.info(f"WhatsApp sent → {to}")
    except Exception as e:
        logger.warning(f"WhatsApp failed → {to}: {e}")


def _deep_link(context_type: str, opp_id: int, conv_id: int | None = None) -> str:
    base = (
        f"https://darios-ap.pages.dev/field/project/{opp_id}"
        if context_type == "construction"
        else f"https://darios-ap.pages.dev/field/maintenance/{opp_id}"
    )
    if conv_id:
        return f"{base}?tab=conversations&conv={conv_id}"
    return base


def _notify_crew_whatsapp(
    crew_whatsapp: str,
    opp_id: int,
    context_type: str,
    property_name: str,
    title: str,
    reply_content: str,
    sender_name: str,
    conv_id: int | None = None,
) -> None:
    """Notify the crew lead that a manager or AI has replied."""
    wa_to = _format_whatsapp_number(crew_whatsapp)
    preview = reply_content.strip()[:150] + ("…" if len(reply_content.strip()) > 150 else "")
    body = (
        f"💬 *Reply on your issue*\n"
        f"Property: {property_name}\n"
        f"Topic: {title}\n"
        f"From: {sender_name}\n\n"
        f"{preview}\n\n"
        f"🔗 View thread: {_deep_link(context_type, opp_id, conv_id)}"
    )
    _twilio_send(body, wa_to)


def _notify_watchers(
    watchers: list[dict],
    opp_id: int,
    context_type: str,
    property_name: str,
    title: str,
    crew_name: str,
    message_preview: str,
    is_new: bool = False,
    tag: Optional[str] = None,
    conv_id: int | None = None,
) -> None:
    """Notify all watchers — used for new conversations and crew follow-ups."""
    if not watchers:
        return
    ctx_label  = "🏗️ Construction" if context_type == "construction" else "🌿 Maintenance"
    tag_label  = f"  [{tag}]" if tag else ""
    crew_label = (crew_name or "Crew").strip() or "Crew"
    preview    = message_preview.strip()[:150] + ("…" if len(message_preview.strip()) > 150 else "")
    link       = _deep_link(context_type, opp_id, conv_id)

    if is_new:
        body = (
            f"{ctx_label} *New Issue Filed*\n"
            f"Property: {property_name}\n"
            f"Crew: {crew_label}\n"
            f"Topic: {title}{tag_label}\n\n"
            f"{preview}\n\n"
            f"🔗 {link}"
        )
    else:
        body = (
            f"💬 *Crew follow-up*\n"
            f"Property: {property_name}\n"
            f"Topic: {title}\n"
            f"From: {crew_label}\n\n"
            f"{preview}\n\n"
            f"🔗 {link}"
        )

    for w in watchers:
        _twilio_send(body, w["whatsapp"])


async def _auto_add_watchers(
    db: Database,
    conv_id: int,
    user_id_filter: list[int] | None = None,
) -> list[dict]:
    """
    Insert active users with phones as watchers.
    If user_id_filter is provided, only those IDs are added.
    Returns the inserted list so callers can notify without a second query.
    """
    managers = await db._q(
        "SELECT id, name, phone FROM users WHERE active = 1 AND phone IS NOT NULL AND phone != ''",
    )
    if user_id_filter is not None:
        managers = [m for m in managers if m["id"] in user_id_filter]
    result = []
    for m in managers:
        wa = _format_whatsapp_number(m["phone"])
        try:
            await db._x(
                """INSERT OR IGNORE INTO conversation_watchers
                     (conversation_id, user_id, name, whatsapp)
                   VALUES (?, ?, ?, ?)""",
                [conv_id, m["id"], m["name"], wa],
            )
            result.append({"user_id": m["id"], "name": m["name"], "whatsapp": wa})
        except Exception:
            pass
    return result


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

_VISION_TYPES  = {"image/jpeg", "image/png", "image/gif", "image/webp"}
_MAX_IMG_BYTES = 4 * 1024 * 1024   # 4 MB — stay under Anthropic's 5 MB vision limit


async def _build_content(text: str, photo_r2_key: Optional[str] = None):
    """Return a plain string or a multimodal content list for the Anthropic API."""
    if not photo_r2_key:
        return text or ""
    try:
        img_bytes = await _r2.get_file_bytes(photo_r2_key)
        if not img_bytes:
            logger.info(f"R2 returned no bytes for {photo_r2_key} — text-only AI call")
            return text or ""

        if len(img_bytes) > _MAX_IMG_BYTES:
            logger.warning(f"Photo {photo_r2_key} too large ({len(img_bytes)} bytes) — text-only AI call")
            return text or ""

        ext        = (photo_r2_key.rsplit(".", 1)[-1] if "." in photo_r2_key else "jpg").lower()
        media_type = _MIME_OVERRIDE.get(ext, "image/jpeg")
        if media_type not in _VISION_TYPES:
            logger.info(f"Photo type {media_type} not supported for vision — text-only AI call")
            return text or ""

        b64    = base64.standard_b64encode(img_bytes).decode()
        blocks: list = [{"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}}]
        blocks.append({"type": "text", "text": text or "(see attached photo)"})
        logger.info(f"Vision block built for {photo_r2_key} ({len(img_bytes)} bytes, {media_type})")
        return blocks
    except Exception as exc:
        logger.warning(f"_build_content failed for {photo_r2_key}: {exc} — text-only AI call")
        return text or ""


def _merge_content(a, b):
    """Merge two consecutive same-role content values (string or list)."""
    def _to_list(c):
        return c if isinstance(c, list) else [{"type": "text", "text": c}]
    if isinstance(a, str) and isinstance(b, str):
        return a + "\n\n" + b
    return _to_list(a) + _to_list(b)


async def _ask_ai(title: str, tag: Optional[str], messages: list[dict]) -> str:
    """Call Claude with conversation history. Returns AI text."""
    try:
        client = _anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        system = AI_SYSTEM + f"\n\nConversation topic: {title}"
        if tag:
            system += f"\nCategory: {tag}"

        has_vision = any(isinstance(m.get("content"), list) for m in messages)
        logger.info(f"AI call: {len(messages)} message(s), vision={has_vision}")

        resp = await client.messages.create(
            model="claude-opus-4-5",
            max_tokens=1024,
            system=system,
            messages=messages,
        )
        return resp.content[0].text
    except Exception as e:
        logger.error(f"Field conversations AI call failed: {type(e).__name__}: {e}")
        return "Sorry, I couldn't reach the AI advisor right now. Please try again."


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/notifiable-users")
async def notifiable_users(db: Database = Depends(get_db)):
    """Public — return active users with phones so field crew can pick who to notify."""
    rows = await db._q(
        "SELECT id, name FROM users WHERE active = 1 AND phone IS NOT NULL AND phone != '' ORDER BY name",
    )
    return {"users": rows or []}


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
    opp_id:           int,
    title:            str                  = Form(...),
    context_type:     str                  = Form(default="maintenance"),
    tag:              Optional[str]        = Form(default=None),
    first_message:    str                  = Form(...),
    crew_name:        Optional[str]        = Form(default=None),
    crew_whatsapp:    Optional[str]        = Form(default=None),
    property_name:    Optional[str]        = Form(default=None),
    use_ai:           int                  = Form(default=0),
    tagged_user_ids:  str                  = Form(default=""),  # comma-separated user IDs
    photo:            Optional[UploadFile] = File(default=None),
    db:               Database             = Depends(get_db),
):
    """Create a new conversation thread with an initial crew message."""
    tag = tag if tag in VALID_TAGS else None
    wa  = crew_whatsapp.strip() if crew_whatsapp and crew_whatsapp.strip() else None

    # 1. Create conversation record
    prop = (property_name or f"Opp #{opp_id}").strip()
    conv_id = await db._x(
        """INSERT INTO field_conversations
             (opp_id, context_type, title, tag, created_by, crew_whatsapp,
              message_count, last_message, property_name, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, datetime('now'))""",
        [opp_id, context_type, title.strip(), tag, crew_name, wa, first_message.strip()[:120], prop],
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
        first_content = await _build_content(first_message.strip(), photo_r2_key)
        ai_response = await _ask_ai(
            title=title,
            tag=tag,
            messages=[{"role": "user", "content": first_content}],
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

    # 5. Add tagged managers as watchers, then notify them
    prop_name = prop  # already resolved above

    # Parse selected user IDs from form (empty = add all)
    selected_ids: list[int] | None = None
    if tagged_user_ids.strip():
        try:
            selected_ids = [int(x) for x in tagged_user_ids.split(",") if x.strip()]
        except ValueError:
            selected_ids = None

    watchers = await _auto_add_watchers(db, conv_id, user_id_filter=selected_ids)
    if watchers:
        asyncio.get_event_loop().run_in_executor(
            None, _notify_watchers,
            watchers, opp_id, context_type, prop_name,
            title.strip(), crew_name or "", first_message.strip(), True, tag, conv_id,
        )
    elif selected_ids is None:
        # Fallback only when no selection was made AND no DB watchers exist yet
        # (i.e. users haven't added phone numbers yet) — use TWILIO_WHATSAPP_TO env var
        raw_to = (
            settings.TWILIO_WHATSAPP_TO_CONSTRUCTION
            if context_type == "construction" and settings.TWILIO_WHATSAPP_TO_CONSTRUCTION
            else settings.TWILIO_WHATSAPP_TO
        )
        fallback = [
            {"name": "Manager", "whatsapp": t.strip()}
            for t in raw_to.split(",") if t.strip()
        ]
        if fallback:
            logger.info("No DB watchers — falling back to TWILIO_WHATSAPP_TO env var")
            asyncio.get_event_loop().run_in_executor(
                None, _notify_watchers,
                fallback, opp_id, context_type, prop_name,
                title.strip(), crew_name or "", first_message.strip(), True, tag, conv_id,
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

    # Attach presigned photo URLs for messages that have photos
    enriched = []
    for m in (msgs or []):
        msg = dict(m)
        key = msg.get("photo_r2_key")
        if key:
            try:
                msg["photo_url"] = await _r2.get_presigned_url(key, expires_in=3600)
            except Exception:
                msg["photo_url"] = None
        else:
            msg["photo_url"] = None
        enriched.append(msg)

    watchers = await db._q(
        "SELECT id, user_id, name, whatsapp, added_at FROM conversation_watchers WHERE conversation_id = ? ORDER BY name",
        [conv_id],
    )
    return {"conversation": rows[0], "messages": enriched, "watchers": watchers or []}


@router.post("/{opp_id}/{conv_id}/messages")
async def add_message(
    opp_id:       int,
    conv_id:      int,
    content:      str                  = Form(...),
    crew_name:    Optional[str]        = Form(default=None),
    sender_role:  str                  = Form(default="crew"),   # 'crew' | 'manager'
    manager_name: Optional[str]        = Form(default=None),
    use_ai:       int                  = Form(default=0),
    photo:        Optional[UploadFile] = File(default=None),
    db:           Database             = Depends(get_db),
):
    """Add a message to an existing conversation, optionally with AI reply."""
    rows = await db._q(
        "SELECT * FROM field_conversations WHERE id = ? AND opp_id = ?",
        [conv_id, opp_id],
    )
    if not rows:
        raise HTTPException(404, "Conversation not found")
    conv = rows[0]

    # Upload photo
    photo_r2_key, has_photo = await _upload_photo(photo, opp_id, conv_id)

    # Determine role and display name
    role         = "manager" if sender_role == "manager" else "crew"
    display_name = (manager_name or "Manager").strip() if role == "manager" else (crew_name or "")

    # Save message
    await db._x(
        """INSERT INTO field_conversation_messages
             (conversation_id, role, crew_name, content, has_photo, photo_r2_key)
           VALUES (?, ?, ?, ?, ?, ?)""",
        [conv_id, role, display_name, content.strip(), has_photo, photo_r2_key],
    )
    await db._x(
        """UPDATE field_conversations
           SET message_count = message_count + 1, last_message = ?, updated_at = datetime('now')
           WHERE id = ?""",
        [content.strip()[:120], conv_id],
    )

    crew_wa = conv.get("crew_whatsapp") or ""
    prop    = conv.get("property_name") or f"Opp #{opp_id}"
    ctx     = conv.get("context_type") or "maintenance"

    if role == "manager" and crew_wa:
        # Manager replied → notify crew
        asyncio.get_event_loop().run_in_executor(
            None, _notify_crew_whatsapp,
            crew_wa, opp_id, ctx, prop, conv["title"], content.strip(), display_name, conv_id,
        )
    elif role == "crew":
        # Crew follow-up → notify all watchers
        watchers = await db._q(
            "SELECT name, whatsapp FROM conversation_watchers WHERE conversation_id = ?",
            [conv_id],
        )
        if watchers:
            asyncio.get_event_loop().run_in_executor(
                None, _notify_watchers,
                list(watchers), opp_id, ctx, prop,
                conv["title"], display_name, content.strip(), False, None, conv_id,
            )

    ai_response = None
    if use_ai:
        # Build message history for Claude (including photos as vision blocks)
        history_rows = await db._q(
            """SELECT role, content, photo_r2_key FROM field_conversation_messages
               WHERE conversation_id = ? ORDER BY created_at ASC""",
            [conv_id],
        )
        messages: list[dict] = []
        for row in history_rows:
            claude_role = "assistant" if row["role"] in ("ai", "manager") else "user"
            content = await _build_content(row["content"], row.get("photo_r2_key"))
            # Claude requires alternating roles — merge consecutive same-role messages
            if messages and messages[-1]["role"] == claude_role:
                messages[-1]["content"] = _merge_content(messages[-1]["content"], content)
            else:
                messages.append({"role": claude_role, "content": content})

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

        # Notify crew when AI responds (they asked for it)
        if crew_wa:
            asyncio.get_event_loop().run_in_executor(
                None, _notify_crew_whatsapp,
                crew_wa, opp_id, ctx, prop, conv["title"], ai_response, "Field Advisor (AI)", conv_id,
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


# ── Watcher management ────────────────────────────────────────────────────────

@router.get("/{opp_id}/{conv_id}/watchers")
async def list_watchers(
    opp_id:  int,
    conv_id: int,
    db:      Database = Depends(get_db),
):
    rows = await db._q(
        "SELECT id, user_id, name, whatsapp, added_at FROM conversation_watchers WHERE conversation_id = ? ORDER BY name",
        [conv_id],
    )
    return {"watchers": rows or []}


@router.post("/{opp_id}/{conv_id}/watchers")
async def add_watcher(
    opp_id:   int,
    conv_id:  int,
    user_id:  Optional[int] = Form(default=None),
    name:     str           = Form(...),
    whatsapp: str           = Form(...),
    db:       Database      = Depends(get_db),
):
    wa = _format_whatsapp_number(whatsapp)
    try:
        wid = await db._x(
            """INSERT OR IGNORE INTO conversation_watchers
                 (conversation_id, user_id, name, whatsapp)
               VALUES (?, ?, ?, ?)""",
            [conv_id, user_id, name.strip(), wa],
        )
    except Exception as exc:
        raise HTTPException(409, f"Already watching: {exc}") from exc
    return {"id": wid, "user_id": user_id, "name": name.strip(), "whatsapp": wa}


@router.delete("/{opp_id}/{conv_id}/watchers/{watcher_id}")
async def remove_watcher(
    opp_id:     int,
    conv_id:    int,
    watcher_id: int,
    db:         Database = Depends(get_db),
):
    await db._x(
        "DELETE FROM conversation_watchers WHERE id = ? AND conversation_id = ?",
        [watcher_id, conv_id],
    )
    return {"removed": True}
