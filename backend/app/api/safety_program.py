"""
Safety Program library — the published OH&S document suite, rendered as searchable HTML
for the field app (and managed from the office).

Each row in safety_documents is one readable unit: the Overview index, the OH&S Manual,
each SWP (SWP-01…15), the PHA, the FHSP, the Worker Sign-Off, and the Safety Policy.
Documents are versioned (every save snapshots the prior HTML into safety_document_versions)
so the program has an audit trail, and `status`/`field_visible` gate what crews see.

Public (field crew, no login):
  GET  /safety/program                 → published + field-visible docs WITH html (one load; client searches)
  GET  /safety/program/{slug}          → one published doc

Office (login):
  GET  /safety/program/admin/all       → every doc incl. drafts (metadata)
  GET  /safety/program/admin/{id}      → one doc (any status) + version count
  POST /safety/program/admin           → create
  PUT  /safety/program/admin/{id}      → update (snapshots previous version)
  POST /safety/program/admin/{id}/publish   → {published: bool}
  DELETE /safety/program/admin/{id}    → hard delete (with its versions)
  GET  /safety/program/admin/{id}/versions  → version history
"""
import html as _html
import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.auth import require_access
from app.core.database import Database

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/safety/program", tags=["safety-program"])

CATEGORIES = {"overview", "manual", "swp", "pha", "fhsp", "signoff", "policy"}


def _plain(html_str: str) -> str:
    """Strip HTML to searchable plain text: tags out, entities decoded, whitespace collapsed."""
    if not html_str:
        return ""
    s = re.sub(r"<\s*(br|/p|/div|/li|/h[1-6])\s*>", " \n", html_str, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = _html.unescape(s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{2,}", "\n", s)
    return s.strip()


class DocIn(BaseModel):
    slug:          Optional[str] = None
    title:         str
    category:      str = "swp"
    layer:         Optional[int] = None
    code:          Optional[str] = None       # e.g. "SWP-07"
    summary:       Optional[str] = None
    html:          str
    version:       Optional[str] = None
    status:        Optional[str] = None        # draft | published
    field_visible: Optional[bool] = None
    sort_order:    Optional[int] = None
    updated_by:    Optional[str] = None


def _slugify(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return s or "doc"


async def _unique_slug(db: Database, base: str, exclude_id: Optional[int] = None) -> str:
    slug = base
    n = 2
    while True:
        rows = await db._q(
            "SELECT id FROM safety_documents WHERE slug = ?" + (" AND id != ?" if exclude_id else ""),
            [slug] + ([exclude_id] if exclude_id else []))
        if not rows:
            return slug
        slug = f"{base}-{n}"; n += 1


def _meta(r: dict) -> dict:
    return {
        "id": r["id"], "slug": r["slug"], "title": r["title"], "category": r["category"],
        "layer": r["layer"], "code": r.get("code"), "summary": r.get("summary"),
        "version": r.get("version"), "status": r.get("status"),
        "field_visible": bool(r.get("field_visible")), "sort_order": r.get("sort_order") or 0,
        "updated_by": r.get("updated_by"), "updated_at": r.get("updated_at"),
    }


# ── Public (field) ──────────────────────────────────────────────────────────────

@router.get("")
async def list_program():
    """Every published, field-visible safety doc WITH its HTML — one call so the field app
    can render the handbook and search it client-side (works after first load)."""
    db = Database(); await db.connect()
    try:
        rows = await db._q(
            """SELECT * FROM safety_documents
               WHERE status = 'published' AND field_visible = 1
               ORDER BY layer ASC, sort_order ASC, code ASC, title ASC""", [])
        docs = [{**_meta(r), "html": r["html"]} for r in rows]
        return {"count": len(docs), "documents": docs}
    finally:
        await db.close()


@router.get("/{slug}")
async def get_program_doc(slug: str):
    db = Database(); await db.connect()
    try:
        rows = await db._q(
            "SELECT * FROM safety_documents WHERE slug = ? AND status = 'published' AND field_visible = 1",
            [slug])
        if not rows:
            raise HTTPException(status_code=404, detail="Document not found")
        r = rows[0]
        return {**_meta(r), "html": r["html"]}
    finally:
        await db.close()


# ── Office (admin) ──────────────────────────────────────────────────────────────

@router.get("/admin/all", dependencies=[Depends(require_access)])
async def admin_list():
    db = Database(); await db.connect()
    try:
        rows = await db._q(
            "SELECT * FROM safety_documents ORDER BY layer ASC, sort_order ASC, code ASC, title ASC", [])
        return {"count": len(rows), "documents": [_meta(r) for r in rows]}
    finally:
        await db.close()


@router.get("/admin/{doc_id}", dependencies=[Depends(require_access)])
async def admin_get(doc_id: int):
    db = Database(); await db.connect()
    try:
        rows = await db._q("SELECT * FROM safety_documents WHERE id = ?", [doc_id])
        if not rows:
            raise HTTPException(status_code=404, detail="Document not found")
        r = rows[0]
        vc = await db._q("SELECT COUNT(*) AS n FROM safety_document_versions WHERE document_id = ?", [doc_id])
        return {**_meta(r), "html": r["html"], "version_count": (vc[0]["n"] if vc else 0)}
    finally:
        await db.close()


@router.post("/admin", dependencies=[Depends(require_access)])
async def admin_create(body: DocIn):
    if body.category not in CATEGORIES:
        raise HTTPException(status_code=400, detail=f"category must be one of {sorted(CATEGORIES)}")
    db = Database(); await db.connect()
    try:
        slug = await _unique_slug(db, _slugify(body.slug or body.code or body.title))
        rows = await db._q(
            """INSERT INTO safety_documents
               (slug, title, category, layer, code, summary, html, plain_text, version,
                status, field_visible, sort_order, updated_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING id""",
            [slug, body.title, body.category, body.layer, body.code, body.summary, body.html,
             _plain(body.html), body.version, (body.status or "draft"),
             1 if (body.field_visible is None or body.field_visible) else 0,
             body.sort_order or 0, body.updated_by or "Admin"])
        return {"id": rows[0]["id"], "slug": slug}
    finally:
        await db.close()


@router.put("/admin/{doc_id}", dependencies=[Depends(require_access)])
async def admin_update(doc_id: int, body: DocIn):
    db = Database(); await db.connect()
    try:
        cur = await db._q("SELECT * FROM safety_documents WHERE id = ?", [doc_id])
        if not cur:
            raise HTTPException(status_code=404, detail="Document not found")
        prev = cur[0]
        # Snapshot the current version before overwriting (audit trail).
        await db._x(
            """INSERT INTO safety_document_versions
               (document_id, version, title, summary, html, saved_by)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [doc_id, prev.get("version"), prev["title"], prev.get("summary"), prev["html"],
             body.updated_by or "Admin"])
        if body.category and body.category not in CATEGORIES:
            raise HTTPException(status_code=400, detail=f"category must be one of {sorted(CATEGORIES)}")
        fv = prev.get("field_visible") if body.field_visible is None else (1 if body.field_visible else 0)
        await db._x(
            """UPDATE safety_documents SET
                 title = ?, category = ?, layer = ?, code = ?, summary = ?, html = ?, plain_text = ?,
                 version = ?, status = ?, field_visible = ?, sort_order = ?, updated_by = ?,
                 updated_at = datetime('now')
               WHERE id = ?""",
            [body.title, body.category or prev["category"], body.layer, body.code, body.summary,
             body.html, _plain(body.html), body.version, (body.status or prev.get("status") or "draft"),
             fv, (body.sort_order if body.sort_order is not None else prev.get("sort_order") or 0),
             body.updated_by or "Admin", doc_id])
        return {"id": doc_id, "ok": True}
    finally:
        await db.close()


class PublishIn(BaseModel):
    published: bool


@router.post("/admin/{doc_id}/publish", dependencies=[Depends(require_access)])
async def admin_publish(doc_id: int, body: PublishIn):
    db = Database(); await db.connect()
    try:
        if not await db._q("SELECT id FROM safety_documents WHERE id = ?", [doc_id]):
            raise HTTPException(status_code=404, detail="Document not found")
        await db._x("UPDATE safety_documents SET status = ?, updated_at = datetime('now') WHERE id = ?",
                    ["published" if body.published else "draft", doc_id])
        return {"id": doc_id, "status": "published" if body.published else "draft"}
    finally:
        await db.close()


@router.get("/admin/{doc_id}/versions", dependencies=[Depends(require_access)])
async def admin_versions(doc_id: int):
    db = Database(); await db.connect()
    try:
        rows = await db._q(
            """SELECT id, version, title, saved_by, saved_at
               FROM safety_document_versions WHERE document_id = ? ORDER BY saved_at DESC""", [doc_id])
        return {"versions": rows}
    finally:
        await db.close()


@router.delete("/admin/{doc_id}", dependencies=[Depends(require_access)])
async def admin_delete(doc_id: int):
    db = Database(); await db.connect()
    try:
        await db._x("DELETE FROM safety_document_versions WHERE document_id = ?", [doc_id])
        await db._x("DELETE FROM safety_documents WHERE id = ?", [doc_id])
        return {"id": doc_id, "deleted": True}
    finally:
        await db.close()
