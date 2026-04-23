"""
Safety Talks API.
Field crew leaders submit toolbox / safety talk records from their phones.
Data is stored in the local D1/SQLite database (not Aspire).
"""
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.database import Database

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/safety", tags=["safety"])


# ── DB dependency ─────────────────────────────────────────────────────────────

async def get_db():
    db = Database()
    await db.connect()
    return db


# ── Schemas ───────────────────────────────────────────────────────────────────

class AttendeeIn(BaseModel):
    name: str

class SafetyTalkIn(BaseModel):
    talk_date:      str              # YYYY-MM-DD
    topic:          str
    presenter_name: str
    job_site:       Optional[str] = None
    notes:          Optional[str] = None
    attendees:      List[str] = []   # list of names

class SafetyTalkOut(BaseModel):
    id:             int
    talk_date:      str
    topic:          str
    presenter_name: str
    job_site:       Optional[str]
    notes:          Optional[str]
    attendee_count: int
    created_at:     str

class SafetyTalkDetail(SafetyTalkOut):
    attendees: List[str]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/talks", response_model=SafetyTalkDetail)
async def create_safety_talk(payload: SafetyTalkIn, db: Database = Depends(get_db)):
    """Create a new safety talk record with attendees."""
    if not payload.topic.strip():
        raise HTTPException(status_code=400, detail="Topic is required")
    if not payload.presenter_name.strip():
        raise HTTPException(status_code=400, detail="Presenter name is required")
    if not payload.attendees:
        raise HTTPException(status_code=400, detail="At least one attendee is required")

    # Insert talk
    talk_id = await db._x(
        """INSERT INTO safety_talks (talk_date, topic, presenter_name, job_site, notes)
           VALUES (?, ?, ?, ?, ?)""",
        [
            payload.talk_date,
            payload.topic.strip(),
            payload.presenter_name.strip(),
            (payload.job_site or "").strip() or None,
            (payload.notes or "").strip() or None,
        ],
    )

    # Insert attendees
    clean_names = [n.strip() for n in payload.attendees if n.strip()]
    for name in clean_names:
        await db._x(
            "INSERT INTO safety_talk_attendees (talk_id, name) VALUES (?, ?)",
            [talk_id, name],
        )

    logger.info(
        f"Safety talk created: id={talk_id} topic='{payload.topic}' "
        f"presenter='{payload.presenter_name}' attendees={len(clean_names)}"
    )

    # Fetch created_at
    rows_ca = await db._q("SELECT created_at FROM safety_talks WHERE id = ?", [talk_id])
    row = rows_ca[0] if rows_ca else None

    return SafetyTalkDetail(
        id=talk_id,
        talk_date=payload.talk_date,
        topic=payload.topic.strip(),
        presenter_name=payload.presenter_name.strip(),
        job_site=(payload.job_site or "").strip() or None,
        notes=(payload.notes or "").strip() or None,
        attendee_count=len(clean_names),
        created_at=row["created_at"] if row else "",
        attendees=clean_names,
    )


@router.get("/talks", response_model=List[SafetyTalkOut])
async def list_safety_talks(
    start_date: Optional[str] = Query(default=None, description="YYYY-MM-DD"),
    end_date:   Optional[str] = Query(default=None, description="YYYY-MM-DD"),
    limit:      int           = Query(default=100, le=500),
    db: Database = Depends(get_db),
):
    """List safety talks, newest first, with attendee counts."""
    where_clauses = []
    params: list = []

    if start_date:
        where_clauses.append("t.talk_date >= ?")
        params.append(start_date)
    if end_date:
        where_clauses.append("t.talk_date <= ?")
        params.append(end_date)

    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    rows = await db._q(
        f"""SELECT t.id, t.talk_date, t.topic, t.presenter_name, t.job_site,
                   t.notes, t.created_at,
                   COUNT(a.id) AS attendee_count
            FROM safety_talks t
            LEFT JOIN safety_talk_attendees a ON a.talk_id = t.id
            {where_sql}
            GROUP BY t.id
            ORDER BY t.talk_date DESC, t.created_at DESC
            LIMIT ?""",
        params + [limit],
    )

    return [
        SafetyTalkOut(
            id=r["id"],
            talk_date=r["talk_date"],
            topic=r["topic"],
            presenter_name=r["presenter_name"],
            job_site=r["job_site"],
            notes=r["notes"],
            attendee_count=r["attendee_count"],
            created_at=r["created_at"],
        )
        for r in rows
    ]


@router.get("/talks/{talk_id}", response_model=SafetyTalkDetail)
async def get_safety_talk(talk_id: int, db: Database = Depends(get_db)):
    """Get a single safety talk with full attendee list."""
    talk_rows = await db._q(
        """SELECT t.id, t.talk_date, t.topic, t.presenter_name, t.job_site,
                  t.notes, t.created_at
           FROM safety_talks t WHERE t.id = ?""",
        [talk_id],
    )
    if not talk_rows:
        raise HTTPException(status_code=404, detail="Safety talk not found")
    row = talk_rows[0]

    attendee_rows = await db._q(
        "SELECT name FROM safety_talk_attendees WHERE talk_id = ? ORDER BY id",
        [talk_id],
    )
    attendees = [r["name"] for r in attendee_rows]

    return SafetyTalkDetail(
        id=row["id"],
        talk_date=row["talk_date"],
        topic=row["topic"],
        presenter_name=row["presenter_name"],
        job_site=row["job_site"],
        notes=row["notes"],
        attendee_count=len(attendees),
        created_at=row["created_at"],
        attendees=attendees,
    )
