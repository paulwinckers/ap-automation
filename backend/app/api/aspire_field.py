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


# ── Contact / Property lookup ─────────────────────────────────────────────────

@router.get("/contact-lookup")
async def contact_lookup(q: str = Query(..., min_length=2)):
    """
    Search for contacts by property name OR contact name.

    Flow:
      1. GET /PropertyContacts filtered on PropertyName OR ContactName —
         returns the property↔contact links (including PrimaryContact flag)
         with PropertyName already present.
      2. Batch-fetch phone numbers from GET /Contacts for the matched ContactIDs.
      3. Return results grouped by property, contacts sorted primary-first.
    """
    import asyncio
    _check_credentials()

    import asyncio
    q_safe = q.replace("'", "''")

    # ── Two parallel searches ─────────────────────────────────────────────────
    # 1. Properties by name → expand PropertyContacts for the linked contacts
    # 2. Contacts by first/last name → for direct people lookups
    # PropertyContacts endpoint rejects all query params, so we go via Properties.

    async def _by_property():
        try:
            res = await _aspire._get("Properties", {
                "$filter":  f"contains(PropertyName,'{q_safe}')",
                "$select":  "PropertyID,PropertyName,"
                            "PropertyAddressLine1,PropertyAddressCity,"
                            "PropertyAddressStateProvinceCode,PropertyAddressZipCode,"
                            "PropertyContacts",
                "$expand":  "PropertyContacts",
                "$top":     "20",
            })
            return _aspire._extract_list(res)
        except Exception as e:
            logger.warning(f"Property search failed: {e}")
            return []

    async def _by_contact():
        try:
            res = await _aspire._get("Contacts", {
                "$filter": (
                    f"contains(LastName,'{q_safe}') or "
                    f"contains(FirstName,'{q_safe}')"
                ),
                "$select": "ContactID,FirstName,LastName,CompanyName,"
                           "ContactTypeName,MobilePhone,OfficePhone,HomePhone,Email",
                "$top":    "20",
            })
            return _aspire._extract_list(res)
        except Exception as e:
            logger.warning(f"Contact name search failed: {e}")
            return []

    props_raw, contacts_raw = await asyncio.gather(_by_property(), _by_contact())

    # ── Batch-fetch phones for contacts found via property expand ─────────────
    prop_contact_ids: list[int] = []
    for p in props_raw:
        for pc in (p.get("PropertyContacts") or []):
            cid = pc.get("ContactID")
            if cid and cid not in prop_contact_ids:
                prop_contact_ids.append(cid)

    phone_map: dict[int, dict] = {}
    if prop_contact_ids:
        id_filter = " or ".join(f"ContactID eq {cid}" for cid in prop_contact_ids[:50])
        try:
            cres = await _aspire._get("Contacts", {
                "$filter": id_filter,
                "$select": "ContactID,MobilePhone,OfficePhone,HomePhone,Email",
                "$top":    "100",
            })
            for c in _aspire._extract_list(cres):
                phone_map[c["ContactID"]] = c
        except Exception as e:
            logger.warning(f"Phone number fetch failed: {e}")

    # Also index the direct contact results into phone_map
    for c in contacts_raw:
        if c.get("ContactID") and c["ContactID"] not in phone_map:
            phone_map[c["ContactID"]] = c

    if not props_raw and not contacts_raw:
        return {"query": q, "properties": []}

    def _phones(cid: int) -> list[dict]:
        c = phone_map.get(cid, {})
        out = []
        for label, key in [("Mobile", "MobilePhone"), ("Office", "OfficePhone"), ("Home", "HomePhone")]:
            val = (c.get(key) or "").strip()
            if val:
                out.append({"label": label, "number": val})
        return out

    def _email(cid: int) -> str | None:
        val = (phone_map.get(cid, {}).get("Email") or "").strip()
        return val or None

    # ── Group property results by property ───────────────────────────────────
    by_prop: dict[int, dict] = {}
    prop_order: list[int] = []
    seen_contact_ids: set[int] = set()

    for p in props_raw:
        pid  = p.get("PropertyID")
        name = p.get("PropertyName") or ""
        if pid not in by_prop:
            addr_parts = [
                p.get("PropertyAddressLine1") or "",
                p.get("PropertyAddressCity")  or "",
                p.get("PropertyAddressStateProvinceCode") or "",
                p.get("PropertyAddressZipCode") or "",
            ]
            address = ", ".join(x for x in addr_parts if x) or None
            by_prop[pid] = {
                "property_id":   pid,
                "property_name": name,
                "address":       address,
                "contacts":      [],
            }
            prop_order.append(pid)
        for pc in (p.get("PropertyContacts") or []):
            cid = pc.get("ContactID")
            if not cid:
                continue
            seen_contact_ids.add(cid)
            by_prop[pid]["contacts"].append({
                "id":      cid,
                "name":    pc.get("ContactName") or "",
                "primary": bool(pc.get("PrimaryContact")),
                "billing": bool(pc.get("BillingContact")),
                "phones":  _phones(cid),
                "email":   _email(cid),
            })

    for prop in by_prop.values():
        prop["contacts"].sort(
            key=lambda c: (not c["primary"], not c["billing"], c["name"].lower())
        )

    # ── Append direct contact matches not already in property results ─────────
    for c in contacts_raw:
        cid = c.get("ContactID")
        if not cid or cid in seen_contact_ids:
            continue
        phones = _phones(cid)
        if not phones:
            continue
        first = (c.get("FirstName") or "").strip()
        last  = (c.get("LastName")  or "").strip()
        cname = f"{first} {last}".strip() or "(no name)"
        company = (c.get("CompanyName") or "").strip()
        # Surface as a pseudo-property using company name or contact name
        display = company or cname
        pid = f"contact-{cid}"  # synthetic key
        by_prop[pid] = {
            "property_id":   None,
            "property_name": display,
            "contacts": [{
                "id":      cid,
                "name":    cname,
                "primary": True,
                "billing": False,
                "phones":  phones,
                "email":   _email(cid),
            }],
        }
        prop_order.append(pid)

    return {
        "query":      q,
        "properties": [by_prop[pid] for pid in prop_order],
    }


# ── Employees ────────────────────────────────────────────────────────────────

@router.get("/employees")
async def get_employees():
    """Return employees for submitter/salesperson selection (built from Opportunity sales rep names)."""
    _check_credentials()
    employees = await _aspire.get_aspire_employees()
    return {"employees": employees}


# ── Opportunity probe ────────────────────────────────────────────────────────

@router.get("/clock-times/probe")
async def probe_clock_times():
    """
    Probe the Aspire ClockTimes endpoint.
    1. GET /ClockTimes — check if readable and what fields exist
    2. GET /ClockTimes with $top=1 — sample record
    3. Check if PATCH/edit is possible (OPTIONS or known methods)
    Does NOT create any real data.
    """
    _check_credentials()
    result = {}

    # 1. Try GET /ClockTimes
    try:
        data = await _aspire._get("ClockTimes", {"$top": "5", "$orderby": "ClockStartDateTime desc"})
        records = _aspire._extract_list(data)
        result["get_clock_times"] = "OK"
        result["sample_count"] = len(records)
        result["sample_fields"] = sorted(records[0].keys()) if records else []
        result["sample_record"] = records[0] if records else None
    except Exception as e:
        result["get_clock_times"] = f"FAILED: {e}"

    # 2. Try GET /Contacts to check if employee list is accessible
    try:
        contacts = await _aspire._get("Contacts", {
            "$select": "ContactID,FirstName,LastName,Active,ContactTypeName",
            "$filter": "Active eq true and ContactTypeName eq 'Employee'",
            "$top": "5",
        })
        recs = _aspire._extract_list(contacts)
        result["get_contacts_employees"] = f"OK — {len(recs)} returned"
        result["contact_sample"] = recs[:2]
    except Exception as e:
        result["get_contacts_employees"] = f"FAILED: {e}"

    # 3. Try GET /Branches to find valid BranchID
    try:
        branches = await _aspire._get("Branches", {"$top": "10"})
        recs = _aspire._extract_list(branches)
        result["get_branches"] = f"OK — {len(recs)} returned"
        result["branches"] = recs
    except Exception as e:
        result["get_branches"] = f"FAILED: {e}"

    return result


@router.get("/opportunities/probe")
async def probe_opportunity_fields():
    """Return all fields on a sample Opportunity — used to find Status/Type field names."""
    _check_credentials()
    result = await _aspire._get("Opportunities", {"$top": "1", "$orderby": "WonDate desc"})
    opps = _aspire._extract_list(result)
    statuses = await _aspire.get_opportunity_statuses()
    sample = opps[0] if opps else {}
    # Pull out all fields that might relate to SalesRep for write-field discovery
    sales_fields = {k: v for k, v in sample.items() if any(
        kw in k.lower() for kw in ("sales", "rep", "person", "assign", "owner")
    )}
    return {
        "fields": sorted(sample.keys()),
        "sales_fields": sales_fields,
        "sample": sample,
        "statuses": statuses,
    }


@router.get("/issues/probe")
async def probe_issues():
    """
    Probe the Aspire Issues endpoint — check if it exists, what fields it has,
    and whether issues can be linked to opportunities.
    Hit: GET /aspire/field/issues/probe
    """
    _check_credentials()
    results = {}

    # Try GET Issues
    for endpoint in ["Issues", "Issue", "ServiceIssues", "WorkOrders"]:
        try:
            result = await _aspire._get(endpoint, {"$top": "1"})
            items = _aspire._extract_list(result)
            results[endpoint] = {
                "status": "OK",
                "count": len(items),
                "fields": sorted(items[0].keys()) if items else [],
            }
        except Exception as e:
            results[endpoint] = {"status": f"FAIL: {str(e)[:100]}"}

    return results


@router.get("/opportunities/notes-probe")
async def probe_notes_field(opp_id: int):
    """
    Try PATCHing a real opportunity with different notes field names.
    Hit: GET /aspire/field/opportunities/notes-probe?opp_id=<any_existing_opp_id>
    """
    _check_credentials()
    # First find which URL format works
    url_format = None
    for fmt in [f"Opportunities({opp_id})", f"Opportunities/{opp_id}"]:
        try:
            await _aspire._patch(fmt, {"EstimatorNotes": "__url_test__"})
            url_format = fmt
            break
        except Exception as e:
            pass

    if not url_format:
        return {"opp_id": opp_id, "error": "PATCH not supported on Opportunities — both URL formats returned 404/405", "results": {}}

    candidates = [
        "Notes", "SalesNotes", "InternalNotes", "EstimatorNotes",
        "Description", "CustomerNotes", "PrivateNotes", "OpportunityNotes",
        "Comments", "Memo",
    ]
    results = {}
    for field in candidates:
        try:
            await _aspire._patch(url_format, {field: f"__probe_{field}__"})
            results[field] = "SUCCESS"
            logger.info(f"Notes probe: {field} WRITABLE via PATCH {url_format}")
        except Exception as e:
            results[field] = f"FAIL: {str(e)[:80]}"
    return {"opp_id": opp_id, "url_format": url_format, "results": results}


@router.get("/opportunities/salesrep-probe")
async def probe_salesrep_field(salesperson_id: int):
    """
    Try posting a minimal opportunity with different SalesRep field names.
    Tells us which field name Aspire actually accepts for write.
    Hit: GET /aspire/field/opportunities/salesrep-probe?salesperson_id=<id>
    """
    _check_credentials()
    base = {
        "OpportunityName":    "__probe_delete_me__",
        "DivisionID":         2,
        "BranchID":           settings.ASPIRE_BRANCH_ID or 2,
        "OpportunityStatusID": 9,
        "OpportunityType":    "Contract",
        "EstimatedDollars":   0,
    }
    candidates = [
        "SalesRepContactID",
        "SalesRepID",
        "SalesRepresentativeID",
        "SalesPersonID",
        "SalesPersonContactID",
        "SalesmanID",
        "AssignedToContactID",
        "OwnerContactID",
    ]
    results = {}
    for field in candidates:
        body = {**base, "OpportunityName": f"__probe_{field}__", field: salesperson_id}
        try:
            res = await _aspire._post("Opportunities", body)
            results[field] = f"SUCCESS — id={res}"
            # Immediately log so we know what worked
            logger.info(f"SalesRep probe: {field}={salesperson_id} SUCCEEDED: {res}")
        except Exception as e:
            err_text = str(e)[:120]
            results[field] = f"FAIL: {err_text}"
    return {"salesperson_id": salesperson_id, "results": results}


# ── Work ticket field probe ───────────────────────────────────────────────────

@router.get("/work-tickets/probe")
async def probe_work_ticket_fields():
    """
    Return all fields present on a sample WorkTicket.
    Use this to identify the correct route / crew field name.
    """
    _check_credentials()
    return await _aspire.probe_work_ticket_fields()


@router.get("/debug-property")
async def debug_property(property_id: int = Query(...)):
    """Debug: fetch a single Property record to see available address fields."""
    _check_credentials()
    try:
        result = await _aspire._get("Properties", {
            "$filter": f"PropertyID eq {property_id}",
            "$top": "1",
        })
        records = _aspire._extract_list(result)
        if records:
            return {"fields": sorted(records[0].keys()), "sample": records[0]}
        return {"error": "not found"}
    except Exception as e:
        return {"error": str(e)}


@router.get("/work-tickets/recent")
async def get_recent_tickets():
    """
    Debug: fetch this week's tickets with targeted $select to find route fields.
    """
    _check_credentials()
    from datetime import date, timedelta
    today = date.today()
    week_start = (today - timedelta(days=today.weekday())).strftime("%Y-%m-%d")
    week_end   = (today + timedelta(days=8)).strftime("%Y-%m-%d")

    result = await _aspire._get("WorkTickets", {
        "$filter": f"ScheduledStartDate ge {week_start} and ScheduledStartDate lt {week_end}",
        "$select": ",".join([
            "WorkTicketID", "WorkTicketNumber", "OpportunityID",
            "ScheduledStartDate", "WorkTicketStatusName",
            "CrewLeaderContactID", "CrewLeaderName",
            "RouteSupervisorContactID",
            "BranchID", "BranchName",
            "OperationsManagerContactID",
        ]),
        "$orderby": "ScheduledStartDate asc",
        "$top": "20",
    })
    tickets = _aspire._extract_list(result)

    return {
        "week": f"{week_start} to {week_end}",
        "ticket_count": len(tickets),
        "tickets": tickets,
    }


# ── Scheduled work tickets ───────────────────────────────────────────────────

@router.get("/work-tickets/scheduled")
async def get_scheduled_tickets(
    range: str = Query(default="today", pattern="^(today|past|upcoming)$"),
    work_date: Optional[str] = Query(default=None, description="Specific date override YYYY-MM-DD"),
):
    """
    Return work tickets grouped by route.
    range: today | past (last 14 days) | upcoming (next 30 days)
    work_date: optional specific date override (e.g. 2026-04-15) — ignores range
    Each route contains a list of tickets with OpportunityName and PropertyName.
    """
    _check_credentials()
    tickets = await _aspire.get_scheduled_work_tickets(range, specific_date=work_date)

    # Group by _RouteName
    from collections import defaultdict
    groups: dict = defaultdict(list)
    for t in tickets:
        groups[t.get("_RouteName", "Unassigned")].append(t)

    routes = [
        {
            "route_name":        name,
            "ticket_count":      len(tix),
            "tickets":           tix,
            "crew_leader_name":  tix[0].get("CrewLeaderName") if tix else None,
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

    # ── Read all photo bytes (validate size first) ─────────────────────────────
    photo_data: list[tuple[str, bytes]] = []  # (filename, bytes)
    for i, photo in enumerate(photos):
        raw = await photo.read()
        is_vid   = _is_video(photo.filename or "")
        max_size = MAX_VIDEO_SIZE if is_vid else MAX_PHOTO_SIZE
        if len(raw) > max_size:
            label = "200 MB per video" if is_vid else "15 MB per photo"
            raise HTTPException(status_code=413, detail=f"File {i+1} is too large (max {label})")
        fname = photo.filename or f"photo_{i+1}.jpg"
        photo_data.append((fname, raw))

    # ── Upload photos: try Aspire direct, fall back to R2 ────────────────────
    ONE_YEAR = 365 * 24 * 3600
    photos_uploaded = 0
    photo_urls: list[str] = []
    for fname, raw in photo_data:
        # Try Aspire attachment first
        try:
            await _aspire.upload_aspire_attachment(
                object_id=ticket_id,
                object_code="WorkTicket",
                filename=fname,
                file_bytes=raw,
                expose_to_crew=True,
            )
            photos_uploaded += 1
            logger.info(f"WorkTicket {ticket_id}: uploaded {fname} to Aspire directly")
            continue
        except Exception:
            logger.info(f"WorkTicket {ticket_id}: Aspire attachment 403, falling back to R2 for {fname}")

        # R2 fallback — 1-year presigned URL
        result = await r2.upload_field_photo(
            file_bytes=raw,
            filename=fname,
            submitter=submitter_name or "field",
            entity_type="work-ticket",
            entity_id=str(ticket_id),
            expires_in=ONE_YEAR,
        )
        if result:
            _key, url = result
            photo_urls.append(url)
            photos_uploaded += 1

    # ── Create Aspire Issue linked to WorkTicket with notes ──────────────────────
    try:
        # Look up submitter's UserID — AssignedTo requires an integer UserID
        # Most field crew don't have Aspire user accounts so fall back to default
        submitter_contact_id = settings.ASPIRE_DEFAULT_USER_ID
        try:
            employees = await _aspire.get_aspire_employees()
            for emp in employees:
                if emp.get("FullName", "").lower() == (submitter_name or "").lower():
                    uid = emp.get("UserID")
                    if uid:
                        submitter_contact_id = uid
                    break
        except Exception:
            pass

        note_lines = [
            f"Submitted by: {submitter_name}",
            f"Date: {date.today().isoformat()}",
        ]
        if comment:
            note_lines += ["", comment]
        if photo_urls:
            note_lines += ["", "Photos:"]
            for url in photo_urls:
                note_lines.append(url)
        issue_notes = "\n".join(note_lines)

        today_dt = f"{date.today().isoformat()}T00:00:00Z"
        issue_body = {
            "Subject":       f"Visit note — {date.today().strftime('%b %d, %Y')}",
            "Notes":         issue_notes,
            "WorkTicketID":  ticket_id,
            "PublicComment": True,   # makes this visible in the customer portal
            "DueDate":       today_dt,
            "CompleteDate":  today_dt,
        }
        if submitter_contact_id:
            issue_body["AssignedTo"] = submitter_contact_id

        await _aspire.create_issue(issue_body)
        logger.info(f"WorkTicket {ticket_id}: Issue created (AssignedTo ContactID={submitter_contact_id})")
    except Exception as e:
        logger.warning(f"WorkTicket {ticket_id}: Issue creation failed: {e}")

    logger.info(f"WorkTicket {ticket_id}: {photos_uploaded}/{len(photo_data)} photos saved")

    return {
        "success":         True,
        "ticket_id":       ticket_id,
        "photos_uploaded": photos_uploaded,
        "aspire_updated":  True,
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
    opportunity_type:     str               = Form(default="Contract"),
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

    # ── Read & validate photos upfront ────────────────────────────────────────
    photo_data: list[tuple[str, bytes]] = []
    for i, photo in enumerate(photos):
        raw = await photo.read()
        is_vid   = _is_video(photo.filename or "")
        max_size = MAX_VIDEO_SIZE if is_vid else MAX_PHOTO_SIZE
        if len(raw) > max_size:
            label = "200 MB per video" if is_vid else "15 MB per photo"
            raise HTTPException(status_code=413, detail=f"File {i+1} is too large (max {label})")
        photo_data.append((photo.filename or f"photo_{i+1}.jpg", raw))

    # ── Build estimator notes text ────────────────────────────────────────────
    note_lines = [f"Submitted by: {submitter_name}", f"Date: {date.today().isoformat()}"]
    if property_name_fyi:
        note_lines.append(f"Property: {property_name_fyi}")
    if notes:
        note_lines.append(f"\n{notes}")
    notes_text = "\n".join(note_lines)

    # ── POST to Aspire ─────────────────────────────────────────────────────────
    def _as_dt(d: Optional[str]) -> Optional[str]:
        """Convert YYYY-MM-DD to ISO datetime string required by Aspire POST."""
        if not d:
            return None
        return d if "T" in d else f"{d}T00:00:00"

    body: dict = {
        "OpportunityName":    opportunity_name,
        "DivisionID":         division_id,
        "BranchID":           settings.ASPIRE_BRANCH_ID or 2,
        "EstimatedDollars":   estimated_value,
        "OpportunityStatusID": 9,               # "New"
        "OpportunityType":    opportunity_type,  # "Contract" or "Work Order"
        "SalesRepID":         salesperson_id,    # correct write field per API doc
    }
    if property_id:
        body["PropertyID"] = property_id
    if due_date:
        body["BidDueDate"] = _as_dt(due_date)   # correct field name per API doc
    if start_date:
        body["StartDate"] = _as_dt(start_date)
    if end_date:
        body["EndDate"] = _as_dt(end_date)
    if lead_source_id:
        body["LeadSourceID"] = lead_source_id
    if sales_type_id:
        body["SalesTypeID"] = sales_type_id

    logger.info(f"Opportunity POST body: {body}")

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
        raw_id = (
            result.get("OpportunityID")
            or result.get("Id")
            or result.get("id")
        )
        try:
            opp_id = int(raw_id) if raw_id is not None else None
        except (ValueError, TypeError):
            opp_id = None
        opp_number = (
            result.get("OpportunityNumber")
            or result.get("opportunityNumber")
        )
        if opp_id is None:
            logger.warning(f"Could not parse OpportunityID from Aspire response: {result}")

    # ── Create linked Issue with notes + R2 photo links ───────────────────────
    if isinstance(opp_id, int) and opp_id > 0:
        try:
            # Look up salesperson or submitter UserID — AssignedTo requires an integer UserID
            # Most field crew don't have Aspire user accounts so fall back to default
            assigned_contact_id = settings.ASPIRE_DEFAULT_USER_ID
            try:
                employees = await _aspire.get_aspire_employees()
                target_name = (salesperson_name or submitter_name or "").lower()
                for emp in employees:
                    if emp.get("FullName", "").lower() == target_name:
                        uid = emp.get("UserID")
                        if uid:
                            assigned_contact_id = uid
                        break
            except Exception:
                pass

            issue_body: dict = {
                "Subject":       f"Field submission — {opportunity_name}",
                "Notes":         notes_text,
                "OpportunityID": opp_id,
                "PublicComment": False,
            }
            if assigned_contact_id:
                issue_body["AssignedTo"] = assigned_contact_id
            # NOTE: do NOT include PropertyID here — Aspire rejects Issues with both
            # OpportunityID and PropertyID in the same request.
            await _aspire.create_issue(issue_body)
            logger.info(f"Opportunity {opp_id}: Issue created (AssignedTo ContactID={assigned_contact_id})")
        except Exception as e:
            logger.warning(f"Opportunity {opp_id}: Issue creation failed: {e}")

    # ── Upload photos: try Aspire direct, fall back to R2 ────────────────────
    ONE_YEAR = 365 * 24 * 3600
    photos_uploaded = 0
    photo_urls: list[str] = []
    for fname, raw in photo_data:
        # Try Aspire attachment first
        aspire_ok = False
        if isinstance(opp_id, int) and opp_id > 0:
            try:
                await _aspire.upload_aspire_attachment(
                    object_id=opp_id,
                    object_code="Opportunity",
                    filename=fname,
                    file_bytes=raw,
                    expose_to_crew=True,
                    attach_to_invoice=False,  # required for Opportunity attachments
                )
                photos_uploaded += 1
                aspire_ok = True
                logger.info(f"Opportunity {opp_id}: uploaded {fname} to Aspire directly")
            except Exception:
                logger.info(f"Opportunity {opp_id}: Aspire attachment 403, falling back to R2 for {fname}")

        if not aspire_ok:
            result = await r2.upload_field_photo(
                file_bytes=raw,
                filename=fname,
                submitter=submitter_name,
                entity_type="opportunity",
                entity_id=str(opp_id),
                expires_in=ONE_YEAR,
            )
            if result:
                _key, url = result
                photo_urls.append(url)
                photos_uploaded += 1

    logger.info(
        f"New opportunity created: ID={opp_id} #={opp_number} '{opportunity_name}' "
        f"by {submitter_name}, {photos_uploaded}/{len(photo_data)} photo(s)"
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
    <tr><td style="padding:8px 0;color:#6b7280;vertical-align:top">Photos</td><td style="padding:8px 0">{photos_uploaded} uploaded</td></tr>
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
        "photos_uploaded":      photos_uploaded,
        "submitter":            submitter_name,
    }


@router.get("/visit-notes/probe")
async def probe_visit_notes(ticket_id: int = Query(default=16914)):
    """Probe VisitNotes endpoint and WorkTicket PATCH to find customer-portal-visible note path."""
    _check_credentials()
    results = {}

    # 1. Try GET VisitNotes
    for ep in ["VisitNotes", "WorkTicketNotes", "PropertyNotes", "CustomerNotes"]:
        try:
            data = await _aspire._get(ep, {"$top": "3"})
            items = _aspire._extract_list(data)
            results[f"GET_{ep}"] = {
                "status": "OK",
                "count": len(items),
                "fields": sorted(items[0].keys()) if items else [],
                "sample": items[0] if items else {},
            }
        except Exception as e:
            results[f"GET_{ep}"] = {"status": f"FAIL: {str(e)[:100]}"}

    # 2. Try PATCH WorkTicket Notes field
    for url_fmt in [f"WorkTickets({ticket_id})", f"WorkTickets/{ticket_id}"]:
        for field in ["Notes", "ProductionNote", "CustomerNote", "PublicNote"]:
            try:
                await _aspire._patch(url_fmt, {field: "__probe_visit_note__"})
                results[f"PATCH_{url_fmt}_{field}"] = "SUCCESS"
            except Exception as e:
                results[f"PATCH_{url_fmt}_{field}"] = f"FAIL: {str(e)[:80]}"

    # 3. Try POST VisitNotes with minimal body
    try:
        r = await _aspire._post("VisitNotes", {
            "WorkTicketID": ticket_id,
            "Note": "__probe__",
        })
        results["POST_VisitNotes"] = f"SUCCESS: {r}"
    except Exception as e:
        results["POST_VisitNotes"] = f"FAIL: {str(e)[:120]}"

    return results
