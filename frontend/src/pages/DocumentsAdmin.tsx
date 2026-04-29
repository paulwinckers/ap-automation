/**
 * DocumentsAdmin — upload and manage company documents.
 * Accessible at /ops/documents (login required, office staff).
 */
import { useState, useEffect, useRef } from 'react';
import { listDocuments, uploadDocument, deleteDocument, getDocumentFileUrl, sendPushNotification, type CompanyDocument } from '../lib/api';

function formatSize(bytes?: number | null) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(dt: string) {
  return new Date(dt).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return '📄';
  if (['doc', 'docx'].includes(ext || '')) return '📝';
  if (['xls', 'xlsx'].includes(ext || '')) return '📊';
  if (['png', 'jpg', 'jpeg'].includes(ext || '')) return '🖼️';
  return '📎';
}

export default function DocumentsAdmin() {
  const [docs, setDocs]         = useState<CompanyDocument[]>([]);
  const [loading, setLoading]   = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [success, setSuccess]   = useState<string | null>(null);
  const [lastUploaded, setLastUploaded] = useState<string | null>(null);  // title of last upload
  const [notifying, setNotifying]      = useState(false);
  const [notifyResult, setNotifyResult] = useState<string | null>(null);

  // Upload form
  const [title, setTitle]       = useState('');
  const [description, setDesc]  = useState('');
  const [file, setFile]         = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    setLoading(true);
    listDocuments()
      .then(setDocs)
      .catch(() => setError('Failed to load documents'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  async function handleUpload() {
    if (!title.trim() || !file) return;
    setUploading(true);
    setError(null);
    setSuccess(null);
    try {
      await uploadDocument({ title: title.trim(), description: description.trim() || undefined, file });
      setSuccess(`"${title}" uploaded successfully.`);
      setLastUploaded(title.trim());
      setNotifyResult(null);
      setTitle(''); setDesc(''); setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleNotify() {
    if (!lastUploaded) return;
    setNotifying(true);
    setNotifyResult(null);
    try {
      const r = await sendPushNotification({
        title: '📋 New Document Available',
        body:  `"${lastUploaded}" has been added to Company Documents.`,
        url:   '/field/documents',
      });
      setNotifyResult(`✅ Sent to ${r.sent} device${r.sent !== 1 ? 's' : ''}${r.failed ? ` (${r.failed} failed)` : ''}`);
    } catch (e: unknown) {
      setNotifyResult(`⚠️ ${e instanceof Error ? e.message : 'Notify failed'}`);
    } finally {
      setNotifying(false);
    }
  }

  async function handleDelete(doc: CompanyDocument) {
    if (!confirm(`Delete "${doc.title}"? It will no longer be visible to staff.`)) return;
    try {
      await deleteDocument(doc.id);
      setDocs(d => d.filter(x => x.id !== doc.id));
    } catch {
      setError('Delete failed');
    }
  }

  const inp: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid #334155', background: '#0f172a',
    color: '#f1f5f9', fontSize: 14, boxSizing: 'border-box',
  };

  return (
    <div style={{ padding: '28px 32px', maxWidth: 760 }}>
      <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: '#0f172a' }}>
        📋 Company Documents
      </h1>
      <p style={{ margin: '0 0 28px', color: '#64748b', fontSize: 14 }}>
        Upload policies, procedures and resources visible to all staff.
      </p>

      {/* ── Upload form ── */}
      <div style={{ background: '#1e293b', borderRadius: 12, padding: 20, marginBottom: 28 }}>
        <h2 style={{ margin: '0 0 16px', color: '#fff', fontSize: 16, fontWeight: 700 }}>Upload New Document</h2>

        <div style={{ marginBottom: 12 }}>
          <label style={{ color: '#94a3b8', fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
            TITLE *
          </label>
          <input style={inp} placeholder="e.g. Health & Safety Policy 2026"
            value={title} onChange={e => setTitle(e.target.value)} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ color: '#94a3b8', fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
            DESCRIPTION (optional)
          </label>
          <input style={inp} placeholder="Brief description of contents"
            value={description} onChange={e => setDesc(e.target.value)} />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ color: '#94a3b8', fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
            FILE * (PDF, Word, Excel — max 50 MB)
          </label>
          <input
            ref={fileRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
            style={{ color: '#94a3b8', fontSize: 13 }}
            onChange={e => setFile(e.target.files?.[0] ?? null)}
          />
          {file && <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>
            {file.name} · {formatSize(file.size)}
          </div>}
        </div>

        {error  && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 10 }}>⚠️ {error}</div>}
        {success && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: '#22c55e', fontSize: 13, marginBottom: 8 }}>✅ {success}</div>
            {lastUploaded && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  onClick={handleNotify}
                  disabled={notifying}
                  style={{
                    padding: '8px 18px', borderRadius: 8, border: 'none',
                    background: notifying ? '#334155' : '#7c3aed',
                    color: '#fff', fontSize: 13, fontWeight: 700,
                    cursor: notifying ? 'wait' : 'pointer',
                  }}
                >
                  {notifying ? 'Sending…' : '📣 Notify Field Staff'}
                </button>
                {notifyResult && (
                  <span style={{ fontSize: 13, color: notifyResult.startsWith('✅') ? '#22c55e' : '#f59e0b' }}>
                    {notifyResult}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        <button
          onClick={handleUpload}
          disabled={!title.trim() || !file || uploading}
          style={{
            padding: '11px 24px', borderRadius: 8, border: 'none',
            background: !title.trim() || !file || uploading ? '#334155' : '#3b82f6',
            color: '#fff', fontSize: 14, fontWeight: 700, cursor: uploading ? 'wait' : 'pointer',
          }}
        >
          {uploading ? 'Uploading…' : '⬆ Upload Document'}
        </button>
      </div>

      {/* ── Document list ── */}
      <h2 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: '#0f172a' }}>
        {loading ? 'Loading…' : `${docs.length} Document${docs.length !== 1 ? 's' : ''}`}
      </h2>

      {!loading && docs.length === 0 && (
        <div style={{ color: '#94a3b8', textAlign: 'center', padding: 40 }}>No documents yet.</div>
      )}

      {docs.map(doc => (
        <div key={doc.id} style={{
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
          padding: '14px 16px', marginBottom: 10,
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <div style={{ fontSize: 28, flexShrink: 0 }}>{fileIcon(doc.filename)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 15 }}>{doc.title}</div>
            {doc.description && <div style={{ color: '#64748b', fontSize: 13 }}>{doc.description}</div>}
            <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 2 }}>
              {doc.filename} · {formatSize(doc.file_size)} · {formatDate(doc.created_at)} · {doc.uploaded_by}
            </div>
          </div>
          <a
            href={getDocumentFileUrl(doc.id)}
            target="_blank" rel="noopener noreferrer"
            style={{ color: '#3b82f6', fontSize: 13, fontWeight: 600, textDecoration: 'none',
              padding: '6px 12px', border: '1px solid #bfdbfe', borderRadius: 6, flexShrink: 0 }}
          >
            View
          </a>
          <button
            onClick={() => handleDelete(doc)}
            style={{ background: 'none', border: '1px solid #fecaca', color: '#ef4444',
              borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
