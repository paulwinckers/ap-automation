/**
 * FieldProjectLookup.tsx — "My Project" landing for construction leads.
 * Route: /field/project  (no oppId)
 *
 * 1. Loads the list of known leads from D1.
 * 2. Lead picks their name (remembered in localStorage).
 * 3. Shows all opportunities where they are crew leader (past year + future).
 * 4. They tap a project to open the permanent /field/project/:oppId page.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { myProjectLookup, getAspireEmployees } from '../lib/api';

const LS_KEY = 'field_lead_name';

interface Project {
  opp_id:       number;
  opp_name:     string;
  property:     string;
  status:       string;
  hrs_est:      number;
  hrs_act:      number;
  ticket_count: number;
  latest_date:  string;
}

const STATUS_COLOR: Record<string, { bg: string; text: string; dot: string }> = {
  'in progress': { bg: '#dcfce7', text: '#15803d', dot: '#16a34a' },
  'active':      { bg: '#dcfce7', text: '#15803d', dot: '#16a34a' },
  'scheduled':   { bg: '#dbeafe', text: '#1d4ed8', dot: '#2563eb' },
  'complete':    { bg: '#f3f4f6', text: '#6b7280', dot: '#9ca3af' },
  'completed':   { bg: '#f3f4f6', text: '#6b7280', dot: '#9ca3af' },
};

function statusStyle(s: string) {
  return STATUS_COLOR[(s || '').toLowerCase()] || { bg: '#fef9c3', text: '#854d0e', dot: '#ca8a04' };
}

function fmtDate(d: string) {
  if (!d) return '';
  try {
    return new Date(d + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return d; }
}

function HoursBar({ est, act }: { est: number; act: number }) {
  const pct = est > 0 ? Math.min((act / est) * 100, 100) : 0;
  const over = est > 0 && act > est;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280', marginBottom: 3 }}>
        <span>{act.toFixed(1)}h actual</span>
        <span>{est.toFixed(1)}h est</span>
      </div>
      <div style={{ height: 4, background: '#e5e7eb', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: over ? '#ef4444' : '#16a34a', borderRadius: 2, transition: 'width .3s' }} />
      </div>
    </div>
  );
}

export default function FieldProjectLookup() {
  const navigate = useNavigate();

  const [employees, setEmployees]   = useState<{ name: string }[]>([]);
  const [empsLoading, setEmpsLoading] = useState(true);
  const [selected, setSelected]     = useState(() => localStorage.getItem(LS_KEY) || '');
  const [projects, setProjects]     = useState<Project[]>([]);
  const [loading, setLoading]       = useState(false);
  const [searched, setSearched]     = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Load employee list from Aspire on mount
  useEffect(() => {
    getAspireEmployees()
      .then(list => {
        const sorted = list
          .map(e => ({ name: e.FullName }))
          .filter(e => e.name)
          .sort((a, b) => a.name.localeCompare(b.name));
        setEmployees(sorted);
      })
      .catch(() => {})
      .finally(() => setEmpsLoading(false));
  }, []);

  // Auto-search if a name was remembered and employees loaded
  useEffect(() => {
    if (selected && employees.length > 0) {
      runLookup(selected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees]);

  const activeName = selected;

  async function runLookup(name: string) {
    if (!name) return;
    setLoading(true);
    setSearched(false);
    setSearchError(null);
    try {
      const r = await myProjectLookup(name);
      setProjects(r.projects || []);
      setSearched(true);
      localStorage.setItem(LS_KEY, name);
    } catch (e: unknown) {
      setSearchError((e as Error).message || 'Could not reach the server. Try again.');
      setProjects([]);
      setSearched(false);
    } finally {
      setLoading(false);
    }
  }

  function handleGo() {
    runLookup(activeName);
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
        <div style={S.hsub}>My Projects</div>
        <div style={S.hdesc}>Construction project dashboard</div>
      </div>

      <div style={S.content}>

        {/* Name picker */}
        <div style={S.card}>
          <div style={S.ctitle}>Who are you?</div>

          {empsLoading ? (
            <div style={S.empty}>Loading employees…</div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                style={{ ...S.sel, flex: 1 }}
                value={selected}
                onChange={e => { setSelected(e.target.value); setProjects([]); setSearched(false); }}
              >
                <option value="">Select your name…</option>
                {employees.map(e => (
                  <option key={e.name} value={e.name}>{e.name}</option>
                ))}
              </select>
              <button
                style={{ ...S.goBtn, opacity: activeName && !loading ? 1 : 0.4 }}
                disabled={!activeName || loading}
                onClick={handleGo}
              >
                {loading ? '…' : 'Go'}
              </button>
            </div>
          )}

          {selected && (
            <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
              Not you?{' '}
              <button
                style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: 11, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}
                onClick={() => { setSelected(''); localStorage.removeItem(LS_KEY); setProjects([]); setSearched(false); }}
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {/* Project list */}
        {loading && (
          <div style={S.loadingMsg}>Loading projects…</div>
        )}

        {searchError && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: '#dc2626', marginBottom: 12 }}>
            {searchError}
          </div>
        )}

        {searched && !loading && !searchError && projects.length === 0 && (
          <div style={S.emptyState}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🏗️</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>No projects found</div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>No work tickets assigned to {selected} in the past year.</div>
          </div>
        )}

        {projects.map(p => {
          const ss = statusStyle(p.status);
          return (
            <div
              key={p.opp_id}
              style={S.projectCard}
              onClick={() => navigate(`/field/project/${p.opp_id}`)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={S.projName}>{p.property || p.opp_name}</div>
                  {p.property && p.opp_name !== p.property && (
                    <div style={S.projSub}>{p.opp_name}</div>
                  )}
                </div>
                <span style={{ ...S.badge, background: ss.bg, color: ss.text }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: ss.dot, display: 'inline-block', marginRight: 5 }} />
                  {p.status || 'Unknown'}
                </span>
              </div>

              <HoursBar est={p.hrs_est} act={p.hrs_act} />

              <div style={S.projMeta}>
                <span>📋 {p.ticket_count} ticket{p.ticket_count !== 1 ? 's' : ''}</span>
                {p.latest_date && <span>📅 {fmtDate(p.latest_date)}</span>}
              </div>

              <div style={S.tapHint}>Tap to open →</div>
            </div>
          );
        })}

      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  phone:      { maxWidth: 430, margin: '0 auto', minHeight: '100vh', background: '#f4f6f9', display: 'flex', flexDirection: 'column', fontFamily: "'DM Sans',sans-serif" },
  header:     { background: '#1e3a2f', color: '#fff', padding: '16px 20px 20px', flexShrink: 0 },
  headerTop:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  hsub:       { fontSize: 20, fontWeight: 700, marginTop: 8 },
  hdesc:      { fontSize: 13, opacity: 0.7, marginTop: 2 },
  content:    { flex: 1, padding: '16px 16px 32px' },
  card:       { background: '#fff', border: '1px solid #e2e6ed', borderRadius: 12, padding: 16, marginBottom: 12 },
  ctitle:     { fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 },
  sel:        { padding: '12px 10px', border: '1.5px solid #e2e6ed', borderRadius: 8, fontSize: 15, color: '#1a1d23', background: '#fff', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' },
  goBtn:      { padding: '12px 18px', background: '#1e3a2f', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  empty:      { color: '#9ca3af', fontSize: 13 },
  loadingMsg: { textAlign: 'center', padding: '24px 0', color: '#6b7280', fontSize: 14 },
  emptyState: { textAlign: 'center', padding: '40px 20px', color: '#374151' },
  projectCard: {
    background: '#fff', border: '1px solid #e2e6ed', borderRadius: 12, padding: 16,
    marginBottom: 10, cursor: 'pointer',
    transition: 'box-shadow .15s, border-color .15s',
  },
  projName:   { fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 2 },
  projSub:    { fontSize: 12, color: '#6b7280' },
  badge:      { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 20, whiteSpace: 'nowrap', flexShrink: 0, marginLeft: 8, display: 'flex', alignItems: 'center' },
  projMeta:   { display: 'flex', gap: 14, marginTop: 8, fontSize: 12, color: '#6b7280' },
  tapHint:    { marginTop: 10, fontSize: 12, color: '#9ca3af', textAlign: 'right' },
};
