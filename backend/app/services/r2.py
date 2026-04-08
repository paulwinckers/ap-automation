"""
Cloudflare R2 storage service — stores vendor statement PDFs.

Uses boto3 with R2's S3-compatible endpoint.
All operations are run in a thread executor to avoid blocking the async event loop.
"""

import asyncio
import logging
from functools import partial
from typing import Optional

import boto3
from botocore.config import Config

from app.core.config import settings

logger = logging.getLogger(__name__)


def _make_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{settings.CF_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=settings.R2_ACCESS_KEY_ID,
        aws_secret_access_key=settings.R2_SECRET_ACCESS_KEY,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )


def _r2_available() -> bool:
    return bool(settings.R2_ACCESS_KEY_ID and settings.R2_SECRET_ACCESS_KEY)


async def upload_statement_pdf(
    file_bytes: bytes,
    period: str,
    vendor_name: str,
    filename: str,
) -> Optional[str]:
    """
    Upload a statement PDF to R2.
    Returns the R2 object key, or None if R2 is not configured.
    Key format: statements/2026-03/James Truck and Trailer Repair Ltd./statement.pdf
    """
    if not _r2_available():
        logger.info("R2 not configured — skipping PDF storage")
        return None

    # Sanitise vendor name for use in object key
    safe_vendor = "".join(c if c.isalnum() or c in (" ", "-", "_", ".") else "_" for c in vendor_name).strip()
    key = f"statements/{period}/{safe_vendor}/{filename}"

    def _upload():
        client = _make_client()
        client.put_object(
            Bucket=settings.R2_BUCKET_NAME,
            Key=key,
            Body=file_bytes,
            ContentType="application/pdf",
        )

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _upload)
    logger.info(f"PDF uploaded to R2: {key}")
    return key


async def upload_invoice_pdf(
    file_bytes: bytes,
    invoice_id: int,
    filename: str,
) -> Optional[str]:
    """
    Upload an invoice or receipt PDF/image to R2.
    Returns the R2 object key, or None if R2 is not configured.
    Key format: invoices/2026-04/invoice_123_original.pdf
    """
    if not _r2_available():
        logger.info("R2 not configured — skipping invoice PDF storage")
        return None

    from datetime import date
    period = date.today().strftime("%Y-%m")
    safe_filename = "".join(c if c.isalnum() or c in (".", "-", "_") else "_" for c in filename)
    key = f"invoices/{period}/invoice_{invoice_id}_{safe_filename}"

    name_lower = filename.lower()
    if name_lower.endswith(".pdf"):
        content_type = "application/pdf"
    elif name_lower.endswith(".png"):
        content_type = "image/png"
    elif name_lower.endswith(".webp"):
        content_type = "image/webp"
    else:
        content_type = "image/jpeg"

    def _upload():
        client = _make_client()
        client.put_object(
            Bucket=settings.R2_BUCKET_NAME,
            Key=key,
            Body=file_bytes,
            ContentType=content_type,
        )

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _upload)
    logger.info(f"Invoice PDF uploaded to R2: {key}")
    return key


async def get_file_bytes(key: str) -> Optional[bytes]:
    """Download a file from R2 and return its bytes. Returns None if unavailable."""
    if not _r2_available() or not key:
        return None

    def _download():
        client = _make_client()
        resp = client.get_object(Bucket=settings.R2_BUCKET_NAME, Key=key)
        return resp["Body"].read()

    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, _download)
    except Exception as e:
        logger.warning(f"R2 download failed for {key}: {e}")
        return None


async def upload_field_photo(
    file_bytes: bytes,
    filename: str,
    submitter: str,
    entity_type: str,
    entity_id: str,
    expires_in: int = 7 * 24 * 3600,
) -> Optional[tuple]:
    """
    Upload a field photo (work-ticket or opportunity) to R2.
    Returns (key, presigned_url) or None if R2 is not configured.
    entity_type: 'work-ticket' or 'opportunity'
    URLs are valid for 7 days by default.
    """
    if not _r2_available():
        logger.info("R2 not configured — skipping field photo storage")
        return None

    import uuid
    from datetime import date as _date

    date_str = _date.today().strftime("%Y-%m-%d")
    safe_submitter = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in submitter).strip() or "crew"
    safe_filename = "".join(c if c.isalnum() or c in (".", "-", "_") else "_" for c in (filename or "photo.jpg"))
    uid = uuid.uuid4().hex[:8]
    key = f"field-photos/{entity_type}/{entity_id}/{date_str}/{safe_submitter}/{uid}_{safe_filename}"

    name_lower = (filename or "").lower()
    if name_lower.endswith(".pdf"):
        content_type = "application/pdf"
    elif name_lower.endswith(".png"):
        content_type = "image/png"
    elif name_lower.endswith(".webp"):
        content_type = "image/webp"
    elif name_lower.endswith(".mp4") or name_lower.endswith(".m4v"):
        content_type = "video/mp4"
    elif name_lower.endswith(".mov"):
        content_type = "video/quicktime"
    elif name_lower.endswith(".avi"):
        content_type = "video/x-msvideo"
    elif name_lower.endswith(".webm"):
        content_type = "video/webm"
    elif name_lower.endswith(".mkv"):
        content_type = "video/x-matroska"
    else:
        content_type = "image/jpeg"

    def _upload():
        client = _make_client()
        client.put_object(
            Bucket=settings.R2_BUCKET_NAME,
            Key=key,
            Body=file_bytes,
            ContentType=content_type,
        )
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.R2_BUCKET_NAME, "Key": key},
            ExpiresIn=expires_in,
        )

    loop = asyncio.get_event_loop()
    url = await loop.run_in_executor(None, _upload)
    logger.info(f"Field photo uploaded to R2: {key}")
    return key, url


async def get_presigned_url(key: str, expires_in: int = 3600) -> Optional[str]:
    """
    Generate a presigned URL for a statement PDF.
    URL is valid for expires_in seconds (default 1 hour).
    Returns None if R2 is not configured or key is missing.
    """
    if not _r2_available() or not key:
        return None

    def _sign():
        client = _make_client()
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.R2_BUCKET_NAME, "Key": key},
            ExpiresIn=expires_in,
        )

    loop = asyncio.get_event_loop()
    url = await loop.run_in_executor(None, _sign)
    return url
