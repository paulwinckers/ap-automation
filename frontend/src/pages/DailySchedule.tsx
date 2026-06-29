/**
 * DailySchedule — high-level list of sites we're visiting on a day, pulled live
 * from Aspire scheduling. Grouped Division → Lead → Property, each site tagged
 * Maintenance (Contract) or Project (Work Order).
 * Route: /dashboards/schedule
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getDaySchedule, DaySchedule } from '../lib/api';

function ViewToggle({ active }: { active: 'day' | 'week' }) {
  const base: React.CSSProperties = { padding: '6px 16px', fontSize: 13, fontWeight: 700, textDecoration: 'none' };
  const on  = { ...base, background: '#2563eb', color: '#fff' };
  const off = { ...base, background: '#fff', color: '#374151', fontWeight: 600 as const };
  return (
    <div style={{ display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 8, overflow: 'hidden' }}>
      <Link to="/dashboards/schedule"      style={active === 'day'  ? on : off}>Day</Link>
      <Link to="/dashboards/schedule/week" style={active === 'week' ? on : off}>Week</Link>
    </div>
  );
}

// Local YYYY-MM-DD (avoids UTC shift from toISOString)
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return ymd(dt);
}
function prettyDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

const DIV_ICON: Record<string, string> = {
  'Construction':            '🏗️',
  'Residential Maintenance': '🏡',
  'Commercial Maintenance':  '🏢',
  'Irrigation/Lighting':     '💧',
  'Snow':                    '❄️',
};

function TypeBadge({ type }: { type: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    maintenance: { bg: '#dcfce7', fg: '#15803d', label: 'Maintenance' },
    project:     { bg: '#ede9fe', fg: '#6d28d9', label: 'Project' },
    other:       { bg: '#f1f5f9', fg: '#64748b', label: 'Other' },
  };
  const s = map[type] || map.other;
  return (
    <span style={{
      background: s.bg, color: s.fg, fontSize: 10, fontWeight: 700,
      padding: '2px 8px', borderRadius: 20, whiteSpace: 'nowrap', flexShrink: 0,
    }}>{s.label}</span>
  );
}

export default function DailySchedule() {
  const [date, setDate]       = useState<string>(ymd(new Date()));
  const [data, setData]       = useState<DaySchedule | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    getDaySchedule(date)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e?.message || 'Failed to load schedule'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date]);

  const isToday = date === ymd(new Date());

  return (
    <div style={{
      background: '#f8fafc', minHeight: '100vh',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      padding: '28px 28px 60px',
    }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h1 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 800, color: '#111827' }}>
              Daily Schedule
            </h1>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6b7280' }}>
              Sites we're visiting, by division &amp; lead — live from Aspire
            </p>
          </div>
          <ViewToggle active="day" />
        </div>

        {/* Date nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
          <button onClick={() => setDate(addDays(date, -1))} style={navBtn}>← Prev</button>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, fontFamily: 'inherit' }}
          />
          <button onClick={() => setDate(addDays(date, 1))} style={navBtn}>Next →</button>
          {!isToday && (
            <button onClick={() => setDate(ymd(new Date()))} style={{ ...navBtn, color: '#2563eb', borderColor: '#bfdbfe' }}>
              Today
            </button>
          )}
          <div style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginLeft: 4 }}>
            {prettyDate(date)}
          </div>
        </div>

        {/* Summary */}
        {data && !loading && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
            <Chip label="Sites"        value={data.summary.total_sites} />
            <Chip label="Maintenance"  value={data.summary.maintenance} color="#15803d" />
            <Chip label="Projects"     value={data.summary.project}      color="#6d28d9" />
            <Chip label="Crews"        value={data.divisions.reduce((s, d) => s + d.lead_count, 0)} />
          </div>
        )}

        {loading && <div style={{ color: '#6b7280', fontSize: 14, padding: '40px 0', textAlign: 'center' }}>Loading…</div>}
        {error && !loading && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 10, padding: '14px 16px', fontSize: 13 }}>
            {error}
          </div>
        )}
        {data && !loading && data.divisions.length === 0 && (
          <div style={{ color: '#6b7280', fontSize: 14, padding: '40px 0', textAlign: 'center' }}>
            No sites scheduled for this day.
          </div>
        )}

        {/* Divisions */}
        {data && !loading && data.divisions.map(div => (
          <div key={div.division} style={{ marginBottom: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 18 }}>{DIV_ICON[div.division] || '📍'}</span>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: '#111827' }}>{div.division}</h2>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>
                {div.site_count} site{div.site_count === 1 ? '' : 's'} · {div.lead_count} crew{div.lead_count === 1 ? '' : 's'}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
              {div.leads.map(ld => (
                <div key={ld.lead} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                  <div style={{
                    padding: '10px 14px', borderBottom: '1px solid #f1f5f9',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: '#fafafa',
                  }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: '#1f2937' }}>{ld.lead}</span>
                    <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600 }}>{ld.site_count}</span>
                  </div>
                  <div>
                    {ld.sites.map((s, i) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 14px',
                        borderTop: i > 0 ? '1px solid #f6f7f9' : undefined,
                      }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.opp_id
                            ? <a href={`/field/project/${s.opp_id}`} style={{ color: '#111827', textDecoration: 'none' }}
                                 onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                                 onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>
                                {s.property}
                              </a>
                            : s.property}
                        </span>
                        <TypeBadge type={s.type} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const navBtn: React.CSSProperties = {
  padding: '7px 12px', borderRadius: 8, border: '1px solid #d1d5db',
  background: '#fff', fontSize: 13, fontWeight: 600, color: '#374151',
  cursor: 'pointer', fontFamily: 'inherit',
};

function Chip({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 16px', textAlign: 'center', minWidth: 90 }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: color || '#111827' }}>{value}</div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>{label}</div>
    </div>
  );
}
