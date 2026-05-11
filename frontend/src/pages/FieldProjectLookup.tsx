/**
 * FieldProjectLookup.tsx — "My Project" landing for construction leads.
 * Route: /field/project  (no oppId)
 *
 * 1. Loads the list of known leads from D1.
 * 2. Lead picks their name (remembered in localStorage).
 * 3. Shows all opportunities where they are crew leader (past year + future),
 *    grouped by property so multiple jobs at the same site appear as one card.
 * 4. They tap a sub-project to open the permanent /field/project/:oppId page.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { myProjectLookup } from '../lib/api';

const LS_KEY = 'field_lead_name';

interface Project {
  opp_id:       number;
  opp_name:     string;
  property:     string;
  status:       string;
  all_done:     boolean;
  hrs_est:      number;
  hrs_act:      number;
  ticket_count: number;
  latest_date:  string;
  lead_name?:   string;
}

interface PropertyGroup {
  key:          string;       // property name (grouping key)
  projects:     Project[];
  hrs_est:      number;
  hrs_act:      number;
  ticket_count: number;
  latest_date:  string;
  all_done:     boolean;      // true only if every opp is done
  status:       string;       // most active status in the group
  lead_name?:   string;       // set when all projects in group share the same lead
}

const STATUS_COLOR: Record<string, { bg: string; text: string; dot: string }> = {
  'in production': { bg: '#dcfce7', text: '#15803d', dot: '#16a34a' },
  'in progress':   { bg: '#dcfce7', text: '#15803d', dot: '#16a34a' },
  'scheduled':     { bg: '#dcfce7', text: '#15803d', dot: '#16a34a' },
  'active':        { bg: '#dcfce7', text: '#15803d', dot: '#16a34a' },
  'won':           { bg: '#dcfce7', text: '#15803d', dot: '#16a34a' },
  'in queue':      { bg: '#dbeafe', text: '#1d4ed8', dot: '#2563eb' },
  'complete':      { bg: '#f3f4f6', text: '#6b7280', dot: '#9ca3af' },
  'completed':     { bg: '#f3f4f6', text: '#6b7280', dot: '#9ca3af' },
};

// Priority order for picking the "best" status to show on a grouped card
const STATUS_PRIORITY = [
  'in production', 'in progress', 'scheduled', 'active', 'won', 'in queue', 'complete', 'completed',
];

function statusStyle(s: string) {
  return STATUS_COLOR[(s || '').toLowerCase()] || { bg: '#fef9c3', text: '#854d0e', dot: '#ca8a04' };
}

function bestStatus(projects: Project[]): string {
  for (const s of STATUS_PRIORITY) {
    if (projects.some(p => (p.status || '').toLowerCase() === s)) {
      return projects.find(p => (p.status || '').toLowerCase() === s)!.status;
    }
  }
  return projects[0]?.status || 'Unknown';
}

function groupByProperty(projects: Project[]): PropertyGroup[] {
  const map = new Map<string, Project[]>();
  for (const p of projects) {
    const key = (p.property || p.opp_name).trim();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(p);
  }
  const groups: PropertyGroup[] = [];
  for (const [key, list] of map.entries()) {
    const leadNames = [...new Set(list.map(p => p.lead_name).filter(Boolean))];
    groups.push({
      key,
      projects:     list,
      hrs_est:      list.reduce((s, p) => s + p.hrs_est, 0),
      hrs_act:      list.reduce((s, p) => s + p.hrs_act, 0),
      ticket_count: list.reduce((s, p) => s + p.ticket_count, 0),
      latest_date:  list.map(p => p.latest_date).filter(Boolean).sort().reverse()[0] || '',
      all_done:     list.every(p => p.all_done),
      status:       bestStatus(list),
      lead_name:    leadNames.length === 1 ? leadNames[0] : leadNames.join(', '),
    });
  }
  return groups;
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

function PropertyCard({ group, onSelect }: { group: PropertyGroup; onSelect: (opp_id: number) => void }) {
  const ss  = statusStyle(group.status);
  const multi = group.projects.length > 1;

  return (
    <div style={S.projectCard}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.projName}>{group.key}</div>
          {!multi && group.projects[0].opp_name !== group.key && (
            <div style={S.projSub}>{group.projects[0].opp_name}</div>
          )}
          {group.lead_name && (
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>👷 {group.lead_name}</div>
          )}
        </div>
        <span style={{ ...S.badge, background: ss.bg, color: ss.text }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: ss.dot, display: 'inline-block', marginRight: 5 }} />
          {group.status || 'Unknown'}
        </span>
      </div>

      {/* Hours bar (combined) */}
      <HoursBar est={group.hrs_est} act={group.hrs_act} />

      {/* Meta */}
      <div style={S.projMeta}>
        <span>📋 {group.ticket_count} ticket{group.ticket_count !== 1 ? 's' : ''}</span>
        {group.latest_date && <span>📅 {fmtDate(group.latest_date)}</span>}
      </div>

      {/* Sub-project rows (when multiple opps at the same property) */}
      {multi ? (
        <div style={{ marginTop: 10, borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
          {group.projects.map(p => {
            const ps = statusStyle(p.status);
            return (
              <div
                key={p.opp_id}
                style={S.subRow}
                onClick={() => onSelect(p.opp_id)}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{p.opp_name}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>
                    {p.hrs_act.toFixed(1)}h / {p.hrs_est.toFixed(1)}h est · {p.ticket_count} ticket{p.ticket_count !== 1 ? 's' : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <span style={{ ...S.badge, background: ps.bg, color: ps.text, fontSize: 10 }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: ps.dot, display: 'inline-block', marginRight: 4 }} />
                    {p.status}
                  </span>
                  <span style={{ color: '#9ca3af', fontSize: 13 }}>›</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div
          style={S.tapHint}
          onClick={() => onSelect(group.projects[0].opp_id)}
        >
          Tap to open →
        </div>
      )}
    </div>
  );
}

export default function FieldProjectLookup() {
  const navigate = useNavigate();

  const [leads, setLeads]               = useState<{ name: string; display: string }[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(true);
  const SHOW_ALL_VALUE = '__all__';
  const [selected, setSelected]         = useState(() => localStorage.getItem(LS_KEY) || '');
  const [projects, setProjects]         = useState<Project[]>([]);
  const [loading, setLoading]           = useState(false);
  const [searched, setSearched]         = useState(false);
  const [searchError, setSearchError]   = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [filterText, setFilterText]     = useState('');

  const q = filterText.trim().toLowerCase();
  const filteredProjects = q
    ? projects.filter(p =>
        (p.property   || '').toLowerCase().includes(q) ||
        (p.opp_name   || '').toLowerCase().includes(q) ||
        (p.lead_name  || '').toLowerCase().includes(q)
      )
    : projects;

  const activeProjects    = filteredProjects.filter(p => !p.all_done);
  const completedProjects = filteredProjects.filter(p =>  p.all_done);

  const activeGroups    = groupByProperty(activeProjects);
  const completedGroups = groupByProperty(completedProjects);

  // Load lead list from D1 on mount
  useEffect(() => {
    myProjectLookup()
      .then(r => setLeads(r.leads))
      .catch(() => {})
      .finally(() => setLeadsLoading(false));
  }, []);

  // Auto-search if a name was remembered and leads loaded
  useEffect(() => {
    if (selected && leads.length > 0) {
      runLookup(selected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads]);

  async function runLookup(name: string) {
    if (!name) return;
    setLoading(true);
    setSearched(false);
    setSearchError(null);
    try {
      const isAll = name === SHOW_ALL_VALUE;
      const r = await myProjectLookup(isAll ? undefined : name, isAll);
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

  return (
    <div style={S.phone}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerTop}>
          <a href="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }} title="Home">
            <img src="/darios-logo.png" alt="Dario's" style={{ height: 32, filter: 'brightness(0) invert(1)' }} />
          </a>
          <a href="/" style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,0.15)', borderRadius: 20, padding: '5px 12px' }}>
            ← Home
          </a>
        </div>
        <div style={S.hsub}>My Projects</div>
        <div style={S.hdesc}>Construction project dashboard</div>
      </div>

      <div style={S.content}>

        {/* Name picker */}
        <div style={S.card}>
          <div style={S.ctitle}>Who are you?</div>

          {leadsLoading ? (
            <div style={S.empty}>Loading…</div>
          ) : leads.length === 0 ? (
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              No crew leads set up yet — ask your manager to add you via the Leads panel.
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                style={{ ...S.sel, flex: 1 }}
                value={selected}
                onChange={e => { setSelected(e.target.value); setProjects([]); setSearched(false); }}
              >
                <option value="">Select your name…</option>
                <option value={SHOW_ALL_VALUE}>👥 Show All Projects</option>
                {leads.map(l => (
                  <option key={l.name} value={l.name}>{l.display}</option>
                ))}
              </select>
              <button
                style={{ ...S.goBtn, opacity: selected && !loading ? 1 : 0.4 }}
                disabled={!selected || loading}
                onClick={() => runLookup(selected)}
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

        {/* Loading */}
        {loading && <div style={S.loadingMsg}>Loading projects…</div>}

        {/* Error */}
        {searchError && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: '#dc2626', marginBottom: 12 }}>
            {searchError}
          </div>
        )}

        {/* Search / filter input — shown once projects are loaded */}
        {searched && !loading && projects.length > 0 && (
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 15, color: '#9ca3af', pointerEvents: 'none' }}>🔍</span>
            <input
              type="text"
              placeholder="Search projects…"
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '11px 36px 11px 36px',
                border: '1.5px solid #e2e6ed', borderRadius: 10,
                fontSize: 14, color: '#1a1d23', background: '#fff',
                fontFamily: 'inherit', outline: 'none',
              }}
            />
            {filterText && (
              <button
                onClick={() => setFilterText('')}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', fontSize: 16, color: '#9ca3af', cursor: 'pointer', padding: 4 }}
              >×</button>
            )}
          </div>
        )}

        {/* Empty state */}
        {searched && !loading && !searchError && activeProjects.length === 0 && completedProjects.length === 0 && (
          <div style={S.emptyState}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>{q ? '🔍' : '🏗️'}</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{q ? 'No matches' : 'No projects found'}</div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              {q
                ? `No projects match "${filterText}".`
                : selected === SHOW_ALL_VALUE
                  ? 'No active construction projects found.'
                  : `No active construction work tickets assigned to ${selected}.`}
            </div>
          </div>
        )}

        {/* Active property groups */}
        {activeGroups.map(g => (
          <PropertyCard key={g.key} group={g} onSelect={id => navigate(`/field/project/${id}`)} />
        ))}

        {/* Completed toggle */}
        {searched && !loading && completedGroups.length > 0 && (
          <button style={S.completedToggle} onClick={() => setShowCompleted(v => !v)}>
            {showCompleted ? '▲ Hide' : '▼ Show'} completed jobs ({completedProjects.length})
          </button>
        )}
        {showCompleted && completedGroups.map(g => (
          <PropertyCard key={g.key} group={g} onSelect={id => navigate(`/field/project/${id}`)} />
        ))}

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
    marginBottom: 10,
  },
  projName:   { fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 2 },
  projSub:    { fontSize: 12, color: '#6b7280' },
  badge:      { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 20, whiteSpace: 'nowrap', flexShrink: 0, marginLeft: 8, display: 'flex', alignItems: 'center' },
  projMeta:   { display: 'flex', gap: 14, marginTop: 8, fontSize: 12, color: '#6b7280' },
  tapHint:    { marginTop: 10, fontSize: 12, color: '#9ca3af', textAlign: 'right', cursor: 'pointer' },
  subRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '9px 0', borderBottom: '1px solid #f3f4f6',
    cursor: 'pointer',
  },
  completedToggle: { width: '100%', padding: '12px 16px', background: '#fff', border: '1px solid #e2e6ed', borderRadius: 10, marginBottom: 8, fontSize: 13, color: '#6b7280', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' },
};
