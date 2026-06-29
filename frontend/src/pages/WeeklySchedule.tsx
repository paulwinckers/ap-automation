/**
 * WeeklySchedule — the daily schedule spread across the 5 workdays (Mon–Fri).
 * Same content as DailySchedule (Division → Lead → Property, tagged
 * Maintenance/Project), laid out as a week grid.
 * Route: /dashboards/schedule/week
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getWeekSchedule, emailWeekSchedule, WeekSchedule, ScheduleSite } from '../lib/api';

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mondayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const wd = (dt.getDay() + 6) % 7; // 0 = Monday
  dt.setDate(dt.getDate() - wd);
  return ymd(dt);
}
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return ymd(dt);
}
function dayLabel(date: string): { dow: string; dom: number } {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return { dow: dt.toLocaleDateString(undefined, { weekday: 'short' }), dom: d };
}
function weekRangeLabel(days: string[]): string {
  if (days.length === 0) return '';
  const fmt = (s: string, withYear = false) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined,
      withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
  };
  return `${fmt(days[0])} – ${fmt(days[days.length - 1], true)}`;
}

const DIV_ICON: Record<string, string> = {
  'Construction':            '🏗️',
  'Residential Maintenance': '🏡',
  'Commercial Maintenance':  '🏢',
  'Irrigation/Lighting':     '💧',
  'Snow':                    '❄️',
};

const TYPE_DOT: Record<string, string> = {
  maintenance: '#16a34a',
  project:     '#7c3aed',
  other:       '#94a3b8',
};

function SiteRow({ s }: { s: ScheduleSite }) {
  const typeLabel = s.type === 'maintenance' ? 'Maintenance' : s.type === 'project' ? 'Project' : 'Other';
  const readyLabel = s.type === 'project' ? `  ·  ${s.ready ? 'Ready' : 'Not ready'}${s.stage ? ` (${s.stage})` : ''}` : '';
  const title = `${s.property} — ${typeLabel}${readyLabel}`;
  const inner = (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: TYPE_DOT[s.type], flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.property}</span>
      {s.type === 'project' && (
        <span style={{ flexShrink: 0, fontWeight: 700, color: s.ready ? '#15803d' : '#b45309' }}>
          {s.ready ? '✓' : '⏳'}
        </span>
      )}
    </span>
  );
  return (
    <div title={title} style={{ fontSize: 12, color: '#1f2937', padding: '2px 0' }}>
      {s.opp_id
        ? <Link to={`/field/project/${s.opp_id}`} style={{ color: '#1f2937', textDecoration: 'none' }}
                onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>
            {inner}
          </Link>
        : inner}
    </div>
  );
}

const navBtn: React.CSSProperties = {
  padding: '7px 12px', borderRadius: 8, border: '1px solid #d1d5db',
  background: '#fff', fontSize: 13, fontWeight: 600, color: '#374151',
  cursor: 'pointer', fontFamily: 'inherit',
};

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

function Chip({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 16px', textAlign: 'center', minWidth: 90 }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: color || '#111827' }}>{value}</div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>{label}</div>
    </div>
  );
}

export default function WeeklySchedule() {
  const [weekStart, setWeekStart] = useState<string>(mondayOf(ymd(new Date())));
  const [data, setData]           = useState<WeekSchedule | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [emailState, setEmailState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [emailMsg, setEmailMsg]     = useState('');

  // reset the email button when the viewed week changes
  useEffect(() => { setEmailState('idle'); setEmailMsg(''); }, [weekStart]);

  async function handleEmail() {
    if (emailState === 'sending') return;
    if (!window.confirm('Email this week’s schedule now?')) return;
    setEmailState('sending');
    setEmailMsg('');
    try {
      const r = await emailWeekSchedule(weekStart);
      setEmailState('sent');
      setEmailMsg(`Sent to ${r.recipients.join(', ')}`);
    } catch (e: any) {
      setEmailState('error');
      setEmailMsg(e?.message || 'Send failed');
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    getWeekSchedule(weekStart)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e?.message || 'Failed to load schedule'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [weekStart]);

  const today      = ymd(new Date());
  const thisMonday = mondayOf(today);
  const days       = data?.days ?? [];

  const COL_LEAD = 150;
  const COL_DAY  = 165;

  return (
    <div style={{
      background: '#f8fafc', minHeight: '100vh',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      padding: '28px 28px 60px',
    }}>
      <div style={{ maxWidth: 1300, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h1 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 800, color: '#111827' }}>
              Weekly Schedule
            </h1>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6b7280' }}>
              Mon–Fri sites by division &amp; lead — live from Aspire
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
            <ViewToggle active="week" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {emailMsg && (
                <span style={{ fontSize: 12, color: emailState === 'error' ? '#b91c1c' : '#15803d' }}>
                  {emailState === 'sent' ? '✓ ' : ''}{emailMsg}
                </span>
              )}
              <button
                onClick={handleEmail}
                disabled={emailState === 'sending' || loading || !data || data.divisions.length === 0}
                style={{
                  padding: '7px 14px', borderRadius: 8, border: '1px solid #2563eb',
                  background: emailState === 'sending' ? '#93c5fd' : '#2563eb', color: '#fff',
                  fontSize: 13, fontWeight: 700, cursor: emailState === 'sending' ? 'default' : 'pointer',
                  fontFamily: 'inherit', opacity: (!data || data.divisions.length === 0) ? 0.5 : 1,
                }}
              >
                {emailState === 'sending' ? 'Sending…' : '✉ Email this week'}
              </button>
            </div>
          </div>
        </div>

        {/* Week nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
          <button onClick={() => setWeekStart(addDays(weekStart, -7))} style={navBtn}>← Prev week</button>
          <button onClick={() => setWeekStart(addDays(weekStart, 7))} style={navBtn}>Next week →</button>
          {weekStart !== thisMonday && (
            <button onClick={() => setWeekStart(thisMonday)} style={{ ...navBtn, color: '#2563eb', borderColor: '#bfdbfe' }}>
              This week
            </button>
          )}
          <div style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginLeft: 4 }}>
            {days.length ? weekRangeLabel(days) : weekRangeLabel([weekStart, addDays(weekStart, 4)])}
          </div>
        </div>

        {/* Summary */}
        {data && !loading && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
            <Chip label="Sites"       value={data.summary.total_sites} />
            <Chip label="Maintenance" value={data.summary.maintenance} color="#15803d" />
            <Chip label="Projects"    value={data.summary.project}      color="#6d28d9" />
            <Chip label="Proj. ready" value={data.summary.project_ready ?? 0} color="#15803d" />
            <Chip label="Crews"       value={data.divisions.reduce((s, d) => s + d.lead_count, 0)} />
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
            No sites scheduled this week.
          </div>
        )}

        {/* Divisions */}
        {data && !loading && data.divisions.map(div => (
          <div key={div.division} style={{ marginBottom: 26 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 18 }}>{DIV_ICON[div.division] || '📍'}</span>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: '#111827' }}>{div.division}</h2>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>
                {div.site_count} visit{div.site_count === 1 ? '' : 's'} · {div.lead_count} crew{div.lead_count === 1 ? '' : 's'}
              </span>
            </div>

            <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: COL_LEAD + COL_DAY * 5 }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e5e7eb' }}>
                    <th style={{ width: COL_LEAD, minWidth: COL_LEAD, textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', position: 'sticky', left: 0, background: '#f8fafc', zIndex: 1 }}>
                      Lead
                    </th>
                    {days.map(dt => {
                      const { dow, dom } = dayLabel(dt);
                      const isToday = dt === today;
                      return (
                        <th key={dt} style={{
                          width: COL_DAY, minWidth: COL_DAY, textAlign: 'left', padding: '8px 12px',
                          fontSize: 12, fontWeight: 700,
                          color: isToday ? '#1d4ed8' : '#374151',
                          background: isToday ? '#eff6ff' : '#f8fafc',
                        }}>
                          {dow} <span style={{ color: '#9ca3af', fontWeight: 600 }}>{dom}</span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {div.leads.map((ld, li) => (
                    <tr key={ld.lead} style={{ borderTop: li > 0 ? '1px solid #f1f5f9' : undefined }}>
                      <td style={{ padding: '8px 12px', fontWeight: 700, fontSize: 13, color: '#1f2937', verticalAlign: 'top', position: 'sticky', left: 0, background: '#fff', zIndex: 1 }}>
                        {ld.lead}
                        <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 600, marginTop: 1 }}>{ld.site_count}</div>
                      </td>
                      {ld.days.map((sites, di) => {
                        const isToday = days[di] === today;
                        return (
                          <td key={di} style={{ padding: '8px 12px', verticalAlign: 'top', background: isToday ? '#f8fbff' : undefined }}>
                            {sites.length === 0
                              ? <span style={{ color: '#e5e7eb' }}>·</span>
                              : sites.map((s, si) => <SiteRow key={si} s={s} />)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {/* Legend */}
        {data && !loading && data.divisions.length > 0 && (
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#6b7280', marginTop: 8 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: TYPE_DOT.maintenance }} /> Maintenance
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: TYPE_DOT.project }} /> Project
            </span>
            <span style={{ color: '#15803d', fontWeight: 700 }}>✓ Ready</span>
            <span style={{ color: '#b45309', fontWeight: 700 }}>⏳ Not ready</span>
            <span style={{ color: '#9ca3af' }}>(projects — Set for Production or beyond)</span>
          </div>
        )}
      </div>
    </div>
  );
}
