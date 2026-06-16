"""
Construction Monthly Planning API
Leads commit jobs to a month and set revenue/hours goals.
Live Aspire actuals (hours, % complete, revenue) are layered on top.

GET    /construction/plan/{month}                  — full plan with live actuals
PUT    /construction/plan/{month}/goal             — set/update monthly goal
POST   /construction/plan/{month}/jobs             — commit a job to the month
DELETE /construction/plan/{month}/jobs/{opp_id}   — remove a committed job
GET    /construction/plan/{month}/suggestions      — active construction opps not yet committed
"""
import logging
from datetime import datetime, timezone, date as _date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.services.aspire import AspireClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/construction/plan", tags=["construction-plan"])

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

# ── DB helper ─────────────────────────────────────────────────────────────────
_db = Database()

async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


# ── Pydantic models ───────────────────────────────────────────────────────────
class GoalIn(BaseModel):
    revenue_goal: Optional[float] = None
    hours_goal:   Optional[float] = None
    notes:        Optional[str]   = None

class JobIn(BaseModel):
    opportunity_id:   int
    opportunity_name: Optional[str] = None
    property_name:    Optional[str] = None
    notes:            Optional[str] = None
    committed_by:     Optional[str] = None

class PrepToggleIn(BaseModel):
    item_key:   str
    checked:    bool
    checked_by: Optional[str] = None

class PlanningIn(BaseModel):
    lead_name:          Optional[str]  = None   # assign a construction lead (None = leave unchanged)
    schedule_confirmed: Optional[bool] = None   # customer-confirmed schedule (None = leave unchanged)
    updated_by:         Optional[str]  = None

# Fixed preparedness checklist applied to every committed job (keyed by opportunity_id).
PREP_ITEMS = [
    {"key": "deposit_received",   "label": "Deposit received"},
    {"key": "site_utility_check", "label": "Site utility check"},
    {"key": "plants_determined",  "label": "Plants determined"},
    {"key": "materials_ordered",  "label": "Materials ordered"},
    {"key": "drawing_uploaded",   "label": "Drawing uploaded"},
    {"key": "site_review",        "label": "Site review"},
]
PREP_TOTAL = len(PREP_ITEMS)


# ── Aspire helpers ────────────────────────────────────────────────────────────
async def _fetch_opp_actuals(opp_ids: list[int]) -> dict[int, dict]:
    """Fetch live actuals for a list of OpportunityIDs from Aspire.
    All chunks are requested in parallel to minimise wall-clock time.
    """
    import asyncio as _asyncio
    if not opp_ids:
        return {}

    chunk_size = 15
    chunks = [opp_ids[i:i + chunk_size] for i in range(0, len(opp_ids), chunk_size)]

    async def _fetch_chunk(chunk: list[int]) -> list[dict]:
        or_filter = " or ".join(f"OpportunityID eq {oid}" for oid in chunk)
        params = {
            "$filter": f"({or_filter})",
            "$select": (
                "OpportunityID,OpportunityName,PropertyName,OpportunityNumber,"
                "DivisionName,WonDollars,ActualEarnedRevenue,EstimatedDollars,"
                "EstimatedLaborHours,ActualLaborHours,PercentComplete,"
                "OpportunityStatusName,StartDate,EndDate"
            ),
            "$top": "200",
        }
        # Retry transient Aspire failures — a single failed chunk would otherwise blank
        # the name/status of every opp in it (rows fall back to "Job #1234" / "—").
        for attempt in range(3):
            try:
                res = await _aspire._get("Opportunities", params)
                return _aspire._extract_list(res)
            except Exception as e:
                if attempt == 2:
                    logger.warning(f"Aspire actuals fetch failed after 3 tries: {e}")
                    return []
                await _asyncio.sleep(0.4 * (attempt + 1))
        return []

    results = await _asyncio.gather(*[_fetch_chunk(c) for c in chunks])
    out: dict[int, dict] = {}
    for records in results:
        for o in records:
            oid = o.get("OpportunityID")
            if oid:
                out[oid] = o
    return out


async def _fetch_scheduled_opp_ids(month: str) -> dict[int, list[dict]]:
    """
    Return {opportunity_id: [ticket, ...]} for all Construction work tickets
    whose ScheduledStartDate falls within the given YYYY-MM month.
    Matches Aspire's 'This Month' filter: status Open or Scheduled, date in month.
    """
    y, m = int(month[:4]), int(month[5:7])
    if m == 12:
        next_m = f"{y + 1}-01"
    else:
        next_m = f"{y}-{str(m + 1).zfill(2)}"
    start = f"{month}-01"
    end   = f"{next_m}-01"

    # Fetch all tickets with ScheduledStartDate in the month (no status filter —
    # Aspire's 'This Month' view shows Open + Scheduled + any other non-terminal status).
    # We try without the time suffix first as some Aspire environments prefer bare dates.
    tickets: list[dict] = []
    for date_fmt in (
        f"ScheduledStartDate ge {start} and ScheduledStartDate lt {end}",
        f"ScheduledStartDate ge {start}T00:00:00Z and ScheduledStartDate lt {end}T00:00:00Z",
    ):
        try:
            res = await _aspire._get("WorkTickets", {
                "$filter": date_fmt,
                "$orderby": "WorkTicketID desc",
                "$top": "500",
                "$select": "WorkTicketID,WorkTicketNumber,WorkTicketStatusName,OpportunityID,OpportunityServiceID,ScheduledStartDate,CompleteDate,HoursEst,HoursAct,Revenue,BudgetVariance,CrewLeaderName,PercentComplete",
            })
            tickets = _aspire._extract_list(res)
            logger.info(f"Plan: fetched {len(tickets)} work tickets for {month} using filter: {date_fmt}")
            if tickets:
                break
        except Exception as e:
            logger.warning(f"WorkTickets filter failed ({date_fmt}): {e}")

    if not tickets:
        return {}

    # Filter to Construction division via Opportunity lookup
    opp_ids = list({t.get("OpportunityID") for t in tickets if t.get("OpportunityID")})
    if not opp_ids:
        return {}

    opp_div: dict[int, str]  = {}
    opp_meta: dict[int, dict] = {}   # name/property/number/status — reliable name source
    branch = (settings.ASPIRE_CONSTRUCTION_BRANCH or "Construction").lower()
    for i in range(0, len(opp_ids), 15):
        chunk = opp_ids[i:i+15]
        or_f  = " or ".join(f"OpportunityID eq {oid}" for oid in chunk)
        try:
            res2 = await _aspire._get("Opportunities", {
                "$filter": f"({or_f})",
                "$select": "OpportunityID,DivisionName,OpportunityName,PropertyName,OpportunityNumber,OpportunityStatusName",
                "$top": "200",
            })
            for o in _aspire._extract_list(res2):
                oid = o.get("OpportunityID")
                if oid:
                    opp_div[oid]  = (o.get("DivisionName") or "").lower()
                    opp_meta[oid] = o
        except Exception:
            pass

    out: dict[int, list[dict]] = {}
    for t in tickets:
        oid = t.get("OpportunityID")
        if oid and branch in opp_div.get(oid, ""):
            # Attach opp name/property so the plan can fall back to it if the live
            # actuals fetch flakes for this opp (keeps rows from showing "Job #1234").
            if oid in opp_meta:
                t["_opp_meta"] = opp_meta[oid]
            out.setdefault(oid, []).append(t)

    logger.info(f"Plan: {len(out)} Construction opportunities with scheduled tickets in {month}")
    return out


async def _fetch_ticket_revenues(month: str, ticket_ids: set[int]) -> dict[int, float]:
    """
    Query /WorkTicketRevenues for the given month and return
    {WorkTicketID: total_RevenueAmount} for only the supplied ticket IDs.

    Uses RevenueMonth to get revenue recognised in this specific month —
    much more accurate than EarnedRevenue (lifetime) on the WorkTicket itself.
    """
    if not ticket_ids:
        return {}

    y, m = int(month[:4]), int(month[5:7])
    next_m = f"{y + 1}-01" if m == 12 else f"{y}-{str(m + 1).zfill(2)}"
    start = f"{month}-01T00:00:00Z"
    end   = f"{next_m}-01T00:00:00Z"

    revenues: dict[int, float] = {}
    try:
        res = await _aspire._get("WorkTicketRevenues", {
            "$filter": f"RevenueMonth ge {start} and RevenueMonth lt {end}",
            "$select": "WorkTicketRevenueID,WorkTicketID,RevenueMonth,RevenueAmount",
            "$top": "2000",
        })
        for row in _aspire._extract_list(res):
            tid = row.get("WorkTicketID")
            amt = float(row.get("RevenueAmount") or 0)
            if tid and tid in ticket_ids:
                revenues[tid] = revenues.get(tid, 0.0) + amt
        logger.info(f"WorkTicketRevenues: {len(revenues)} tickets with revenue in {month}")
    except Exception as e:
        logger.warning(f"WorkTicketRevenues fetch failed: {e}")

    return revenues


async def _fetch_construction_opps(exclude_ids: set[int] | None = None) -> list[dict]:
    """Fetch active Construction division opportunities from Aspire, excluding given IDs."""
    try:
        res = await _aspire._get("Opportunities", {
            "$filter": "OpportunityStatusName ne 'Lost' and OpportunityStatusName ne 'Complete'",
            "$select": (
                "OpportunityID,OpportunityName,PropertyName,DivisionName,"
                "OpportunityStatusName,WonDollars,EstimatedLaborHours,ActualLaborHours,"
                "PercentComplete,StartDate,EndDate"
            ),
            "$top": "500",
            "$orderby": "OpportunityName asc",
        })
        all_opps = _aspire._extract_list(res)
        branch = (settings.ASPIRE_CONSTRUCTION_BRANCH or "Construction").lower()
        return [
            o for o in all_opps
            if branch in (o.get("DivisionName") or "").lower()
            and (not exclude_ids or o.get("OpportunityID") not in exclude_ids)
        ]
    except Exception as e:
        logger.warning(f"Aspire opps fetch failed: {e}")
        return []


def _risk_flag(opp: dict, pct_month: float | None = None) -> str:
    """Return a risk label based on hours burn vs monthly ticket completion.

    Aspire returns PercentComplete as a decimal (0–1), not a percentage (0–100).
    pct_month (from ticket counts) is already in 0–100 form.
    """
    aspire_pct = float(opp.get("PercentComplete") or 0)
    # Aspire decimal → percentage; clamp to 0-100
    aspire_pct_scaled = min(aspire_pct * 100, 100.0)

    pct  = pct_month if pct_month is not None else aspire_pct_scaled
    est  = float(opp.get("EstimatedLaborHours") or 0)
    act  = float(opp.get("ActualLaborHours") or 0)
    burn = (act / est * 100) if est else 0

    # Also treat as complete if Aspire job-level completion is 100%
    if pct >= 100 or aspire_pct_scaled >= 100:
        return "complete"
    if burn > 90 and pct < 70:
        return "over_budget"
    if burn > pct + 25:
        return "at_risk"
    return "on_track"


def _days_left_in_month(month: str) -> int:
    try:
        y, m = int(month[:4]), int(month[5:7])
        if m == 12:
            end = _date(y + 1, 1, 1)
        else:
            end = _date(y, m + 1, 1)
        return (end - _date.today()).days
    except Exception:
        return 0


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{month}")
async def get_plan(month: str, db: Database = Depends(get_db)):
    """
    Return the full monthly plan: goal + jobs with live Aspire actuals.

    Jobs come from two sources (merged, deduped):
      1. SCHEDULED — work tickets with ScheduledStartDate in the month (auto, from Aspire)
      2. MANUAL    — opportunities committed via the Add Job button (stored in D1)

    month format: YYYY-MM
    """
    if len(month) != 7 or month[4] != "-":
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")

    import asyncio as _aio

    # Fetch goal, manually committed jobs, and scheduled work tickets in parallel
    goal_rows_coro  = db._q("SELECT * FROM construction_monthly_goals WHERE month = ?", [month])
    target_rows_coro = db._q("SELECT * FROM construction_job_targets WHERE month = ? ORDER BY created_at", [month])
    scheduled_coro  = _fetch_scheduled_opp_ids(month)

    goal_rows, target_rows, scheduled_map = await _aio.gather(
        goal_rows_coro, target_rows_coro, scheduled_coro
    )

    goal = dict(goal_rows[0]) if goal_rows else {
        "month": month, "revenue_goal": None, "hours_goal": None, "notes": None
    }
    all_targets    = [dict(r) for r in target_rows]
    # Suppressed jobs (manually removed by user) — exclude from plan entirely
    suppressed_ids = {t["opportunity_id"] for t in all_targets if t.get("notes") == "__suppressed__"}
    manual_targets = [t for t in all_targets if t.get("notes") != "__suppressed__"]
    manual_ids     = {t["opportunity_id"] for t in manual_targets}
    scheduled_ids  = set(scheduled_map.keys()) - suppressed_ids

    # All ticket IDs across all scheduled opps — used for the revenue query
    all_ticket_ids: set[int] = set()
    for tlist in scheduled_map.values():
        for t in tlist:
            tid = t.get("WorkTicketID")
            if tid:
                all_ticket_ids.add(tid)

    # Fetch opportunity actuals and ticket revenues in parallel
    all_opp_ids = list(scheduled_ids | manual_ids)
    actuals, ticket_revenues = await _aio.gather(
        _fetch_opp_actuals(all_opp_ids),
        _fetch_ticket_revenues(month, all_ticket_ids),
    )

    def _make_job(oid: int, source: str, notes: str = "", committed_by: str = "", committed_at: str = "") -> dict:
        opp     = actuals.get(oid, {})
        hrs_est = float(opp.get("EstimatedLaborHours") or 0)
        hrs_act = float(opp.get("ActualLaborHours") or 0)
        rev_est = float(opp.get("WonDollars") or opp.get("EstimatedDollars") or 0)
        pct     = float(opp.get("PercentComplete") or 0)

        # Tickets scheduled for this month
        tickets = scheduled_map.get(oid, [])
        sched_dates = sorted(
            [t.get("ScheduledStartDate", "") for t in tickets if t.get("ScheduledStartDate")]
        )
        # % complete = completed tickets this month / total tickets this month
        completed_tickets = [
            t for t in tickets
            if (t.get("WorkTicketStatusName") or "").lower() in ("complete", "completed")
        ]
        n_total     = len(tickets)
        n_complete  = len(completed_tickets)
        pct_month   = (n_complete / n_total * 100) if n_total else 0

        # ── Month-specific hours & revenue from scheduled tickets ──────────────
        hrs_est_month     = sum(float(t.get("HoursEst") or 0) for t in tickets)
        hrs_act_month     = sum(float(t.get("HoursAct") or 0) for t in tickets)
        # Earned revenue this month. Prefer /WorkTicketRevenues (month-recognised); when that's
        # empty — common for completed tickets — estimate from progress so a job with logged
        # hours still shows earned revenue (complete → full Revenue, else Revenue × hours-progress).
        def _ticket_earned(t: dict) -> float:
            wtr = ticket_revenues.get(t.get("WorkTicketID"), 0.0)
            if wtr:
                return wtr
            rev = float(t.get("Revenue") or 0)
            if rev <= 0:
                return 0.0
            status = (t.get("WorkTicketStatusName") or "").lower()
            if status in ("complete", "completed") or t.get("CompleteDate"):
                return rev
            he = float(t.get("HoursEst") or 0)
            ha = float(t.get("HoursAct") or 0)
            if he > 0:
                return rev * min(ha / he, 1.0)
            return 0.0
        revenue_act_month = sum(_ticket_earned(t) for t in tickets)
        # Budgeted revenue for this month's tickets (ticket-level Revenue field)
        revenue_est_month = sum(float(t.get("Revenue") or 0) for t in tickets)

        rev_act = float(opp.get("ActualEarnedRevenue") or 0)

        # Name/property/number/status fall back to the meta carried on the scheduled
        # tickets when the live actuals fetch didn't return this opp.
        meta = tickets[0].get("_opp_meta", {}) if tickets else {}

        return {
            "opportunity_id":    oid,
            "opportunity_name":  opp.get("OpportunityName") or meta.get("OpportunityName") or f"Job #{oid}",
            "property_name":     opp.get("PropertyName") or meta.get("PropertyName") or "",
            "opp_number":        opp.get("OpportunityNumber") or meta.get("OpportunityNumber"),
            "status":            opp.get("OpportunityStatusName") or meta.get("OpportunityStatusName") or "",
            "hrs_est":           hrs_est,           # total job estimated hours
            "hrs_act":           hrs_act,           # total job actual hours (lifetime)
            "hrs_est_month":         hrs_est_month,     # estimated hours from THIS month's tickets
            "hrs_act_month":         hrs_act_month,     # actual hours from THIS month's tickets only
            "revenue_act_month":     revenue_act_month, # EarnedRevenue from THIS month's tickets
            "revenue_est_month":     revenue_est_month, # budgeted Revenue from THIS month's tickets
            "pct_complete":      pct_month,         # tickets done this month / total this month
            "pct_complete_job":  pct,               # Aspire's overall job % complete
            "revenue_est":       rev_est,
            "revenue_act":       rev_act,
            "start_date":        opp.get("StartDate"),
            "end_date":          opp.get("EndDate"),
            "scheduled_dates":   sched_dates,
            "ticket_count":      len(tickets),
            "completed_tickets": len(completed_tickets),
            "source":            source,
            "notes":             notes,
            "committed_by":      committed_by,
            "committed_at":      committed_at,
            "risk":              _risk_flag(opp, pct_month if n_total else None),
        }

    jobs: dict[int, dict] = {}

    # 1. Add scheduled jobs
    for oid in scheduled_ids:
        jobs[oid] = _make_job(oid, source="scheduled")

    # 2. Merge manual jobs — upgrade source to "both" if already scheduled
    for t in manual_targets:
        oid = t["opportunity_id"]
        if oid in jobs:
            jobs[oid]["source"] = "both"
            jobs[oid]["notes"]  = t.get("notes") or ""
        else:
            job = _make_job(
                oid, source="manual",
                notes=t.get("notes") or "",
                committed_by=t.get("committed_by") or "",
                committed_at=t.get("created_at") or "",
            )
            # Resilience: if Aspire didn't return a name (e.g. during an Aspire/D1 hiccup),
            # fall back to the name/property captured when the job was committed.
            if not job["opportunity_name"] or job["opportunity_name"] == f"Job #{oid}":
                if t.get("opportunity_name"):
                    job["opportunity_name"] = t["opportunity_name"]
            if not job["property_name"] and t.get("property_name"):
                job["property_name"] = t["property_name"]
            jobs[oid] = job

    # Preparedness checklist progress — one query for every job in the plan
    prep_done: dict[int, int] = {}
    if jobs:
        ph = ",".join("?" for _ in jobs)
        try:
            prep_rows = await db._q(
                f"""SELECT opportunity_id, COUNT(*) AS done
                    FROM job_prep_checklist
                    WHERE checked = 1 AND opportunity_id IN ({ph})
                    GROUP BY opportunity_id""",
                list(jobs.keys()),
            )
            prep_done = {r["opportunity_id"]: r["done"] for r in prep_rows}
        except Exception:
            prep_done = {}  # table may not exist yet on older deployments

    # Lead assignment + customer-confirmed schedule — one query for all jobs in the plan
    planning: dict[int, dict] = {}
    if jobs:
        ph2 = ",".join("?" for _ in jobs)
        try:
            plan_rows = await db._q(
                f"""SELECT opportunity_id, lead_name, schedule_confirmed
                    FROM job_planning WHERE opportunity_id IN ({ph2})""",
                list(jobs.keys()),
            )
            planning = {r["opportunity_id"]: r for r in plan_rows}
        except Exception:
            planning = {}  # table may not exist yet on older deployments

    for oid, j in jobs.items():
        j["prep_done"]  = prep_done.get(oid, 0)
        j["prep_total"] = PREP_TOTAL
        p = planning.get(oid) or {}
        j["lead_name"]          = p.get("lead_name") or ""
        j["schedule_confirmed"] = bool(p.get("schedule_confirmed"))

    job_list = list(jobs.values())
    risk_order = {"over_budget": 0, "at_risk": 1, "on_track": 2, "complete": 3}
    job_list.sort(key=lambda j: (risk_order.get(j["risk"], 9), j["property_name"]))

    summary = {
        "job_count":         len(job_list),
        "scheduled_count":   len(scheduled_ids),
        "manual_count":      len(manual_ids - scheduled_ids),
        "days_left":         _days_left_in_month(month),
        "hrs_est":           sum(j["hrs_est"] for j in job_list),
        "hrs_act":           sum(j["hrs_act"] for j in job_list),
        # Month-specific ticket hours (excludes prior-month accumulated actuals)
        "hrs_est_month":         sum(j["hrs_est_month"] for j in job_list),
        "hrs_act_month":         sum(j["hrs_act_month"] for j in job_list),
        # Month-specific ticket revenue from Aspire EarnedRevenue field
        "revenue_act_month":     sum(j["revenue_act_month"] for j in job_list),
        "revenue_est_month":     sum(j["revenue_est_month"] for j in job_list),
        "revenue_est":           sum(j["revenue_est"] for j in job_list),
        "revenue_act":           sum(j["revenue_act"] for j in job_list),
    }

    return {"month": month, "goal": goal, "jobs": job_list, "summary": summary}


@router.put("/{month}/goal")
async def set_goal(month: str, body: GoalIn, db: Database = Depends(get_db)):
    """Set or update the monthly revenue / hours goal."""
    if len(month) != 7 or month[4] != "-":
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")
    await db._x(
        """INSERT INTO construction_monthly_goals (month, revenue_goal, hours_goal, notes, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(month) DO UPDATE SET
             revenue_goal = excluded.revenue_goal,
             hours_goal   = excluded.hours_goal,
             notes        = excluded.notes,
             updated_at   = excluded.updated_at""",
        [month, body.revenue_goal, body.hours_goal, body.notes],
    )
    return {"ok": True, "month": month}


@router.post("/{month}/jobs")
async def add_job(month: str, body: JobIn, db: Database = Depends(get_db)):
    """Commit an opportunity to the month's plan."""
    if len(month) != 7 or month[4] != "-":
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")
    try:
        await db._x(
            """INSERT OR IGNORE INTO construction_job_targets
               (month, opportunity_id, opportunity_name, property_name, notes, committed_by)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [month, body.opportunity_id, body.opportunity_name,
             body.property_name, body.notes, body.committed_by],
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "month": month, "opportunity_id": body.opportunity_id}


@router.delete("/{month}/jobs/{opp_id}")
async def remove_job(month: str, opp_id: int, db: Database = Depends(get_db)):
    """
    Remove an opportunity from the month's plan.
    - For manually committed jobs: removes the D1 entry.
    - For Aspire-scheduled jobs: adds a '__suppressed__' marker so the job
      does not reappear on the next refresh (even though Aspire still has
      a work ticket scheduled for that month).
    Suppression is stored in the same table using notes='__suppressed__'.
    """
    # Remove any existing manual commitment (no-op if job is only scheduled)
    await db._x(
        "DELETE FROM construction_job_targets WHERE month = ? AND opportunity_id = ?",
        [month, opp_id],
    )
    # Insert suppression marker — prevents scheduled jobs from reappearing
    await db._x(
        """INSERT OR IGNORE INTO construction_job_targets
           (month, opportunity_id, notes)
           VALUES (?, ?, '__suppressed__')""",
        [month, opp_id],
    )
    return {"ok": True, "month": month, "opportunity_id": opp_id}


@router.get("/jobs/{opportunity_id}/checklist")
async def get_checklist(opportunity_id: int, db: Database = Depends(get_db)):
    """Preparedness checklist for a job — fixed items merged with saved checked state."""
    try:
        rows = await db._q(
            "SELECT item_key, checked, checked_by, checked_at FROM job_prep_checklist WHERE opportunity_id = ?",
            [opportunity_id],
        )
    except Exception:
        rows = []  # table may not exist yet on older deployments
    state = {r["item_key"]: r for r in rows}
    items = []
    done = 0
    for it in PREP_ITEMS:
        r = state.get(it["key"]) or {}
        checked = bool(r.get("checked"))
        if checked:
            done += 1
        items.append({
            "key":        it["key"],
            "label":      it["label"],
            "checked":    checked,
            "checked_by": r.get("checked_by"),
            "checked_at": r.get("checked_at"),
        })
    return {"opportunity_id": opportunity_id, "items": items, "done": done, "total": PREP_TOTAL}


@router.post("/jobs/{opportunity_id}/checklist")
async def toggle_checklist(opportunity_id: int, body: PrepToggleIn, db: Database = Depends(get_db)):
    """Check / uncheck one preparedness item for a job."""
    if body.item_key not in {it["key"] for it in PREP_ITEMS}:
        raise HTTPException(status_code=400, detail=f"Unknown checklist item: {body.item_key}")
    await db._x(
        """INSERT INTO job_prep_checklist (opportunity_id, item_key, checked, checked_by, checked_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(opportunity_id, item_key) DO UPDATE SET
             checked    = excluded.checked,
             checked_by = excluded.checked_by,
             checked_at = datetime('now')""",
        [opportunity_id, body.item_key, 1 if body.checked else 0, body.checked_by],
    )
    return {"ok": True, "opportunity_id": opportunity_id, "item_key": body.item_key, "checked": body.checked}


@router.put("/jobs/{opportunity_id}/planning")
async def set_planning(opportunity_id: int, body: PlanningIn, db: Database = Depends(get_db)):
    """Assign the lead and/or set the customer-confirmed schedule flag for a job."""
    sc = None if body.schedule_confirmed is None else (1 if body.schedule_confirmed else 0)
    await db._x(
        """INSERT INTO job_planning (opportunity_id, lead_name, schedule_confirmed, updated_by, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(opportunity_id) DO UPDATE SET
             lead_name          = COALESCE(excluded.lead_name, job_planning.lead_name),
             schedule_confirmed = COALESCE(excluded.schedule_confirmed, job_planning.schedule_confirmed),
             updated_by         = excluded.updated_by,
             updated_at         = datetime('now')""",
        [opportunity_id, body.lead_name, sc, body.updated_by],
    )
    return {"ok": True, "opportunity_id": opportunity_id}


@router.get("/jobs/{opportunity_id}/diagnose")
async def diagnose_job(opportunity_id: int):
    """Temporary diagnostic — tests entity names and filter shapes."""
    import asyncio as _aio
    results: dict = {}

    # 1. Get first 3 work ticket IDs for this opp
    try:
        wt_res = await _aspire._get("WorkTickets", {
            "$filter": f"OpportunityID eq {opportunity_id}",
            "$select": "WorkTicketID,WorkTicketNumber",
            "$top": "5",
        })
        tickets = _aspire._extract_list(wt_res)
        results["tickets"] = [{"id": t["WorkTicketID"], "num": t.get("WorkTicketNumber")} for t in tickets]
        tids = [t["WorkTicketID"] for t in tickets[:3]]
    except Exception as e:
        results["tickets_error"] = str(e); tids = []

    if tids:
        or_f = " or ".join(f"WorkTicketID eq {tid}" for tid in tids)

        # 2. WorkTicketItems — confirmed entity name
        try:
            res = await _aspire._get("WorkTicketItems", {"$filter": f"({or_f})", "$top": "5"})
            items = _aspire._extract_list(res)
            results["WorkTicketItems"] = {"count": len(items), "sample_keys": list(items[0].keys())[:15] if items else [], "sample": items[0] if items else None}
        except Exception as e:
            results["WorkTicketItems"] = {"error": str(e)}

        # 3. Receipts by WorkTicketID
        try:
            res = await _aspire._get("Receipts", {"$filter": f"({or_f})", "$top": "5"})
            recs = _aspire._extract_list(res)
            results["Receipts_by_wt"] = {"count": len(recs), "sample": {k:v for k,v in recs[0].items() if k not in ('ReceiptItems','ItemAllocations')} if recs else None}
        except Exception as e:
            results["Receipts_by_wt"] = {"error": str(e)}

    # 4. All receipts (no filter) — check if any exist + see field names
    try:
        res = await _aspire._get("Receipts", {"$top": "3", "$orderby": "ReceiptID desc"})
        recs = _aspire._extract_list(res)
        results["Receipts_any"] = {"count": len(recs), "sample_keys": list(recs[0].keys())[:20] if recs else []}
    except Exception as e:
        results["Receipts_any"] = {"error": str(e)}

    # 5. WorkTicketItems — show ALL types for first ticket
    if tids:
        try:
            res = await _aspire._get("WorkTicketItems", {
                "$filter": f"WorkTicketID eq {tids[0]}",
                "$top": "20",
            })
            items = _aspire._extract_list(res)
            results["WorkTicketItems_types"] = {
                "ticket_id": tids[0],
                "count": len(items),
                "types": [{"name": i.get("ItemName"), "type": i.get("ItemType"), "cat": i.get("CatalogItemCategoryName"), "qty": i.get("ItemQuantityExtended"), "uom": i.get("AllocationUnitTypeName"), "do_not_purchase": i.get("DoNotPurchase")} for i in items],
            }
        except Exception as e:
            results["WorkTicketItems_types"] = {"error": str(e)}

    return results


@router.get("/jobs/{opportunity_id}/materials")
async def get_job_materials(opportunity_id: int):
    """
    Return all material items for a construction opportunity, with PO status.

    Flow (mirrors Aspire's own data path):
      Estimate items → WorkTicketItems (ItemType = Material) → Receipts (POs)

    Returns:
      - items: list of material line items with quantity, UOM, cost, service name
      - pos:   list of POs (Receipts) linked to any work ticket for this opp,
               each with status and their line items
    """
    import asyncio as _aio

    # ── Step 1: get all work tickets for this opportunity ─────────────────────
    try:
        wt_res = await _aspire._get("WorkTickets", {
            "$filter":  f"OpportunityID eq {opportunity_id}",
            "$select":  "WorkTicketID,WorkTicketNumber,WorkTicketStatusName,OpportunityServiceID",
            "$top":     "200",
        })
        tickets = _aspire._extract_list(wt_res)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WorkTickets fetch failed: {e}")

    if not tickets:
        return {"items": [], "pos": [], "ticket_count": 0}

    ticket_ids = [t["WorkTicketID"] for t in tickets if t.get("WorkTicketID")]

    # ── Step 2: fetch WorkTicketItems and Receipts in parallel ────────────────
    async def _fetch_wt_items(tids: list[int]) -> list[dict]:
        """Fetch purchasable items across all work tickets in chunks of 10."""
        out: list[dict] = []
        for i in range(0, len(tids), 10):
            chunk = tids[i:i + 10]
            or_f  = " or ".join(f"WorkTicketID eq {tid}" for tid in chunk)
            try:
                # No $select — fetches all fields to avoid field-name issues
                res = await _aspire._get("WorkTicketItems", {
                    "$filter": f"({or_f})",
                    "$top": "500",
                })
                records = _aspire._extract_list(res)
                logger.info(f"WorkTicketItems chunk {chunk}: got {len(records)} records")
                out.extend(records)
            except Exception as e:
                logger.warning(f"WorkTicketItems chunk failed: {e}")
        return out

    async def _fetch_receipts(tids: list[int]) -> list[dict]:
        """Fetch all Receipts (POs) for these work tickets."""
        out: list[dict] = []
        for i in range(0, len(tids), 10):
            chunk = tids[i:i + 10]
            or_f  = " or ".join(f"WorkTicketID eq {tid}" for tid in chunk)
            try:
                res = await _aspire._get("Receipts", {
                    "$filter": f"({or_f})",
                    "$select": (
                        "ReceiptID,ReceiptNumber,WorkTicketID,VendorName,"
                        "ReceiptStatusName,ReceivedDate,ReceiptTotalCost,"
                        "ReceiptNote,ReceiptItems"
                    ),
                    "$top": "200",
                })
                out.extend(_aspire._extract_list(res))
            except Exception as e:
                logger.warning(f"Receipts chunk failed: {e}")
        return out

    # Fetch service names for richer display
    svc_ids = list({t.get("OpportunityServiceID") for t in tickets if t.get("OpportunityServiceID")})

    async def _fetch_services(svc_ids: list[int]) -> dict[int, str]:
        if not svc_ids:
            return {}
        out: dict[int, str] = {}
        or_f = " or ".join(f"OpportunityServiceID eq {sid}" for sid in svc_ids)
        try:
            res = await _aspire._get("OpportunityServices", {
                "$filter": f"({or_f})",
                "$select": "OpportunityServiceID,ServiceName,DisplayName,ServiceNameAbr",
                "$top": "100",
            })
            for s in _aspire._extract_list(res):
                sid = s.get("OpportunityServiceID")
                if sid:
                    out[sid] = (s.get("DisplayName") or s.get("ServiceName") or s.get("ServiceNameAbr") or "")
        except Exception as e:
            logger.warning(f"OpportunityServices fetch failed: {e}")
        return out

    wt_items, receipts, svc_map = await _aio.gather(
        _fetch_wt_items(ticket_ids),
        _fetch_receipts(ticket_ids),
        _fetch_services(svc_ids),
    )

    # ── Step 3: map ticket → service name ─────────────────────────────────────
    ticket_svc: dict[int, str] = {
        t["WorkTicketID"]: svc_map.get(t.get("OpportunityServiceID") or 0, "")
        for t in tickets if t.get("WorkTicketID")
    }

    # ── Step 4: build purchasable items (Material + Sub + Other) ─────────────
    # Exclude Labor and Equipment — those are internal resources, not purchased.
    # DoNotPurchase=True means the item is costed internally, no PO expected.
    # ItemCost = unit cost; total = ItemCost × ItemQuantityExtended
    PURCHASABLE_TYPES = {"material", "sub", "other"}
    items = []
    for it in wt_items:
        item_type = (it.get("ItemType") or "").lower()
        if item_type not in PURCHASABLE_TYPES:
            continue
        tid  = it.get("WorkTicketID")
        qty  = float(it.get("ItemQuantityExtended") or 0)
        unit = float(it.get("ItemCost") or 0)
        items.append({
            "work_ticket_item_id": it.get("WorkTicketItemID"),
            "work_ticket_id":      tid,
            "service_name":        ticket_svc.get(tid, ""),
            "item_name":           it.get("ItemName") or "",
            "item_type":           it.get("ItemType") or "",
            "category":            it.get("CatalogItemCategoryName") or "",
            "quantity":            qty,
            "uom":                 it.get("AllocationUnitTypeName") or "",
            "unit_cost":           unit,
            "total_cost_est":      round(qty * unit, 2),
            "do_not_purchase":     it.get("DoNotPurchase") or False,
            "notes":               it.get("EstimatingNotes") or "",
        })

    # ── Step 5: build PO list ──────────────────────────────────────────────────
    pos = []
    for r in receipts:
        rid = r.get("ReceiptID")
        # ReceiptNumber in Aspire is display_number + 1
        receipt_num = r.get("ReceiptNumber")
        display_num = (receipt_num - 1) if receipt_num else None
        raw_items   = r.get("ReceiptItems") or []
        po_items = []
        if isinstance(raw_items, list):
            for ri in raw_items:
                po_items.append({
                    "item_name": ri.get("ItemName") or "",
                    "quantity":  ri.get("ItemQuantity"),
                    "uom":       ri.get("UOMName") or ri.get("ItemUOM") or "",
                    "unit_cost": ri.get("ItemUnitCost"),
                })
        pos.append({
            "receipt_id":     rid,
            "po_number":      display_num,
            "work_ticket_id": r.get("WorkTicketID"),
            "vendor_name":    r.get("VendorName") or "",
            "status":         r.get("ReceiptStatusName") or "",
            "received_date":  (r.get("ReceivedDate") or "")[:10],
            "total_cost":     r.get("ReceiptTotalCost") or 0,
            "note":           (r.get("ReceiptNote") or "")[:120],
            "items":          po_items,
        })

    logger.info(
        f"Materials for opp {opportunity_id}: {len(items)} items, "
        f"{len(pos)} POs across {len(ticket_ids)} tickets"
    )

    return {
        "opportunity_id": opportunity_id,
        "ticket_count":   len(ticket_ids),
        "items":          items,
        "pos":            pos,
    }


async def _fetch_scheduled_opp_ids_all_divisions(month: str) -> dict[int, int]:
    """
    Like _fetch_scheduled_opp_ids but WITHOUT the Construction division filter.
    Returns {opportunity_id: ticket_count} for ALL opps with scheduled work tickets
    in the given month — used so suggestions can surface jobs from any division.
    """
    y, m = int(month[:4]), int(month[5:7])
    next_m = f"{y + 1}-01" if m == 12 else f"{y}-{str(m + 1).zfill(2)}"
    start, end = f"{month}-01", f"{next_m}-01"

    tickets: list[dict] = []
    for date_fmt in (
        f"ScheduledStartDate ge {start} and ScheduledStartDate lt {end}",
        f"ScheduledStartDate ge {start}T00:00:00Z and ScheduledStartDate lt {end}T00:00:00Z",
    ):
        try:
            res = await _aspire._get("WorkTickets", {
                "$filter": date_fmt,
                "$select": "WorkTicketID,OpportunityID",
                "$top": "500",
            })
            tickets = _aspire._extract_list(res)
            if tickets:
                break
        except Exception:
            pass

    out: dict[int, int] = {}
    for t in tickets:
        oid = t.get("OpportunityID")
        if oid:
            out[oid] = out.get(oid, 0) + 1
    return out


@router.get("/{month}/suggestions")
async def get_suggestions(month: str, db: Database = Depends(get_db)):
    """
    Work queue: WON Construction opportunities that still have work to do but aren't
    in this month's plan yet. A job qualifies if it has either:
      • an OPEN work ticket (status 'Open' — created, not yet scheduled), OR
      • a work ticket SCHEDULED in a future month (after the selected month).
    Jobs already committed/scheduled this month (in the plan) are excluded.
    """
    if len(month) != 7 or month[4] != "-":
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")

    import asyncio as _aio

    y, m = int(month[:4]), int(month[5:7])
    next_m = f"{y + 1}-01" if m == 12 else f"{y}-{str(m + 1).zfill(2)}"
    future_start = f"{next_m}-01"   # first day after the selected month

    async def _open_tickets() -> list[dict]:
        """Work tickets in 'Open' status (created but not yet scheduled)."""
        try:
            res = await _aspire._get("WorkTickets", {
                "$filter": "WorkTicketStatusName eq 'Open'",
                "$select": "WorkTicketID,OpportunityID,WorkTicketStatusName",
                "$top": "1000",
            })
            return _aspire._extract_list(res)
        except Exception as e:
            logger.warning(f"Open work-ticket fetch failed: {e}")
            return []

    async def _future_tickets() -> list[dict]:
        """Work tickets scheduled in a month after the selected one."""
        for fmt in (
            f"ScheduledStartDate ge {future_start}",
            f"ScheduledStartDate ge {future_start}T00:00:00Z",
        ):
            try:
                res = await _aspire._get("WorkTickets", {
                    "$filter": fmt,
                    "$select": "WorkTicketID,OpportunityID,ScheduledStartDate",
                    "$top": "1000",
                })
                t = _aspire._extract_list(res)
                if t:
                    return t
            except Exception:
                pass
        return []

    committed_coro = db._q(
        "SELECT opportunity_id FROM construction_job_targets WHERE month = ?", [month]
    )
    committed_rows, scheduled_plan_map, open_tk, future_tk = await _aio.gather(
        committed_coro,
        _fetch_scheduled_opp_ids(month),   # construction opps already scheduled this month
        _open_tickets(),
        _future_tickets(),
    )
    already_in_plan = {r["opportunity_id"] for r in committed_rows} | set(scheduled_plan_map.keys())

    # Candidate opps from open + future tickets, with why-it-qualifies flags
    cand: dict[int, dict] = {}
    for t in open_tk:
        oid = t.get("OpportunityID")
        if oid:
            c = cand.setdefault(oid, {"open": False, "future": False, "n": 0})
            c["open"] = True
            c["n"] += 1
    for t in future_tk:
        oid = t.get("OpportunityID")
        if oid:
            c = cand.setdefault(oid, {"open": False, "future": False, "n": 0})
            c["future"] = True
            c["n"] += 1

    cand_ids = [oid for oid in cand if oid not in already_in_plan]
    if not cand_ids:
        return {"month": month, "suggestions": [], "scheduled_count": 0}

    # Resolve opp details and keep only WON Construction jobs
    actuals = await _fetch_opp_actuals(cand_ids)
    branch = (settings.ASPIRE_CONSTRUCTION_BRANCH or "Construction").lower()
    suggestions = []
    for oid in cand_ids:
        o = actuals.get(oid, {})
        status = o.get("OpportunityStatusName") or ""
        div = (o.get("DivisionName") or "").lower()
        if status.strip().lower() != "won" or branch not in div:
            continue
        c = cand[oid]
        suggestions.append({
            "opportunity_id":   oid,
            "opportunity_name": o.get("OpportunityName") or f"Job #{oid}",
            "property_name":    o.get("PropertyName") or "",
            "status":           status,
            "pct_complete":     float(o.get("PercentComplete") or 0),
            "hrs_est":          float(o.get("EstimatedLaborHours") or 0),
            "hrs_act":          float(o.get("ActualLaborHours") or 0),
            "won_dollars":      float(o.get("WonDollars") or 0),
            "ticket_count":     c["n"],
            "has_scheduled":    c["future"],   # has tickets scheduled in a future month
        })
    suggestions.sort(key=lambda s: s["property_name"])

    return {
        "month": month,
        "suggestions": suggestions,
        "scheduled_count": sum(1 for s in suggestions if s["has_scheduled"]),
    }
