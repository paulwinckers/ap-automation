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
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.api.auth import optional_actor, current_actor

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

async def _ensure_user_col(db: Database) -> None:
    """Add the user_id column (per-rep targeting) if it isn't there yet. Safe to call repeatedly."""
    try:
        await db._x("ALTER TABLE push_subscriptions ADD COLUMN user_id INTEGER", [])
    except Exception:
        pass  # already exists


async def _upsert_subscription(sub: PushSubscription, user_id: Optional[int]) -> None:
    db = Database()
    await db.connect()
    try:
        await _ensure_user_col(db)
        await db._x(
            """INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(endpoint) DO UPDATE SET
                 p256dh     = excluded.p256dh,
                 auth       = excluded.auth,
                 user_id    = COALESCE(excluded.user_id, push_subscriptions.user_id),
                 updated_at = datetime('now')""",
            [sub.endpoint, sub.p256dh, sub.auth, user_id],
        )
    finally:
        await db.close()


async def _delete_subscription(endpoint: str) -> None:
    db = Database()
    await db.connect()
    try:
        await db._x("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint])
    finally:
        await db.close()


async def _send(rows: list, title: str, body: str, url: str) -> dict:
    """Web-push `rows` (each with endpoint/p256dh/auth). Dormant until VAPID is configured."""
    if not settings.VAPID_PRIVATE_KEY or not settings.VAPID_PUBLIC_KEY:
        return {"sent": 0, "failed": 0, "configured": False}
    try:
        from pywebpush import webpush  # noqa: F401
    except ImportError:
        logger.warning("pywebpush not installed — push skipped")
        return {"sent": 0, "failed": 0, "configured": False}
    from pywebpush import webpush

    data = json.dumps({"title": title, "body": body, "url": url})
    sent = failed = 0
    stale: list[str] = []
    for row in rows:
        endpoint = row["endpoint"]
        try:
            webpush(
                subscription_info={"endpoint": endpoint,
                                   "keys": {"p256dh": row["p256dh"], "auth": row["auth"]}},
                data=data,
                vapid_private_key=settings.VAPID_PRIVATE_KEY,
                vapid_claims={"sub": "mailto:accounting@darios.ca"},
                ttl=86400,
            )
            sent += 1
        except Exception as exc:
            status_code = getattr(getattr(exc, "response", None), "status_code", None)
            if status_code in (404, 410):
                stale.append(endpoint)
            else:
                logger.warning("Push failed for %s…: %s", endpoint[:40], exc)
            failed += 1
    for ep in stale:
        await _delete_subscription(ep)
    return {"sent": sent, "failed": failed, "configured": True}


async def push_to_user(user_id: int, title: str, body: str, url: str = "/my-work") -> dict:
    """Send a push to one rep's subscribed devices. No-ops cleanly if VAPID isn't set or the rep
    has no device subscribed. Importable by other modules (e.g. task creation)."""
    if not user_id:
        return {"sent": 0, "failed": 0, "configured": bool(settings.VAPID_PUBLIC_KEY)}
    db = Database()
    await db.connect()
    try:
        await _ensure_user_col(db)
        rows = await db._q(
            "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?", [user_id])
    except Exception as e:
        logger.warning(f"push_to_user lookup failed for {user_id}: {e}")
        rows = []
    finally:
        await db.close()
    if not rows:
        return {"sent": 0, "failed": 0, "no_subscription": True}
    return await _send(rows, title, body, url)


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get("/vapid-public-key")
async def vapid_public_key():
    """Return the VAPID public key so the browser can subscribe."""
    if not settings.VAPID_PUBLIC_KEY:
        raise HTTPException(503, "Push notifications not configured on this server")
    return {"public_key": settings.VAPID_PUBLIC_KEY}


@router.post("/subscribe")
async def subscribe(sub: PushSubscription, user: Optional[dict] = Depends(optional_actor)):
    """Register or refresh a browser push subscription, stamped with the signed-in user when there
    is one (so task pushes can target them); anonymous field-page subscriptions still work."""
    uid = user.get("id") if (user and user.get("id")) else None
    if uid == 0:  # the generic service principal is not a real person
        uid = None
    await _upsert_subscription(sub, uid)
    return {"ok": True, "user_scoped": uid is not None}


@router.delete("/subscribe")
async def unsubscribe(endpoint: str = Query(...)):
    """Remove a push subscription."""
    await _delete_subscription(endpoint)
    return {"ok": True}


@router.get("/my-status")
async def my_status(test: bool = Query(False), user: dict = Depends(current_actor)):
    """Diagnostics for the current user: VAPID configured?, how many of their devices are subscribed,
    and (with test=true) fire a test push to them and report the send result."""
    db = Database()
    await db.connect()
    try:
        await _ensure_user_col(db)
        rows = await db._q("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?", [user["id"]])
        total = await db._q("SELECT COUNT(*) AS n FROM push_subscriptions", [])
    finally:
        await db.close()
    out = {
        "user_id": user["id"],
        "email": user.get("email"),
        "configured": bool(settings.VAPID_PUBLIC_KEY),
        "my_subscriptions": (rows[0]["n"] if rows else 0),
        "total_subscriptions": (total[0]["n"] if total else 0),
    }
    if test:
        out["test_send"] = await push_to_user(
            user["id"], "Darios test", "If you see this, task push is working.", "/my-work")
    return out


@router.post("/notify")
async def notify_all(payload: NotifyPayload):
    """Send a push to EVERY subscribed device (broadcast — used by office staff after a document upload)."""
    if not settings.VAPID_PRIVATE_KEY or not settings.VAPID_PUBLIC_KEY:
        raise HTTPException(
            503, "Push notifications not configured — set VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY in Railway")
    db = Database()
    await db.connect()
    try:
        rows = await db._q("SELECT endpoint, p256dh, auth FROM push_subscriptions", [])
    finally:
        await db.close()
    if not rows:
        return {"sent": 0, "failed": 0, "message": "No subscribers yet"}
    res = await _send(rows, payload.title, payload.body, payload.url)
    logger.info("Push broadcast sent=%d failed=%d", res["sent"], res["failed"])
    return {"sent": res["sent"], "failed": res["failed"]}
