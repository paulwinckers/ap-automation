"""Admin API for email timing + distribution settings."""
from fastapi import APIRouter

from app.services.email_settings import get_email_settings, save_email_settings

router = APIRouter(prefix="/settings/email", tags=["email-settings"])


@router.get("")
async def read_email_settings():
    """Current effective email settings (D1 overrides merged over config defaults)."""
    return await get_email_settings(force=True)


@router.put("")
async def update_email_settings(body: dict):
    """Save email settings. Unknown keys/fields are ignored."""
    return await save_email_settings(body)
