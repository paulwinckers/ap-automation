"""FastAPI application entrypoint."""
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import invoices, vendors, health
from app.api.vendor_import import router as vendor_import_router
from app.core.config import settings
from app.services.qbo import qbo_auth_router
from app.services.email_intake import email_intake

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.ANTHROPIC_API_KEY:
        logger.error(
            "ANTHROPIC_API_KEY is not set — invoice extraction will fail with 401. "
            "Set this environment variable in your Railway dashboard."
        )
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
    if request.method == "POST" and "/upload" in str(request.url):
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > 20 * 1024 * 1024:
            return JSONResponse(status_code=413, content={"detail": "File too large — maximum 20MB"})
    return await call_next(request)

app.include_router(health.router)
app.include_router(invoices.router, prefix="/invoices", tags=["invoices"])
app.include_router(vendors.router,  prefix="/vendors",  tags=["vendors"])
app.include_router(vendor_import_router, prefix="/vendors", tags=["vendors"])
app.include_router(qbo_auth_router)
