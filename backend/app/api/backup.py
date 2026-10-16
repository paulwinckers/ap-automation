"""
Database backup — nightly D1 → R2 dump, on-demand run, and download.

The D1 database holds operational data that exists nowhere else (vendors,
reconciliation, safety records, PHAs, job planning, settings, QBO refresh
token). This module dumps every table to a gzipped JSON snapshot in R2 under
`backups/`, keeps the most recent N, and can email a copy on a weekly cadence.

Endpoints (office / login-gated at the frontend):
  POST   /admin/backup/run        — run a backup now
  GET    /admin/backup/list       — list snapshots in R2 (newest first)
  GET    /admin/backup/download   — presigned URL for one snapshot (?key=)
  GET    /admin/backup/settings   — read schedule config
  PUT    /admin/backup/settings   — update schedule config

A self-contained asyncio scheduler (same pattern as the issues digest) runs the
nightly backup — no external cron required.
"""
import asyncio
import gzip
import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.services import r2
from app.services.d1_settings import get_setting, set_setting

router = APIRouter(prefix="/admin/backup", tags=["backup"])
logger = logging.getLogger(__name__)

_PREFIX = "backups/"
_CFG_KEY = "BACKUP_SETTINGS"
_PAGE = 500            # rows per page when dumping a table
_ROW_CAP = 300_000     # per-table safety cap
_EMAIL_ATTACH_CAP = 15 * 1024 * 1024  # don't email snapshots larger than 15 MB


def _cfg_defaults() -> dict:
    return {
        "enabled": True,
        "hour": 2,                 # 2 AM in the company timezone
        "retention": 30,           # keep this many snapshots
        "weekly_email_to": "",     # comma-separated; blank = no email
        "weekly_email_day": 6,     # Python weekday(): Mon=0 … Sun=6
    }


async def get_backup_cfg() -> dict:
    merged = _cfg_defaults()
    try:
        raw = await get_setting(_CFG_KEY)
        if raw:
            stored = json.loads(raw)
            if isinstance(stored, dict):
                merged.update({k: v for k, v in stored.items() if k in merged})
    except Exception as e:
        logger.warning("backup cfg load failed — using defaults: %s", e)
    try:
        merged["hour"] = max(0, min(23, int(merged["hour"])))
    except Exception:
        merged["hour"] = 2
    try:
        merged["retention"] = max(1, min(365, int(merged["retention"])))
    except Exception:
        merged["retention"] = 30
    merged["enabled"] = bool(merged["enabled"])
    return merged


# ── Core backup ───────────────────────────────────────────────────────────────

async def run_backup() -> dict:
    """Dump every user table to a gzipped JSON snapshot in R2. Returns a summary."""
    if not r2._r2_available():
        raise RuntimeError("R2 storage is not configured — cannot store a backup")

    db = Database()
    await db.connect()
    try:
        tbls = await db._q(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' "
            "AND name NOT LIKE 'd1_%' ORDER BY name"
        )
        names = [t["name"] for t in tbls]
        dump: dict = {}
        counts: dict = {}
        for name in names:
            rows: list = []
            offset = 0
            while True:
                page = await db._q(f'SELECT * FROM "{name}" LIMIT {_PAGE} OFFSET {offset}')
                rows.extend(page)
                if len(page) < _PAGE:
                    break
                offset += _PAGE
                if offset >= _ROW_CAP:
                    logger.warning("backup: table %s hit the %s-row cap — truncated", name, _ROW_CAP)
                    break
            dump[name] = rows
            counts[name] = len(rows)
    finally:
        await db.close()

    now = datetime.now(timezone.utc)
    snapshot = {
        "generated_at": now.isoformat(),
        "database_id": settings.CF_D1_DATABASE_ID or settings.D1_DATABASE_ID,
        "table_count": len(names),
        "row_count": sum(counts.values()),
        "table_counts": counts,
        "tables": dump,
    }
    raw = json.dumps(snapshot, default=str).encode("utf-8")
    gz = gzip.compress(raw, compresslevel=6)
    key = f"{_PREFIX}dario-backup-{now.strftime('%Y%m%d-%H%M%S')}.json.gz"

    def _upload(k=key, b=gz):
        client = r2._make_client()
        client.put_object(Bucket=settings.R2_BUCKET_NAME, Key=k, Body=b, ContentType="application/gzip")
    await asyncio.get_event_loop().run_in_executor(None, _upload)

    logger.info("Backup written: %s (%s tables, %s rows, %s bytes gz)",
                key, len(names), snapshot["row_count"], len(gz))

    # Prune old snapshots
    pruned = 0
    try:
        cfg = await get_backup_cfg()
        pruned = await _prune(cfg["retention"])
    except Exception as e:
        logger.warning("backup prune skipped: %s", e)

    return {
        "ok": True, "key": key, "bytes": len(gz),
        "table_count": len(names), "row_count": snapshot["row_count"],
        "table_counts": counts, "generated_at": snapshot["generated_at"],
        "pruned": pruned,
    }


async def _list_snapshots() -> list[dict]:
    def _ls():
        client = r2._make_client()
        out: list[dict] = []
        token = None
        while True:
            kw = {"Bucket": settings.R2_BUCKET_NAME, "Prefix": _PREFIX}
            if token:
                kw["ContinuationToken"] = token
            resp = client.list_objects_v2(**kw)
            for o in resp.get("Contents", []):
                if o["Key"].endswith(".json.gz"):
                    out.append({
                        "key": o["Key"],
                        "bytes": o.get("Size", 0),
                        "last_modified": o["LastModified"].isoformat() if o.get("LastModified") else None,
                    })
            if resp.get("IsTruncated"):
                token = resp.get("NextContinuationToken")
            else:
                break
        out.sort(key=lambda x: x["key"], reverse=True)
        return out
    return await asyncio.get_event_loop().run_in_executor(None, _ls)


async def _prune(keep: int) -> int:
    snaps = await _list_snapshots()
    old = snaps[keep:]
    if not old:
        return 0

    def _del(keys):
        client = r2._make_client()
        for k in keys:
            try:
                client.delete_object(Bucket=settings.R2_BUCKET_NAME, Key=k)
            except Exception as e:
                logger.warning("backup prune: could not delete %s: %s", k, e)
    await asyncio.get_event_loop().run_in_executor(None, _del, [s["key"] for s in old])
    logger.info("Backup prune: removed %s old snapshot(s)", len(old))
    return len(old)


# ── Endpoints ───────────────────────────────────────────────────────────────────

@router.post("/run")
async def backup_now():
    try:
        return await run_backup()
    except Exception as e:
        logger.error("Manual backup failed: %s", e)
        raise HTTPException(500, f"Backup failed: {e}")


@router.get("/list")
async def backup_list():
    try:
        return {"backups": await _list_snapshots()}
    except Exception as e:
        raise HTTPException(500, f"Could not list backups: {e}")


@router.get("/download")
async def backup_download(key: str = Query(...)):
    if not key.startswith(_PREFIX) or ".." in key:
        raise HTTPException(400, "Invalid backup key")
    url = await r2.get_presigned_url(key, expires_in=900)
    if not url:
        raise HTTPException(404, "Backup not found or storage unavailable")
    return {"url": url}


class CfgBody(BaseModel):
    enabled:          Optional[bool] = None
    hour:             Optional[int] = None
    retention:        Optional[int] = None
    weekly_email_to:  Optional[str] = None
    weekly_email_day: Optional[int] = None


@router.get("/settings")
async def backup_get_settings():
    cfg = await get_backup_cfg()
    snaps = await _list_snapshots()
    cfg["_latest"] = snaps[0] if snaps else None
    cfg["_count"] = len(snaps)
    return cfg


@router.put("/settings")
async def backup_put_settings(body: CfgBody):
    cfg = await get_backup_cfg()
    for k in ("enabled", "hour", "retention", "weekly_email_to", "weekly_email_day"):
        v = getattr(body, k)
        if v is not None:
            cfg[k] = v
    await set_setting(_CFG_KEY, json.dumps({k: cfg[k] for k in _cfg_defaults()}))
    return await get_backup_cfg()


# ── Weekly email ─────────────────────────────────────────────────────────────────

async def _email_latest_backup(result: dict, recipients: list[str]):
    key = result["key"]
    gz = await r2.get_file_bytes(key)
    from app.services.email_intake import GraphClient
    filename = key.split("/")[-1]
    tc = result.get("table_count")
    rc = result.get("row_count")
    body = f"""
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px">
      <div style="background:#0f172a;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0">
        <div style="font-size:16px;font-weight:800">💾 Weekly database backup</div>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:16px 18px;color:#111827;font-size:14px">
        <p>Snapshot <b>{filename}</b> — {tc} tables, {rc:,} rows.</p>
        <p style="color:#6b7280;font-size:13px">{"Attached to this email." if gz and len(gz) <= _EMAIL_ATTACH_CAP else "Too large to attach — download it from the Backups page in the portal."}</p>
      </div>
    </div>"""
    attach = gz if (gz and len(gz) <= _EMAIL_ATTACH_CAP) else None
    await GraphClient().send_email(
        mailbox=settings.ms_send_from,
        to_addresses=recipients,
        subject=f"💾 Weekly DB backup — {filename}",
        body_html=body,
        attachment_bytes=attach,
        attachment_filename=(filename if attach else None),
    )
    logger.info("Weekly backup email sent to %s (attached=%s)", recipients, bool(attach))


# ── Scheduler ─────────────────────────────────────────────────────────────────

_backup_task = None


async def _backup_scheduler_loop():
    """Run the backup once per day at the configured hour (company timezone).
    Polls every 5 minutes; an in-memory last-run-date guard prevents double runs."""
    import zoneinfo as _zi
    from datetime import datetime as _dt

    tz = _zi.ZoneInfo(settings.CONSTRUCTION_REPORT_TIMEZONE or "America/Vancouver")
    last_run_date = ""
    WINDOW_MINS = 30

    while True:
        await asyncio.sleep(5 * 60)
        now = _dt.now(tz)
        today = now.strftime("%Y-%m-%d")
        try:
            cfg = await get_backup_cfg()
        except Exception:
            cfg = _cfg_defaults()
        if not cfg.get("enabled", True):
            continue
        if not (now.hour == int(cfg.get("hour", 2)) and now.minute < WINDOW_MINS):
            continue
        if last_run_date == today:
            continue
        last_run_date = today
        logger.info("Backup scheduler: firing for %s at %s", today, now.strftime("%H:%M %Z"))
        try:
            result = await run_backup()
            # Weekly email, if configured and today is the chosen weekday
            to = [e.strip() for e in (cfg.get("weekly_email_to") or "").split(",") if e.strip()]
            if to and now.weekday() == int(cfg.get("weekly_email_day", 6)):
                try:
                    await _email_latest_backup(result, to)
                except Exception as e:
                    logger.warning("Weekly backup email failed (backup still stored): %s", e)
        except Exception as e:
            logger.error("Scheduled backup failed: %s", e)


def start_backup_scheduler():
    global _backup_task
    _backup_task = asyncio.ensure_future(_backup_scheduler_loop())
    logger.info("Backup scheduler started (nightly D1 → R2)")


def stop_backup_scheduler():
    global _backup_task
    if _backup_task:
        _backup_task.cancel()
        _backup_task = None
