"""
Sales email auto-capture — turns reps' real email into sales_activities, with no manual logging.

For each configured rep mailbox we read (READ-ONLY) Inbox + Sent Items via Microsoft Graph, match
each message's counterpart address against a customer-contact index built from Aspire, and — when the
contact is in scope (tied to an open opportunity or a recent lead) — write one sales_activity
(type=email) anchored to that contact's customer_key. It then shows up in Customer 360 + the worklist.

Design notes:
  * NON-INVASIVE: never marks read, never moves, never sends. The AP intake service owns mailbox
    mutation; this one only reads. (Contrast app/services/email_intake.py.)
  * Dedupe by Graph message id → sales_activities.external_id (unique index).
  * Can't use isRead (reps read their own mail) — we keep a per-mailbox high-water mark in
    sales_email_cursor and filter by sent/receivedDateTime.
  * OFF by default. Config lives in the settings KV under SETTINGS_KEY; run dry-run first.
"""
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.core.config import settings
from app.core.database import Database
from app.services.email_intake import GraphClient

logger = logging.getLogger(__name__)

SETTINGS_KEY = "sales_email_capture"
RECENT_LEAD_DAYS = 90          # a contact is "in scope" if their job/lead activity is within this window
ACTIVE_JOB_STATES = {"active", "won", "open", "tentative", "confirmed", "scheduled", "in_progress"}

_DEFAULTS = {
    "enabled": False,          # master switch — poll loop no-ops until true
    "mailboxes": [],           # rep addresses to poll, e.g. ["jane@darios.ca", "rob@darios.ca"]
    "poll_minutes": 10,
    "backfill_days": 30,       # first run per mailbox, when there's no cursor yet
    "store_full_body": False,  # False = store bodyPreview (~255 chars); True = would need a body fetch
}


async def get_capture_config(db: Database) -> dict:
    cfg = dict(_DEFAULTS)
    try:
        raw = await db.get_setting(SETTINGS_KEY)
        if raw:
            stored = json.loads(raw)
            if isinstance(stored, dict):
                cfg.update({k: v for k, v in stored.items() if k in cfg})
    except Exception as e:
        logger.warning(f"sales email capture: config load failed — defaults: {e}")
    # normalise
    cfg["mailboxes"] = [str(m).strip().lower() for m in (cfg.get("mailboxes") or []) if str(m).strip()]
    return cfg


async def set_capture_config(db: Database, patch: dict) -> dict:
    cfg = await get_capture_config(db)
    for k, v in (patch or {}).items():
        if k in _DEFAULTS:
            cfg[k] = v
    cfg["mailboxes"] = [str(m).strip().lower() for m in (cfg.get("mailboxes") or []) if str(m).strip()]
    await db.set_setting(SETTINGS_KEY, json.dumps(cfg))
    return cfg


# ── Matcher index (email → customer contact) ─────────────────────────────────────

async def refresh_contact_index(db: Database, aspire) -> dict:
    """Rebuild sales_contact_emails from Aspire's active contacts (those with an email).
    Each becomes email → contact:{ContactID}. Returns {contacts, emails}."""
    rows = await aspire.get_contacts_with_email()
    now = datetime.now(timezone.utc).isoformat()
    n = 0
    for c in rows:
        cid = c.get("ContactID")
        email = (c.get("Email") or "").strip().lower()
        if not cid or not email:
            continue
        await db._x(
            "INSERT OR REPLACE INTO sales_contact_emails (email, contact_id, customer_key, name, synced_at) "
            "VALUES (?, ?, ?, ?, ?)",
            [email, cid, f"contact:{cid}", c.get("FullName") or "", now],
        )
        n += 1
    logger.info(f"sales email capture: contact index refreshed — {n} emails")
    return {"contacts": len(rows), "emails": n}


async def _load_index(db: Database) -> dict:
    """email(lower) → {contact_id, customer_key, name}."""
    out: dict = {}
    for r in await db._q("SELECT email, contact_id, customer_key, name FROM sales_contact_emails", []):
        em = (r.get("email") or "").strip().lower()
        if em:
            out[em] = {"contact_id": r.get("contact_id"), "customer_key": r.get("customer_key"),
                       "name": r.get("name")}
    return out


async def _scope_keys(db: Database) -> set:
    """customer_keys considered in-scope: tied to an active/recent spine_job, that job's billing
    contact, or any customer_key with a sales_activity in the last RECENT_LEAD_DAYS (recent leads)."""
    keys: set = set()
    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=RECENT_LEAD_DAYS)).isoformat()
    try:
        for j in await db._q("SELECT customer_key, billing_contact_id, status, won_date, created_at FROM spine_jobs", []):
            status = (j.get("status") or "").strip().lower()
            won = (j.get("won_date") or "")[:10]
            created = (j.get("created_at") or "")[:10]
            recent = (won and won >= cutoff) or (created and created >= cutoff)
            if status in ACTIVE_JOB_STATES or recent:
                if j.get("customer_key"):
                    keys.add(j["customer_key"])
                if j.get("billing_contact_id"):
                    keys.add(f"contact:{j['billing_contact_id']}")
    except Exception as e:
        logger.warning(f"sales email capture: spine_jobs scope read failed: {e}")
    try:
        for a in await db._q(
            "SELECT DISTINCT customer_key FROM sales_activities WHERE customer_key IS NOT NULL "
            "AND (occurred_at >= ? OR created_at >= ?)", [cutoff, cutoff]):
            if a.get("customer_key"):
                keys.add(a["customer_key"])
    except Exception as e:
        logger.warning(f"sales email capture: activity scope read failed: {e}")
    return keys


# ── Message → activity ───────────────────────────────────────────────────────────

def _addr(obj: dict) -> str:
    return ((obj or {}).get("emailAddress", {}) or {}).get("address", "").strip().lower()


def _counterparts(msg: dict, direction: str) -> list[str]:
    """The customer side of the message: recipients for outbound, sender for inbound."""
    if direction == "out":
        out = [_addr(r) for r in (msg.get("toRecipients") or [])]
        out += [_addr(r) for r in (msg.get("ccRecipients") or [])]
        return [a for a in out if a]
    a = _addr(msg.get("from"))
    return [a] if a else []


async def capture_once(db: Database, aspire, *, dry_run: bool = True,
                       mailboxes: Optional[list] = None, backfill_days: Optional[int] = None) -> dict:
    """One capture pass over the configured mailboxes. Returns a per-mailbox report. When dry_run,
    nothing is written and no cursor advances — it just reports what WOULD be captured."""
    cfg = await get_capture_config(db)
    boxes = [m.strip().lower() for m in (mailboxes if mailboxes is not None else cfg["mailboxes"]) if m and m.strip()]
    if not boxes:
        return {"ok": False, "error": "No mailboxes configured.", "mailboxes": []}
    backfill = backfill_days if backfill_days is not None else cfg["backfill_days"]
    default_since = (datetime.now(timezone.utc) - timedelta(days=backfill)).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    index = await _load_index(db)
    scope = await _scope_keys(db)
    graph = GraphClient()
    # mailbox → rep display name (for created_by), from the users table.
    rep_name: dict = {}
    for u in await db._q("SELECT email, name FROM users WHERE active = 1", []):
        em = (u.get("email") or "").strip().lower()
        if em:
            rep_name[em] = u.get("name") or em

    report = {"ok": True, "dry_run": dry_run, "mailboxes": [], "totals": {"scanned": 0, "matched": 0,
              "written": 0, "skipped_dup": 0, "out_of_scope": 0}}
    try:
        for mbx in boxes:
            cur = await db._q("SELECT last_seen FROM sales_email_cursor WHERE mailbox = ?", [mbx])
            since = (cur[0]["last_seen"] if cur and cur[0].get("last_seen") else None) or default_since
            box_rep = {"mailbox": mbx, "since": since, "scanned": 0, "matched": 0, "written": 0,
                       "skipped_dup": 0, "out_of_scope": 0, "samples": [], "error": None}
            newest = since
            for folder in ("inbox", "sentitems"):
                direction = "out" if folder == "sentitems" else "in"
                try:
                    msgs = await graph.list_messages(mbx, folder, since=since, top=50)
                except Exception as e:
                    box_rep["error"] = f"{folder}: {e}"
                    logger.warning(f"sales email capture: list {folder} for {mbx} failed: {e}")
                    continue
                for m in msgs:
                    if m.get("isDraft"):
                        continue
                    box_rep["scanned"] += 1
                    occurred = m.get("sentDateTime" if direction == "out" else "receivedDateTime") or ""
                    if occurred and occurred > newest:
                        newest = occurred
                    hit = None
                    for addr in _counterparts(m, direction):
                        cand = index.get(addr)
                        if cand:
                            hit = (addr, cand)
                            break
                    if not hit:
                        continue
                    addr, cand = hit
                    ck = cand["customer_key"]
                    if ck not in scope:
                        box_rep["out_of_scope"] += 1
                        continue
                    box_rep["matched"] += 1
                    ext = m.get("id")
                    dup = await db._q("SELECT id FROM sales_activities WHERE external_id = ?", [ext])
                    if dup:
                        box_rep["skipped_dup"] += 1
                        continue
                    sample = {"direction": direction, "with": cand.get("name") or addr,
                              "subject": m.get("subject") or "(no subject)", "at": occurred[:10]}
                    if len(box_rep["samples"]) < 5:
                        box_rep["samples"].append(sample)
                    if not dry_run:
                        await db._x(
                            "INSERT INTO sales_activities (customer_key, type, subject, body, direction, "
                            "occurred_at, created_by, external_id, created_at) "
                            "VALUES (?, 'email', ?, ?, ?, ?, ?, ?, datetime('now'))",
                            [ck, (m.get("subject") or "")[:255], (m.get("bodyPreview") or "")[:1000],
                             direction, occurred, rep_name.get(mbx, mbx), ext],
                        )
                        box_rep["written"] += 1
            if not dry_run and newest and newest > since:
                await db._x(
                    "INSERT OR REPLACE INTO sales_email_cursor (mailbox, last_seen, updated_at) "
                    "VALUES (?, ?, datetime('now'))", [mbx, newest])
            for k in ("scanned", "matched", "written", "skipped_dup", "out_of_scope"):
                report["totals"][k] += box_rep[k]
            report["mailboxes"].append(box_rep)
    finally:
        await graph.close()
    return report


# ── Background poller (gated; off by default) ────────────────────────────────────

class SalesEmailCaptureService:
    def __init__(self):
        self._running = False
        self._last_run: Optional[str] = None
        self._last_report: Optional[dict] = None

    async def start(self):
        import asyncio
        if not (settings.MS_CLIENT_ID and settings.MS_TENANT_ID):
            logger.info("sales email capture: Microsoft Graph not configured — disabled")
            return
        self._running = True
        asyncio.create_task(self._loop())
        logger.info("sales email capture: poller started (gated by settings.enabled)")

    async def stop(self):
        self._running = False

    async def _loop(self):
        import asyncio
        from app.api.aspire_attachments import _aspire  # shared AspireClient singleton
        while self._running:
            db = Database()
            try:
                await db.connect()
                cfg = await get_capture_config(db)
                if cfg["enabled"] and cfg["mailboxes"]:
                    self._last_report = await capture_once(db, _aspire, dry_run=False)
                    self._last_run = datetime.now(timezone.utc).isoformat()
                sleep_min = max(5, int(cfg.get("poll_minutes") or 10))
            except Exception as e:
                logger.error(f"sales email capture loop error: {e}")
                sleep_min = 10
            finally:
                try:
                    await db.close()
                except Exception:
                    pass
            await asyncio.sleep(sleep_min * 60)


sales_email_capture = SalesEmailCaptureService()
