"""
Outlook drafts with Aspire crew photos attached — for the Claude connector.

Claude can see work-ticket photos (connector) and can write Outlook drafts (Microsoft 365
connector), but it can't move a photo from one to the other. This endpoint does that step
server-side: it pulls the photos from Aspire, shrinks them to email size, and puts them on a
draft in the SIGNED-IN PERSON'S OWN mailbox. Nothing is ever sent — the person reviews the
draft in Outlook and sends it themselves.

  POST /mail/draft-with-photos
    attachment_ids  Aspire attachment ids (from get_ticket_photos), max 10
    draft_id        optional — add the photos to this existing draft (e.g. one Claude just
                    made with the Microsoft 365 connector) instead of making a new one
    to / cc / subject / body_html   used when making a new draft

Needs the portal's Microsoft app to hold Mail.ReadWrite (application). Only the caller's own
mailbox is ever touched.
"""
import base64
import io
import logging
import re
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.auth import require_access
from app.api.aspire_attachments import _aspire
from app.services.email_intake import GRAPH_BASE, GraphClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/mail", tags=["mail-drafts"])
_graph = GraphClient()

MAX_PHOTOS = 10
MAX_EDGE = 1600          # px — plenty for email, ~200–400 KB as JPEG
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class DraftPhotosIn(BaseModel):
    attachment_ids: list[int] = Field(..., min_length=1, max_length=MAX_PHOTOS)
    draft_id: Optional[str] = Field(None, max_length=512)
    to: list[str] = []
    cc: list[str] = []
    subject: Optional[str] = Field(None, max_length=255)
    body_html: Optional[str] = Field(None, max_length=200_000)


def _shrink(raw: bytes, name: str) -> tuple[bytes, str, str]:
    """Phone photos → a JPEG no wider/taller than MAX_EDGE. Non-images pass through."""
    try:
        from PIL import Image, ImageOps
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img)
        img.thumbnail((MAX_EDGE, MAX_EDGE))
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=82, optimize=True)
        stem = name.rsplit(".", 1)[0] if "." in name else name
        return buf.getvalue(), f"{stem}.jpg", "image/jpeg"
    except Exception:
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        mime = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg",
                "jpeg": "image/jpeg"}.get(ext, "application/octet-stream")
        return raw, name, mime


async def _graph_call(method: str, path: str, body: Optional[dict] = None) -> dict:
    h = await _graph._headers()
    h["Content-Type"] = "application/json"
    h["Prefer"] = 'IdType="ImmutableId"'   # the Microsoft 365 connector hands out immutable ids
    r = await _graph._http.request(method, f"{GRAPH_BASE}/{path}", json=body, headers=h)
    if r.status_code in (401, 403):
        raise HTTPException(status_code=502, detail=(
            "The portal isn't allowed to write to Outlook drafts yet — an admin needs to grant the "
            "portal's Microsoft app the Mail.ReadWrite (application) permission."))
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="That draft wasn't found in your mailbox.")
    if r.status_code >= 400:
        logger.warning(f"graph {method} {path} → {r.status_code}: {r.text[:300]}")
        raise HTTPException(status_code=502, detail=f"Outlook refused the request ({r.status_code}).")
    return r.json() if r.content else {}


@router.post("/draft-with-photos")
async def draft_with_photos(body: DraftPhotosIn, user: dict = Depends(require_access)):
    # Same reach as viewing the photos themselves (the /aspire/ticket photo list).
    from app.api.permissions import area_for, user_areas
    need = area_for("GET", "/aspire/ticket/{work_ticket_id}/photos")
    if need and need not in user_areas(user):
        raise HTTPException(status_code=403, detail="You don't have access to crew photos.")
    mailbox = (user.get("email") or "").strip().lower()
    if not mailbox.endswith("@darios.ca"):
        raise HTTPException(status_code=400, detail="Drafts can only be made in a darios.ca mailbox.")
    bad = [a for a in body.to + body.cc if not _EMAIL.match(a.strip())]
    if bad:
        raise HTTPException(status_code=400, detail=f"Not an email address: {', '.join(bad)}")

    # 1) Pull + shrink the photos first, so a bad id fails before anything is created.
    files = []
    for aid in dict.fromkeys(body.attachment_ids):
        data = await _aspire.get_attachment_file_data(aid)
        if not data or not data.get("file_data"):
            raise HTTPException(status_code=404, detail=f"Photo {aid} not found in Aspire.")
        try:
            raw = base64.b64decode(data["file_data"])
        except Exception:
            raise HTTPException(status_code=502, detail=f"Photo {aid} came back unreadable from Aspire.")
        content, name, mime = _shrink(raw, data.get("file_name") or f"photo-{aid}.jpg")
        if len(content) > 3_000_000:
            raise HTTPException(status_code=413, detail=f"Photo {aid} is too large to attach ({len(content)//1024} KB).")
        files.append((content, name, mime))

    # 2) The draft — an existing one, or a new one.
    if body.draft_id:
        msg = await _graph_call("GET", f"users/{mailbox}/messages/{body.draft_id}?$select=id,isDraft,subject,webLink")
        if not msg.get("isDraft"):
            raise HTTPException(status_code=400, detail="That message has already been sent — it isn't a draft.")
    else:
        if not body.subject:
            raise HTTPException(status_code=400, detail="A new draft needs a subject.")
        msg = await _graph_call("POST", f"users/{mailbox}/messages", {
            "subject": body.subject,
            "body": {"contentType": "HTML", "content": body.body_html or ""},
            "toRecipients": [{"emailAddress": {"address": a.strip()}} for a in body.to],
            "ccRecipients": [{"emailAddress": {"address": a.strip()}} for a in body.cc],
        })

    # 3) Attach one at a time (keeps each request well under Graph's size limit).
    for content, name, mime in files:
        await _graph_call("POST", f"users/{mailbox}/messages/{msg['id']}/attachments", {
            "@odata.type": "#microsoft.graph.fileAttachment",
            "name": name, "contentType": mime,
            "contentBytes": base64.b64encode(content).decode(),
        })

    return {
        "ok": True, "draft_id": msg["id"], "subject": msg.get("subject") or body.subject,
        "attached": [n for _, n, _ in files], "web_link": msg.get("webLink"),
        "note": "Saved as a draft in your Outlook — nothing was sent.",
    }
