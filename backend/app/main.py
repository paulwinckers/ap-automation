"""FastAPI application entrypoint."""
import csv
import io
import logging
import os
from contextlib import asynccontextmanager

# ── Configure logging before anything else ────────────────────────────────────
# Without this, Python's root logger defaults to WARNING and all INFO logs
# from routing, email, etc. are silently discarded in Railway.
logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s:     %(name)s - %(message)s",
    handlers=[logging.StreamHandler()],
    force=True,
)
from fastapi import FastAPI, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import invoices, vendors, health
from app.api.vendor_import import router as vendor_import_router
from app.api.reconcile import router as reconcile_router
from app.api.dashboard import router as dashboard_router
from app.api.aspire_field import router as aspire_field_router
from app.api.crew_schedule import router as crew_schedule_router
from app.api.time_tracking import router as time_tracking_router
from app.api.auth import router as auth_router, require_access
from app.api.keys import router as keys_router
from app.api.safety_talks import router as safety_talks_router
from app.api.construction_report import router as construction_report_router, start_scheduler as start_construction_scheduler, stop_scheduler as stop_construction_scheduler
from app.api.construction_plan import router as construction_plan_router
from app.api.daily_schedule import router as daily_schedule_router
from app.api.customer_dashboard import router as customer_dashboard_router
from app.api.dashboard import start_digest_scheduler, stop_digest_scheduler
from app.api.documents import router as documents_router
from app.api.push import router as push_router
from app.api.site_inspections import router as site_inspections_router
from app.api.safety_incidents import router as safety_incidents_router
from app.api.email_settings_api import router as email_settings_router
from app.api.vehicle_inspections import router as vehicle_inspections_router
from app.api.safety_pha import router as safety_pha_router
from app.api.schedule import router as schedule_router
from app.api.cx import router as cx_router
from app.api.spine import router as spine_router, start_spine_scheduler, stop_spine_scheduler
from app.api.sales import router as sales_router
from app.api.backup import router as backup_router, start_backup_scheduler, stop_backup_scheduler
from app.api.property_hazards import router as property_hazards_router
from app.api.project_checkin import (
    router as checkin_router,
    public_router as checkin_public_router,
    start_checkin_scheduler,
    stop_checkin_scheduler,
)
from app.api.maintenance_field import router as maintenance_field_router
from app.api.field_conversations import router as field_conversations_router
from app.api.invoice_summary import router as invoice_summary_router
from app.core.config import settings
from app.core.database import Database
from app.services.qbo import qbo_auth_router
from app.services.email_intake import email_intake

logger = logging.getLogger(__name__)

VENDOR_SEED_FILE = os.path.join(os.path.dirname(__file__), "../vendor_rules.csv")


async def seed_vendors_if_empty(db: Database):
    """Auto-import vendor rules from bundled CSV if the table is empty."""
    # Remove example/placeholder vendors that were inserted by schema.sql
    for example in ("Example Supply Co", "Example Fuel Co", "Office Depot", "Telus"):
        await db._x("DELETE FROM vendor_rules WHERE vendor_name = ?", [example])

    result = await db.get_all_vendor_rules()
    if result and len(result) > 4:
        logger.info(f"Vendor rules already loaded ({len(result)} vendors) — skipping seed")
        return

    if not os.path.exists(VENDOR_SEED_FILE):
        logger.warning(f"Vendor seed file not found at {VENDOR_SEED_FILE} — skipping")
        return

    with open(VENDOR_SEED_FILE, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        count = 0
        for row in reader:
            row = {k.strip().lower(): (v.strip() if v else "") for k, v in row.items()}
            vendor_name = row.get("vendor_name", "").strip()
            vendor_type = row.get("type", "").strip().lower()
            if not vendor_name or vendor_type not in {"job_cost", "overhead", "mixed"}:
                continue
            await db.create_vendor_rule(
                vendor_name=vendor_name,
                vendor_type=vendor_type,
                default_gl_account=row.get("default_gl_account") or None,
                default_gl_name=row.get("default_gl_name") or None,
                vendor_id_aspire=None,
                vendor_id_qbo=None,
                notes=row.get("notes") or None,
                forward_to=row.get("forward_to") or None,
                match_keyword=row.get("match_keyword") or None,
            )
            count += 1
    logger.info(f"Seeded {count} vendor rules from {VENDOR_SEED_FILE}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.ANTHROPIC_API_KEY:
        logger.error(
            "ANTHROPIC_API_KEY is not set — invoice extraction will fail with 401. "
            "Set this environment variable in your Railway dashboard."
        )
    # Connect DB on startup — this runs _apply_schema() which creates any new tables
    _db = Database()
    await _db.connect()
    # Verify critical tables exist — self-heal if _ensure_schema() silently failed.
    # We run the CREATE TABLE directly here (no inline comments, clean SQL) as a
    # belt-and-suspenders in case D1 rejected the comment-bearing version from schema.sql.
    _ENSURE_TABLES = {
        "document_folders": """
            CREATE TABLE IF NOT EXISTS document_folders (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT    NOT NULL,
                parent_id   INTEGER,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                created_by  TEXT
            )
        """,
        "job_attachments": """
            CREATE TABLE IF NOT EXISTS job_attachments (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                opp_id           INTEGER NOT NULL,
                work_ticket_id   INTEGER,
                attachment_type  TEXT    NOT NULL DEFAULT 'General',
                file_name        TEXT    NOT NULL,
                file_extension   TEXT,
                r2_key           TEXT    NOT NULL,
                file_size        INTEGER,
                note             TEXT,
                uploaded_by      TEXT,
                uploaded_at      TEXT    NOT NULL DEFAULT (datetime('now')),
                is_active        INTEGER NOT NULL DEFAULT 1
            )
        """,
        "checkin_photos": """
            CREATE TABLE IF NOT EXISTS checkin_photos (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                checkin_id     INTEGER NOT NULL,
                response_id    INTEGER,
                file_name      TEXT    NOT NULL,
                file_extension TEXT,
                r2_key         TEXT    NOT NULL,
                file_size      INTEGER,
                uploaded_at    TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """,
        "field_advisor_log": """
            CREATE TABLE IF NOT EXISTS field_advisor_log (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                opp_id       INTEGER NOT NULL,
                question     TEXT    NOT NULL,
                answer       TEXT    NOT NULL,
                has_photo    INTEGER NOT NULL DEFAULT 0,
                photo_r2_key TEXT,
                asked_at     TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """,
        "project_strategy": """
            CREATE TABLE IF NOT EXISTS project_strategy (
                opp_id     INTEGER PRIMARY KEY,
                strategy   TEXT    NOT NULL DEFAULT '',
                updated_by TEXT,
                updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """,
        "reconciliation_periods": """
            CREATE TABLE IF NOT EXISTS reconciliation_periods (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                period     TEXT NOT NULL UNIQUE,
                label      TEXT NOT NULL,
                status     TEXT NOT NULL DEFAULT 'open',
                closed_at  TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """,
        "vendor_statements": """
            CREATE TABLE IF NOT EXISTS vendor_statements (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                period_id       INTEGER NOT NULL,
                vendor_name     TEXT NOT NULL,
                statement_date  TEXT,
                closing_balance REAL,
                currency        TEXT DEFAULT 'CAD',
                aging_current   REAL DEFAULT 0,
                aging_1_30      REAL DEFAULT 0,
                aging_31_60     REAL DEFAULT 0,
                aging_61_90     REAL DEFAULT 0,
                aging_over_90   REAL DEFAULT 0,
                pdf_filename    TEXT,
                pdf_r2_key      TEXT,
                intake_source   TEXT DEFAULT 'upload',
                qbo_snapshot    TEXT,
                created_at      TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """,
        "statement_lines": """
            CREATE TABLE IF NOT EXISTS statement_lines (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                statement_id    INTEGER NOT NULL,
                line_date       TEXT,
                invoice_number  TEXT,
                raw_description TEXT,
                amount          REAL,
                running_balance REAL
            )
        """,
        "vendor_qbo_links": """
            CREATE TABLE IF NOT EXISTS vendor_qbo_links (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                statement_name  TEXT NOT NULL UNIQUE,
                qbo_vendor_id   TEXT NOT NULL,
                qbo_vendor_name TEXT NOT NULL,
                created_at      TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """,
        "user_divisions": """
            CREATE TABLE IF NOT EXISTS user_divisions (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL,
                division   TEXT    NOT NULL,
                is_default INTEGER NOT NULL DEFAULT 0,
                UNIQUE(user_id, division)
            )
        """,
        "job_prep_checklist": """
            CREATE TABLE IF NOT EXISTS job_prep_checklist (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                opportunity_id INTEGER NOT NULL,
                item_key       TEXT    NOT NULL,
                checked        INTEGER NOT NULL DEFAULT 0,
                status         TEXT,
                attachment_id  INTEGER,
                checked_by     TEXT,
                checked_at     TEXT,
                UNIQUE(opportunity_id, item_key)
            )
        """,
        "job_planning": """
            CREATE TABLE IF NOT EXISTS job_planning (
                opportunity_id     INTEGER PRIMARY KEY,
                lead_name          TEXT,
                schedule_confirmed INTEGER NOT NULL DEFAULT 0,
                stage              TEXT,
                updated_by         TEXT,
                updated_at         TEXT
            )
        """,
        "safety_incidents": """
            CREATE TABLE IF NOT EXISTS safety_incidents (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                incident_date      TEXT NOT NULL,
                incident_time      TEXT,
                reporter_name      TEXT NOT NULL,
                location           TEXT,
                incident_type      TEXT,
                severity           TEXT,
                people_involved    TEXT,
                injury_description TEXT,
                description        TEXT NOT NULL,
                immediate_action   TEXT,
                witnesses          TEXT,
                photo_r2_keys      TEXT,
                reported_worksafe  INTEGER,
                property_damage    INTEGER,
                property_damage_desc TEXT,
                sent_to_medical    INTEGER,
                contributing_factors TEXT,
                signed_off_by      TEXT,
                signed_off_at      TEXT,
                employee_signed_off_by TEXT,
                employee_signed_off_at TEXT,
                status             TEXT NOT NULL DEFAULT 'open',
                reviewed_by        TEXT,
                reviewed_at        TEXT,
                created_at         TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """,
        "vehicle_inspections": """
            CREATE TABLE IF NOT EXISTS vehicle_inspections (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                vehicle_number  TEXT,
                odometer        TEXT,
                completed_by    TEXT NOT NULL,
                inspection_date TEXT NOT NULL,
                items_json      TEXT,
                defect_count    INTEGER NOT NULL DEFAULT 0,
                notes           TEXT,
                created_at      TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """,
        "schedule_assignments": """
            CREATE TABLE IF NOT EXISTS schedule_assignments (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                work_date      TEXT NOT NULL,
                lead_name      TEXT NOT NULL,
                opportunity_id INTEGER,
                job_label      TEXT,
                note           TEXT,
                sort_order     INTEGER DEFAULT 0,
                created_by     TEXT,
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at     TEXT
            )
        """,
        "cx_templates": """
            CREATE TABLE IF NOT EXISTS cx_templates (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                key         TEXT UNIQUE NOT NULL,
                title       TEXT,
                stage_order INTEGER DEFAULT 0,
                subject     TEXT,
                body        TEXT,
                from_role   TEXT,
                cc          TEXT,
                optional    INTEGER DEFAULT 0,
                active      INTEGER NOT NULL DEFAULT 1,
                updated_at  TEXT
            )
        """,
        "cx_action_skips": """
            CREATE TABLE IF NOT EXISTS cx_action_skips (
                opportunity_id INTEGER NOT NULL,
                action_key     TEXT NOT NULL,
                skipped_by     TEXT,
                skipped_at     TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (opportunity_id, action_key)
            )
        """,
        "cx_sends": """
            CREATE TABLE IF NOT EXISTS cx_sends (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                opportunity_id INTEGER NOT NULL,
                template_key   TEXT,
                subject        TEXT,
                to_addresses   TEXT,
                cc             TEXT,
                from_email     TEXT,
                from_name      TEXT,
                sent_by        TEXT,
                sent_at        TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """,
        "schedule_crew": """
            CREATE TABLE IF NOT EXISTS schedule_crew (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                active     INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """,
        "schedule_archived_jobs": """
            CREATE TABLE IF NOT EXISTS schedule_archived_jobs (
                opportunity_id INTEGER PRIMARY KEY,
                created_at     TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """,
        "schedule_blocks": """
            CREATE TABLE IF NOT EXISTS schedule_blocks (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                opportunity_id INTEGER,
                job_label      TEXT NOT NULL,
                start_date     TEXT NOT NULL,
                hours          REAL,
                hours_per_day  REAL DEFAULT 10,
                include_friday INTEGER DEFAULT 0,
                employees      TEXT,
                lead_name      TEXT,
                note           TEXT,
                status         TEXT NOT NULL DEFAULT 'tentative',
                extra_days     INTEGER DEFAULT 0,
                exceptions     TEXT,
                created_by     TEXT,
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at     TEXT
            )
        """,
        "project_hazard_assessments": """
            CREATE TABLE IF NOT EXISTS project_hazard_assessments (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                opportunity_id INTEGER,
                pha_number     TEXT,
                project_name   TEXT,
                site_address   TEXT,
                status         TEXT NOT NULL DEFAULT 'draft',
                payload        TEXT,
                photo_r2_keys  TEXT,
                created_by     TEXT,
                submitted_by   TEXT,
                submitted_at   TEXT,
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at     TEXT
            )
        """,
        # ── Canonical spine cache (synced from Aspire; see app/api/spine.py) ──
        "spine_customers": """
            CREATE TABLE IF NOT EXISTS spine_customers (
                customer_key TEXT PRIMARY KEY,   -- 'company:{id}' | 'contact:{id}'
                kind         TEXT NOT NULL,       -- 'company' | 'contact'
                aspire_id    INTEGER,
                name         TEXT,
                synced_at    TEXT
            )
        """,
        "spine_properties": """
            CREATE TABLE IF NOT EXISTS spine_properties (
                property_id INTEGER PRIMARY KEY,
                name        TEXT,
                synced_at   TEXT
            )
        """,
        "spine_jobs": """
            CREATE TABLE IF NOT EXISTS spine_jobs (
                opportunity_id     INTEGER PRIMARY KEY,
                customer_key       TEXT,
                billing_company_id INTEGER,
                billing_contact_id INTEGER,
                property_id        INTEGER,
                division           TEXT,
                status             TEXT,
                won_date           TEXT,
                complete_date      TEXT,
                created_at         TEXT,
                payload            TEXT,
                synced_at          TEXT
            )
        """,
        "spine_sync_meta": """
            CREATE TABLE IF NOT EXISTS spine_sync_meta (
                id           INTEGER PRIMARY KEY CHECK (id = 1),
                last_sync_at TEXT,
                companies    INTEGER,
                properties   INTEGER,
                jobs         INTEGER,
                customers    INTEGER,
                detail       TEXT
            )
        """,
        # ── Sales activity layer (own CRUD; anchored on spine customer_key) ──
        "sales_activities": """
            CREATE TABLE IF NOT EXISTS sales_activities (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_key     TEXT,                -- 'company:{id}' | 'contact:{id}' (works pre-opportunity)
                opportunity_id   INTEGER,             -- optional: tied to a specific job
                property_id      INTEGER,             -- optional
                type             TEXT NOT NULL DEFAULT 'note',  -- note|call|meeting|email|site_visit
                subject          TEXT,
                body             TEXT,
                direction        TEXT,                -- for emails: 'in' | 'out'
                occurred_at      TEXT,                -- when it happened (date/datetime)
                next_action_date TEXT,                -- followup due (null = no followup)
                next_action_note TEXT,
                next_action_done INTEGER NOT NULL DEFAULT 0,
                created_by       TEXT,
                created_at       TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at       TEXT
            )
        """,
        "sales_tasks": """
            CREATE TABLE IF NOT EXISTS sales_tasks (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_key   TEXT,
                opportunity_id INTEGER,
                activity_id    INTEGER,               -- the site visit / note that spawned it
                title          TEXT NOT NULL,
                detail         TEXT,
                assignee       TEXT,                  -- coworker (name/user)
                due_date       TEXT,
                priority       TEXT,
                status         TEXT NOT NULL DEFAULT 'open',  -- open|done|cancelled
                created_by     TEXT,
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                done_at        TEXT,
                updated_at     TEXT
            )
        """,
        "sales_task_updates": """
            CREATE TABLE IF NOT EXISTS sales_task_updates (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id    INTEGER NOT NULL,          -- append log / progress thread on a task
                author     TEXT,
                body       TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """,
        "sales_attachments": """
            CREATE TABLE IF NOT EXISTS sales_attachments (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_type  TEXT NOT NULL,           -- 'activity' | 'task'
                parent_id    INTEGER NOT NULL,
                r2_key       TEXT NOT NULL,
                file_name    TEXT,
                content_type TEXT,
                kind         TEXT,                    -- photo | video | file
                caption      TEXT,
                uploaded_by  TEXT,
                uploaded_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """,
    }
    for tbl, ddl in _ENSURE_TABLES.items():
        try:
            await _db._q(f"SELECT COUNT(*) FROM {tbl} LIMIT 1")
            logger.info(f"DB startup: {tbl} OK")
        except Exception:
            logger.warning(f"DB startup: {tbl} missing — creating now")
            try:
                await _db._x(ddl.strip())
                logger.info(f"DB startup: {tbl} created successfully")
            except Exception as e2:
                logger.error(f"DB startup: FAILED to create {tbl}: {e2}")
    # Column migrations — ALTER TABLE for columns added after initial schema deploy.
    # D1 has no IF NOT EXISTS for ALTER TABLE, so we probe first.
    _COLUMN_MIGRATIONS = [
        # vendor_statements.pdf_r2_key — added after initial reconciliation deploy
        ("vendor_statements", "pdf_r2_key", "ALTER TABLE vendor_statements ADD COLUMN pdf_r2_key TEXT"),
        # vendor_statements diff cache — added for bulk-diff speed improvement
        ("vendor_statements", "diff_cache",     "ALTER TABLE vendor_statements ADD COLUMN diff_cache TEXT"),
        ("vendor_statements", "diff_cached_at", "ALTER TABLE vendor_statements ADD COLUMN diff_cached_at TEXT"),
        # vendor_rules.job_cost_forward_to — AP email for employee job cost expense notifications
        ("vendor_rules", "job_cost_forward_to", "ALTER TABLE vendor_rules ADD COLUMN job_cost_forward_to TEXT"),
        # field_conversations.created_by_user_id — link a conversation to a real user (directory identity)
        ("field_conversations", "created_by_user_id", "ALTER TABLE field_conversations ADD COLUMN created_by_user_id INTEGER"),
        # job_prep_checklist — N/A/Complete/Upload-Doc status + linked attachment
        ("job_prep_checklist", "status",        "ALTER TABLE job_prep_checklist ADD COLUMN status TEXT"),
        ("job_prep_checklist", "attachment_id", "ALTER TABLE job_prep_checklist ADD COLUMN attachment_id INTEGER"),
        # job_planning.stage — workflow stage (New → Complete)
        ("job_planning", "stage", "ALTER TABLE job_planning ADD COLUMN stage TEXT"),
        # job_planning.queued — parked jobs (1) drop to a "Queued / Parked" section; stay plannable
        ("job_planning", "queued", "ALTER TABLE job_planning ADD COLUMN queued INTEGER DEFAULT 0"),
        # job_planning.paid_at — when the job's stage was set to Paid (drives Paid drop-off in later months)
        ("job_planning", "paid_at", "ALTER TABLE job_planning ADD COLUMN paid_at TEXT"),
        # safety_incidents — extended fields (WorkSafeBC, damage, medical, factors, sign-off)
        ("safety_incidents", "reported_worksafe",    "ALTER TABLE safety_incidents ADD COLUMN reported_worksafe INTEGER"),
        ("safety_incidents", "property_damage",      "ALTER TABLE safety_incidents ADD COLUMN property_damage INTEGER"),
        ("safety_incidents", "property_damage_desc", "ALTER TABLE safety_incidents ADD COLUMN property_damage_desc TEXT"),
        ("safety_incidents", "sent_to_medical",      "ALTER TABLE safety_incidents ADD COLUMN sent_to_medical INTEGER"),
        ("safety_incidents", "contributing_factors", "ALTER TABLE safety_incidents ADD COLUMN contributing_factors TEXT"),
        ("safety_incidents", "signed_off_by",        "ALTER TABLE safety_incidents ADD COLUMN signed_off_by TEXT"),
        ("safety_incidents", "signed_off_at",        "ALTER TABLE safety_incidents ADD COLUMN signed_off_at TEXT"),
        ("safety_incidents", "employee_signed_off_by", "ALTER TABLE safety_incidents ADD COLUMN employee_signed_off_by TEXT"),
        ("safety_incidents", "employee_signed_off_at", "ALTER TABLE safety_incidents ADD COLUMN employee_signed_off_at TEXT"),
        # job_prep_checklist — per-item due & completed dates
        ("job_prep_checklist", "due_date",       "ALTER TABLE job_prep_checklist ADD COLUMN due_date TEXT"),
        ("job_prep_checklist", "completed_date", "ALTER TABLE job_prep_checklist ADD COLUMN completed_date TEXT"),
        # company_documents.folder — optional folder/category for grouping (legacy text)
        ("company_documents", "folder", "ALTER TABLE company_documents ADD COLUMN folder TEXT"),
        # company_documents.folder_id — FK into document_folders (nested folder tree)
        ("company_documents", "folder_id", "ALTER TABLE company_documents ADD COLUMN folder_id INTEGER"),
        # schedule_blocks.status — tentative (movable) vs confirmed (locked)
        ("schedule_blocks", "status", "ALTER TABLE schedule_blocks ADD COLUMN status TEXT DEFAULT 'tentative'"),
        # schedule_blocks — manual extend beyond budget + per-day employee exceptions
        ("schedule_blocks", "extra_days", "ALTER TABLE schedule_blocks ADD COLUMN extra_days INTEGER DEFAULT 0"),
        ("schedule_blocks", "exceptions", "ALTER TABLE schedule_blocks ADD COLUMN exceptions TEXT"),
        ("schedule_blocks", "lead_name",  "ALTER TABLE schedule_blocks ADD COLUMN lead_name TEXT"),
    ]
    for tbl, col, sql in _COLUMN_MIGRATIONS:
        try:
            await _db._q(f"SELECT {col} FROM {tbl} LIMIT 1")
            logger.info(f"DB migration: {tbl}.{col} already exists")
        except Exception:
            try:
                await _db._x(sql)
                logger.info(f"DB migration: added {tbl}.{col}")
            except Exception as me:
                logger.warning(f"DB migration: could not add {tbl}.{col}: {me}")

    # Backfill: turn any legacy document.folder text into real root folders + folder_id.
    try:
        legacy = await _db._q(
            "SELECT DISTINCT folder FROM company_documents "
            "WHERE folder IS NOT NULL AND folder != '' AND folder_id IS NULL"
        )
        for row in legacy:
            fname = (row.get("folder") or "").strip()
            if not fname:
                continue
            existing = await _db._q(
                "SELECT id FROM document_folders WHERE name = ? AND parent_id IS NULL", [fname]
            )
            if existing:
                fid = existing[0]["id"]
            else:
                ins = await _db._q(
                    "INSERT INTO document_folders (name, parent_id, created_by) "
                    "VALUES (?, NULL, 'migration') RETURNING id", [fname]
                )
                fid = ins[0]["id"]
            await _db._x(
                "UPDATE company_documents SET folder_id = ? WHERE folder = ? AND folder_id IS NULL",
                [fid, fname],
            )
            logger.info(f"Document folder backfill: '{fname}' → folder_id {fid}")
    except Exception as e:
        logger.warning(f"Document folder backfill skipped: {e}")

    # Resilient startup: a transient D1 error (e.g. rate-limit) during seeding must
    # NOT crash the app, or the container crash-loops and re-hammers D1 (see incident
    # history). Log and continue so /health stays up and the app self-heals.
    try:
        await seed_vendors_if_empty(_db)
    except Exception as e:
        logger.error(f"Vendor seed skipped — startup continues (D1 error?): {e}")
    try:
        await _db.close()
    except Exception:
        pass
    # Start email polling on startup
    try:
        await email_intake.start()
    except Exception as e:
        logger.error(f"Email intake start failed — startup continues: {e}")
    # Construction nightly Work Ticket Report is paused (a weekly report may
    # replace it later). The router/manual-send endpoint stays available.
    # start_construction_scheduler()
    # Start issues digest nightly scheduler (fires 7 PM Pacific)
    start_digest_scheduler()
    # Start nightly database backup scheduler (D1 → R2)
    try:
        start_backup_scheduler()
    except Exception as e:
        logger.error(f"Backup scheduler start failed — startup continues: {e}")
    # Start nightly spine cache refresh (gentle: once/day @ 1 AM, never on boot)
    try:
        start_spine_scheduler()
    except Exception as e:
        logger.error(f"Spine scheduler start failed — startup continues: {e}")
    yield
    # Stop on shutdown
    await email_intake.stop()
    stop_construction_scheduler()
    stop_digest_scheduler()
    stop_backup_scheduler()
    stop_spine_scheduler()


app = FastAPI(
    title="AP Automation API",
    description="Invoice routing — Aspire + QBO",
    version="1.0.0",
    docs_url="/docs" if settings.DEBUG else None,
    lifespan=lifespan,
)

# allow_credentials must NOT be used with allow_origins=["*"] — browsers reject it.
# The frontend does not send cookies, so credentials=False is correct here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def limit_upload_size(request: Request, call_next):
    if request.method == "POST":
        url = str(request.url)
        content_length = request.headers.get("content-length")
        if content_length:
            size = int(content_length)
            # Field media uploads: photos + videos (up to ~500 MB per submission)
            if "/aspire/field/" in url and size > 500 * 1024 * 1024:
                return JSONResponse(status_code=413, content={"detail": "Upload too large — maximum 500MB total"})
            # Regular invoice uploads: 20 MB
            elif "/upload" in url and size > 20 * 1024 * 1024:
                return JSONResponse(status_code=413, content={"detail": "File too large — maximum 20MB"})
    return await call_next(request)

app.include_router(health.router)
app.include_router(invoices.router, prefix="/invoices", tags=["invoices"])
app.include_router(vendors.router,  prefix="/vendors",  tags=["vendors"])
app.include_router(vendor_import_router, prefix="/vendors", tags=["vendors"])
app.include_router(reconcile_router, dependencies=[Depends(require_access)])
app.include_router(dashboard_router, dependencies=[Depends(require_access)])
app.include_router(aspire_field_router)
app.include_router(crew_schedule_router, dependencies=[Depends(require_access)])
app.include_router(time_tracking_router)
app.include_router(auth_router)
app.include_router(qbo_auth_router)
app.include_router(keys_router)
app.include_router(safety_talks_router)
app.include_router(construction_report_router)
app.include_router(construction_plan_router, dependencies=[Depends(require_access)])
app.include_router(daily_schedule_router, dependencies=[Depends(require_access)])
app.include_router(customer_dashboard_router)
app.include_router(documents_router)
app.include_router(push_router)
app.include_router(site_inspections_router)
app.include_router(safety_incidents_router)
app.include_router(email_settings_router)
app.include_router(vehicle_inspections_router)
app.include_router(safety_pha_router)
app.include_router(schedule_router, dependencies=[Depends(require_access)])
app.include_router(cx_router)
app.include_router(spine_router)
app.include_router(sales_router)
app.include_router(backup_router)
app.include_router(property_hazards_router)
app.include_router(checkin_router)
app.include_router(checkin_public_router)
app.include_router(maintenance_field_router)
app.include_router(field_conversations_router)
app.include_router(invoice_summary_router, dependencies=[Depends(require_access)])
