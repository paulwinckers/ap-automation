"""
Outlook drafts with Aspire crew photos attached — for the Claude connector.

Claude can see work-ticket photos (connector) and can write Outlook drafts (Microsoft 365
connector), but it can't move a photo from one to the other. This endpoint does that step
server-side: it pulls the photos from Aspire, shrinks them to email size, and puts them on a
draft in the SIGNED-IN PERSON'S OWN mailbox. Nothing is ever sent — the person reviews the
draft in Outlook and sends it themselves.

  POST /mail/draft-with-photos
    attachment_ids  Aspire attachment ids (from get_ticket_photos), max 10, attached one by one
    collages        optional — [{label: "Before", attachment_ids: [...≤6]}, {label: "After", ...}]:
                    each group becomes ONE labelled grid image, shown in the email body (where
                    the body says [[PHOTOS]], else at the end) and attached as a file too
    draft_id        optional — add to this existing draft (e.g. one Claude just made with the
                    Microsoft 365 connector) instead of making a new one
    to / cc / subject / body_html   used when making a new draft

Needs the portal's Microsoft app to hold Mail.ReadWrite (application). Only the caller's own
mailbox is ever touched.
"""
import base64
import io
import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.auth import require_access
from app.api.aspire_attachments import _aspire
from app.services.email_intake import GRAPH_BASE, GraphClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/mail", tags=["mail-drafts"])
_graph = GraphClient()

MAX_PHOTOS = 10
MAX_PER_COLLAGE = 6
MAX_COLLAGES = 4
MAX_EDGE = 1600          # px — plenty for email, ~200–400 KB as JPEG
PLACEHOLDER = "[[PHOTOS]]"
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class CollageIn(BaseModel):
    label: str = Field(..., min_length=1, max_length=40)
    attachment_ids: list[int] = Field(..., min_length=1, max_length=MAX_PER_COLLAGE)


class DraftPhotosIn(BaseModel):
    attachment_ids: list[int] = Field(default_factory=list, max_length=MAX_PHOTOS)
    collages: list[CollageIn] = Field(default_factory=list, max_length=MAX_COLLAGES)
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


def _collage(raws: list[bytes], label: str) -> bytes:
    """1–6 photos → one labelled grid JPEG (1600 px wide). Each photo is cropped to fill its
    4:3 tile; a short last row is centred. The label sits in a green banner across the top."""
    from PIL import Image, ImageDraw, ImageFont, ImageOps
    n = len(raws)
    cols = {1: 1, 2: 2, 3: 3, 4: 2, 5: 3, 6: 3}[n]
    rows = -(-n // cols)
    W, gap, banner = 1600, 10, 90
    tw = (W - gap * (cols + 1)) // cols
    th = tw * 3 // 4
    H = banner + rows * th + (rows + 1) * gap
    canvas = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, 0, W, banner], fill="#2f6b3f")
    try:
        font = ImageFont.load_default(size=52)
    except TypeError:  # very old Pillow
        font = ImageFont.load_default()
    tb = draw.textbbox((0, 0), label, font=font)
    draw.text(((W - (tb[2] - tb[0])) // 2, (banner - (tb[3] - tb[1])) // 2 - tb[1]),
              label, fill="white", font=font)
    for i, raw in enumerate(raws):
        r, c = divmod(i, cols)
        in_row = min(cols, n - r * cols)
        x0 = (W - (in_row * tw + (in_row - 1) * gap)) // 2       # centre a short last row
        x = x0 + c * (tw + gap)
        y = banner + gap + r * (th + gap)
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
        canvas.paste(ImageOps.fit(img, (tw, th)), (x, y))
    buf = io.BytesIO()
    canvas.save(buf, "JPEG", quality=82, optimize=True)
    return buf.getvalue()


async def _photo_bytes(aid: int) -> tuple[bytes, str]:
    data = await _aspire.get_attachment_file_data(aid)
    if not data or not data.get("file_data"):
        raise HTTPException(status_code=404, detail=f"Photo {aid} not found in Aspire.")
    try:
        return base64.b64decode(data["file_data"]), data.get("file_name") or f"photo-{aid}.jpg"
    except Exception:
        raise HTTPException(status_code=502, detail=f"Photo {aid} came back unreadable from Aspire.")


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
    if not body.attachment_ids and not body.collages:
        raise HTTPException(status_code=400, detail="Pick at least one photo or collage.")

    # 1) Pull + shrink the photos / build the collages first, so a bad id fails before anything
    #    is created in Outlook.
    files: list[tuple[bytes, str, str, Optional[str]]] = []   # bytes, name, mime, inline content-id
    for aid in dict.fromkeys(body.attachment_ids):
        raw, fname = await _photo_bytes(aid)
        content, name, mime = _shrink(raw, fname)
        files.append((content, name, mime, None))
    for i, g in enumerate(body.collages, 1):
        raws = [(await _photo_bytes(aid))[0] for aid in dict.fromkeys(g.attachment_ids)]
        label = g.label.strip()
        try:
            content = _collage(raws, label)
        except Exception as e:
            logger.warning(f"collage '{label}' failed: {e}")
            raise HTTPException(status_code=422,
                                detail=f"Couldn't build the {label} collage — one of its files may not be a photo.")
        slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or f"collage-{i}"
        files.append((content, f"{slug}.jpg", "image/jpeg", f"collage{i}"))
    for content, name, _, _ in files:
        if len(content) > 3_000_000:
            raise HTTPException(status_code=413, detail=f"{name} is too large to attach ({len(content)//1024} KB).")

    # 2) The draft — an existing one, or a new one.
    if body.draft_id:
        msg = await _graph_call("GET", f"users/{mailbox}/messages/{body.draft_id}"
                                       "?$select=id,isDraft,subject,webLink,body")
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

    # 3) Attach one at a time (keeps each request well under Graph's size limit). Collages go in
    #    as inline images so they can show in the body.
    for content, name, mime, cid in files:
        att = {
            "@odata.type": "#microsoft.graph.fileAttachment",
            "name": name, "contentType": mime,
            "contentBytes": base64.b64encode(content).decode(),
        }
        if cid:
            att.update({"isInline": True, "contentId": cid})
        await _graph_call("POST", f"users/{mailbox}/messages/{msg['id']}/attachments", att)

    # 4) Show the collages in the body: where it says [[PHOTOS]], else at the end.
    cids = [(cid, name) for _, name, _, cid in files if cid]
    if cids:
        imgs = "".join(
            f'<p><img src="cid:{cid}" alt="{name}" width="600" style="max-width:100%;height:auto"></p>'
            for cid, name in cids)
        current = ((msg.get("body") or {}).get("content") if body.draft_id else body.body_html) or ""
        if PLACEHOLDER in current:
            new = current.replace(PLACEHOLDER, imgs, 1)
        elif "</body>" in current:
            new = current.replace("</body>", imgs + "</body>", 1)
        else:
            new = current + imgs
        await _graph_call("PATCH", f"users/{mailbox}/messages/{msg['id']}",
                          {"body": {"contentType": "HTML", "content": new}})

    return {
        "ok": True, "draft_id": msg["id"], "subject": msg.get("subject") or body.subject,
        "attached": [n for _, n, _, _ in files], "collages_in_body": len(cids),
        "web_link": msg.get("webLink"),
        "note": "Saved as a draft in your Outlook — nothing was sent.",
    }
