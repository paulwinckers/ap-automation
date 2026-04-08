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


# ── Employees (Aspire Contacts) ──────────────────────────────────────────────

@router.get("/employees")
async def get_employees():
    """Return Aspire employees (ContactType = Employee) for submitter name selection."""
    _check_credentials()
    employees = await _aspire.get_aspire_employees()
    return {"employees": employees}


# ── Work ticket field probe ───────────────────────────────────────────────────

@router.get("/work-tickets/probe")
async def probe_work_ticket_fields():
    """
    Return all fields present on a sample WorkTicket.
    Use this to identify the correct route / crew field name.
    """
    _check_credentials()
    return await _aspire.probe_work_ticket_fields()


# ── Scheduled work tickets ───────────────────────────────────────────────────

@router.get("/work-tickets/scheduled")
async def get_scheduled_tickets(range: str = Query(default="today", pattern="^(today|past|upcoming)$")):
    """
    Return work tickets grouped by route.
    range: today | past (last 14 days) | upcoming (next 30 days)
    Each route contains a list of tickets with OpportunityName and PropertyName.
    """
    _check_credentials()
    tickets = await _aspire.get_scheduled_work_tickets(range)

    # Group by _RouteName
    from collections import defaultdict
    groups: dict = defaultdict(list)
    for t in tickets:
        groups[t.get("_RouteName", "Unassigned")].append(t)

    routes = [
        {
            "route_name":   name,
            "ticket_count": len(tix),
            "tickets":      tix,
        }
        for name, tix in sorted(groups.items())
    ]
    return {"routes": routes, "range": range, "total_tickets": len(tickets)}


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
    submitter_name:       str               = Form(...),
    opportunity_name:     str               = Form(...),
    division_id:          int               = Form(...),
    estimated_value:      float             = Form(default=0.0),
    notes:                str               = Form(default=""),
    property_id:          Optional[int]     = Form(default=None),
    property_name_fyi:    Optional[str]     = Form(default=None),
    due_date:             Optional[str]     = Form(default=None),
    start_date:           Optional[str]     = Form(default=None),
    end_date:             Optional[str]     = Form(default=None),
    lead_source_id:       Optional[int]     = Form(default=None),
    lead_source_name:     Optional[str]     = Form(default=None),
    sales_type_id:        Optional[int]     = Form(default=None),
    sales_type_name:      Optional[str]     = Form(default=None),
    salesperson_id:       Optional[int]     = Form(default=None),
    salesperson_name:     Optional[str]     = Form(default=None),
    salesperson_email:    Optional[str]     = Form(default=None),
    photos:               List[UploadFile]  = File(default=[]),
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
    if salesperson_id:
        body["SalesRepContactID"] = salesperson_id

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

    # ── Notify salesperson by email ────────────────────────────────────────────
    if salesperson_email and salesperson_name:
        try:
            from app.services.email_intake import GraphClient
            from app.core.config import settings as _s
            graph = GraphClient()
            opp_num_str = f" #{opp_number}" if opp_number else ""
            est_str = f"${estimated_value:,.0f}" if estimated_value else "—"
            prop_str = property_name_fyi or (
                f"Property ID {property_id}" if property_id else "—"
            )
            div_str  = DIVISION_MAP.get(division_id, str(division_id))
            date_str = date.today().strftime("%B %d, %Y")
            note_html = notes.replace("\n", "<br>") if notes else "<em>None</em>"
            await graph.send_email(
                mailbox=_s.MS_AP_INBOX,
                to_addresses=[salesperson_email],
                subject=f"New opportunity assigned to you{opp_num_str} — {opportunity_name}",
                body_html=f"""
<html><body style="font-family:Arial,sans-serif;color:#1a1d23;max-width:600px">
<div style="background:#1e3a2f;padding:20px 24px;border-radius:8px 8px 0 0">
  <h2 style="color:#fff;margin:0;font-size:18px">🌿 New Opportunity — {opportunity_name}</h2>
</div>
<div style="background:#fff;border:1px solid #e2e6ed;border-top:none;padding:24px;border-radius:0 0 8px 8px">
  <p style="margin:0 0 16px;color:#374151">
    A new opportunity has been created in Aspire and assigned to you.
  </p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr><td style="padding:8px 0;color:#6b7280;width:140px;vertical-align:top">Opportunity</td><td style="padding:8px 0;font-weight:600">{opportunity_name}{opp_num_str}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280;vertical-align:top">Property</td><td style="padding:8px 0">{prop_str}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280;vertical-align:top">Division</td><td style="padding:8px 0">{div_str}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280;vertical-align:top">Estimate</td><td style="padding:8px 0">{est_str}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280;vertical-align:top">Submitted by</td><td style="padding:8px 0">{submitter_name}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280;vertical-align:top">Date</td><td style="padding:8px 0">{date_str}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280;vertical-align:top">Notes</td><td style="padding:8px 0">{note_html}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280;vertical-align:top">Photos</td><td style="padding:8px 0">{len(photo_urls)} uploaded</td></tr>
  </table>
</div>
</body></html>""",
            )
            logger.info(f"Salesperson notification sent to {salesperson_email}")
        except Exception as e:
            logger.warning(f"Failed to send salesperson notification: {e}")

    return {
        "success":              True,
        "opportunity_id":       opp_id,
        "opportunity_number":   opp_number,
        "opportunity_name":     opportunity_name,
        "photos_uploaded":      len(photo_urls),
        "submitter":            submitter_name,
    }
