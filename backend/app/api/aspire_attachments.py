"""
Aspire work-ticket attachments (crew photos) — read-only proxy.

Crew photos taken in the Aspire mobile app live in Aspire's /Attachments store, keyed by
WorkTicketID (distinct from our own job_attachments R2 photos, which are portal uploads).
This router lists a ticket's Aspire photos and streams a single photo's bytes so they can
be shown in the portal or pulled into a field review.

GET /aspire/ticket/{work_ticket_id}/photos   — metadata list (attachment_id, name, geo, flags, file_url)
GET /aspire/attachment/{attachment_id}/file   — the decoded image bytes (image/jpeg, …)

Both are gated (require_access) at include time in main.py.
"""
import base64
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app.core.config import settings
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/aspire", tags=["aspire-attachments"])
_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

_MIME = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "heic": "image/heic", "heif": "image/heif", "webp": "image/webp",
    "gif": "image/gif", "bmp": "image/bmp", "tif": "image/tiff", "tiff": "image/tiff",
}


@router.get("/ticket/{work_ticket_id}/photos")
async def ticket_photos(work_ticket_id: int, images_only: bool = True):
    """List the photos (default) or all attachments on an Aspire work ticket. Each row
    carries a `file_url` that serves the decoded bytes via the endpoint below."""
    atts = await _aspire.get_work_ticket_attachments(work_ticket_id, images_only=images_only)
    for a in atts:
        a["file_url"] = f"/aspire/attachment/{a['attachment_id']}/file"
    return {
        "work_ticket_id": work_ticket_id,
        "count": len(atts),
        "images_only": images_only,
        "photos": atts,
    }


@router.get("/attachment/{attachment_id}/file")
async def attachment_file(attachment_id: int, download: bool = False):
    """Stream one Aspire attachment's decoded bytes with the right image content-type.
    `download=true` sets a Content-Disposition attachment header."""
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
