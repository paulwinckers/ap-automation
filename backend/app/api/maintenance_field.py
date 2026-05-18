"""
Maintenance Field Portal
========================
Mobile portal for maintenance / landscape-management team.

Routes (public — no login required):
  GET  /field/maintenance/lookup              — list active maintenance contracts
  GET  /field/maintenance/{opp_id}           — full page data
  POST /field/maintenance/{opp_id}/field-advisor      — ask field advisor
  POST /field/maintenance/{opp_id}/field-advisor/save — save Q&A to log
"""
import asyncio
import logging
import time as _time
import uuid
from typing import Optional

import anthropic as _anthropic
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.core.config import settings
from app.core.database import Database
from app.services import r2 as _r2
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/field/maintenance", tags=["maintenance-field"])

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)
_db     = Database()

# ── Lookup cache ─────────────────────────────────────────────────────────────
_lookup_cache:    dict | None = None
_lookup_cache_ts: float       = 0.0
_cache_building:  bool        = False   # prevent concurrent rebuilds
_LOOKUP_TTL = 8 * 60 * 60  # 8 hours — matches a workday

# ── Per-contract page cache ───────────────────────────────────────────────────
_contract_cache: dict[int, tuple[dict, float]] = {}
_CONTRACT_TTL = 60 * 60  # 1 hour


async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


# ── D1-backed cache helpers ───────────────────────────────────────────────────

async def _load_lookup_from_db() -> dict | None:
    """Try to load the lookup cache from D1 (survives Railway restarts)."""
    import json
    try:
        if _db._db is None:
            await _db.connect()
        rows = await _db._q(
            "SELECT data FROM cache_entries WHERE key = 'maintenance_lookup' AND expires_at > datetime('now')"
        )
        if rows:
            logger.info("Maintenance lookup: loaded from D1 cache")
            return json.loads(rows[0]["data"])
    except Exception as exc:
        logger.warning(f"D1 cache load failed: {exc}")
    return None


async def _save_lookup_to_db(data: dict) -> None:
    """Persist the lookup cache to D1 with a 12-hour TTL."""
    import json
    from datetime import datetime, timedelta, timezone
    try:
        if _db._db is None:
            await _db.connect()
        expires = (datetime.now(timezone.utc) + timedelta(hours=12)).strftime("%Y-%m-%d %H:%M:%S")
        await _db._x(
            "INSERT OR REPLACE INTO cache_entries (key, data, expires_at, updated_at) VALUES (?, ?, ?, datetime('now'))",
            ["maintenance_lookup", json.dumps(data), expires],
        )
        logger.info("Maintenance lookup: saved to D1 cache")
    except Exception as exc:
        logger.warning(f"D1 cache save failed: {exc}")


def _invalidate_contract(opp_id: int) -> None:
    """Drop a single contract from the in-memory page cache."""
    _contract_cache.pop(opp_id, None)


# ── Helpers ───────────────────────────────────────────────────────────────────

_MIME_OVERRIDE = {
    "pdf":  "application/pdf",
    "png":  "image/png",
    "jpg":  "image/jpeg",
    "jpeg": "image/jpeg",
    "gif":  "image/gif",
    "webp": "image/webp",
    "heic": "image/heic",
}


async def _fetch_opp(opp_id: int) -> dict:
    """Fetch a single opportunity record from Aspire (all fields)."""
    try:
        res = await _aspire._get("Opportunities", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$top":    "1",
        })
        rows = _aspire._extract_list(res)
        return rows[0] if rows else {}
    except Exception as e:
        logger.warning(f"Maintenance: opp fetch failed for {opp_id}: {e}")
        return {}


async def _fetch_tickets(opp_id: int) -> list[dict]:
    """Fetch ALL work tickets for a maintenance opportunity, with service names."""
    SELECT = (
        "WorkTicketID,WorkTicketNumber,WorkTicketStatusName,"
        "OpportunityServiceID,OpportunityID,ScheduledStartDate,CompleteDate,"
        "HoursEst,HoursAct,HoursScheduled,CrewLeaderName,PercentComplete"
    )
    try:
        res = await _aspire._get("WorkTickets", {
            "$filter":  f"OpportunityID eq {opp_id}",
            "$orderby": "ScheduledStartDate asc",
            "$top":     "500",
            "$select":  SELECT,
        })
        rows = _aspire._extract_list(res)
        logger.info(f"Maintenance tickets: {len(rows)} for opp {opp_id}")
    except Exception as e:
        logger.warning(f"Maintenance tickets fetch failed for {opp_id}: {e}")
        return []

    # Resolve service names
    service_map: dict = {}
    try:
        svc_res = await _aspire._get("OpportunityServices", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$top": "50",
        })
        for svc in _aspire._extract_list(svc_res):
            sid = svc.get("OpportunityServiceID")
            if sid:
                service_map[sid] = (
                    svc.get("ServiceNameAbr")
                    or svc.get("DisplayName")
                    or svc.get("ServiceName")
                    or ""
                )
    except Exception as e:
        logger.info(f"OpportunityServices fetch non-fatal for {opp_id}: {e}")

    for t in rows:
        sid = t.get("OpportunityServiceID")
        t["ServiceName"] = service_map.get(sid) or "" if sid else ""

    return rows


async def _fetch_visit_notes(ticket_id: int) -> list[dict]:
    """Fetch WorkTicketVisitNotes for a single work ticket."""
    try:
        res = await _aspire._get("WorkTicketVisitNotes", {
            "$filter":  f"WorkTicketID eq {ticket_id}",
            "$orderby": "CreatedDateTime desc",
            "$top":     "50",
            "$select":  "WorkTicketVisitNoteID,WorkTicketID,Note,CreatedDateTime,CreatedByUserName,ScheduledDate",
        })
        return _aspire._extract_list(res)
    except Exception as e:
        logger.debug(f"Visit notes fetch for ticket {ticket_id}: {e}")
        return []


async def _generate_maintenance_summary(opp: dict, tickets: list[dict], services: list[dict]) -> str:
    """Generate a concise bullet-point AI summary of the maintenance agreement."""
    import re as _re

    def _strip_html(s: str) -> str:
        if not s:
            return ""
        text = _re.sub(r"<[^>]+>", " ", s)
        return _re.sub(r"\s{2,}", " ", text).strip()

    opp_name      = opp.get("OpportunityName") or "Maintenance Agreement"
    property_name = opp.get("PropertyName") or ""
    status        = opp.get("OpportunityStatusName") or ""

    COMPLETE = {"complete", "completed"}
    ACTIVE   = {"open", "in progress", "scheduled", "in production", "in queue"}

    total_est  = sum(float(t.get("HoursEst") or 0) for t in tickets)
    total_act  = sum(float(t.get("HoursAct") or 0) for t in tickets)
    done_count = sum(1 for t in tickets if (t.get("WorkTicketStatusName") or "").lower() in COMPLETE)
    active_count = sum(1 for t in tickets if (t.get("WorkTicketStatusName") or "").lower() in ACTIVE)

    # Scope notes from opp record
    NOTE_KEYS = {
        "Notes", "EstimatorNotes", "SalesNotes", "Description", "CustomerNotes",
        "InternalNotes", "Scope", "ScopeNotes", "WorkDescription", "Comments", "Memo",
    }
    note_parts: list[str] = []
    for key, val in opp.items():
        if isinstance(val, str) and (key in NOTE_KEYS or len(val) > 30):
            clean = _strip_html(val.strip())
            if clean and len(clean) > 15:
                note_parts.append(f"[{key}] {clean}")

    # Services summary
    svc_lines: list[str] = []
    for svc in services:
        name = (
            svc.get("ServiceNameAbr") or svc.get("ServiceName") or svc.get("DisplayName") or "Service"
        )
        freq  = svc.get("Frequency") or svc.get("FrequencyName") or ""
        price = svc.get("Price") or svc.get("UnitCost") or ""
        line  = name
        if freq:
            line += f" ({freq})"
        if price:
            try:
                line += f" — ${float(price):,.2f}"
            except Exception:
                pass
        svc_lines.append(line)

    context = (
        f"Agreement: {opp_name}" + (f" at {property_name}" if property_name else "") + "\n"
        f"Status: {status}\n"
        f"Work Tickets: {len(tickets)} total — {done_count} complete, {active_count} active/upcoming\n"
        f"Hours: {total_act:.1f} actual / {total_est:.1f} estimated\n"
    )
    if svc_lines:
        context += "Services in agreement:\n" + "\n".join(f"  - {s}" for s in svc_lines[:10]) + "\n"
    if note_parts:
        context += "\nScope notes:\n" + "\n".join(note_parts[:4]) + "\n"

    prompt = (
        "You are summarizing a landscape maintenance agreement for a field crew lead. "
        "Write 4-6 bullet points covering: what services are included, current progress "
        "(tickets done vs remaining), hours used vs budget, and anything urgent or over budget. "
        "Each bullet must be under 15 words. Start each with '• '. No preamble, no headings.\n\n"
        + context + "\nSummary bullets:"
    )

    try:
        client = _anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        msg = await client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        return (msg.content[0].text or "").strip()
    except Exception as e:
        logger.warning(f"Maintenance summary AI call failed: {e}")
        lines = [f"• {total_act:.1f}h used of {total_est:.1f}h estimated."]
        if done_count:
            lines.append(f"• {done_count} of {len(tickets)} work tickets completed.")
        if active_count:
            lines.append(f"• {active_count} tickets still active or upcoming.")
        if svc_lines:
            lines.append(f"• Services: {', '.join(svc_lines[:3])}.")
        return "\n".join(lines)


def _parse_comments_from_notes(notes_html: str) -> list[dict]:
    """Extract comment rows from the HTML Aspire embeds in Notes."""
    import re as _re
    if not notes_html:
        return []
    section = (
        _re.search(r'Issue Comment History</h3>(.*)',  notes_html, _re.IGNORECASE | _re.DOTALL) or
        _re.search(r'Comment History</h3>(.*)',        notes_html, _re.IGNORECASE | _re.DOTALL) or
        _re.search(r'Comments?</h\d>(.*)',             notes_html, _re.IGNORECASE | _re.DOTALL)
    )
    if not section:
        return []
    comments = []
    rows = _re.findall(r'<tr>(.*?)</tr>', section.group(1), _re.DOTALL)
    for row in rows:
        cells = _re.findall(r'<td[^>]*>(.*?)</td>', row, _re.DOTALL)
        if len(cells) < 2:
            continue
        meta    = _re.sub(r'<[^>]+>', ' ', cells[0]).strip()
        comment = _re.sub(r'<[^>]+>', '', cells[1]).strip()
        if not comment or comment == 'Comment' or meta in ('Created Date/By', ''):
            continue
        date_str = ""
        author   = meta
        dm = _re.match(r'^(\d{1,2}/\d{1,2}/\d{2,4})\s*(.*)', meta)
        if dm:
            try:
                from datetime import datetime as _dt
                date_str = _dt.strptime(dm.group(1), "%m/%d/%y").strftime("%Y-%m-%d")
            except Exception:
                date_str = dm.group(1)
            author = dm.group(2).strip()
        comments.append({
            "Comment":           comment,
            "CreatedDate":       date_str,
            "CreatedByUserName": author,
        })
    return comments


# ── Cache management ─────────────────────────────────────────────────────────

@router.post("/cache/clear")
async def clear_lookup_cache(db: Database = Depends(get_db)):
    """Force all caches to expire and trigger an immediate background rebuild."""
    global _lookup_cache, _lookup_cache_ts, _cache_building
    _lookup_cache    = None
    _lookup_cache_ts = 0.0
    _cache_building  = False
    _contract_cache.clear()
    # Drop D1 entry so it won't be served while rebuilding
    try:
        await db._x("DELETE FROM cache_entries WHERE key = 'maintenance_lookup'")
    except Exception:
        pass
    asyncio.create_task(_build_lookup_cache())
    return {"cleared": True, "rebuilding": True}


# ── Lookup endpoint ───────────────────────────────────────────────────────────

async def _build_lookup_cache() -> None:
    """
    Build the full maintenance lookup cache in the background.
    Fetches all maintenance opps then enriches each with ticket summaries.
    Runs as a background task so the HTTP request returns immediately.
    """
    global _lookup_cache, _lookup_cache_ts, _cache_building
    if _cache_building:
        return
    _cache_building = True
    try:
        from datetime import datetime
        year     = datetime.now().year
        yr_start = f"{year}-01-01"
        yr_end   = f"{year}-12-31"

        SELECT = "OpportunityID,OpportunityName,PropertyName,DivisionName,OpportunityStatusName,OpportunityType,StartDate,EndDate,JobStatusName,EstimatedLaborHours,ActualLaborHours,PercentComplete,CompleteDate"
        DIV_FILTER = (
            "(DivisionName eq 'Commercial Maintenance' or DivisionName eq 'Residential Maintenance')"
            " and OpportunityStatusName eq 'Won'"
            f" and ((StartDate ge {yr_start} and StartDate le {yr_end})"
            f" or (EndDate ge {yr_start} and EndDate le {yr_end}))"
        )

        # ── Step 1: fetch opps ────────────────────────────────────────────────
        all_opps: list[dict] = []
        for page in range(1, 21):
            try:
                res = await _aspire._get("Opportunities", {
                    "$select":     SELECT,
                    "$filter":     DIV_FILTER,
                    "$orderby":    "OpportunityID desc",
                    "$limit":      "500",
                    "$pageNumber": str(page),
                })
                batch = _aspire._extract_list(res)
                logger.info(f"Maintenance cache build page {page}: {len(batch)} opps")
                if not batch:
                    break
                all_opps.extend(batch)
                if len(batch) < 500:
                    break
            except Exception as e:
                logger.warning(f"Maintenance opp page {page} failed: {e}")
                break

        # ── Step 2: type filter ───────────────────────────────────────────────
        ALLOWED_TYPES = {"contract", "work order", "workorder"}
        maintenance_opps = [
            o for o in all_opps
            if not (opp_type := (o.get("OpportunityType") or "").strip().lower())
            or any(t in opp_type for t in ALLOWED_TYPES)
        ]
        logger.info(f"Maintenance cache build: {len(maintenance_opps)} opps after type filter")

        if not maintenance_opps:
            _lookup_cache    = {"contracts": []}
            _lookup_cache_ts = _time.time()
            return

        # ── Step 3: assemble using opp fields directly (no ticket fetch needed) ─
        # JobStatusName tells us "In Production" vs "Complete" without tickets.
        # EstimatedLaborHours / ActualLaborHours give us budget progress.
        ACTIVE_JOB_STATUSES = {"in production", "open", "scheduled", "in queue"}
        contracts = []
        for opp in maintenance_opps:
            raw_type   = (opp.get("OpportunityType") or "").strip().lower()
            is_work_order = "work order" in raw_type or "workorder" in raw_type
            job_status = (opp.get("JobStatusName") or "").strip().lower()
            all_done   = job_status not in ACTIVE_JOB_STATUSES and job_status != ""
            contracts.append({
                "opp_id":       opp["OpportunityID"],
                "opp_name":     opp.get("OpportunityName") or f"Contract #{opp['OpportunityID']}",
                "property":     opp.get("PropertyName") or "",
                "division":     opp.get("DivisionName") or "",
                "status":       opp.get("JobStatusName") or "Won",
                "opp_type":     "work_order" if is_work_order else "contract",
                "all_done":     all_done,
                "hrs_est":      round(float(opp.get("EstimatedLaborHours") or 0), 1),
                "hrs_act":      round(float(opp.get("ActualLaborHours") or 0), 1),
                "ticket_count": 0,   # not fetched at lookup — open contract for details
                "latest_date":  (opp.get("EndDate") or "")[:10],
            })

        contracts.sort(key=lambda x: x["latest_date"], reverse=True)
        contracts.sort(key=lambda x: x["all_done"])  # active first

        payload = {"contracts": contracts}
        _lookup_cache    = payload
        _lookup_cache_ts = _time.time()
        logger.info(f"Maintenance cache build complete: {len(contracts)} contracts")

        # Persist to D1 so it survives Railway restarts
        await _save_lookup_to_db(payload)

    except Exception as e:
        logger.error(f"Maintenance cache build failed: {e}", exc_info=True)
    finally:
        _cache_building = False


@router.get("/lookup")
async def maintenance_lookup():
    """
    Return cached maintenance contracts. If cache is stale, kicks off a
    background rebuild and returns whatever is cached (even if empty/stale)
    so the HTTP request never times out.
    """
    global _lookup_cache, _lookup_cache_ts, _cache_building

    age = _time.time() - _lookup_cache_ts
    cache_valid = _lookup_cache is not None and age < _LOOKUP_TTL

    if cache_valid:
        logger.info(f"Maintenance lookup: cache hit (age={age:.0f}s)")
        return _lookup_cache

    # Stale or empty — start background rebuild if not already running
    if not _cache_building:
        logger.info("Maintenance lookup: cache stale, starting background build")
        asyncio.create_task(_build_lookup_cache())

    # Return whatever we have (may be stale but not empty)
    if _lookup_cache is not None:
        logger.info("Maintenance lookup: returning stale cache while rebuilding")
        return _lookup_cache

    # Try D1 before blocking the request (handles Railway cold-starts instantly)
    db_data = await _load_lookup_from_db()
    if db_data:
        _lookup_cache    = db_data
        _lookup_cache_ts = _time.time()
        return _lookup_cache

    # Truly first-ever load — wait briefly for the background build
    logger.info("Maintenance lookup: first load, waiting up to 10s for initial data")
    for _ in range(20):           # 20 × 0.5s = 10s max wait
        await asyncio.sleep(0.5)
        if _lookup_cache is not None:
            return _lookup_cache

    return {"contracts": [], "loading": True}


@router.get("/debug/opp-statuses")
async def debug_opp_statuses():
    """Return all OpportunityStatus records so we can see stage values."""
    try:
        res = await _aspire._get("OpportunityStatus", {"$top": "100"})
        return {"statuses": _aspire._extract_list(res)}
    except Exception as e:
        return {"error": str(e)}


@router.get("/debug/opp-fields/{opp_id}")
async def debug_opp_fields(opp_id: int):
    """Return ALL fields on a single opportunity so we can find status/production flags."""
    try:
        res = await _aspire._get("Opportunities", {
            "$filter": f"OpportunityID eq {opp_id}",
            "$top":    "1",
        })
        rows = _aspire._extract_list(res)
        if not rows:
            return {"error": "not found"}
        return {"opp_id": opp_id, "fields": rows[0]}
    except Exception as e:
        return {"error": str(e)}


@router.get("/debug/tickets/{opp_id}")
async def debug_tickets(opp_id: int):
    """Test: fetch ticket summary for one opp and return raw results."""
    try:
        res = await _aspire._get("WorkTickets", {
            "$filter":  f"OpportunityID eq {opp_id}",
            "$select":  "WorkTicketID,WorkTicketStatusName,ScheduledStartDate,HoursEst,HoursAct",
            "$top":     "200",
        })
        rows = _aspire._extract_list(res)
        return {
            "opp_id":       opp_id,
            "ticket_count": len(rows),
            "raw_response_type": str(type(res)),
            "tickets": rows[:10],
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "traceback": traceback.format_exc()}


@router.get("/debug/divisions")
async def debug_divisions():
    """
    Dev endpoint: shows what DivisionName and OpportunityStatusName values
    exist in Aspire for all non-construction opps that had recent tickets.
    Use this to tune the lookup filter.
    """
    from datetime import datetime, timedelta
    date_cutoff = (datetime.now() - timedelta(days=548)).strftime("%Y-%m-%d")
    try:
        res = await _aspire._get("WorkTickets", {
            "$select":  "WorkTicketID,OpportunityID,WorkTicketStatusName,ScheduledStartDate",
            "$filter":  f"ScheduledStartDate ge {date_cutoff}",
            "$orderby": "WorkTicketID desc",
            "$top":     "500",
        })
        tickets = _aspire._extract_list(res)
    except Exception as e:
        raise HTTPException(500, f"Ticket fetch failed: {e}")

    opp_ids = list({t.get("OpportunityID") for t in tickets if t.get("OpportunityID")})[:60]
    opp_details: dict = {}
    BATCH = 20
    for i in range(0, len(opp_ids), BATCH):
        chunk = opp_ids[i:i+BATCH]
        try:
            res = await _aspire._get("Opportunities", {
                "$filter": " or ".join(f"OpportunityID eq {oid}" for oid in chunk),
                "$top":    str(BATCH),
                "$select": "OpportunityID,OpportunityName,PropertyName,DivisionName,OpportunityStatusName",
            })
            for opp in _aspire._extract_list(res):
                oid = opp.get("OpportunityID")
                if oid:
                    opp_details[oid] = opp
        except Exception as e:
            logger.warning(f"debug_divisions batch failed: {e}")

    # Tally unique division+status combos
    combos: dict = {}
    for opp in opp_details.values():
        div    = opp.get("DivisionName") or "(none)"
        status = opp.get("OpportunityStatusName") or "(none)"
        key    = f"{div} | {status}"
        combos[key] = combos.get(key, 0) + 1

    return {
        "total_opps_sampled": len(opp_details),
        "division_status_combos": dict(sorted(combos.items(), key=lambda x: -x[1])),
        "sample_opps": [
            {
                "opp_id":   o.get("OpportunityID"),
                "name":     o.get("OpportunityName"),
                "property": o.get("PropertyName"),
                "division": o.get("DivisionName"),
                "status":   o.get("OpportunityStatusName"),
            }
            for o in list(opp_details.values())[:20]
        ],
    }


# ── Main page data endpoint ───────────────────────────────────────────────────

@router.post("/{opp_id}/cache/clear")
async def clear_contract_cache(opp_id: int):
    """Drop the in-memory page cache for one contract (call after saving advisor/conversations)."""
    _invalidate_contract(opp_id)
    return {"cleared": True, "opp_id": opp_id}


@router.get("/{opp_id}")
async def get_maintenance_page(opp_id: int, db: Database = Depends(get_db)):
    """Full maintenance contract page: opp, tickets, visit notes, activities, AI summary."""
    # ── Per-contract cache ────────────────────────────────────────────────────
    if opp_id in _contract_cache:
        cached_data, cached_ts = _contract_cache[opp_id]
        if _time.time() - cached_ts < _CONTRACT_TTL:
            logger.info(f"Maintenance contract cache hit: opp {opp_id} (age={int(_time.time()-cached_ts)}s)")
            # Always fetch fresh advisor log and conversations from D1 (they update frequently)
            try:
                advisor_rows = await db._q(
                    "SELECT id, question, answer, has_photo, photo_r2_key, asked_at FROM field_advisor_log WHERE opp_id = ? ORDER BY asked_at DESC LIMIT 50",
                    [opp_id],
                )
                cached_data = {**cached_data, "advisor_log": [dict(r) for r in advisor_rows]}
            except Exception:
                pass
            return cached_data
    async def _fetch_services() -> list[dict]:
        try:
            res = await _aspire._get("OpportunityServices", {
                "$filter": f"OpportunityID eq {opp_id}",
                "$top":    "50",
            })
            return _aspire._extract_list(res)
        except Exception as e:
            logger.info(f"OpportunityServices for {opp_id}: {e}")
            return []

    async def _fetch_construction_projects(property_name: str) -> list[dict]:
        """Fetch active Won construction opps at the same property."""
        if not property_name:
            return []
        try:
            safe = property_name.replace("'", "''")
            res = await _aspire._get("Opportunities", {
                "$filter": (
                    f"PropertyName eq '{safe}'"
                    " and DivisionName eq 'Construction'"
                    " and OpportunityStatusName eq 'Won'"
                ),
                "$select": "OpportunityID,OpportunityName,PropertyName,OpportunityStatusName,StartDate,EndDate",
                "$top":    "20",
            })
            return _aspire._extract_list(res)
        except Exception as e:
            logger.info(f"Construction projects fetch for {property_name}: {e}")
            return []

    opp, tickets, services = await asyncio.gather(
        _fetch_opp(opp_id),
        _fetch_tickets(opp_id),
        _fetch_services(),
    )

    COMPLETE = {"complete", "completed"}

    completed_tickets = [t for t in tickets if (t.get("WorkTicketStatusName") or "").lower() in COMPLETE]
    upcoming_tickets  = [t for t in tickets if (t.get("WorkTicketStatusName") or "").lower() not in COMPLETE]

    # Fetch construction projects for this property in parallel
    property_name = opp.get("PropertyName") or ""
    construction_projects = await _fetch_construction_projects(property_name)

    # Fetch visit notes for completed tickets in parallel (cap at 30)
    async def _safe_visit_notes(tid: int) -> tuple[int, list[dict]]:
        notes = await _fetch_visit_notes(tid)
        return tid, notes

    visit_notes_map: dict[int, list[dict]] = {}
    if completed_tickets:
        # Cap at 10 most-recent — each is a separate Aspire API call
        completed_ids = [t["WorkTicketID"] for t in completed_tickets if t.get("WorkTicketID")][:10]
        results = await asyncio.gather(*[_safe_visit_notes(tid) for tid in completed_ids])
        for tid, notes in results:
            if notes:
                visit_notes_map[tid] = notes

    # Fetch activities
    activities: list[dict] = []
    try:
        res = await _aspire._get("Activities", {
            "$filter":  f"OpportunityID eq {opp_id}",
            "$orderby": "CreatedDate desc",
            "$top":     "50",
            "$select":  (
                "ActivityID,Subject,ActivityType,ActivityCategoryName,"
                "Status,Notes,CreatedDate,CompleteDate,CreatedByUserName,IsMileStone"
            ),
        })
        activities = _aspire._extract_list(res)
    except Exception as e:
        logger.warning(f"Activities fetch failed for opp {opp_id}: {e}")

    # Re-fetch Notes for activities with empty Notes (Aspire strips them on OppID filter)
    async def _refetch_notes(activity_id: int) -> str:
        try:
            r = await _aspire._get("Activities", {
                "$filter": f"ActivityID eq {activity_id}",
                "$select": "ActivityID,Notes",
                "$top":    "1",
            })
            rows = _aspire._extract_list(r)
            return rows[0].get("Notes") or "" if rows else ""
        except Exception:
            return ""

    # Aspire strips Notes on OppID filter — re-fetch individually, but cap at 8
    # to avoid a long tail of API calls (activities are deduped/merged anyway)
    missing = [a for a in activities if not (a.get("Notes") or "").strip()][:8]
    if missing:
        refetched = await asyncio.gather(*[_refetch_notes(a["ActivityID"]) for a in missing])
        for a, notes in zip(missing, refetched):
            a["Notes"] = notes

    for a in activities:
        a["_comments"] = _parse_comments_from_notes(a.get("Notes") or "")

    # Deduplicate activities — Aspire creates a new record per comment update on
    # the same issue, so group by Subject and keep the most recent, merging all
    # unique comments across duplicates into one card.
    seen: dict[str, dict] = {}
    for a in activities:
        key = (a.get("Subject") or "").strip() or str(a.get("ActivityID"))
        if key not in seen:
            seen[key] = a
        else:
            existing = seen[key]
            # Keep the entry with the latest CreatedDate as the primary
            if (a.get("CreatedDate") or "") > (existing.get("CreatedDate") or ""):
                # Merge existing comments into the newer record
                a["_comments"] = a["_comments"] + existing["_comments"]
                seen[key] = a
            else:
                # Merge new comments into the existing record
                existing["_comments"] = existing["_comments"] + a["_comments"]
    # Deduplicate the merged comments themselves (same text + author)
    for a in seen.values():
        unique_comments: list[dict] = []
        seen_cmts: set[tuple] = set()
        for c in a["_comments"]:
            ck = (c.get("Comment") or "").strip(), (c.get("CreatedByUserName") or "")
            if ck not in seen_cmts:
                seen_cmts.add(ck)
                unique_comments.append(c)
        a["_comments"] = unique_comments
    activities = list(seen.values())

    # AI summary (parallel with above would be better but summary depends on tickets)
    ai_summary = await _generate_maintenance_summary(opp, tickets, services)

    # Field Advisor log
    try:
        advisor_rows = await db._q(
            """SELECT id, question, answer, has_photo, photo_r2_key, asked_at
               FROM field_advisor_log
               WHERE opp_id = ?
               ORDER BY asked_at DESC
               LIMIT 50""",
            [opp_id],
        )
    except Exception:
        advisor_rows = []

    def _fmt_ticket(t: dict, include_notes: bool = False) -> dict:
        tid = t.get("WorkTicketID")
        out: dict = {
            "WorkTicketID":         tid,
            "WorkTicketNumber":     t.get("WorkTicketNumber"),
            "ServiceName":          t.get("ServiceName") or "",
            "WorkTicketStatusName": t.get("WorkTicketStatusName"),
            "ScheduledStartDate":   (t.get("ScheduledStartDate") or "")[:10],
            "CompleteDate":         (t.get("CompleteDate") or "")[:10],
            "HoursEst":             t.get("HoursEst"),
            "HoursAct":             t.get("HoursAct"),
            "CrewLeaderName":       t.get("CrewLeaderName"),
            "visit_notes":          [],
        }
        if include_notes and tid and tid in visit_notes_map:
            out["visit_notes"] = [
                {
                    "note":           vn.get("Note") or "",
                    "created_at":     (vn.get("CreatedDateTime") or "")[:16],
                    "created_by":     vn.get("CreatedByUserName") or "",
                    "scheduled_date": (vn.get("ScheduledDate") or "")[:10],
                }
                for vn in visit_notes_map[tid]
            ]
        return out

    result = {
        "opportunity_id":    opp_id,
        "opportunity_name":  opp.get("OpportunityName") or f"Contract #{opp_id}",
        "property_name":     opp.get("PropertyName") or "",
        "division":          opp.get("DivisionName") or "",
        "status":            opp.get("OpportunityStatusName"),
        "hrs_est":           opp.get("EstimatedLaborHours"),
        "hrs_act":           opp.get("ActualLaborHours"),
        "ai_summary":        ai_summary,
        "services": [
            {
                "name":      s.get("ServiceNameAbr") or s.get("ServiceName") or s.get("DisplayName") or "",
                "frequency": s.get("Frequency") or s.get("FrequencyName") or "",
                "price":     s.get("Price") or s.get("UnitCost") or None,
                "notes":     s.get("Notes") or s.get("ServiceNotes") or "",
            }
            for s in services
        ],
        "completed_tickets": [_fmt_ticket(t, include_notes=True) for t in completed_tickets],
        "upcoming_tickets":  [_fmt_ticket(t, include_notes=False) for t in upcoming_tickets],
        "activities": [
            {
                "ActivityID":           a.get("ActivityID"),
                "Subject":              a.get("Subject") or "",
                "ActivityType":         a.get("ActivityType") or "",
                "ActivityCategoryName": a.get("ActivityCategoryName") or "",
                "Status":               a.get("Status") or "",
                "CreatedDate":          (a.get("CreatedDate") or "")[:10],
                "CompleteDate":         (a.get("CompleteDate") or "")[:10],
                "CreatedByUserName":    a.get("CreatedByUserName") or "",
                "IsMileStone":          bool(a.get("IsMileStone")),
                "comments": [
                    {
                        "Comment":           c.get("Comment") or "",
                        "CreatedDate":       (c.get("CreatedDate") or "")[:10],
                        "CreatedByUserName": c.get("CreatedByUserName") or "",
                    }
                    for c in (a.get("_comments") or [])
                ],
            }
            for a in activities
        ],
        "advisor_log": [dict(r) for r in advisor_rows],
        "construction_projects": [
            {
                "opp_id":   p.get("OpportunityID"),
                "name":     p.get("OpportunityName") or "",
                "status":   p.get("OpportunityStatusName") or "",
                "start":    (p.get("StartDate") or "")[:10],
                "end":      (p.get("EndDate") or "")[:10],
            }
            for p in construction_projects
        ],
    }

    # Store in per-contract cache (advisor_log excluded — fetched fresh on cache hits)
    _contract_cache[opp_id] = (result, _time.time())
    logger.info(f"Maintenance contract cached: opp {opp_id}")
    return result


# ── Field Advisor ─────────────────────────────────────────────────────────────

@router.post("/{opp_id}/field-advisor")
async def maintenance_field_advisor(
    opp_id:   int,
    question: str                  = Form(...),
    photo:    Optional[UploadFile] = File(default=None),
    db:       Database             = Depends(get_db),
):
    """AI field advisor for maintenance crew. Accepts text question + optional photo."""
    import base64 as _b64

    try:
        if not settings.ANTHROPIC_API_KEY:
            raise HTTPException(503, "AI advisor not configured")

        SYSTEM = (
            "You are an experienced landscape maintenance advisor helping crew leads solve real "
            "site problems. Your expertise covers: turf management, plant health, irrigation, "
            "fertilization, pest and disease identification, pruning and horticulture, drainage, "
            "seasonal maintenance programs, and BC landscape best practices.\n\n"
            "Give practical, field-ready advice a maintenance crew lead can act on immediately. "
            "Use short bullet points or numbered steps where helpful. "
            "If a photo is provided, describe what you observe before giving advice. "
            "Keep responses focused and under 300 words.\n\n"
            "IMPORTANT: Never ask clarifying questions. Always give your best practical answer."
        )

        content: list[dict] = []
        photo_raw: bytes | None = None
        photo_ext: str = ""
        photo_mime: str = "image/jpeg"

        if photo:
            raw = await photo.read()
            if raw and len(raw) <= 8 * 1024 * 1024:
                photo_raw = raw
                fname     = (photo.filename or "").strip()
                photo_ext = (fname.rsplit(".", 1)[-1] if "." in fname else "").lower()
                if not photo_ext:
                    ct = (photo.content_type or "image/jpeg").lower()
                    photo_ext = ct.split("/")[-1] if "/" in ct else "jpeg"
                photo_mime = {
                    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                    "webp": "image/webp", "heic": "image/jpeg", "gif": "image/gif",
                }.get(photo_ext, "image/jpeg")
                content.append({
                    "type": "image",
                    "source": {
                        "type":       "base64",
                        "media_type": photo_mime,
                        "data":       _b64.b64encode(raw).decode("ascii"),
                    },
                })

        content.append({
            "type": "text",
            "text": question.strip() or "What do you observe and what should I know?",
        })

        client   = _anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        response = await client.messages.create(
            model="claude-opus-4-5",
            max_tokens=1024,
            system=SYSTEM,
            messages=[{"role": "user", "content": content}],
        )
        answer = response.content[0].text if response.content else "No response generated."

        # Save photo to R2 (best-effort)
        photo_r2_key: str | None = None
        if photo_raw and _r2._r2_available():
            try:
                safe_ext = photo_ext or "jpg"
                r2_key   = f"advisor-photos/maintenance/{opp_id}/{uuid.uuid4().hex[:8]}.{safe_ext}"
                ct       = photo_mime
                def _up(key=r2_key, body=photo_raw, content_type=ct):
                    _r2._make_client().put_object(
                        Bucket=settings.R2_BUCKET_NAME,
                        Key=key, Body=body, ContentType=content_type,
                    )
                await asyncio.get_event_loop().run_in_executor(None, _up)
                photo_r2_key = r2_key
            except Exception as r2_err:
                logger.warning(f"Maintenance advisor: R2 save failed: {r2_err}")

        return {
            "answer":         answer,
            "photo_r2_key":   photo_r2_key,
            "has_photo":      1 if photo_raw else 0,
            "photo_received": photo_raw is not None,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Maintenance field advisor error for opp {opp_id}: {e}", exc_info=True)
        raise HTTPException(500, f"Advisor error: {e}") from e


def _send_whatsapp_notification(
    opp_id: int,
    property_name: str,
    crew_name: str,
    question: str,
) -> None:
    """Fire-and-forget Twilio WhatsApp message to configured recipients."""
    sid   = settings.TWILIO_ACCOUNT_SID
    token = settings.TWILIO_AUTH_TOKEN
    frm   = settings.TWILIO_WHATSAPP_FROM
    to_list = [t.strip() for t in settings.TWILIO_WHATSAPP_TO.split(",") if t.strip()]

    if not (sid and token and frm and to_list):
        logger.info("Twilio not configured — skipping WhatsApp notification.")
        return

    try:
        from twilio.rest import Client as TwilioClient  # lazy import
        client = TwilioClient(sid, token)

        crew_label = crew_name.strip() if crew_name.strip() else "Unknown"
        q_preview  = question.strip()[:200] + ("…" if len(question.strip()) > 200 else "")
        deep_link  = f"https://darios-ap.pages.dev/field/maintenance/{opp_id}"

        body = (
            f"🌿 *Field Advisor Q&A Saved*\n"
            f"Property: {property_name}\n"
            f"Crew: {crew_label}\n\n"
            f"Q: {q_preview}\n\n"
            f"🔗 {deep_link}"
        )

        for to in to_list:
            client.messages.create(body=body, from_=frm, to=to)
            logger.info(f"WhatsApp notification sent to {to} for opp {opp_id}")

    except Exception as e:
        logger.warning(f"WhatsApp notification failed for opp {opp_id}: {e}")


@router.post("/{opp_id}/field-advisor/save")
async def maintenance_advisor_save(
    opp_id:        int,
    question:      str            = Form(...),
    answer:        str            = Form(...),
    has_photo:     int            = Form(default=0),
    photo_r2_key:  Optional[str] = Form(default=None),
    crew_name:     Optional[str] = Form(default=None),
    property_name: Optional[str] = Form(default=None),
    db:            Database       = Depends(get_db),
):
    """Persist a Field Advisor Q&A (called only when crew lead confirms save)."""
    try:
        log_id = await db._x(
            """INSERT INTO field_advisor_log
               (opp_id, question, answer, has_photo, photo_r2_key)
               VALUES (?,?,?,?,?)""",
            [opp_id, question.strip(), answer.strip(), has_photo, photo_r2_key or None],
        )

        # Fire WhatsApp notification (non-blocking — runs in thread pool)
        prop = property_name or f"Opp #{opp_id}"
        crew = crew_name or ""
        asyncio.get_event_loop().run_in_executor(
            None,
            _send_whatsapp_notification,
            opp_id, prop, crew, question.strip(),
        )

        return {"saved": True, "log_id": log_id}
    except Exception as e:
        logger.error(f"Maintenance advisor save failed for opp {opp_id}: {e}", exc_info=True)
        raise HTTPException(500, f"Save failed: {e}") from e
