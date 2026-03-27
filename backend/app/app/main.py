"""FastAPI application entrypoint."""
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import invoices, vendors, health
from app.core.config import settings
from app.services.qbo import qbo_auth_router
from app.services.email_intake import email_intake


@asynccontextmanager
async def lifespan(app: FastAPI):
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
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
app.include_router(qbo_auth_router)


@app.on_event("startup")
async def start_email_polling():
    """Start the email intake poller if configured."""
    if settings.EMAIL_POLLING and settings.MS_AP_INBOX and settings.MS_CLIENT_ID:
        import asyncio
        from app.services.email_intake import GraphEmailService
        service = GraphEmailService()
        asyncio.create_task(service.start_polling())
        logger.info(f"Email intake polling started — {settings.MS_AP_INBOX}")
    else:
        logger.info("Email intake polling disabled — set EMAIL_POLLING=true in .env to enable")
