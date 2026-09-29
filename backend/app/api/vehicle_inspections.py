"""
Weekly Vehicle Inspection API

POST  /vehicle/inspections        — submit an inspection (emails only if there are defects)
GET   /vehicle/inspections        — list (admin)
GET   /vehicle/inspections/{id}   — full detail
"""
import json
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database
from app.services.email_intake import GraphClient

router = APIRouter(prefix="/vehicle/inspections", tags=["vehicle-inspections"])
logger = logging.getLogger(__name__)


async def _get_db() -> Database:
    db = Database()
    await db.connect()
    return db


def _row(r) -> dict:
    return dict(r) if r else {}


def _recipients() -> list[str]:
    raw = (getattr(settings, "VEHICLE_INSPECTION_RECIPIENTS", "") or "").strip() \
        or (getattr(settings, "SAFETY_INCIDENT_RECIPIENTS", "") or "") \
        or (settings.ISSUES_DIGEST_MGMT_RECIPIENTS or "")
    return [e.strip() for e in raw.split(",") if e.strip()]


def _portal_base() -> str:
    return (getattr(settings, "PORTAL_BASE_URL", "") or "https://darios-ap.pages.dev").rstrip("/")


class InspectionItem(BaseModel):
    key:    str
    label:  str
    result: str = ""     # 'ok' | 'not_ok' | ''
    notes:  Optional[str] = None


class VehicleInspectionIn(BaseModel):
    vehicle_number:  str
    completed_by:    str
    inspection_date: str
    odometer:        Optional[str] = None
    notes:           Optional[str] = None
    items:           list[InspectionItem] = []


@router.post("")
async def submit_vehicle_inspection(body: VehicleInspectionIn):
    if not body.completed_by.strip():
        raise HTTPException(400, "Completed-by name is required")
    items = [i.model_dump() for i in body.items]
    defects = [i for i in items if i.get("result") == "not_ok"]

    db = await _get_db()
    try:
        rows = await db._q(
            """INSERT INTO vehicle_inspections
               (vehicle_number, odometer, completed_by, inspection_date, items_json, defect_count, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               RETURNING id""",
            [
                (body.vehicle_number or "").strip() or None,
                (body.odometer or "").strip() or None,
                body.completed_by.strip(),
                body.inspection_date,
                json.dumps(items),
                len(defects),
                (body.notes or "").strip() or None,
            ],
        )
        inspection_id = rows[0]["id"]
    finally:
        await db.close()

    logger.info("Vehicle inspection #%s submitted for %s by %s (%d defect(s))",
                inspection_id, body.vehicle_number, body.completed_by, len(defects))

    # Email only when there are defects (routine clean inspections don't spam the inbox).
    if defects:
        try:
            recipients = _recipients()
            if recipients:
                html = _render_defect_email(inspection_id, body, defects)
                await GraphClient().send_email(
                    mailbox=settings.ms_send_from,
                    to_addresses=recipients,
                    subject=f"🔧 Vehicle defect(s) — #{body.vehicle_number or '?'} — {len(defects)} item(s)",
                    body_html=html,
                )
        except Exception as e:
            logger.warning("Vehicle inspection email failed (record saved): %s", e)

    return {"id": inspection_id, "defect_count": len(defects)}


def _render_defect_email(iid: int, body: VehicleInspectionIn, defects: list) -> str:
    base = _portal_base()
    rows = "".join(
        f'<tr><td style="padding:6px 12px 6px 0;color:#111827;font-size:14px;font-weight:600;vertical-align:top">{d.get("label")}</td>'
        f'<td style="padding:6px 0;color:#6b7280;font-size:13px;white-space:pre-wrap">{d.get("notes") or "—"}</td></tr>'
        for d in defects
    )
    return f"""
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px">
      <div style="background:#b45309;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">
        <div style="font-size:18px;font-weight:800">🔧 Vehicle Inspection — defects found</div>
        <div style="font-size:13px;opacity:0.9;margin-top:2px">Inspection #{iid}</div>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:18px 20px">
        <table style="border-collapse:collapse;width:100%;margin-bottom:12px">
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px">Vehicle</td><td style="padding:4px 0;color:#111827;font-size:14px;font-weight:700">#{body.vehicle_number or '?'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px">Odometer</td><td style="padding:4px 0;color:#111827;font-size:14px">{body.odometer or '—'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px">Completed by</td><td style="padding:4px 0;color:#111827;font-size:14px">{body.completed_by}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px">Date</td><td style="padding:4px 0;color:#111827;font-size:14px">{body.inspection_date}</td></tr>
        </table>
        <div style="font-size:12px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Items marked Not OK</div>
        <table style="border-collapse:collapse;width:100%">{rows}</table>
        <a href="{base}/ops/vehicle-inspections" style="display:inline-block;margin-top:16px;background:#111827;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700">Open the vehicle inspection log →</a>
      </div>
    </div>"""


@router.get("")
async def list_vehicle_inspections(
    vehicle_number: Optional[str] = None,
    only_defects:   bool = False,
    limit:          int = 200,
):
    db = await _get_db()
    try:
        where, params = ["1=1"], []
        if vehicle_number:
            where.append("lower(vehicle_number) LIKE ?"); params.append(f"%{vehicle_number.lower()}%")
        if only_defects:
            where.append("defect_count > 0")
        params.append(limit)
        rows = await db._q(
            f"""SELECT id, vehicle_number, odometer, completed_by, inspection_date,
                       defect_count, created_at
                FROM vehicle_inspections
                WHERE {' AND '.join(where)}
                ORDER BY inspection_date DESC, id DESC
                LIMIT ?""",
            params,
        )
        return {"inspections": [_row(r) for r in rows]}
    finally:
        await db.close()


@router.get("/{inspection_id}")
async def get_vehicle_inspection(inspection_id: int):
    db = await _get_db()
    try:
        rows = await db._q("SELECT * FROM vehicle_inspections WHERE id = ?", [inspection_id])
        if not rows:
            raise HTTPException(404, "Inspection not found")
        insp = _row(rows[0])
    finally:
        await db.close()
    try:
        insp["items"] = json.loads(insp.get("items_json") or "[]")
    except Exception:
        insp["items"] = []
    insp.pop("items_json", None)
    return insp
