"""
Aspire Field Operations API.
Used by field crew from phones to:
  - Complete work tickets with photos + comments
  - Create new opportunities with photos

Photo strategy: direct attachment upload is 403 in Aspire, so photos are
stored in R2 and their presigned URLs are written into the WorkTicket/
Opportunity Notes field.
"""
import logging
import uuid
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile

from app.core.config import settings
from app.services.aspire import AspireClient
from app.services import r2

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/aspire/field", tags=["aspire-field"])

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

MAX_FILES     = 10
MAX_PHOTO_SIZE = 15  * 1024 * 1024   # 15 MB per photo/image
MAX_VIDEO_SIZE = 200 * 1024 * 1024   # 200 MB per video clip

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".webm", ".mkv"}

def _is_video(filename: str) -> bool:
    import os
    return os.path.splitext((filename or "").lower())[1] in VIDEO_EXTS


def _check_credentials():
    if not settings.ASPIRE_CLIENT_ID or not settings.ASPIRE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Aspire credentials not configured")


# ── Work ticket search ────────────────────────────────────────────────────────

@router.get("/opportunities/search")
async def search_opportunities(q: str = Query(..., min_length=2), limit: int = 15):
    """
    Search Won opportunities by name for the work ticket completion flow.
    Returns active (Won) jobs so crew can find the job they're on.
    """
    _check_credentials()
    results = await _aspire.search_opportunities_field(q, limit)
    return {"opportunities": results}


@router.get("/opportunities/{opportunity_id}/work-tickets")
async def get_opportunity_work_tickets(opportunity_id: int):
    """
    Return work tickets for a specific opportunity.
    Used after the crew selects their job — shows individual tickets to complete.
    """
    _check_credentials()
    tickets = await _aspire.get_work_tickets_summary(opportunity_id)
    return {"opportunity_id": opportunity_id, "tickets": tickets}


# ── Work ticket completion ────────────────────────────────────────────────────

@router.post("/work-ticket/{ticket_id}/complete")
async def complete_work_ticket(
    ticket_id:      int,
    submitter_name: str               = Form(...),
    comment:        str               = Form(...),
    photos:         List[UploadFile]  = File(default=[]),
):
    """
    Complete a work ticket: uploads photos to R2 then patches WorkTicket.Notes
    with the submitter, comment, and photo URLs.

    Photos are stored in R2 with 7-day presigned URLs (the URLs are embedded
    in Aspire's Notes field so anyone opening the ticket can view the photos).
    """
    _check_credentials()

    if len(photos) > MAX_FILES:
        raise HTTPException(
            status_code=400, detail=f"Maximum {MAX_FILES} files allowed"
        )

    # ── Upload photos to R2 ────────────────────────────────────────────────────
    photo_urls: list[str] = []
    for i, photo in enumerate(photos):
        raw = await photo.read()
        is_vid   = _is_video(photo.filename or "")
        max_size = MAX_VIDEO_SIZE if is_vid else MAX_PHOTO_SIZE
        if len(raw) > max_size:
            label = "200 MB per video" if is_vid else "15 MB per photo"
            raise HTTPException(
                status_code=413,
                detail=f"File {i+1} is too large (max {label})",
            )
        result = await r2.upload_field_photo(
            file_bytes=raw,
            filename=photo.filename or f"photo_{i+1}.jpg",
            submitter=submitter_name,
            entity_type="work-ticket",
            entity_id=str(ticket_id),
        )
        if result:
            _key, url = result
            photo_urls.append(url)
        else:
            logger.warning(
                f"R2 not available for work ticket {ticket_id} photo {i+1} — "
                "photo not saved"
            )

    # ── Build notes text ───────────────────────────────────────────────────────
    lines = [
        f"Completed by: {submitter_name}",
        f"Date: {date.today().isoformat()}",
        "",
        comment,
    ]
    if photo_urls:
        lines.append(f"\nPhotos ({len(photo_urls)}):")
        for idx, url in enumerate(photo_urls, 1):
            lines.append(f"  {idx}. {url}")
    notes_text = "\n".join(lines)

    # ── Patch Aspire WorkTicket ────────────────────────────────────────────────
    try:
        await _aspire.patch_work_ticket_notes(ticket_id, notes_text)
    except Exception as e:
        logger.error(f"WorkTicket PATCH failed for ticket {ticket_id}: {e}")
        raise HTTPException(
            status_code=502,
            detail=f"Photos saved to cloud storage but failed to update Aspire: {e}",
        )

    return {
        "success":         True,
        "ticket_id":       ticket_id,
        "photos_uploaded": len(photo_urls),
        "submitter":       submitter_name,
    }


# ── Lead sources & sales types ───────────────────────────────────────────────

@router.get("/lead-sources")
async def get_lead_sources():
    """Return all Aspire lead sources for the opportunity creation form."""
    _check_credentials()
    sources = await _aspire.get_lead_sources()
    return {"lead_sources": sources}


@router.get("/sales-types")
async def get_sales_types():
    """Return all Aspire sales types for the opportunity creation form."""
    _check_credentials()
    types = await _aspire.get_sales_types()
    return {"sales_types": types}


# ── Property search (for new opportunity flow) ────────────────────────────────

@router.get("/properties/search")
async def search_properties(q: str = Query(..., min_length=2), limit: int = 15):
    """
    Search existing opportunities to find unique property names + IDs.
    Since /Properties is 403 in Aspire's API, we derive properties from
    existing opportunities that share the same property.
    """
    _check_credentials()
    results = await _aspire.search_all_opportunities_field(q, limit)
    return {"properties": results}


# ── Opportunity creation ──────────────────────────────────────────────────────

DIVISION_MAP = {
    2:  "Residential Maintenance",
    8:  "Construction",
    9:  "Commercial Maintenance",
    6:  "Snow",
    7:  "Irrigation / Lighting",
}

@router.post("/opportunity")
async def create_opportunity(
    submitter_name:    str               = Form(...),
    opportunity_name:  str               = Form(...),
    division_id:       int               = Form(...),
    estimated_value:   float             = Form(default=0.0),
    notes:             str               = Form(default=""),
    property_id:       Optional[int]     = Form(default=None),
    property_name_fyi: Optional[str]     = Form(default=None),
    due_date:          Optional[str]     = Form(default=None),
    start_date:        Optional[str]     = Form(default=None),
    end_date:          Optional[str]     = Form(default=None),
    lead_source_id:    Optional[int]     = Form(default=None),
    lead_source_name:  Optional[str]     = Form(default=None),
    sales_type_id:     Optional[int]     = Form(default=None),
    sales_type_name:   Optional[str]     = Form(default=None),
    photos:            List[UploadFile]  = File(default=[]),
):
    """
    Create a new Aspire Opportunity.
    Photos are uploaded to R2 and their URLs are embedded in the opportunity Notes.

    Required: opportunity_name, division_id, submitter_name
    Optional: property_id (from /properties/search), estimated_value, notes, photos
    """
    _check_credentials()

    if len(photos) > MAX_FILES:
        raise HTTPException(
            status_code=400, detail=f"Maximum {MAX_FILES} files allowed"
        )

    if division_id not in DIVISION_MAP:
        valid = ", ".join(f"{k} ({v})" for k, v in DIVISION_MAP.items())
        raise HTTPException(
            status_code=400,
            detail=f"Invalid division_id {division_id}. Valid options: {valid}",
        )

    # ── Upload photos to R2 ────────────────────────────────────────────────────
    # Use a temporary UUID as entity_id (no opportunity ID yet)
    temp_id = uuid.uuid4().hex[:12]
    photo_urls: list[str] = []
    for i, photo in enumerate(photos):
        raw = await photo.read()
        is_vid   = _is_video(photo.filename or "")
        max_size = MAX_VIDEO_SIZE if is_vid else MAX_PHOTO_SIZE
        if len(raw) > max_size:
            label = "200 MB per video" if is_vid else "15 MB per photo"
            raise HTTPException(
                status_code=413,
                detail=f"File {i+1} is too large (max {label})",
            )
        result = await r2.upload_field_photo(
            file_bytes=raw,
            filename=photo.filename or f"photo_{i+1}.jpg",
            submitter=submitter_name,
            entity_type="opportunity",
            entity_id=temp_id,
        )
        if result:
            _key, url = result
            photo_urls.append(url)

    # ── Build notes ────────────────────────────────────────────────────────────
    lines = [
        f"Created by: {submitter_name}",
        f"Date: {date.today().isoformat()}",
        f"Division: {DIVISION_MAP[division_id]}",
    ]
    if property_name_fyi:
        lines.append(f"Property: {property_name_fyi}")
    if notes:
        lines.append(f"\n{notes}")
    if photo_urls:
        lines.append(f"\nPhotos ({len(photo_urls)}):")
        for idx, url in enumerate(photo_urls, 1):
            lines.append(f"  {idx}. {url}")
    notes_text = "\n".join(lines)

    # ── POST to Aspire ─────────────────────────────────────────────────────────
    body: dict = {
        "OpportunityName":  opportunity_name,
        "DivisionID":       division_id,
        "BranchID":         settings.ASPIRE_BRANCH_ID or 2,
        "Notes":            notes_text,
        "EstimatedDollars": estimated_value,
    }
    if property_id:
        body["PropertyID"] = property_id
    if due_date:
        body["DueDate"] = due_date
    if start_date:
        body["StartDate"] = start_date
    if end_date:
        body["EndDate"] = end_date
    if lead_source_id:
        body["LeadSourceID"] = lead_source_id
    if sales_type_id:
        body["SalesTypeID"] = sales_type_id

    try:
        result = await _aspire.create_opportunity(body)
    except Exception as e:
        logger.error(f"Opportunity creation failed: {e}")
        raise HTTPException(
            status_code=502,
            detail=f"Failed to create opportunity in Aspire: {e}",
        )

    logger.info(f"Aspire create_opportunity response: {result}")

    # Aspire may return a plain integer (the OpportunityID) or a full object
    if isinstance(result, (int, float)):
        opp_id     = int(result)
        opp_number = None
    else:
        opp_id = (
            result.get("OpportunityID")
            or result.get("Id")
            or result.get("id")
            or "unknown"
        )
        opp_number = (
            result.get("OpportunityNumber")
            or result.get("opportunityNumber")
        )

    logger.info(
        f"New opportunity created: ID={opp_id} #={opp_number} '{opportunity_name}' "
        f"by {submitter_name}, {len(photo_urls)} photo(s)"
    )

    return {
        "success":              True,
        "opportunity_id":       opp_id,
        "opportunity_number":   opp_number,
        "opportunity_name":     opportunity_name,
        "photos_uploaded":      len(photo_urls),
        "submitter":            submitter_name,
    }
