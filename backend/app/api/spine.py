"""
Canonical spine — a local (D1) cache of the customer → property → job identity,
synced from Aspire. Phase 1 of decoupling the portal from live-Aspire reads and
giving every record a stable customer anchor.

Customer model (the important bit): a customer is a COMPANY *or* a CONTACT —
commercial jobs bill to BillingCompanyID, residential jobs bill to BillingContactID.
Every customer gets a unified `customer_key`:  "company:{id}" | "contact:{id}".
So residential customers (e.g. a homeowner) are first-class, not dropped — that was
the mistake to avoid.

Sync is MANUAL-TRIGGER only (POST /spine/sync) — never on boot and never on a tight
schedule (hard-won lesson: aggressive D1 background jobs crash-looped the app twice).
It's gentle: Companies + Properties are one call each (~109 / ~624 rows); Opportunities
are keyset-paginated by CreatedDateTime (Aspire has no $count, no LastModified, and
flaky $skip — but CreatedDateTime sorts cleanly).

Read endpoints come in a later increment; this one just builds + verifies the cache.
"""
import json
import logging
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends

from app.core.config import settings
from app.core.database import Database
from app.services.aspire import AspireClient
from app.api.auth import require_access
from app.api.construction_plan import get_db

router = APIRouter(prefix="/spine", tags=["spine"])
logger = logging.getLogger(__name__)

_aspire = AspireClient(sandbox=settings.ASPIRE_DASHBOARD_SANDBOX)

# How far back to backfill opportunities (keyset by CreatedDateTime). Covers active
# business without paging the entire multi-year history on every manual sync.
_BACKFILL_YEARS = 3
_MAX_PAGES = 8  # safety guard (8 × 1000 opps)


def _num(v):
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _d10(v):
    return (v or "")[:10] or None


async def _upsert(db: Database, table: str, pk: str, cols: list[str], rows: list[tuple]) -> int:
    """Chunked multi-row INSERT … ON CONFLICT(pk) DO UPDATE, staying under D1's
    100-bound-param cap. Manual sync, so a few hundred statements is acceptable."""
    if not rows:
        return 0
    per = max(1, 90 // len(cols))
    set_clause = ", ".join(f"{c}=excluded.{c}" for c in cols if c != pk)
    placeholder = "(" + ",".join(["?"] * len(cols)) + ")"
    n = 0
    for i in range(0, len(rows), per):
        chunk = rows[i:i + per]
        sql = (f"INSERT INTO {table} ({','.join(cols)}) VALUES "
               + ", ".join([placeholder] * len(chunk))
               + f" ON CONFLICT({pk}) DO UPDATE SET {set_clause}")
        params = [v for r in chunk for v in r]
        await db._x(sql, params)
        n += len(chunk)
    return n


async def _fetch_all_opps() -> list[dict]:
    """Every opportunity created in the backfill window, keyset-paginated by
    CreatedDateTime (ascending) — robust against Aspire's $top=1000 cap and flaky $skip."""
    sel = ("OpportunityID,OpportunityNumber,OpportunityName,OpportunityStatusName,JobStatusName,"
           "DivisionName,PropertyID,PropertyName,BillingCompanyID,BillingCompanyName,"
           "BillingContactID,BillingContactName,WonDate,StartDate,EndDate,CompleteDate,"
           "PercentComplete,WonDollars,ActualEarnedRevenue,EstimatedLaborHours,ActualLaborHours,CreatedDateTime")
    start_year = datetime.now(timezone.utc).year - _BACKFILL_YEARS
    cursor = f"{start_year}-01-01T00:00:00Z"
    out: list[dict] = []
    for _ in range(_MAX_PAGES):
        page = _aspire._extract_list(await _aspire._get("Opportunities", {
            "$filter": f"CreatedDateTime gt {cursor}",
            "$orderby": "CreatedDateTime asc",
            "$top": "1000",
            "$select": sel,
        }))
        if not page:
            break
        out.extend(page)
        last = page[-1].get("CreatedDateTime")
        if not last or len(page) < 1000:
            break
        cursor = last
    return out


async def _run_sync(db: Database) -> dict:
    t0 = time.time()
    now = datetime.now(timezone.utc).isoformat()

    # ── Companies (commercial customers) ─────────────────────────────────────
    comps = _aspire._extract_list(await _aspire._get(
        "Companies", {"$select": "CompanyID,CompanyName", "$top": "1000"}))
    cust_rows = [(f"company:{c['CompanyID']}", "company", c["CompanyID"], c.get("CompanyName"), now)
                 for c in comps if c.get("CompanyID")]

    # ── Properties ───────────────────────────────────────────────────────────
    props = _aspire._extract_list(await _aspire._get(
        "Properties", {"$select": "PropertyID,PropertyName", "$top": "1000"}))
    prop_rows = [(p["PropertyID"], p.get("PropertyName"), now) for p in props if p.get("PropertyID")]

    # ── Jobs (opportunities) + residential customers derived from billing ────
    opps = await _fetch_all_opps()
    residential: dict[int, str] = {}
    job_rows = []
    for o in opps:
        oid = o.get("OpportunityID")
        if not oid:
            continue
        bc, bk = o.get("BillingCompanyID"), o.get("BillingContactID")
        if bc:
            key = f"company:{bc}"
        elif bk:
            key = f"contact:{bk}"
            residential[bk] = o.get("BillingContactName")  # a homeowner is a customer too
        else:
            key = None
        payload = json.dumps({
            "opportunity_id": oid, "opp_number": o.get("OpportunityNumber"),
            "name": o.get("OpportunityName"), "division": o.get("DivisionName"),
            "status": o.get("OpportunityStatusName"), "job_status": o.get("JobStatusName"),
            "property_id": o.get("PropertyID"), "property_name": o.get("PropertyName"),
            "billing_company_id": bc, "billing_company_name": o.get("BillingCompanyName"),
            "billing_contact_id": bk, "billing_contact_name": o.get("BillingContactName"),
            "won_date": _d10(o.get("WonDate")), "start_date": _d10(o.get("StartDate")),
            "end_date": _d10(o.get("EndDate")), "complete_date": _d10(o.get("CompleteDate")),
            "pct_complete": _num(o.get("PercentComplete")), "won_dollars": _num(o.get("WonDollars")),
            "earned_revenue": _num(o.get("ActualEarnedRevenue")),
            "est_hours": _num(o.get("EstimatedLaborHours")), "act_hours": _num(o.get("ActualLaborHours")),
        })
        job_rows.append((
            oid, key, bc, bk, o.get("PropertyID"), o.get("DivisionName"),
            o.get("OpportunityStatusName"), _d10(o.get("WonDate")), _d10(o.get("CompleteDate")),
            (o.get("CreatedDateTime") or "")[:19], payload, now,
        ))
    cust_rows += [(f"contact:{cid}", "contact", cid, name, now) for cid, name in residential.items()]

    # ── Upserts ──────────────────────────────────────────────────────────────
    n_cust = await _upsert(db, "spine_customers", "customer_key",
                           ["customer_key", "kind", "aspire_id", "name", "synced_at"], cust_rows)
    n_prop = await _upsert(db, "spine_properties", "property_id",
                           ["property_id", "name", "synced_at"], prop_rows)
    n_job = await _upsert(db, "spine_jobs", "opportunity_id",
                          ["opportunity_id", "customer_key", "billing_company_id", "billing_contact_id",
                           "property_id", "division", "status", "won_date", "complete_date",
                           "created_at", "payload", "synced_at"], job_rows)

    detail = f"{len(comps)} companies, {len(residential)} residential contacts"
    await db._x(
        """INSERT INTO spine_sync_meta (id, last_sync_at, companies, properties, jobs, customers, detail)
           VALUES (1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET last_sync_at=excluded.last_sync_at, companies=excluded.companies,
             properties=excluded.properties, jobs=excluded.jobs, customers=excluded.customers, detail=excluded.detail""",
        [now, len(comps), n_prop, n_job, n_cust, detail])

    return {
        "ok": True, "elapsed_s": round(time.time() - t0, 1), "synced_at": now,
        "customers": n_cust, "companies": len(comps), "residential": len(residential),
        "properties": n_prop, "jobs": n_job,
    }


@router.post("/sync", dependencies=[Depends(require_access)])
async def sync_spine(db: Database = Depends(get_db)):
    """Rebuild the local spine cache from Aspire (manual trigger). Idempotent upserts."""
    try:
        return await _run_sync(db)
    except Exception as e:
        logger.exception("spine sync failed")
        return {"ok": False, "error": str(e)}


@router.get("/status", dependencies=[Depends(require_access)])
async def spine_status(db: Database = Depends(get_db)):
    """Row counts + last sync time for the spine cache."""
    def _count(rows):
        return (rows[0].get("n") if rows else 0) or 0
    out = {}
    for t in ("spine_customers", "spine_properties", "spine_jobs"):
        try:
            out[t] = _count(await db._q(f"SELECT COUNT(*) AS n FROM {t}", []))
        except Exception:
            out[t] = None
    try:
        meta = await db._q("SELECT * FROM spine_sync_meta WHERE id = 1", [])
        out["meta"] = meta[0] if meta else None
    except Exception:
        out["meta"] = None
    return out
