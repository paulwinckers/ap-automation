"""
Aspire work-ticket attachments (crew photos) — read-only proxy.

Crew photos taken in the Aspire mobile app live in Aspire's /Attachments store, keyed by
WorkTicketID (distinct from our own job_attachments R2 photos, which are portal uploads).
This router lists a ticket's Aspire photos and streams a single photo's bytes so they can
be shown in the portal (Customer 360) or pulled into a field review.

GET /aspire/ticket/{work_ticket_id}/photos   — metadata list (gated); each photo carries a
                                                signed `file_url`.
GET /aspire/attachment/{attachment_id}/file   — the decoded image bytes. Accepts EITHER a
                                                logged-in/service caller OR a valid short-lived
                                                signature (so <img src> works without headers).

`signed_attachment_url()` is reused by customer_dashboard to embed photos in the 360 payload.
"""
import base64
import hashlib
import hmac
import logging
import time

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from app.core.config import settings
from app.services.aspire import AspireClient
from app.api.auth import require_access, optional_actor

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/aspire", tags=["aspire-attachments"])
_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

_MIME = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "heic": "image/heic", "heif": "image/heif", "webp": "image/webp",
    "gif": "image/gif", "bmp": "image/bmp", "tif": "image/tiff", "tiff": "image/tiff",
}

_DEFAULT_TTL = 6 * 3600  # 6h, like R2 presigned URLs


def _sign(attachment_id: int, exp: int) -> str:
    secret = (settings.SERVICE_API_KEY or "dev-unsigned").encode()
    return hmac.new(secret, f"{attachment_id}:{exp}".encode(), hashlib.sha256).hexdigest()[:32]


def signed_attachment_url(attachment_id: int, ttl: int = _DEFAULT_TTL) -> str:
    """A relative, header-free URL for one attachment's bytes, valid for `ttl` seconds."""
    exp = int(time.time()) + ttl
    return f"/aspire/attachment/{attachment_id}/file?exp={exp}&sig={_sign(attachment_id, exp)}"


@router.get("/ticket/{work_ticket_id}/photos", dependencies=[Depends(require_access)])
async def ticket_photos(work_ticket_id: int, images_only: bool = True):
    """List the photos (default) or all attachments on an Aspire work ticket. Each row carries
    a signed `file_url` that serves the decoded bytes via the endpoint below."""
    atts = await _aspire.get_work_ticket_attachments(work_ticket_id, images_only=images_only)
    for a in atts:
        a["file_url"] = signed_attachment_url(a["attachment_id"])
    return {
        "work_ticket_id": work_ticket_id,
        "count": len(atts),
        "images_only": images_only,
        "photos": atts,
    }


@router.get("/attachment/{attachment_id}/file")
async def attachment_file(
    attachment_id: int,
    exp: int = 0,
    sig: str = "",
    download: bool = False,
    actor=Depends(optional_actor),
):
    """Stream one Aspire attachment's decoded bytes with the right image content-type.
    Authorized by a logged-in/service caller OR a valid, unexpired signature (for <img>)."""
    valid_sig = bool(sig) and exp > time.time() and hmac.compare_digest(sig, _sign(attachment_id, exp))
    if actor is None and not valid_sig:
        raise HTTPException(status_code=401, detail="Not authorized for this attachment")

    data = await _aspire.get_attachment_file_data(attachment_id)
    if not data or not data.get("file_data"):
        raise HTTPException(status_code=404, detail="Attachment not found or has no data")
    try:
        raw = base64.b64decode(data["file_data"])
    except Exception:
        raise HTTPException(status_code=502, detail="Attachment data was not valid base64")

    name = data.get("file_name") or f"attachment-{attachment_id}"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else "jpg"
    media = _MIME.get(ext, "application/octet-stream")
    headers = {"Cache-Control": "private, max-age=3600"}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{name}"'
    return Response(content=raw, media_type=media, headers=headers)
