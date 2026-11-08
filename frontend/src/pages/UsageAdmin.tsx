/**
 * UsageAdmin — which pages people open and how often. Admin only. Route: /ops/usage
 * Data comes from PageViewTracker (every page open) via GET /admin/usage.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { getUsageReport, type UsageReport } from '../lib/api';
import { FIELD_LINKS, OFFICE_SECTIONS, activePath } from '../lib/nav';

// Pages that aren't menu items, or whose detail pages deserve their own name.
const EXTRA: Record<string, string> = {
  '/': 'Front door', '/login': 'Sign in', '/home': 'Office Home', '/crew': 'Field Main Menu',
  '/my-work': 'My Action Items', '/my-work?tab=daily': 'My Action Items · Day-to-day',
  '/my-work?tab=workflow': 'My Action Items · Workflows', '/my-work?tab=project': 'My Action Items · Projects',
  '/my-work?tab=feed': 'My Action Items · Feed',
  '/field/project/:id': 'Project (job page)', '/field/maintenance/:id': 'Maintenance (job page)',
  '/field/checkin/:id': 'Project check-in', '/keys/scan/:id': 'Key scan',
  '/dashboards/customer/360': 'Customer 360', '/sales/log': 'Sales visit log',
  '/ops/time-tracking': 'Time tracking', '/ops/usage': 'Usage',
};

function pageName(path: string): string {
  if (EXTRA[path]) return EXTRA[path];
  const bare = path.split('?')[0];
  if (EXTRA[bare]) return EXTRA[bare];
  const links = [...FIELD_LINKS, ...OFFICE_SECTIONS.flatMap(s => s.items)];
  const own = activePath(bare, links.map(l => l.path));
  const hit = own ? links.find(l => l.path === own) : undefined;
  if (!hit) return bare;
  return own === bare ? hit.label : `${hit.label} › ${bare.slice(own!.length + 1)}`;
}

function ago(ts: string): string {
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return '';
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 60) return `${Math.max(m, 0)}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const card: CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '16px 18px', marginBottom: 16 };
const th: CSSProperties = { textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
  letterSpacing: '0.04em', padding: '6px 8px', borderBottom: '1px solid #e5e7eb' };
const td: CSSProperties = { padding: '8px', borderBottom: '1px solid #f3f4f6', fontSize: 14, color: '#111827', verticalAlign: 'top' };
const num: CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const pill = (field: boolean): CSSProperties => ({ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
  background: field ? '#dcfce7' : '#e0e7ff', color: field ? '#166534' : '#3730a3' });

export default function UsageAdmin() {
  const [days, setDays] = useState(7);
  const [kind, setKind] = useState<'all' | 'office' | 'field'>('all');
  const [r, setR] = useState<UsageReport | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setErr('');
    getUsageReport(days).then(setR).catch(e => setErr(String(e.message || e)));
  }, [days]);

  const pages = useMemo(() => (r?.by_page || []).filter(p => kind === 'all' || p.kind === kind), [r, kind]);
  const people = useMemo(() => (r?.by_person || []).filter(p => kind === 'all' || p.kind === kind), [r, kind]);
  const daysList = useMemo(() => {
    const m = new Map<string, { office: number; field: number }>();
    (r?.by_day || []).forEach(d => {
      const e = m.get(d.day) || { office: 0, field: 0 };
      e[d.kind === 'field' ? 'field' : 'office'] += d.views; m.set(d.day, e);
    });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [r]);
  const maxDay = Math.max(1, ...daysList.map(([, v]) => v.office + v.field));
  const maxPage = Math.max(1, ...pages.map(p => p.views));
  const views = pages.reduce((s, p) => s + p.views, 0);

  const chip = (on: boolean): CSSProperties => ({ padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: `1px solid ${on ? '#1d4ed8' : '#d1d5db'}`, background: on ? '#1d4ed8' : '#fff', color: on ? '#fff' : '#374151' });

  return (
    <div style={{ padding: '24px 20px', maxWidth: 1000, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, color: '#111827', margin: '0 0 4px' }}>📈 Usage</h1>
      <div style={{ color: '#6b7280', fontSize: 14, marginBottom: 16 }}>
        Which pages people open, and how often. Every page open counts once (repeats within 20 seconds are ignored).
        Crew phones show the name they last typed on a form; phones that never typed one show as “Unnamed phone”.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        {[1, 7, 30, 90].map(d => <button key={d} style={chip(days === d)} onClick={() => setDays(d)}>
          {d === 1 ? 'Today' : `Last ${d} days`}</button>)}
        <div style={{ width: 12 }} />
        {(['all', 'office', 'field'] as const).map(k => <button key={k} style={chip(kind === k)} onClick={() => setKind(k)}>
          {k === 'all' ? 'Everyone' : k === 'office' ? 'Office' : 'Field'}</button>)}
      </div>

      {err && <div style={{ ...card, color: '#991b1b', background: '#fef2f2', borderColor: '#fecaca' }}>{err}</div>}
      {!r && !err && <div style={{ color: '#6b7280', padding: 30 }}>Loading…</div>}

      {r && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
            {[['Page views', views], ['People', people.length], ['Pages used', pages.length]].map(([l, v]) => (
              <div key={l as string} style={{ ...card, marginBottom: 0 }}>
                <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>{l}</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: '#111827' }}>{v}</div>
              </div>
            ))}
          </div>

          {r.total_views === 0 && (
            <div style={card}>No page views recorded yet in this period. Tracking started when this version went live.</div>
          )}

          {daysList.length > 0 && (
            <div style={card}>
              <div style={{ fontWeight: 700, marginBottom: 10 }}>By day <span style={{ color: '#6b7280', fontWeight: 400, fontSize: 13 }}>
                (<span style={{ color: '#3730a3' }}>office</span> / <span style={{ color: '#166534' }}>field</span>, UTC days)</span></div>
              {daysList.map(([d, v]) => (
                <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, fontSize: 13 }}>
                  <div style={{ width: 92, color: '#374151' }}>
                    {new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })}</div>
                  <div style={{ flex: 1, display: 'flex', height: 14 }}>
                    {(kind !== 'field') && <div style={{ width: `${(v.office / maxDay) * 100}%`, background: '#818cf8', borderRadius: 3 }} />}
                    {(kind !== 'office') && <div style={{ width: `${(v.field / maxDay) * 100}%`, background: '#4ade80', borderRadius: 3, marginLeft: 2 }} />}
                  </div>
                  <div style={{ width: 70, textAlign: 'right', color: '#6b7280', fontVariantNumeric: 'tabular-nums' }}>
                    {kind === 'office' ? v.office : kind === 'field' ? v.field : v.office + v.field}</div>
                </div>
              ))}
            </div>
          )}

          {pages.length > 0 && (
            <div style={{ ...card, overflowX: 'auto' }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Pages</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>Page</th><th style={{ ...th, textAlign: 'right' }}>Views</th>
                  <th style={{ ...th, textAlign: 'right' }}>People</th><th style={{ ...th, textAlign: 'right' }}>Last</th></tr></thead>
                <tbody>
                  {pages.map(p => (
                    <tr key={p.path + p.kind}>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={pill(p.kind === 'field')}>{p.kind}</span>
                          <span style={{ fontWeight: 600 }}>{pageName(p.path)}</span>
                        </div>
                        <div style={{ height: 4, marginTop: 5, background: p.kind === 'field' ? '#4ade80' : '#818cf8',
                          width: `${(p.views / maxPage) * 100}%`, borderRadius: 2, opacity: 0.7 }} />
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{p.path}</div>
                      </td>
                      <td style={num}>{p.views}</td><td style={num}>{p.people}</td>
                      <td style={{ ...num, color: '#6b7280', fontSize: 13, whiteSpace: 'nowrap' }}>{ago(p.last_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {people.length > 0 && (
            <div style={{ ...card, overflowX: 'auto' }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>People</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>Who</th><th style={th}>Most-used pages</th>
                  <th style={{ ...th, textAlign: 'right' }}>Views</th><th style={{ ...th, textAlign: 'right' }}>Days</th>
                  <th style={{ ...th, textAlign: 'right' }}>Last</th></tr></thead>
                <tbody>
                  {people.map((p, i) => (
                    <tr key={i}>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={pill(p.kind === 'field')}>{p.kind}</span>
                          <span style={{ fontWeight: 600, color: p.who === 'Unnamed phone' ? '#9ca3af' : '#111827' }}>{p.who}</span>
                        </div>
                      </td>
                      <td style={{ ...td, fontSize: 13, color: '#374151' }}>
                        {p.top_pages.map(t => `${pageName(t.path)} (${t.views})`).join(' · ')}</td>
                      <td style={num}>{p.views}</td><td style={num}>{p.days_active}</td>
                      <td style={{ ...num, color: '#6b7280', fontSize: 13, whiteSpace: 'nowrap' }}>{ago(p.last_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
