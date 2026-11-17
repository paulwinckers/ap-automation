/**
 * SafetyProgramAdmin — author / publish / version the Safety Program library.
 * Office, login required. /ops/safety-program
 */
import { useEffect, useMemo, useState } from 'react';
import {
  adminListSafetyDocs, adminGetSafetyDoc, createSafetyDoc, updateSafetyDoc,
  publishSafetyDoc, deleteSafetyDoc, type SafetyDoc, type SafetyDocInput,
} from '../lib/api';

const CATS = ['overview', 'manual', 'swp', 'pha', 'fhsp', 'signoff', 'policy'] as const;
const LAYER_NAME: Record<number, string> = {
  0: 'Overview', 1: 'L1 · Foundation', 2: 'L2 · SWPs', 3: 'L3 · PHA', 4: 'L4 · FHSP', 5: 'L5 · Talk',
};

const blank: SafetyDocInput = {
  title: '', category: 'swp', layer: 2, code: '', summary: '', html: '', version: '', field_visible: true,
};

export default function SafetyProgramAdmin() {
  const [docs, setDocs] = useState<SafetyDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<null | (SafetyDocInput & { id?: number; status?: string; version_count?: number })>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function refresh() {
    setLoading(true);
    try { setDocs(await adminListSafetyDocs()); } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  const grouped = useMemo(() => {
    const m = new Map<number, SafetyDoc[]>();
    docs.forEach(d => { const l = d.layer ?? 9; if (!m.has(l)) m.set(l, []); m.get(l)!.push(d); });
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [docs]);

  async function openEdit(id: number) {
    const d = await adminGetSafetyDoc(id);
    setEditing({ id: d.id, title: d.title, category: d.category, layer: d.layer ?? undefined,
      code: d.code ?? '', summary: d.summary ?? '', html: d.html ?? '', version: d.version ?? '',
      field_visible: d.field_visible, status: d.status, version_count: d.version_count });
  }

  async function save() {
    if (!editing) return;
    setBusy(true); setMsg('');
    try {
      const body: SafetyDocInput = {
        title: editing.title, category: editing.category, layer: editing.layer,
        code: editing.code || undefined, summary: editing.summary || undefined,
        html: editing.html, version: editing.version || undefined,
        field_visible: editing.field_visible, updated_by: 'Admin',
      };
      if (editing.id) { await updateSafetyDoc(editing.id, body); setMsg('Saved.'); }
      else { const r = await createSafetyDoc(body); setMsg('Created.'); setEditing({ ...editing, id: r.id }); }
      await refresh();
    } catch (e: any) { setMsg(`Error: ${e?.message || e}`); }
    finally { setBusy(false); }
  }

  async function togglePublish(d: SafetyDoc) {
    await publishSafetyDoc(d.id, d.status !== 'published');
    await refresh();
    if (editing?.id === d.id) setEditing({ ...editing, status: d.status !== 'published' ? 'published' : 'draft' });
  }

  async function remove(d: SafetyDoc) {
    if (!confirm(`Delete “${d.title}”? This removes it and its version history.`)) return;
    await deleteSafetyDoc(d.id);
    if (editing?.id === d.id) setEditing(null);
    await refresh();
  }

  const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14 };
  const label: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#6b7280', display: 'block', marginBottom: 3 };
  const btn: React.CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '18px 20px 60px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>🦺 Safety Program</h1>
        <span style={{ color: '#9ca3af', fontSize: 13 }}>{docs.length} documents</span>
        <button onClick={() => setEditing({ ...blank })} style={{ ...btn, marginLeft: 'auto', background: '#0f172a', color: '#fff', border: 'none' }}>+ New document</button>
      </div>

      {!editing && (
        <>
          {loading && <div style={{ color: '#9ca3af', padding: 30 }}>Loading…</div>}
          {!loading && grouped.map(([layer, group]) => (
            <div key={layer} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '4px 2px 8px' }}>
                {LAYER_NAME[layer] || 'Other'}
              </div>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                {group.map((d, i) => (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: i ? '1px solid #f1f5f9' : 'none' }}>
                    {d.code && <span style={{ background: '#eff6ff', color: '#1d4ed8', fontSize: 11, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>{d.code}</span>}
                    <span style={{ fontWeight: 700, color: '#0f172a', fontSize: 14.5, flex: 1, minWidth: 0 }}>{d.title}</span>
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>{d.category}{d.version ? ` · ${d.version}` : ''}</span>
                    <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 999,
                      background: d.status === 'published' ? '#dcfce7' : '#fef9c3', color: d.status === 'published' ? '#166534' : '#854d0e' }}>
                      {d.status === 'published' ? 'Published' : 'Draft'}
                    </span>
                    {!d.field_visible && <span title="Hidden from field app" style={{ fontSize: 11, color: '#b45309' }}>🚫 field</span>}
                    <button onClick={() => togglePublish(d)} style={{ ...btn, padding: '5px 10px', fontSize: 12 }}>{d.status === 'published' ? 'Unpublish' : 'Publish'}</button>
                    <button onClick={() => openEdit(d.id)} style={{ ...btn, padding: '5px 10px', fontSize: 12, color: '#1d4ed8' }}>Edit</button>
                    <button onClick={() => remove(d)} style={{ ...btn, padding: '5px 10px', fontSize: 12, color: '#b91c1c' }}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {editing && (
        <>
          <style>{PREVIEW_CSS}</style>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <button onClick={() => { setEditing(null); setMsg(''); }} style={{ ...btn }}>← Back to list</button>
            {editing.id && <span style={{ fontSize: 12, color: '#9ca3af' }}>
              {editing.status === 'published' ? 'Published' : 'Draft'}{editing.version_count ? ` · ${editing.version_count} prior version${editing.version_count === 1 ? '' : 's'}` : ''}
            </span>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
              {msg && <span style={{ fontSize: 13, color: msg.startsWith('Error') ? '#b91c1c' : '#16a34a' }}>{msg}</span>}
              <button onClick={save} disabled={busy || !editing.title || !editing.html}
                style={{ ...btn, background: '#0f172a', color: '#fff', border: 'none' }}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16 }}>
            {/* Form */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div><label style={label}>Title</label><input style={input} value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} /></div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1 }}><label style={label}>Category</label>
                  <select style={input} value={editing.category} onChange={e => setEditing({ ...editing, category: e.target.value })}>
                    {CATS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select></div>
                <div style={{ width: 90 }}><label style={label}>Layer</label>
                  <input style={input} type="number" min={0} max={5} value={editing.layer ?? ''} onChange={e => setEditing({ ...editing, layer: e.target.value === '' ? undefined : Number(e.target.value) })} /></div>
                <div style={{ width: 120 }}><label style={label}>Code</label>
                  <input style={input} placeholder="SWP-07" value={editing.code ?? ''} onChange={e => setEditing({ ...editing, code: e.target.value })} /></div>
                <div style={{ width: 110 }}><label style={label}>Version</label>
                  <input style={input} placeholder="v2.2" value={editing.version ?? ''} onChange={e => setEditing({ ...editing, version: e.target.value })} /></div>
              </div>
              <div><label style={label}>Summary (one line, shown in the index)</label><input style={input} value={editing.summary ?? ''} onChange={e => setEditing({ ...editing, summary: e.target.value })} /></div>
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 7, color: '#374151' }}>
                <input type="checkbox" checked={!!editing.field_visible} onChange={e => setEditing({ ...editing, field_visible: e.target.checked })} />
                Visible on the field app
              </label>
              <div><label style={label}>HTML body</label>
                <textarea style={{ ...input, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5, minHeight: 420, resize: 'vertical', lineHeight: 1.5 }}
                  value={editing.html} onChange={e => setEditing({ ...editing, html: e.target.value })} /></div>
            </div>
            {/* Preview */}
            <div>
              <label style={label}>Preview</label>
              <div className="sp-preview" style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 18px', background: '#fff', minHeight: 420, maxHeight: 640, overflowY: 'auto' }}
                dangerouslySetInnerHTML={{ __html: editing.html || '<p style="color:#9ca3af">Nothing to preview yet.</p>' }} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const PREVIEW_CSS = `
.sp-preview { color: #334155; font-size: 15px; line-height: 1.6; }
.sp-preview .lead { font-size: 16px; color: #0f172a; }
.sp-preview h2 { color: #0f172a; font-size: 17px; font-weight: 800; margin: 22px 0 7px; border-top: 1px solid #e5e7eb; padding-top: 15px; }
.sp-preview h2 small { color: #94a3b8; font-weight: 600; font-size: 13px; }
.sp-preview h3 { color: #1e293b; font-size: 15px; font-weight: 800; margin: 16px 0 5px; }
.sp-preview p { margin: 0 0 11px; }
.sp-preview ul, .sp-preview ol { margin: 0 0 13px; padding-left: 20px; }
.sp-preview li { margin: 0 0 6px; }
.sp-preview strong { color: #0f172a; }
.sp-preview a { color: #2563eb; }
.sp-preview table { width: 100%; border-collapse: collapse; margin: 6px 0 15px; font-size: 13px; }
.sp-preview th, .sp-preview td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; vertical-align: top; }
.sp-preview th { background: #f8fafc; font-weight: 700; }
.sp-preview .footer-note { color: #94a3b8; font-size: 12.5px; border-top: 1px solid #e5e7eb; padding-top: 12px; margin-top: 20px; }
`;
