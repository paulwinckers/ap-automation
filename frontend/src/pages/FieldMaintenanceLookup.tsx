/**
 * FieldMaintenanceLookup.tsx — Maintenance contract search / job list.
 * Route: /field/maintenance  (no oppId)
 *
 * Loads all active maintenance contracts and lets the user search by
 * property or job name. Tap a card to open the contract page.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const API = import.meta.env.VITE_API_URL ?? '';

interface Contract {
  opp_id:       number;
  opp_name:     string;
  property:     string;
  division:     string;
  status:       string;
  opp_type:     string;   // 'contract' | 'work_order'
  all_done:     boolean;
  hrs_est:      number;
  hrs_act:      number;
  ticket_count: number;
  latest_date:  string;
}

interface PropertyGroup {
  key:          string;
  contracts:    Contract[];
  hrs_est:      number;
  hrs_act:      number;
  ticket_count: number;
  latest_date:  string;
  all_done:     boolean;
  division:     string;
}

function groupByProperty(contracts: Contract[]): PropertyGroup[] {
  const map = new Map<string, Contract[]>();
  for (const c of contracts) {
    const key = (c.property || c.opp_name).trim();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(c);
  }
  const groups: PropertyGroup[] = [];
  for (const [key, list] of map.entries()) {
    groups.push({
      key,
      contracts:    list,
      hrs_est:      list.reduce((s, c) => s + c.hrs_est, 0),
      hrs_act:      list.reduce((s, c) => s + c.hrs_act, 0),
      ticket_count: list.reduce((s, c) => s + c.ticket_count, 0),
      latest_date:  list.map(c => c.latest_date).filter(Boolean).sort().reverse()[0] || '',
      all_done:     list.every(c => c.all_done),
      division:     list[0]?.division || '',
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
        <div style={{ height: '100%', width: `${pct}%`, background: over ? '#ef4444' : '#0369a1', borderRadius: 2, transition: 'width .3s' }} />
      </div>
    </div>
  );
}

function PropertyCard({ group, onSelect }: { group: PropertyGroup; onSelect: (c: Contract) => void }) {
  const multi = group.contracts.length > 1;
  const isDone = group.all_done;
  const badgeBg   = isDone ? '#f3f4f6' : '#dbeafe';
  const badgeText = isDone ? '#6b7280' : '#1d4ed8';
  const dot       = isDone ? '#9ca3af' : '#2563eb';

  return (
    <div style={S.card}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.propName}>{group.key}</div>
          {group.division && <div style={S.propSub}>{group.division}</div>}
        </div>
        <span style={{ ...S.badge, background: badgeBg, color: badgeText }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, display: 'inline-block', marginRight: 5 }} />
          {isDone ? 'Complete' : 'Active'}
        </span>
      </div>

      <HoursBar est={group.hrs_est} act={group.hrs_act} />

      <div style={S.meta}>
        <span>📋 {group.ticket_count} ticket{group.ticket_count !== 1 ? 's' : ''}</span>
        {group.latest_date && <span>📅 {fmtDate(group.latest_date)}</span>}
      </div>

      {/* Sub-contract rows when multiple opps at same property */}
      {multi ? (
        <div style={{ marginTop: 10, borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
          {group.contracts.map(c => {
            const cDone = c.all_done;
            const isWO  = c.opp_type === 'work_order';
            return (
              <div key={c.opp_id} style={S.subRow} onClick={() => onSelect(c)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{c.opp_name}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>
                    {c.hrs_act.toFixed(1)}h / {c.hrs_est.toFixed(1)}h est · {c.ticket_count} ticket{c.ticket_count !== 1 ? 's' : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {isWO && (
                    <span style={{ fontSize: 10, fontWeight: 700, background: '#fef3c7', color: '#92400e', borderRadius: 20, padding: '2px 7px' }}>
                      Work Order
                    </span>
                  )}
                  <span style={{ ...S.badge, background: cDone ? '#f3f4f6' : '#dbeafe', color: cDone ? '#6b7280' : '#1d4ed8', fontSize: 10 }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: cDone ? '#9ca3af' : '#2563eb', display: 'inline-block', marginRight: 4 }} />
                    {cDone ? 'Done' : 'Active'}
                  </span>
                  <span style={{ color: '#9ca3af', fontSize: 13 }}>›</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {group.contracts[0].opp_type === 'work_order' && (
            <span style={{ fontSize: 11, fontWeight: 700, background: '#fef3c7', color: '#92400e', borderRadius: 20, padding: '3px 9px' }}>
              🔧 Work Order
            </span>
          )}
          <div style={{ ...S.tapHint, marginTop: 0, marginLeft: 'auto' }} onClick={() => onSelect(group.contracts[0])}>
            Tap to open →
          </div>
        </div>
      )}
    </div>
  );
}

export default function FieldMaintenanceLookup() {
  const navigate = useNavigate();

  const [contracts, setContracts]         = useState<Contract[]>([]);
  const [loading, setLoading]             = useState(true);
  const [rebuilding, setRebuilding]       = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [filterText, setFilterText]       = useState('');

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const r = await fetch(`${API}/field/maintenance/lookup`);
        const d = await r.json();
        if (cancelled) return;

        if (d.contracts && d.contracts.length > 0) {
          // Got real data
          setContracts(d.contracts);
          setRebuilding(false);
          setLoading(false);
        } else if (d.loading) {
          // Backend is still building — show building state and retry in 3s
          setRebuilding(true);
          setLoading(false);
          setTimeout(() => { if (!cancelled) poll(); }, 3000);
        } else {
          // Genuinely empty
          setContracts([]);
          setRebuilding(false);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message || 'Could not reach the server.');
          setLoading(false);
        }
      }
    }

    poll();
    return () => { cancelled = true; };
  }, []);

  const q = filterText.trim().toLowerCase();
  const filtered = q
    ? contracts.filter(c =>
        (c.property || '').toLowerCase().includes(q) ||
        (c.opp_name || '').toLowerCase().includes(q) ||
        (c.division || '').toLowerCase().includes(q)
      )
    : contracts;

  const active    = filtered.filter(c => !c.all_done);
  const completed = filtered.filter(c => c.all_done);
  const activeGroups    = groupByProperty(active);
  const completedGroups = groupByProperty(completed);

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
        <div style={S.hsub}>Maintenance Contracts</div>
        <div style={S.hdesc}>Landscape management portal</div>
      </div>

      <div style={S.content}>

        {loading && <div style={S.loadingMsg}>Loading contracts…</div>}

        {rebuilding && !loading && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '14px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>⏳</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: '#92400e' }}>Building contract list…</div>
              <div style={{ fontSize: 12, color: '#b45309', marginTop: 2 }}>Loading from Aspire, usually takes 10–15 seconds. Checking again automatically.</div>
            </div>
          </div>
        )}

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: '#dc2626', marginBottom: 12 }}>
            {error}
          </div>
        )}

        {!loading && contracts.length > 0 && (
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 15, color: '#9ca3af', pointerEvents: 'none' }}>🔍</span>
            <input
              type="text"
              placeholder="Search contracts…"
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

        {!loading && !rebuilding && !error && active.length === 0 && completed.length === 0 && (
          <div style={S.emptyState}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>{q ? '🔍' : '🌿'}</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{q ? 'No matches' : 'No contracts found'}</div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              {q ? `No contracts match "${filterText}".` : 'No active maintenance contracts found.'}
            </div>
          </div>
        )}

        {activeGroups.map(g => (
          <PropertyCard key={g.key} group={g} onSelect={c =>
            navigate(c.opp_type === 'work_order' ? `/field/project/${c.opp_id}` : `/field/maintenance/${c.opp_id}`)
          } />
        ))}

        {!loading && completedGroups.length > 0 && (
          <button style={S.completedToggle} onClick={() => setShowCompleted(v => !v)}>
            {showCompleted ? '▲ Hide' : '▼ Show'} completed ({completed.length})
          </button>
        )}
        {showCompleted && completedGroups.map(g => (
          <PropertyCard key={g.key} group={g} onSelect={c =>
            navigate(c.opp_type === 'work_order' ? `/field/project/${c.opp_id}` : `/field/maintenance/${c.opp_id}`)
          } />
        ))}

      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  phone:      { maxWidth: 430, margin: '0 auto', minHeight: '100vh', background: '#f4f6f9', display: 'flex', flexDirection: 'column', fontFamily: "'DM Sans',sans-serif" },
  header:     { background: '#0f4c75', color: '#fff', padding: '16px 20px 20px', flexShrink: 0 },
  headerTop:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  hsub:       { fontSize: 20, fontWeight: 700, marginTop: 8 },
  hdesc:      { fontSize: 13, opacity: 0.7, marginTop: 2 },
  content:    { flex: 1, padding: '16px 16px 32px' },
  loadingMsg: { textAlign: 'center', padding: '24px 0', color: '#6b7280', fontSize: 14 },
  emptyState: { textAlign: 'center', padding: '40px 20px', color: '#374151' },
  card:       { background: '#fff', border: '1px solid #e2e6ed', borderRadius: 12, padding: 16, marginBottom: 10 },
  propName:   { fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 2 },
  propSub:    { fontSize: 12, color: '#6b7280' },
  badge:      { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 20, whiteSpace: 'nowrap', flexShrink: 0, marginLeft: 8, display: 'flex', alignItems: 'center' },
  meta:       { display: 'flex', gap: 14, marginTop: 8, fontSize: 12, color: '#6b7280' },
  tapHint:    { marginTop: 10, fontSize: 12, color: '#9ca3af', textAlign: 'right', cursor: 'pointer' },
  subRow:     { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid #f3f4f6', cursor: 'pointer' },
  completedToggle: { width: '100%', padding: '12px 16px', background: '#fff', border: '1px solid #e2e6ed', borderRadius: 10, marginBottom: 8, fontSize: 13, color: '#6b7280', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' },
};
