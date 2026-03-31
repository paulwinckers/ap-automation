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
