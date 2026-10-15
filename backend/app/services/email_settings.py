"""
Runtime-configurable email settings (timing + distribution).

Stored as a single JSON document in D1 (key EMAIL_SETTINGS) so the admin UI can
change recipients and schedule times without a redeploy. config.py values are the
fallback defaults. A short in-memory cache keeps the schedulers/senders cheap.
"""
import json
import logging
import time

from app.core.config import settings
from app.services.d1_settings import get_setting, set_setting

logger = logging.getLogger(__name__)

_KEY = "EMAIL_SETTINGS"
_TTL = 30.0  # seconds
_cache: dict = {"data": None, "ts": 0.0}


# Default per-division recipients for the daily division reports. These seed the
# editable settings doc; the admin UI (Email Settings) overrides them in D1.
_DAILY_REPORT_DIVISION_DEFAULTS: dict[str, str] = {
    "Construction":            "rodger@darios.ca, dustin@darios.ca, keeland@darios.ca",
    "Commercial Maintenance":  "ipm@darios.ca, vesna@darios.ca, don.i.whyte@gmail.com, clientcare@darios.ca",
    "Residential Maintenance": "vesna@darios.ca, becca@darios.ca, ipm@darios.ca, clientcare@darios.ca",
    "Irrigation":              "vesna@darios.ca, becca@darios.ca, ipm@darios.ca, clientcare@darios.ca, don.i.whyte@gmail.com",
    "Snow":                    "",
}


def _defaults() -> dict:
    return {
        "safety_incident":     {"recipients": settings.SAFETY_INCIDENT_RECIPIENTS or ""},
        "vehicle_inspection":  {"recipients": settings.VEHICLE_INSPECTION_RECIPIENTS or ""},
        "issues_digest":       {"recipients": settings.ISSUES_DIGEST_MGMT_RECIPIENTS or "",
                                "enabled": True, "hour": 19, "skip_weekend": True},
        "project_checkin":     {"cc": settings.CONSTRUCTION_CHECKIN_CC or "",
                                "enabled": True, "hour": 6, "skip_weekend": True},
        "daily_reports":       {"cc": "paul@darios.ca",
                                "divisions": dict(_DAILY_REPORT_DIVISION_DEFAULTS)},
    }


def _merge(stored: dict | None) -> dict:
    merged = _defaults()
    for k, v in (stored or {}).items():
        if k in merged and isinstance(v, dict):
            # daily_reports.divisions is itself a dict — deep-merge so that
            # divisions added in code later still appear for an older stored doc.
            if k == "daily_reports" and isinstance(v.get("divisions"), dict):
                merged[k]["divisions"] = {**merged[k]["divisions"], **v["divisions"]}
                rest = {kk: vv for kk, vv in v.items() if kk != "divisions"}
                merged[k].update(rest)
            else:
                merged[k].update(v)
    return merged


async def get_email_settings(force: bool = False) -> dict:
    """Effective settings (D1 overrides merged over config defaults)."""
    now = time.time()
    if not force and _cache["data"] is not None and (now - _cache["ts"]) < _TTL:
        return _cache["data"]
    stored = None
    try:
        raw = await get_setting(_KEY)
        if raw:
            stored = json.loads(raw)
    except Exception as e:
        logger.warning(f"email settings load failed — using defaults: {e}")
    merged = _merge(stored)
    _cache["data"] = merged
    _cache["ts"] = now
    return merged


async def save_email_settings(data: dict) -> dict:
    merged = _merge(data)
    # normalise hours to 0-23 ints
    for key in ("issues_digest", "project_checkin"):
        try:
            merged[key]["hour"] = max(0, min(23, int(merged[key].get("hour", 0))))
        except (TypeError, ValueError):
            merged[key]["hour"] = _defaults()[key]["hour"]
        merged[key]["enabled"] = bool(merged[key].get("enabled", True))
        merged[key]["skip_weekend"] = bool(merged[key].get("skip_weekend", True))
    await set_setting(_KEY, json.dumps(merged))
    _cache["data"] = merged
    _cache["ts"] = time.time()
    return merged


def recipients(csv: str) -> list[str]:
    return [e.strip() for e in (csv or "").split(",") if e.strip()]


async def daily_report_recipients() -> tuple[dict[str, list[str]], list[str]]:
    """
    Resolve the daily division reports distribution from settings.
    Returns (divisions_map, cc_list) where divisions_map only includes
    divisions that have at least one recipient configured.
    """
    s = await get_email_settings()
    dr = s.get("daily_reports", {}) or {}
    divs: dict[str, list[str]] = {}
    for name, csv in (dr.get("divisions") or {}).items():
        rcpts = recipients(csv)
        if rcpts:
            divs[name] = rcpts
    cc = recipients(dr.get("cc", ""))
    return divs, cc
