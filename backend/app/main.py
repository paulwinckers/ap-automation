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
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import invoices, vendors, health
from app.api.vendor_import import router as vendor_import_router
from app.api.reconcile import router as reconcile_router
from app.api.dashboard import router as dashboard_router
from app.api.aspire_field import router as aspire_field_router
from app.api.crew_schedule import router as crew_schedule_router
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
    # Auto-seed vendor rules if DB is empty
    _db = Database()
    await _db.connect()
    await seed_vendors_if_empty(_db)
    await _db.close()
    # Start email polling on startup
    await email_intake.start()
    yield
    # Stop on shutdown
    await email_intake.stop()


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
app.include_router(reconcile_router)
app.include_router(dashboard_router)
app.include_router(aspire_field_router)
app.include_router(crew_schedule_router)
app.include_router(qbo_auth_router)
