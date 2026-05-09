/**
 * FieldProjectLookup.tsx — "My Project" landing for construction leads.
 * Route: /field/project  (no oppId)
 *
 * 1. Loads the list of known leads from D1.
 * 2. Lead picks their name (remembered in localStorage).
 * 3. Fetches their most recent active project and navigates to /field/project/:oppId.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { myProjectLookup } from '../lib/api';

const LS_KEY = 'field_lead_name';

export default function FieldProjectLookup() {
  const navigate = useNavigate();

  const [leads, setLeads]         = useState<{ name: string; display: string }[]>([]);
  const [selected, setSelected]   = useState(() => localStorage.getItem(LS_KEY) || '');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [notFound, setNotFound]   = useState(false);

  // Load lead list on mount
  useEffect(() => {
    myProjectLookup().then(r => setLeads(r.leads)).catch(() => {});
  }, []);

  // If a name was remembered and leads are loaded, try to auto-navigate
  useEffect(() => {
    if (selected && leads.length > 0) {
      handleLookup(selected, /* auto */ true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads]);

  async function handleLookup(name: string, auto = false) {
    if (!name) return;
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const r = await myProjectLookup(name);
      if (r.project) {
        localStorage.setItem(LS_KEY, name);
        navigate(`/field/project/${r.project.opp_id}`, { replace: true });
      } else {
        if (!auto) setNotFound(true);
        setLoading(false);
      }
    } catch {
      if (!auto) setError('Could not reach the server. Try again.');
      setLoading(false);
    }
  }

  return (
    <div style={S.phone}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerTop}>
          <a href="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }} title="Home">
            <img src="/darios-logo.png" alt="Dario's" style={{ height: 32, filter: 'brightness(0) invert(1)' }} />
          </a>
        </div>
        <div style={S.hsub}>My Project</div>
        <div style={S.hdesc}>Construction project dashboard</div>
      </div>

      <div style={S.content}>
        <div style={S.card}>
          <div style={S.ctitle}>Who are you?</div>
          <p style={S.hint}>Select your name to open your project page.</p>

          {leads.length === 0 ? (
            <div style={S.empty}>Loading leads…</div>
          ) : (
            <select
              style={S.sel}
              value={selected}
              onChange={e => {
                setSelected(e.target.value);
                setNotFound(false);
                setError(null);
              }}
            >
              <option value="">Select your name…</option>
              {leads.map(l => (
                <option key={l.name} value={l.name}>{l.display}</option>
              ))}
            </select>
          )}

          {notFound && (
            <div style={S.warn}>
              No active project found for <strong>{selected}</strong>. Ask your manager to set up your check-in.
            </div>
          )}

          {error && <div style={S.err}>{error}</div>}

          {selected && (
            <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
              Not you?{' '}
              <button
                style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: 11, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}
                onClick={() => { setSelected(''); localStorage.removeItem(LS_KEY); setNotFound(false); }}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Bottom bar */}
      <div style={S.bar}>
        <button
          style={{ ...S.btn, opacity: selected && !loading ? 1 : 0.4 }}
          disabled={!selected || loading}
          onClick={() => handleLookup(selected)}
        >
          {loading ? 'Opening project…' : 'Open My Project →'}
        </button>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  phone:     { maxWidth: 430, margin: '0 auto', minHeight: '100vh', background: '#f4f6f9', display: 'flex', flexDirection: 'column', fontFamily: "'DM Sans',sans-serif" },
  header:    { background: '#1e3a2f', color: '#fff', padding: '16px 20px 20px', flexShrink: 0 },
  headerTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  hsub:      { fontSize: 20, fontWeight: 700, marginTop: 8 },
  hdesc:     { fontSize: 13, opacity: 0.7, marginTop: 2 },
  content:   { flex: 1, padding: '20px 20px 0' },
  card:      { background: '#fff', border: '1px solid #e2e6ed', borderRadius: 12, padding: 20 },
  ctitle:    { fontSize: 13, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 },
  hint:      { fontSize: 13, color: '#6b7280', margin: '0 0 16px' },
  sel:       { width: '100%', padding: '14px 12px', border: '1.5px solid #e2e6ed', borderRadius: 10, fontSize: 15, color: '#1a1d23', background: '#fff', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' },
  empty:     { color: '#9ca3af', fontSize: 13, padding: '12px 0' },
  warn:      { marginTop: 12, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#92400e', lineHeight: 1.5 },
  err:       { marginTop: 12, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#dc2626' },
  bar:       { padding: '16px 20px', background: '#fff', borderTop: '1px solid #e2e6ed', flexShrink: 0 },
  btn:       { width: '100%', padding: 16, background: '#1e3a2f', color: '#fff', border: 'none', borderRadius: 10, fontSize: 16, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', display: 'block' },
};
