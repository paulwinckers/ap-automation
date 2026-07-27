"""
Company Documents API
GET  /documents           → list active documents (public — field crew)
POST /documents           → upload a document to R2 (admin)
GET  /documents/{id}/file → stream file from R2 (public)
DELETE /documents/{id}    → soft-delete (admin)
"""
import asyncio
import logging
import mimetypes
import uuid
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core.database import Database
from app.services import r2

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/documents", tags=["documents"])

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB


# ── Folder management (nested tree) ─────────────────────────────────────────────

class FolderCreate(BaseModel):
    name:       str
    parent_id:  Optional[int] = None
    created_by: Optional[str] = "Admin"


class FolderUpdate(BaseModel):
    name:      Optional[str] = None
    parent_id: Optional[int] = None   # sent to move; use -1 sentinel to move to root


class DocMove(BaseModel):
    folder_id: Optional[int] = None   # null = unfiled (root)


@router.get("/folders")
async def list_folders():
    """All document folders (flat list with parent_id — the client builds the tree)."""
    db = Database()
    await db.connect()
    try:
        rows = await db._q(
            "SELECT id, name, parent_id, created_at FROM document_folders ORDER BY name COLLATE NOCASE",
            [],
        )
        return {"folders": [dict(r) for r in rows]}
    finally:
        await db.close()


@router.post("/folders")
async def create_folder(body: FolderCreate):
    """Create a folder (optionally nested under parent_id)."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Folder name is required")
    db = Database()
    await db.connect()
    try:
        if body.parent_id is not None:
            parent = await db._q("SELECT id FROM document_folders WHERE id = ?", [body.parent_id])
            if not parent:
                raise HTTPException(status_code=404, detail="Parent folder not found")
        dup = await db._q(
            "SELECT id FROM document_folders WHERE name = ? COLLATE NOCASE AND "
            + ("parent_id = ?" if body.parent_id is not None else "parent_id IS NULL"),
            [name, body.parent_id] if body.parent_id is not None else [name],
        )
        if dup:
            raise HTTPException(status_code=409, detail="A folder with that name already exists here")
        rows = await db._q(
            "INSERT INTO document_folders (name, parent_id, created_by) VALUES (?, ?, ?) "
            "RETURNING id, name, parent_id, created_at",
            [name, body.parent_id, body.created_by or "Admin"],
        )
        return dict(rows[0])
    finally:
        await db.close()


async def _descendant_ids(db: Database, folder_id: int) -> set[int]:
    """All descendant folder ids of folder_id (for cycle prevention)."""
    rows = await db._q("SELECT id, parent_id FROM document_folders", [])
    children: dict = {}
    for r in rows:
        children.setdefault(r.get("parent_id"), []).append(r["id"])
    out: set[int] = set()
    stack = list(children.get(folder_id, []))
    while stack:
        cur = stack.pop()
        if cur in out:
            continue
        out.add(cur)
        stack.extend(children.get(cur, []))
    return out


@router.patch("/folders/{folder_id}")
async def update_folder(folder_id: int, body: FolderUpdate):
    """Rename a folder and/or move it under a new parent (-1 → move to root)."""
    db = Database()
    await db.connect()
    try:
        exists = await db._q("SELECT id FROM document_folders WHERE id = ?", [folder_id])
        if not exists:
            raise HTTPException(status_code=404, detail="Folder not found")

        sets, params = [], []
        if body.name is not None:
            nm = body.name.strip()
            if not nm:
                raise HTTPException(status_code=400, detail="Folder name cannot be empty")
            sets.append("name = ?"); params.append(nm)

        if body.parent_id is not None:
            new_parent = None if body.parent_id == -1 else body.parent_id
            if new_parent is not None:
                if new_parent == folder_id:
                    raise HTTPException(status_code=400, detail="A folder cannot be its own parent")
                if not await db._q("SELECT id FROM document_folders WHERE id = ?", [new_parent]):
                    raise HTTPException(status_code=404, detail="Target parent folder not found")
                if new_parent in await _descendant_ids(db, folder_id):
                    raise HTTPException(status_code=400, detail="Cannot move a folder into one of its own subfolders")
            sets.append("parent_id = ?"); params.append(new_parent)

        if not sets:
            raise HTTPException(status_code=400, detail="Nothing to update")
        params.append(folder_id)
        await db._x(f"UPDATE document_folders SET {', '.join(sets)} WHERE id = ?", params)
        return {"ok": True, "id": folder_id}
    finally:
        await db.close()


@router.delete("/folders/{folder_id}")
async def delete_folder(folder_id: int):
    """Delete a folder — only when it's empty (no subfolders, no documents)."""
    db = Database()
    await db.connect()
    try:
        if not await db._q("SELECT id FROM document_folders WHERE id = ?", [folder_id]):
            raise HTTPException(status_code=404, detail="Folder not found")
        subs = await db._q("SELECT COUNT(*) AS n FROM document_folders WHERE parent_id = ?", [folder_id])
        docs = await db._q("SELECT COUNT(*) AS n FROM company_documents WHERE folder_id = ? AND is_active = 1", [folder_id])
        n_sub = subs[0]["n"] if subs else 0
        n_doc = docs[0]["n"] if docs else 0
        if n_sub or n_doc:
            raise HTTPException(
                status_code=409,
                detail=f"Folder is not empty ({n_sub} subfolder(s), {n_doc} document(s)). "
                       f"Move or delete its contents first.",
            )
        await db._x("DELETE FROM document_folders WHERE id = ?", [folder_id])
        return {"ok": True, "deleted_id": folder_id}
    finally:
        await db.close()


@router.patch("/{doc_id}/move")
async def move_document(doc_id: int, body: DocMove):
    """Move a document into a folder (folder_id null → unfiled)."""
    db = Database()
    await db.connect()
    try:
        if not await db._q("SELECT id FROM company_documents WHERE id = ?", [doc_id]):
            raise HTTPException(status_code=404, detail="Document not found")
        if body.folder_id is not None:
            if not await db._q("SELECT id FROM document_folders WHERE id = ?", [body.folder_id]):
                raise HTTPException(status_code=404, detail="Target folder not found")
        await db._x("UPDATE company_documents SET folder_id = ? WHERE id = ?", [body.folder_id, doc_id])
        return {"ok": True, "id": doc_id, "folder_id": body.folder_id}
    finally:
        await db.close()


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("")
async def list_documents():
    """Return all active company documents (public)."""
    db = Database()
    await db.connect()
    try:
        rows = await db._q(
            "SELECT id, title, description, folder, folder_id, filename, file_size, uploaded_by, created_at "
            "FROM company_documents WHERE is_active = 1 ORDER BY created_at DESC",
            [],
        )
        return {"documents": [dict(r) for r in rows]}
    finally:
        await db.close()


# ── Upload ────────────────────────────────────────────────────────────────────

@router.post("")
async def upload_document(
    title:       str            = Form(...),
    description: Optional[str] = Form(default=None),
    folder:      Optional[str] = Form(default=None),
    folder_id:   Optional[int] = Form(default=None),
    uploaded_by: Optional[str] = Form(default="Admin"),
    file:        UploadFile     = File(...),
):
    """Upload a company document to R2 and register it in the DB."""
    file_bytes = await file.read()
    if len(file_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large — maximum 50 MB")
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Empty file")

    filename     = file.filename or "document"
    content_type = file.content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"

    # Upload to R2
    safe_name = "".join(c if c.isalnum() or c in (".", "-", "_") else "_" for c in filename)
    uid       = uuid.uuid4().hex[:8]
    r2_key    = f"documents/{uid}_{safe_name}"

    if not r2._r2_available():
        raise HTTPException(status_code=503, detail="R2 storage not configured")

    def _upload():
        client = r2._make_client()
        client.put_object(
            Bucket=r2.settings.R2_BUCKET_NAME,
            Key=r2_key,
            Body=file_bytes,
            ContentType=content_type,
        )

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _upload)
    logger.info("Document uploaded to R2: %s", r2_key)

    # Insert into DB
    db = Database()
    await db.connect()
    try:
        rows = await db._q(
            "INSERT INTO company_documents (title, description, folder, folder_id, r2_key, filename, file_size, uploaded_by) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at",
            [
                title.strip(),
                (description or "").strip() or None,
                (folder or "").strip() or None,
                folder_id,
                r2_key,
                filename,
                len(file_bytes),
                uploaded_by or "Admin",
            ],
        )
    finally:
        await db.close()

    doc_id = rows[0]["id"] if rows else None
    logger.info("Document #%s '%s' saved by %s", doc_id, title, uploaded_by)

    return {
        "id":          doc_id,
        "title":       title,
        "folder":      (folder or "").strip() or None,
        "folder_id":   folder_id,
        "filename":    filename,
        "file_size":   len(file_bytes),
        "uploaded_by": uploaded_by,
    }


# ── Serve file ────────────────────────────────────────────────────────────────

@router.get("/{doc_id}/file")
async def get_document_file(doc_id: int):
    """Stream the document file from R2 (public — no login required)."""
    db = Database()
    await db.connect()
    try:
        rows = await db._q(
            "SELECT r2_key, filename FROM company_documents WHERE id = ? AND is_active = 1",
            [doc_id],
        )
    finally:
        await db.close()

    if not rows:
        raise HTTPException(status_code=404, detail="Document not found")

    r2_key   = rows[0]["r2_key"]
    filename = rows[0]["filename"]

    file_bytes = await r2.get_file_bytes(r2_key)
    if file_bytes is None:
        raise HTTPException(status_code=404, detail="File not found in storage")

    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    safe_name    = filename.replace('"', "")

    return StreamingResponse(
        iter([file_bytes]),
        media_type=content_type,
        headers={
            "Content-Disposition": f'inline; filename="{safe_name}"',
            "Content-Length":      str(len(file_bytes)),
        },
    )


# ── Delete (soft) ─────────────────────────────────────────────────────────────

@router.delete("/{doc_id}")
async def delete_document(doc_id: int):
    """Soft-delete a document (admin)."""
    db = Database()
    await db.connect()
    try:
        await db._x(
            "UPDATE company_documents SET is_active = 0 WHERE id = ?",
            [doc_id],
        )
    finally:
        await db.close()

    logger.info("Document #%s soft-deleted", doc_id)
    return {"status": "deleted", "id": doc_id}
