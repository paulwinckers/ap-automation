/**
 * FieldSafetyProgram — the published OH&S Safety Program, readable & searchable by crew.
 * Public, no login required. /field/safety-program
 *
 * Loads every published safety doc once (with HTML) and searches client-side, so it keeps
 * working on a flaky signal after first load.
 */
import { useEffect, useMemo, useState } from 'react';
import { listSafetyProgram, type SafetyDoc } from '../lib/api';

const BG = '#0f172a';
const CARD = '#1e293b';

const LAYER_META: Record<number, { name: string; icon: string }> = {
  0: { name: 'Overview', icon: '🧭' },
  1: { name: 'Layer 1 · Program Foundation', icon: '📘' },
  2: { name: 'Layer 2 · Safe Work Procedures', icon: '🧰' },
  3: { name: 'Layer 3 · Project Hazard Assessment', icon: '⚠️' },
  4: { name: 'Layer 4 · Field Hazard & Safety Plan', icon: '📋' },
  5: { name: 'Layer 5 · Daily Safety Talk', icon: '🗣️' },
};
const CAT_LABEL: Record<string, string> = {
  overview: 'Overview', manual: 'Manual', swp: 'SWP', pha: 'PHA', fhsp: 'FHSP',
  signoff: 'Sign-Off', policy: 'Policy',
};

function stripHtml(html: string): string {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
}
function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** A snippet of plain text around the first match, with the match wrapped in <mark>. */
function snippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 160) + (text.length > 160 ? '…' : '');
  const start = Math.max(0, i - 70);
  const slice = text.slice(start, i + q.length + 110);
  const safe = slice.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  return (start > 0 ? '…' : '') + safe.replace(new RegExp(escapeRe(q), 'ig'), m => `<mark>${m}</mark>`) + '…';
}

export default function FieldSafetyProgram() {
  const [docs, setDocs] = useState<SafetyDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    listSafetyProgram()
      .then(setDocs)
      .catch(() => setError('Could not load the safety program. Please try again.'))
      .finally(() => setLoading(false));
  }, []);

  // Pre-strip plain text per doc for searching.
  const text = useMemo(() => {
    const m = new Map<number, string>();
    docs.forEach(d => m.set(d.id, [d.title, d.code, d.summary, stripHtml(d.html || '')].filter(Boolean).join(' ')));
    return m;
  }, [docs]);

  const open = openId != null ? docs.find(d => d.id === openId) || null : null;

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return docs.filter(d => (text.get(d.id) || '').toLowerCase().includes(term));
  }, [q, docs, text]);

  const layers = useMemo(() => {
    const byLayer = new Map<number, SafetyDoc[]>();
    docs.forEach(d => {
      const l = d.layer ?? 9;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(d);
    });
    return [...byLayer.entries()].sort((a, b) => a[0] - b[0]);
  }, [docs]);

  const wrap: React.CSSProperties = {
    minHeight: '100vh', background: BG,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', paddingBottom: 40,
  };

  // ── Reading view ──
  if (open) {
    return (
      <div style={wrap}>
        <style>{DOC_CSS}</style>
        <div style={{ background: CARD, padding: '16px 18px', position: 'sticky', top: 0, zIndex: 5, borderBottom: '1px solid #334155' }}>
          <button onClick={() => setOpenId(null)}
            style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: 15, cursor: 'pointer', padding: 0, marginBottom: 6 }}>
            ← All safety documents
          </button>
          <h1 style={{ margin: 0, color: '#fff', fontSize: 20, fontWeight: 800 }}>{open.title}</h1>
          <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>
            {[open.code, open.version && `Version ${open.version}`,
              open.updated_at && `Updated ${new Date(open.updated_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}`]
              .filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="sp-doc" style={{ padding: '18px 18px 60px', maxWidth: 820, margin: '0 auto' }}
          dangerouslySetInnerHTML={{ __html: open.html || '' }} />
      </div>
    );
  }

  // ── Index + search ──
  return (
    <div style={wrap}>
      <div style={{ background: CARD, padding: '20px 18px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <a href="/crew" style={{ color: '#64748b', fontSize: 20, textDecoration: 'none' }}>←</a>
          <h1 style={{ margin: 0, color: '#fff', fontSize: 20, fontWeight: 800, flex: 1 }}>🦺 Safety Program</h1>
        </div>
        <input
          value={q} onChange={e => setQ(e.target.value)} placeholder="Search procedures, hazards, PPE…"
          style={{
            width: '100%', boxSizing: 'border-box', background: '#0f172a', border: '1px solid #334155',
            borderRadius: 10, color: '#f1f5f9', fontSize: 15, padding: '11px 14px', outline: 'none',
          }} />
      </div>

      <div style={{ padding: '16px 16px 0' }}>
        {loading && <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>Loading…</div>}
        {error && <div style={{ color: '#ef4444', textAlign: 'center', padding: 40 }}>{error}</div>}
        {!loading && !error && docs.length === 0 && (
          <div style={{ color: '#64748b', textAlign: 'center', padding: 60 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🦺</div>No safety documents published yet.
          </div>
        )}

        {/* Search results */}
        {q.trim() && (
          <>
            <div style={{ color: '#64748b', fontSize: 12, fontWeight: 700, margin: '2px 2px 10px' }}>
              {results.length} result{results.length === 1 ? '' : 's'} for “{q.trim()}”
            </div>
            {results.map(d => (
              <div key={d.id} onClick={() => setOpenId(d.id)}
                style={{ background: CARD, borderRadius: 12, padding: '13px 15px', marginBottom: 10, border: '1px solid #334155', cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ background: '#0f172a', color: '#60a5fa', fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>
                    {d.code || CAT_LABEL[d.category] || 'DOC'}
                  </span>
                  <span style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 700 }}>{d.title}</span>
                </div>
                <div style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.5 }}
                  dangerouslySetInnerHTML={{ __html: snippet(text.get(d.id) || '', q.trim()) }} />
              </div>
            ))}
            {results.length === 0 && <div style={{ color: '#64748b', textAlign: 'center', padding: 30 }}>No matches.</div>}
          </>
        )}

        {/* Grouped index */}
        {!q.trim() && !loading && layers.map(([layer, group]) => {
          const meta = LAYER_META[layer] || { name: 'Other', icon: '📄' };
          return (
            <div key={layer} style={{ marginBottom: 18 }}>
              <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '4px 2px 10px' }}>
                {meta.icon} {meta.name}
              </div>
              {group.map(d => (
                <div key={d.id} onClick={() => setOpenId(d.id)}
                  style={{ background: CARD, borderRadius: 12, padding: '13px 15px', marginBottom: 10, border: '1px solid #334155', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {d.code && <span style={{ background: '#0f172a', color: '#60a5fa', fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 5 }}>{d.code}</span>}
                      <span style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 700 }}>{d.title}</span>
                    </div>
                    {d.summary && <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 3 }}>{d.summary}</div>}
                  </div>
                  <div style={{ color: '#3b82f6', fontSize: 18, flexShrink: 0 }}>→</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Styling for admin-authored HTML, tuned for reading on the dark field app.
const DOC_CSS = `
.sp-doc { color: #cbd5e1; font-size: 15.5px; line-height: 1.65; }
.sp-doc .lead { font-size: 16.5px; color: #e2e8f0; }
.sp-doc h2 { color: #fff; font-size: 18px; font-weight: 800; margin: 26px 0 8px; border-top: 1px solid #334155; padding-top: 18px; }
.sp-doc h2 small { color: #64748b; font-weight: 600; font-size: 13px; }
.sp-doc h3 { color: #e2e8f0; font-size: 15.5px; font-weight: 800; margin: 18px 0 6px; }
.sp-doc p { margin: 0 0 12px; }
.sp-doc ul, .sp-doc ol { margin: 0 0 14px; padding-left: 20px; }
.sp-doc li { margin: 0 0 7px; }
.sp-doc strong { color: #f1f5f9; }
.sp-doc a { color: #60a5fa; }
.sp-doc table { width: 100%; border-collapse: collapse; margin: 6px 0 16px; font-size: 13.5px; }
.sp-doc th, .sp-doc td { border: 1px solid #334155; padding: 7px 9px; text-align: left; vertical-align: top; }
.sp-doc th { background: #1e293b; color: #e2e8f0; font-weight: 700; }
.sp-doc .footer-note { color: #64748b; font-size: 12.5px; border-top: 1px solid #334155; padding-top: 14px; margin-top: 22px; }
.sp-doc mark { background: #fde047; color: #0f172a; border-radius: 2px; }
`;
