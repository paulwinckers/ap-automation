/**
 * Customer 360 — one unified view of a commercial customer (Aspire Company):
 * identity + contacts + properties, every job across all divisions, and the
 * portal activity we've attached (stage, schedule, prep, PHA, comms) — joined
 * live by the read-only GET /customer/{company_id}/360 endpoint.
 * Route: /dashboards/customer/360
 */
import { useEffect, useRef, useState } from 'react';
import {
  searchCustomers, getCustomer360,
  type CustomerSearchResult, type Customer360, type C360Job,
} from '../lib/api';

const NAVY = '#1e3a5f';
const DIV_ICON: Record<string, string> = {
  'Commercial Maintenance': '🏢', 'Residential Maintenance': '🏡',
  'Irrigation/Lighting': '💧', 'Snow': '❄️', 'Construction': '🏗️', 'Enhancement': '🌿',
};

function Spinner({ label }: { label?: string }) {
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 30 }}>
      <svg width="30" height="30" viewBox="0 0 50 50" role="status" aria-label="Loading">
        <circle cx="25" cy="25" r="20" fill="none" stroke="#e5e7eb" strokeWidth="5" />
        <circle cx="25" cy="25" r="20" fill="none" stroke={NAVY} strokeWidth="5" strokeLinecap="round" strokeDasharray="90 150">
          <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="0.9s" repeatCount="indefinite" />
        </circle>
      </svg>
      {label && <span style={{ fontSize: 13, color: '#9ca3af' }}>{label}</span>}
    </div>
  );
}

function fmt$(n: number | null | undefined): string {
  if (n == null || n === 0) return '';
  return '$' + Math.round(n).toLocaleString();
}
function pretty(date: string | null): string {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  if (!y) return date;
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
// A job is "history" when it's Lost, completed, or its latest date is >15 months old.
function isHistory(j: C360Job): boolean {
  if ((j.status || '').toLowerCase() === 'lost') return true;
  if (j.complete_date) return true;
  const latest = j.end_date || j.start_date || j.won_date || '';
  if (latest) {
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 15);
    const [y, m, d] = latest.split('-').map(Number);
    if (y && new Date(y, (m || 1) - 1, d || 1) < cutoff) return true;
  }
  return false;
}

function pill(bg: string, fg: string): React.CSSProperties {
  return { display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: bg, color: fg, whiteSpace: 'nowrap' };
}

function JobCard({ j }: { j: C360Job }) {
  const chips: React.ReactNode[] = [];
  if (j.stage) chips.push(<span key="st" style={pill('#eef2ff', '#3730a3')} title="Portal stage">{j.stage}</span>);
  if (j.lead) chips.push(<span key="ld" style={pill('#fef3c7', '#92400e')} title="Lead">★ {j.lead}</span>);
  if (j.schedule) chips.push(<span key="sc" style={pill(j.schedule.status === 'confirmed' ? '#dcfce7' : '#e0f2fe', j.schedule.status === 'confirmed' ? '#15803d' : '#075985')} title="Schedule board">{j.schedule.status === 'confirmed' ? '🔒 ' : '📅 '}{pretty(j.schedule.start)}</span>);
  if (j.prep) chips.push(<span key="pr" style={pill('#f1f5f9', '#475569')} title="Prep checklist">Prep {j.prep.done}/{j.prep.total}</span>);
  if (j.pha) chips.push(<span key="ph" style={pill('#fee2e2', '#991b1b')} title="Project Hazard Assessment">PHA {j.pha.status || ''}</span>);
  if (j.comms?.length) chips.push(<span key="cm" style={pill('#ecfccb', '#3f6212')} title="Emails sent">✉ {j.comms.length}</span>);

  const pct = j.pct_complete != null ? Math.round(j.pct_complete * 100) : null;
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13.5, color: '#0f172a' }}>{j.name || '(unnamed)'}</span>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>{j.number ? `#${j.number}` : ''}</span>
        <span style={{ ...pill('#f8fafc', '#475569'), border: '1px solid #e5e7eb' }}>{DIV_ICON[j.division || ''] || '📍'} {j.division}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>{j.status}</span>
        {pct != null && <span style={{ fontSize: 12, color: '#6b7280' }}>· {pct}%</span>}
        {fmt$(j.won_dollars) && <span style={{ fontSize: 12, color: '#6b7280' }}>· {fmt$(j.won_dollars)}</span>}
        <a href={`/field/project/${j.opportunity_id}`} style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: NAVY, textDecoration: 'none' }}>Open ↗</a>
      </div>
      {chips.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>{chips}</div>}
    </div>
  );
}

const TL_ICON: Record<string, string> = { comms: '✉️', schedule: '📅', pha: '🦺' };

export default function Customer360Page() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [data, setData] = useState<Customer360 | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const tmr = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    if (tmr.current) clearTimeout(tmr.current);
    tmr.current = setTimeout(async () => {
      setSearching(true);
      try { setResults(await searchCustomers(q.trim())); } catch { setResults([]); } finally { setSearching(false); }
    }, 300);
    return () => { if (tmr.current) clearTimeout(tmr.current); };
  }, [q]);

  async function pick(c: CustomerSearchResult) {
    setResults([]); setQ(c.company_name); setLoading(true); setErr(''); setData(null);
    try { setData(await getCustomer360(c.company_id)); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }

  const jobs = data?.jobs ?? [];
  const active = jobs.filter(j => !isHistory(j));
  const history = jobs.filter(isHistory);
  // group active by property
  const byProperty = new Map<string, C360Job[]>();
  for (const j of active) {
    const key = j.property || '(no property)';
    (byProperty.get(key) ?? byProperty.set(key, []).get(key)!).push(j);
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', padding: 20 }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>👤 Customer 360</h1>
        <p style={{ margin: '3px 0 14px', color: '#6b7280', fontSize: 13 }}>Everything on one customer — all jobs across divisions, plus the portal activity we've attached.</p>

        {/* Search */}
        <div style={{ position: 'relative', maxWidth: 460, marginBottom: 18 }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search customers (company name)…"
            style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db', fontSize: 14 }} />
          {(results.length > 0 || searching) && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginTop: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 20, maxHeight: 280, overflowY: 'auto' }}>
              {searching && <div style={{ padding: '10px 12px', color: '#9ca3af', fontSize: 13 }}>Searching…</div>}
              {results.map(c => (
                <button key={c.company_id} onClick={() => pick(c)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', borderTop: '1px solid #f1f5f9', background: 'none', cursor: 'pointer', fontSize: 13.5, color: '#111827' }}>
                  {c.company_name}
                </button>
              ))}
            </div>
          )}
        </div>

        {err && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 14px', color: '#991b1b', marginBottom: 14 }}>{err}</div>}
        {loading && <Spinner label="Loading customer…" />}

        {data && !loading && (
          <>
            {/* Header */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#0f172a' }}>{data.customer.name || `Company ${data.customer.company_id}`}</h2>
                <span style={{ fontSize: 12, color: '#9ca3af' }}>
                  {data.counts.jobs} jobs · {data.counts.properties} properties · {data.counts.contacts} contacts
                </span>
              </div>
              {data.customer.contacts.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10 }}>
                  {data.customer.contacts.map(c => (
                    <div key={c.contact_id} style={{ fontSize: 13, color: '#374151' }}>
                      <span style={{ fontWeight: 700 }}>{c.name || '(contact)'}</span>
                      {c.primary && <span style={{ ...pill('#dcfce7', '#15803d'), marginLeft: 6 }}>primary</span>}
                      {c.title && <span style={{ color: '#9ca3af' }}> · {c.title}</span>}
                      <div style={{ color: '#6b7280', fontSize: 12 }}>
                        {c.email && <a href={`mailto:${c.email}`} style={{ color: NAVY, textDecoration: 'none' }}>{c.email}</a>}
                        {c.email && c.phone && ' · '}
                        {c.phone}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {/* Jobs */}
              <div style={{ flex: 1, minWidth: 320 }}>
                {active.length === 0 && <div style={{ color: '#9ca3af', fontSize: 13, padding: 12 }}>No active jobs.</div>}
                {[...byProperty.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([prop, pj]) => (
                  <div key={prop} style={{ marginBottom: 16 }}>
                    <div style={{ fontWeight: 800, fontSize: 14, color: NAVY, margin: '2px 0 8px' }}>📍 {prop} <span style={{ color: '#9ca3af', fontWeight: 500 }}>({pj.length})</span></div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {pj.sort((a, b) => (b.start_date || b.won_date || '').localeCompare(a.start_date || a.won_date || '')).map(j => <JobCard key={j.opportunity_id} j={j} />)}
                    </div>
                  </div>
                ))}

                {history.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <button onClick={() => setShowHistory(s => !s)}
                      style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontWeight: 700, padding: 0 }}>
                      {showHistory ? '▾' : '▸'} History — lost / completed / older ({history.length})
                    </button>
                    {showHistory && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, opacity: 0.85 }}>
                        {history.sort((a, b) => (b.start_date || b.won_date || '').localeCompare(a.start_date || a.won_date || '')).map(j => <JobCard key={j.opportunity_id} j={j} />)}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Activity timeline */}
              <div style={{ width: 320, flexShrink: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 14, position: 'sticky', top: 12 }}>
                <div style={{ fontWeight: 800, fontSize: 14, color: '#0f172a', marginBottom: 10 }}>Activity timeline</div>
                {data.activity_timeline.length === 0 && <div style={{ color: '#9ca3af', fontSize: 13 }}>No portal activity recorded yet. As comms, schedules and PHAs are created, they appear here.</div>}
                {data.activity_timeline.map((t, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, padding: '7px 0', borderTop: i ? '1px solid #f1f5f9' : 'none' }}>
                    <span style={{ fontSize: 14 }}>{TL_ICON[t.type] || '•'}</span>
                    <div>
                      <div style={{ fontSize: 12.5, color: '#374151' }}>{t.summary}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{pretty(t.when)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {!data && !loading && (
          <div style={{ color: '#9ca3af', fontSize: 14, padding: 20 }}>Search for a customer above to see their full picture.</div>
        )}
      </div>
    </div>
  );
}
