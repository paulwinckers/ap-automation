/**
 * DocumentsAdmin — upload & manage company documents with a nested folder tree.
 * Accessible at /ops/documents (login required, office staff).
 */
import { useState, useEffect, useRef } from 'react';
import {
  listDocuments, uploadDocument, deleteDocument, getDocumentFileUrl, sendPushNotification,
  listFolders, createFolder, renameFolder, moveFolder, deleteFolder, moveDocument,
  type CompanyDocument, type DocumentFolder,
} from '../lib/api';

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

type Selected = number | 'all' | 'unfiled';

export default function DocumentsAdmin() {
  const [docs, setDocs]         = useState<CompanyDocument[]>([]);
  const [folders, setFolders]   = useState<DocumentFolder[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected>('all');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Upload form
  const [uploading, setUploading] = useState(false);
  const [title, setTitle]       = useState('');
  const [description, setDesc]  = useState('');
  const [file, setFile]         = useState<File | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [lastUploaded, setLastUploaded] = useState<string | null>(null);
  const [notifying, setNotifying] = useState(false);
  const [notifyResult, setNotifyResult] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    setLoading(true);
    Promise.all([listDocuments(), listFolders()])
      .then(([d, f]) => { setDocs(d); setFolders(f); })
      .catch(() => setError('Failed to load documents'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // ── Folder helpers ──
  const childrenOf = (pid: number | null) =>
    folders.filter(f => f.parent_id === pid).sort((a, b) => a.name.localeCompare(b.name));
  const folderById = (id: number) => folders.find(f => f.id === id);
  const descendantIds = (id: number): Set<number> => {
    const out = new Set<number>();
    const stack = childrenOf(id).map(f => f.id);
    while (stack.length) { const c = stack.pop()!; if (out.has(c)) continue; out.add(c); childrenOf(c).forEach(x => stack.push(x.id)); }
    return out;
  };
  const folderPath = (id: number | null): string => {
    if (id == null) return 'Unfiled';
    const parts: string[] = [];
    let cur: number | null = id;
    const seen = new Set<number>();
    while (cur != null && !seen.has(cur)) { seen.add(cur); const f = folderById(cur); if (!f) break; parts.unshift(f.name); cur = f.parent_id; }
    return parts.join(' / ');
  };
  const docCount = (fid: number) => docs.filter(d => d.folder_id === fid).length;

  const visibleDocs = selected === 'all'
    ? docs
    : selected === 'unfiled'
    ? docs.filter(d => d.folder_id == null)
    : docs.filter(d => d.folder_id === selected);

  const currentFolderId: number | null = typeof selected === 'number' ? selected : null;

  // ── Folder actions ──
  async function addFolder(parentId: number | null) {
    const name = window.prompt(parentId ? `New subfolder under "${folderPath(parentId)}":` : 'New folder name:');
    if (!name || !name.trim()) return;
    try {
      const f = await createFolder(name.trim(), parentId);
      if (parentId) setExpanded(s => new Set(s).add(parentId));
      setFolders(prev => [...prev, f]);
      setSelected(f.id);
    } catch (e: any) { alert(e?.message || 'Create failed'); }
  }
  async function rename(f: DocumentFolder) {
    const name = window.prompt('Rename folder:', f.name);
    if (!name || !name.trim() || name.trim() === f.name) return;
    try { await renameFolder(f.id, name.trim()); load(); }
    catch (e: any) { alert(e?.message || 'Rename failed'); }
  }
  async function removeFolder(f: DocumentFolder) {
    if (!window.confirm(`Delete folder "${f.name}"? (It must be empty.)`)) return;
    try { await deleteFolder(f.id); if (selected === f.id) setSelected('all'); load(); }
    catch (e: any) { alert(e?.message || 'Delete failed'); }
  }
  async function reparent(f: DocumentFolder, parentId: number | null) {
    try { await moveFolder(f.id, parentId); load(); }
    catch (e: any) { alert(e?.message || 'Move failed'); }
  }
  async function moveDoc(doc: CompanyDocument, folderId: number | null) {
    try { await moveDocument(doc.id, folderId); load(); }
    catch (e: any) { alert(e?.message || 'Move failed'); }
  }

  async function handleUpload() {
    if (!title.trim() || !file) return;
    setUploading(true); setError(null); setUploadMsg(null);
    try {
      await uploadDocument({ title: title.trim(), description: description.trim() || undefined, folderId: currentFolderId, file });
      setUploadMsg(`"${title}" uploaded to ${currentFolderId ? folderPath(currentFolderId) : 'Unfiled'}.`);
      setLastUploaded(title.trim()); setNotifyResult(null);
      setTitle(''); setDesc(''); setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      load();
    } catch (e: any) { setError(e?.message || 'Upload failed'); }
    finally { setUploading(false); }
  }
  async function handleDelete(doc: CompanyDocument) {
    if (!confirm(`Delete "${doc.title}"?`)) return;
    try { await deleteDocument(doc.id); setDocs(d => d.filter(x => x.id !== doc.id)); }
    catch { setError('Delete failed'); }
  }
  async function handleNotify() {
    if (!lastUploaded) return;
    setNotifying(true); setNotifyResult(null);
    try {
      const r = await sendPushNotification({ title: '📋 New Document Available', body: `"${lastUploaded}" has been added to Company Documents.`, url: '/field/documents' });
      setNotifyResult(`✅ Sent to ${r.sent} device${r.sent !== 1 ? 's' : ''}${r.failed ? ` (${r.failed} failed)` : ''}`);
    } catch (e: any) { setNotifyResult(`⚠️ ${e?.message || 'Notify failed'}`); }
    finally { setNotifying(false); }
  }

  // ── Folder tree node ──
  const rowBase: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, padding: '5px 6px', borderRadius: 6, cursor: 'pointer', fontSize: 13 };
  function renderFolder(f: DocumentFolder, depth: number) {
    const kids = childrenOf(f.id);
    const isOpen = expanded.has(f.id);
    const isSel = selected === f.id;
    const invalid = descendantIds(f.id);
    return (
      <div key={f.id}>
        <div style={{ ...rowBase, paddingLeft: 6 + depth * 16, background: isSel ? '#1e293b' : 'transparent', color: isSel ? '#fff' : '#334155' }}>
          <span onClick={() => setExpanded(s => { const n = new Set(s); n.has(f.id) ? n.delete(f.id) : n.add(f.id); return n; })}
            style={{ width: 14, textAlign: 'center', color: '#94a3b8', visibility: kids.length ? 'visible' : 'hidden' }}>
            {isOpen ? '▾' : '▸'}
          </span>
          <span onClick={() => setSelected(f.id)} style={{ flex: 1, fontWeight: isSel ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            📁 {f.name} <span style={{ color: '#94a3b8', fontWeight: 400 }}>{docCount(f.id) ? `· ${docCount(f.id)}` : ''}</span>
          </span>
          <button title="Add subfolder" onClick={() => addFolder(f.id)} style={miniBtn}>＋</button>
          <button title="Rename" onClick={() => rename(f)} style={miniBtn}>✏️</button>
          <select title="Move to" value="" onChange={e => { const v = e.target.value; if (v !== '') reparent(f, v === 'root' ? null : Number(v)); e.target.value=''; }}
            style={{ ...miniBtn, width: 24, appearance: 'none' as const }}>
            <option value="">↔</option>
            <option value="root">Move to top level</option>
            {folders.filter(t => t.id !== f.id && !invalid.has(t.id)).map(t => (
              <option key={t.id} value={t.id}>Move into: {folderPath(t.id)}</option>
            ))}
          </select>
          <button title="Delete (must be empty)" onClick={() => removeFolder(f)} style={{ ...miniBtn, color: '#ef4444' }}>🗑</button>
        </div>
        {isOpen && kids.map(k => renderFolder(k, depth + 1))}
      </div>
    );
  }

  const inp: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9', fontSize: 14, boxSizing: 'border-box' };

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1080 }}>
      <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: '#0f172a' }}>📋 Company Documents</h1>
      <p style={{ margin: '0 0 22px', color: '#64748b', fontSize: 14 }}>Organise policies, procedures & resources into folders — visible to all staff.</p>

      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ── Folder tree ── */}
        <div style={{ width: 300, flexShrink: 0, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Folders</span>
            <button onClick={() => addFolder(null)} style={{ fontSize: 12, fontWeight: 700, color: '#2563eb', background: 'none', border: '1px solid #bfdbfe', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>＋ New folder</button>
          </div>
          <div onClick={() => setSelected('all')} style={{ ...rowBase, background: selected === 'all' ? '#1e293b' : 'transparent', color: selected === 'all' ? '#fff' : '#334155', fontWeight: selected === 'all' ? 700 : 500 }}>
            <span style={{ width: 14 }} />🗂️ All documents <span style={{ color: '#94a3b8', fontWeight: 400 }}>· {docs.length}</span>
          </div>
          {childrenOf(null).map(f => renderFolder(f, 0))}
          <div onClick={() => setSelected('unfiled')} style={{ ...rowBase, marginTop: 4, background: selected === 'unfiled' ? '#1e293b' : 'transparent', color: selected === 'unfiled' ? '#fff' : '#64748b' }}>
            <span style={{ width: 14 }} />📭 Unfiled <span style={{ color: '#94a3b8' }}>· {docs.filter(d => d.folder_id == null).length}</span>
          </div>
        </div>

        {/* ── Main panel ── */}
        <div style={{ flex: 1, minWidth: 340 }}>
          {/* Upload */}
          <div style={{ background: '#1e293b', borderRadius: 12, padding: 18, marginBottom: 22 }}>
            <h2 style={{ margin: '0 0 4px', color: '#fff', fontSize: 15, fontWeight: 700 }}>Upload to: {selected === 'unfiled' || selected === 'all' ? 'Unfiled' : folderPath(currentFolderId)}</h2>
            <p style={{ margin: '0 0 14px', color: '#64748b', fontSize: 12 }}>Select a folder on the left to upload into it.</p>
            <input style={{ ...inp, marginBottom: 10 }} placeholder="Title *" value={title} onChange={e => setTitle(e.target.value)} />
            <input style={{ ...inp, marginBottom: 10 }} placeholder="Description (optional)" value={description} onChange={e => setDesc(e.target.value)} />
            <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" style={{ color: '#94a3b8', fontSize: 13, marginBottom: 12, display: 'block' }} onChange={e => setFile(e.target.files?.[0] ?? null)} />
            {file && <div style={{ color: '#64748b', fontSize: 12, marginBottom: 10 }}>{file.name} · {formatSize(file.size)}</div>}
            {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 8 }}>⚠️ {error}</div>}
            {uploadMsg && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ color: '#22c55e', fontSize: 13, marginBottom: 8 }}>✅ {uploadMsg}</div>
                <button onClick={handleNotify} disabled={notifying} style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: notifying ? '#334155' : '#7c3aed', color: '#fff', fontSize: 13, fontWeight: 700, cursor: notifying ? 'wait' : 'pointer' }}>
                  {notifying ? 'Sending…' : '📣 Notify Field Staff'}
                </button>
                {notifyResult && <span style={{ marginLeft: 10, fontSize: 13, color: notifyResult.startsWith('✅') ? '#22c55e' : '#f59e0b' }}>{notifyResult}</span>}
              </div>
            )}
            <button onClick={handleUpload} disabled={!title.trim() || !file || uploading}
              style={{ padding: '11px 24px', borderRadius: 8, border: 'none', background: !title.trim() || !file || uploading ? '#334155' : '#3b82f6', color: '#fff', fontSize: 14, fontWeight: 700, cursor: uploading ? 'wait' : 'pointer' }}>
              {uploading ? 'Uploading…' : '⬆ Upload Document'}
            </button>
          </div>

          {/* Document list */}
          <h2 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: '#0f172a' }}>
            {loading ? 'Loading…' : `${visibleDocs.length} document${visibleDocs.length !== 1 ? 's' : ''} in ${selected === 'all' ? 'all folders' : selected === 'unfiled' ? 'Unfiled' : folderPath(currentFolderId)}`}
          </h2>
          {!loading && visibleDocs.length === 0 && <div style={{ color: '#94a3b8', padding: 24, textAlign: 'center' }}>No documents here.</div>}
          {visibleDocs.map(doc => (
            <div key={doc.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ fontSize: 26, flexShrink: 0 }}>{fileIcon(doc.filename)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 14 }}>{doc.title}</div>
                {doc.description && <div style={{ color: '#64748b', fontSize: 12 }}>{doc.description}</div>}
                <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 2 }}>
                  📁 {folderPath(doc.folder_id)} · {formatSize(doc.file_size)} · {formatDate(doc.created_at)}
                </div>
              </div>
              <select title="Move to folder" value={doc.folder_id ?? 'root'} onChange={e => moveDoc(doc, e.target.value === 'root' ? null : Number(e.target.value))}
                style={{ fontSize: 12, padding: '5px 6px', borderRadius: 6, border: '1px solid #cbd5e1', maxWidth: 160, flexShrink: 0 }}>
                <option value="root">Unfiled</option>
                {folders.map(t => <option key={t.id} value={t.id}>{folderPath(t.id)}</option>)}
              </select>
              <a href={getDocumentFileUrl(doc.id)} target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', fontSize: 13, fontWeight: 600, textDecoration: 'none', padding: '6px 12px', border: '1px solid #bfdbfe', borderRadius: 6, flexShrink: 0 }}>View</a>
              <button onClick={() => handleDelete(doc)} style={{ background: 'none', border: '1px solid #fecaca', color: '#ef4444', borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>Delete</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const miniBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 12,
  color: '#64748b', padding: '2px 3px', borderRadius: 4, flexShrink: 0,
};
