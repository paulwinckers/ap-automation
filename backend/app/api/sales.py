"""
Sales activity layer — own-D1 CRUD for the sales team.

Scope (locked plan, see memory project-sales-activity-tracking):
  - sales_activities   notes / calls / meetings / emails / SITE VISITS, each anchored on the
                       spine customer_key (so PRE-opportunity leads work), with an optional
                       next_action_date (followup).
  - sales_tasks        LIVING work items spawned from a visit/note (assignee, due, status) —
                       held here (not Aspire) so they can be appended to, carry photos, be
                       marked done, and be surfaced by the agent as a "due" worklist.
  - sales_task_updates append log / progress thread on a task.
  - sales_attachments  pics/videos (R2) on an activity OR a task (shared pattern).

This module starts with /sales/status only (verifies the schema). Capture endpoints, the
fan-out (create Aspire opportunity / task / followup), the Claude tools, and the field
capture form come in the next increments.
"""
import logging

from fastapi import APIRouter, Depends

from app.core.database import Database
from app.api.auth import require_access
from app.api.construction_plan import get_db

router = APIRouter(prefix="/sales", tags=["sales"])
logger = logging.getLogger(__name__)

_TABLES = ("sales_activities", "sales_tasks", "sales_task_updates", "sales_attachments")


@router.get("/status", dependencies=[Depends(require_access)])
async def sales_status(db: Database = Depends(get_db)):
    """Row counts per sales table — confirms the schema exists and is reachable."""
    tables = {}
    for t in _TABLES:
        try:
            r = await db._q(f"SELECT COUNT(*) AS n FROM {t}", [])
            tables[t] = (r[0].get("n") if r else 0) or 0
        except Exception as e:
            tables[t] = f"ERR: {e}"
    return {"ok": all(isinstance(v, int) for v in tables.values()), "tables": tables}
