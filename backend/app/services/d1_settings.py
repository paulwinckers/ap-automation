"""
Cloudflare D1 settings store — persists key/value pairs (like QBO refresh tokens)
to D1 via the Cloudflare REST API so they survive Railway redeployments.

Required env vars:
  CF_ACCOUNT_ID     — Cloudflare account ID
  CF_D1_DATABASE_ID — D1 database ID
  CF_API_TOKEN      — Cloudflare API token with D1 write access
"""

import logging
import httpx
from app.core.config import settings

logger = logging.getLogger(__name__)

CF_D1_URL = "https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{db_id}/query"


def _is_configured() -> bool:
    return bool(settings.CF_ACCOUNT_ID and settings.CF_D1_DATABASE_ID and settings.CF_API_TOKEN)


async def get_setting(key: str) -> str | None:
    """Read a value from D1 settings table. Returns None if not found or not configured."""
    if not _is_configured():
        logger.debug("D1 settings not configured — skipping get")
        return None
    url = CF_D1_URL.format(account_id=settings.CF_ACCOUNT_ID, db_id=settings.CF_D1_DATABASE_ID)
    try:
        async with httpx.AsyncClient(timeout=10.0) as http:
            resp = await http.post(
                url,
                headers={"Authorization": f"Bearer {settings.CF_API_TOKEN}"},
                json={"sql": "SELECT value FROM settings WHERE key = ?", "params": [key]},
            )
            resp.raise_for_status()
            data = resp.json()
            rows = data.get("result", [{}])[0].get("results", [])
            if rows:
                logger.info(f"D1 settings: loaded '{key}'")
                return rows[0]["value"]
    except Exception as e:
        logger.warning(f"D1 settings: failed to get '{key}': {e}")
    return None


async def set_setting(key: str, value: str) -> None:
    """Write a value to D1 settings table. Silently skips if not configured."""
    if not _is_configured():
        logger.debug("D1 settings not configured — skipping set")
        return
    url = CF_D1_URL.format(account_id=settings.CF_ACCOUNT_ID, db_id=settings.CF_D1_DATABASE_ID)
    try:
        async with httpx.AsyncClient(timeout=10.0) as http:
            resp = await http.post(
                url,
                headers={"Authorization": f"Bearer {settings.CF_API_TOKEN}"},
                json={
                    "sql": "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
                    "params": [key, value],
                },
            )
            resp.raise_for_status()
            logger.info(f"D1 settings: saved '{key}'")
    except Exception as e:
        logger.warning(f"D1 settings: failed to set '{key}': {e}")
