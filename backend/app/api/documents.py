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

from app.core.database import Database
from app.services import r2

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/documents", tags=["documents"])

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("")
async def list_documents():
    """Return all active company documents (public)."""
    db = Database()
    await db.connect()
    try:
        rows = await db._q(
            "SELECT id, title, description, filename, file_size, uploaded_by, created_at "
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
            "INSERT INTO company_documents (title, description, r2_key, filename, file_size, uploaded_by) "
            "VALUES (?, ?, ?, ?, ?, ?) RETURNING id, created_at",
            [
                title.strip(),
                (description or "").strip() or None,
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
