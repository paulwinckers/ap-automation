"""
Push notification endpoints — VAPID web push.

Endpoints:
  GET  /push/vapid-public-key  — returns public key for browser subscription
  POST /push/subscribe         — save or refresh a push subscription
  DELETE /push/subscribe       — remove a subscription (unsubscribe)
  POST /push/notify            — send push to ALL subscribers (office staff only)
"""
import json
import logging

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database

router = APIRouter(prefix="/push", tags=["push"])
logger = logging.getLogger(__name__)


# ── Pydantic models ────────────────────────────────────────────────────────────

class PushSubscription(BaseModel):
    endpoint: str
    p256dh:   str
    auth:     str


class NotifyPayload(BaseModel):
    title: str
    body:  str
    url:   str = "/field/documents"


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _all_subscriptions():
    db = Database()
    await db.connect()
    try:
        return await db._q(
            "SELECT endpoint, p256dh, auth FROM push_subscriptions", []
        )
    finally:
        await db.close()


async def _upsert_subscription(sub: PushSubscription):
    db = Database()
    await db.connect()
    try:
        await db._x(
            """INSERT INTO push_subscriptions (endpoint, p256dh, auth)
               VALUES (?, ?, ?)
               ON CONFLICT(endpoint) DO UPDATE SET
                 p256dh     = excluded.p256dh,
                 auth       = excluded.auth,
                 updated_at = datetime('now')""",
            [sub.endpoint, sub.p256dh, sub.auth],
        )
    finally:
        await db.close()


async def _delete_subscription(endpoint: str):
    db = Database()
    await db.connect()
    try:
        await db._x(
            "DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]
        )
    finally:
        await db.close()


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get("/vapid-public-key")
async def vapid_public_key():
    """Return the VAPID public key so the browser can subscribe."""
    if not settings.VAPID_PUBLIC_KEY:
        raise HTTPException(503, "Push notifications not configured on this server")
    return {"public_key": settings.VAPID_PUBLIC_KEY}


@router.post("/subscribe")
async def subscribe(sub: PushSubscription):
    """Register or refresh a browser push subscription."""
    await _upsert_subscription(sub)
    return {"ok": True}


@router.delete("/subscribe")
async def unsubscribe(endpoint: str = Query(...)):
    """Remove a push subscription."""
    await _delete_subscription(endpoint)
    return {"ok": True}


@router.post("/notify")
async def notify_all(payload: NotifyPayload):
    """
    Send a push notification to every subscribed device.
    Called manually by office staff after uploading a document.
    """
    if not settings.VAPID_PRIVATE_KEY or not settings.VAPID_PUBLIC_KEY:
        raise HTTPException(
            503,
            "Push notifications not configured — set VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY in Railway",
        )

    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        raise HTTPException(500, "pywebpush not installed")

    rows = await _all_subscriptions()
    if not rows:
        return {"sent": 0, "failed": 0, "message": "No subscribers yet"}

    data = json.dumps({
        "title": payload.title,
        "body":  payload.body,
        "url":   payload.url,
    })

    sent   = 0
    failed = 0
    stale  = []

    for row in rows:
        endpoint = row["endpoint"]
        try:
            webpush(
                subscription_info={
                    "endpoint": endpoint,
                    "keys": {
                        "p256dh": row["p256dh"],
                        "auth":   row["auth"],
                    },
                },
                data=data,
                vapid_private_key=settings.VAPID_PRIVATE_KEY,
                vapid_claims={"sub": "mailto:accounting@darios.ca"},
                ttl=86400,
            )
            sent += 1
        except Exception as exc:
            logger.warning("Push failed for %s…: %s", endpoint[:40], exc)
            # 404 / 410 = subscription expired — clean up
            status_code = getattr(getattr(exc, "response", None), "status_code", None)
            if status_code in (404, 410):
                stale.append(endpoint)
            failed += 1

    # Clean up expired subscriptions
    for ep in stale:
        await _delete_subscription(ep)
        logger.info("Removed stale push subscription: %s…", ep[:40])

    logger.info("Push sent=%d failed=%d stale_removed=%d", sent, failed, len(stale))
    return {"sent": sent, "failed": failed}
