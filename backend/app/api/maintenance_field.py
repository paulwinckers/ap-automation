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

# ── Simple in-memory lookup cache (10 min TTL) ────────────────────────────────
_lookup_cache:    dict | None = None
_lookup_cache_ts: float       = 0.0
_LOOKUP_TTL = 10 * 60


async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


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


# ── Lookup endpoint ───────────────────────────────────────────────────────────

@router.get("/lookup")
async def maintenance_lookup():
    """
    List active maintenance contracts from Aspire.
    Filters Won opportunities in non-construction divisions.
    Cached for 10 minutes.
    """
    global _lookup_cache, _lookup_cache_ts

    if _lookup_cache is not None:
        age = _time.time() - _lookup_cache_ts
        if age < _LOOKUP_TTL:
            logger.info(f"Maintenance lookup: cache hit (age={age:.0f}s)")
            return _lookup_cache

    try:
        from datetime import datetime, timedelta

        date_cutoff = (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")
        all_tickets: list[dict] = []
        for skip in range(0, 2000, 500):
            try:
                res = await _aspire._get("WorkTickets", {
                    "$select":  "WorkTicketID,WorkTicketStatusName,OpportunityID,ScheduledStartDate,CompleteDate,HoursEst,HoursAct",
                    "$filter":  f"ScheduledStartDate ge {date_cutoff}",
                    "$orderby": "WorkTicketID desc",
                    "$top":     "500",
                    "$skip":    str(skip),
                })
                batch = _aspire._extract_list(res)
                if not batch:
                    break
                all_tickets.extend(batch)
                if len(batch) < 500:
                    break
            except Exception as e:
                logger.warning(f"Maintenance lookup: ticket page skip={skip} failed: {e}")
                break

        ACTIVE_STATUSES   = {"in production", "in queue", "scheduled", "open"}
        COMPLETE_STATUSES = {"complete", "completed"}
        cutoff_90 = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")

        opp_map: dict = {}
        for t in all_tickets:
            oid = t.get("OpportunityID")
            if not oid:
                continue
            status = (t.get("WorkTicketStatusName") or "").strip().lower()
            if status not in ACTIVE_STATUSES and status not in COMPLETE_STATUSES:
                continue
            if status in COMPLETE_STATUSES:
                done = (t.get("CompleteDate") or t.get("ScheduledStartDate") or "")[:10]
                if done < cutoff_90:
                    continue
            if oid not in opp_map:
                opp_map[oid] = {
                    "hrs_est":        0.0,
                    "hrs_act":        0.0,
                    "ticket_count":   0,
                    "active_tickets": 0,
                    "latest_date":    "",
                }
            e = opp_map[oid]
            e["hrs_est"]      += float(t.get("HoursEst") or 0)
            e["hrs_act"]      += float(t.get("HoursAct") or 0)
            e["ticket_count"] += 1
            d = (t.get("ScheduledStartDate") or "")[:10]
            if d > e["latest_date"]:
                e["latest_date"] = d
            if status in ACTIVE_STATUSES:
                e["active_tickets"] += 1

        if not opp_map:
            result = {"contracts": []}
            _lookup_cache    = result
            _lookup_cache_ts = _time.time()
            return result

        # Batch-fetch opp details
        opp_ids     = list(opp_map.keys())
        opp_details: dict = {}
        BATCH = 20
        for i in range(0, len(opp_ids), BATCH):
            chunk     = opp_ids[i:i+BATCH]
            or_filter = " or ".join(f"OpportunityID eq {oid}" for oid in chunk)
            try:
                res = await _aspire._get("Opportunities", {
                    "$filter": or_filter,
                    "$top":    str(BATCH),
                    "$select": "OpportunityID,OpportunityName,PropertyName,DivisionName,OpportunityStatusName,ContractType,ContractTypeName",
                })
                for opp in _aspire._extract_list(res):
                    oid = opp.get("OpportunityID")
                    if oid:
                        opp_details[oid] = opp
            except Exception as e:
                logger.warning(f"Maintenance opp batch fetch failed: {e}")

        EXCLUDE_DIVISIONS = {"construction"}

        contracts = []
        for oid, e in opp_map.items():
            opp        = opp_details.get(oid, {})
            if not opp:
                continue
            division   = (opp.get("DivisionName") or "").strip().lower()
            opp_status = (opp.get("OpportunityStatusName") or "").strip().lower()

            # Skip construction and lost/cancelled
            if any(ex in division for ex in EXCLUDE_DIVISIONS):
                continue
            if opp_status in {"lost", "cancelled", "canceled", "void"}:
                continue
            if opp_status != "won":
                continue

            all_done = e["active_tickets"] == 0
            contracts.append({
                "opp_id":       oid,
                "opp_name":     opp.get("OpportunityName") or f"Contract #{oid}",
                "property":     opp.get("PropertyName") or "",
                "division":     opp.get("DivisionName") or "",
                "status":       "Complete" if all_done else "Active",
                "all_done":     all_done,
                "hrs_est":      round(e["hrs_est"], 1),
                "hrs_act":      round(e["hrs_act"], 1),
                "ticket_count": e["ticket_count"],
                "latest_date":  e["latest_date"],
            })

        contracts.sort(key=lambda x: x["latest_date"], reverse=True)
        contracts.sort(key=lambda x: x["all_done"])  # active first

        result = {"contracts": contracts}
        _lookup_cache    = result
        _lookup_cache_ts = _time.time()
        logger.info(f"Maintenance lookup: returning {len(contracts)} contracts")
        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Maintenance lookup error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to load contracts: {e}") from e


# ── Main page data endpoint ───────────────────────────────────────────────────

@router.get("/{opp_id}")
async def get_maintenance_page(opp_id: int, db: Database = Depends(get_db)):
    """Full maintenance contract page: opp, tickets, visit notes, activities, AI summary."""
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

    opp, tickets, services = await asyncio.gather(
        _fetch_opp(opp_id),
        _fetch_tickets(opp_id),
        _fetch_services(),
    )

    COMPLETE = {"complete", "completed"}

    completed_tickets = [t for t in tickets if (t.get("WorkTicketStatusName") or "").lower() in COMPLETE]
    upcoming_tickets  = [t for t in tickets if (t.get("WorkTicketStatusName") or "").lower() not in COMPLETE]

    # Fetch visit notes for completed tickets in parallel (cap at 30)
    async def _safe_visit_notes(tid: int) -> tuple[int, list[dict]]:
        notes = await _fetch_visit_notes(tid)
        return tid, notes

    visit_notes_map: dict[int, list[dict]] = {}
    if completed_tickets:
        completed_ids = [t["WorkTicketID"] for t in completed_tickets if t.get("WorkTicketID")][:30]
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

    missing = [a for a in activities if not (a.get("Notes") or "").strip()]
    if missing:
        refetched = await asyncio.gather(*[_refetch_notes(a["ActivityID"]) for a in missing])
        for a, notes in zip(missing, refetched):
            a["Notes"] = notes

    for a in activities:
        a["_comments"] = _parse_comments_from_notes(a.get("Notes") or "")

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

    return {
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
    }


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


@router.post("/{opp_id}/field-advisor/save")
async def maintenance_advisor_save(
    opp_id:       int,
    question:     str            = Form(...),
    answer:       str            = Form(...),
    has_photo:    int            = Form(default=0),
    photo_r2_key: Optional[str] = Form(default=None),
    db:           Database       = Depends(get_db),
):
    """Persist a Field Advisor Q&A (called only when crew lead confirms save)."""
    try:
        log_id = await db._x(
            """INSERT INTO field_advisor_log
               (opp_id, question, answer, has_photo, photo_r2_key)
               VALUES (?,?,?,?,?)""",
            [opp_id, question.strip(), answer.strip(), has_photo, photo_r2_key or None],
        )
        return {"saved": True, "log_id": log_id}
    except Exception as e:
        logger.error(f"Maintenance advisor save failed for opp {opp_id}: {e}", exc_info=True)
        raise HTTPException(500, f"Save failed: {e}") from e
