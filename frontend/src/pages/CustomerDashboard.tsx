/**
 * CustomerDashboard — internal service report for a commercial customer that
 * owns multiple properties (an Aspire Company / BillingCompany).
 *  1. This week   — completed visits, grouped by division (excl. Construction)
 *  2. Next week   — scheduled look-ahead, grouped by division
 *  3. Construction — projects (start/end, % complete) + visits
 * Plus a Print/Save-PDF layout and an Email button that previews + confirms.
 * Route: /dashboards/customer
 */

import { useEffect, useRef, useState } from 'react';
import {
  searchCustomers, getCustomerReport, emailCustomerReport, customerEmailPreviewUrl,
  type CustomerSearchResult, type CustomerReport, type CustomerTicket, type CustomerDivisionGroup,
} from '../lib/api';

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Saturday on/before the given date (weeks run Saturday–Friday).
function weekStartOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 1) % 7));
  return ymd(dt);
}
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return ymd(dt);
}
function pretty(date: string): string {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const DIV_ICON: Record<string, string> = {
  'Commercial Maintenance': '🏢', 'Residential Maintenance': '🏡',
  'Irrigation/Lighting': '💧', 'Snow': '❄️', 'Construction': '🏗️',
};

function Thumbs({ t }: { t: CustomerTicket }) {
  if (!t.photos?.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
      {t.photos.slice(0, 4).map((p, i) => (
        <a key={i} href={p.url} target="_blank" rel="noreferrer" title={p.file_name || 'Photo'}>
          <img src={p.url} alt="" style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 6, border: '1px solid #e5e7eb' }} />
        </a>
      ))}
    </div>
  );
}

function TicketRow({ t }: { t: CustomerTicket }) {
  const date = t.complete_date || t.scheduled_date;
  const meta = [t.crew, t.service].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'flex', gap: 12, padding: '9px 0', borderTop: '1px solid #f1f5f9' }}>
      <div style={{ width: 140, flexShrink: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: '#111827' }}>{t.property}</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>{pretty(date)}</div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#15803d' }}>{t.status}</span>
        {meta && <span style={{ fontSize: 12, color: '#6b7280' }}> — {meta}</span>}
        {t.notes && <div style={{ fontSize: 13, color: '#374151', marginTop: 2, whiteSpace: 'pre-wrap' }}>{t.notes}</div>}
        <Thumbs t={t} />
      </div>
    </div>
  );
}

function DivisionSection({ groups }: { groups: CustomerDivisionGroup[] }) {
  if (!groups.length) return <div style={{ color: '#9ca3af', fontSize: 13, padding: '4px 0' }}>No visits.</div>;
  return (
    <>
      {groups.map(g => (
        <div key={g.division} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#111827', marginBottom: 2 }}>
            {DIV_ICON[g.division] || '📍'} {g.division}
            <span style={{ fontSize: 12, fontWeight: 600, color: '#9ca3af' }}> · {g.count} visit{g.count === 1 ? '' : 's'}</span>
          </div>
          {g.tickets.map(t => <TicketRow key={t.work_ticket_id} t={t} />)}
        </div>
      ))}
    </>
  );
}

const btn: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 8, border: '1px solid #d1d5db',
  background: '#fff', fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer', fontFamily: 'inherit',
};

export default function CustomerDashboard() {
  const [query, setQuery]       = useState('');
  const [results, setResults]   = useState<CustomerSearchResult[]>([]);
  const [picked, setPicked]     = useState<CustomerSearchResult | null>(null);
  const [weekStart, setWeekStart] = useState<string>(weekStartOf(ymd(new Date())));
  const [report, setReport]     = useState<CustomerReport | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Email panel state
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo]     = useState('');
  const [emailState, setEmailState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [emailMsg, setEmailMsg]   = useState('');

  // Debounced customer search
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (query.trim().length < 2) { setResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      try { setResults(await searchCustomers(query.trim())); } catch { setResults([]); }
    }, 250);
  }, [query]);

  async function loadReport(companyId: number, ws: string) {
    setLoading(true); setError('');
    try { setReport(await getCustomerReport(companyId, ws)); }
    catch (e: any) { setError(e?.message || 'Failed to load report'); setReport(null); }
    finally { setLoading(false); }
  }

  useEffect(() => { if (picked) loadReport(picked.company_id, weekStart); }, [picked, weekStart]);
  useEffect(() => { setEmailState('idle'); setEmailMsg(''); }, [picked, weekStart]);

  function choose(c: CustomerSearchResult) {
    setPicked(c); setQuery(c.company_name); setResults([]);
  }

  async function sendEmail() {
    const recips = emailTo.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    if (!recips.length) { setEmailMsg('Enter at least one recipient'); return; }
    if (!picked) return;
    if (!window.confirm(`Send this report for ${picked.company_name} to:\n${recips.join(', ')}?`)) return;
    setEmailState('sending'); setEmailMsg('');
    try {
      const r = await emailCustomerReport(picked.company_id, recips, weekStart);
      setEmailState('sent'); setEmailMsg(`Sent to ${r.recipients.join(', ')}`); setEmailOpen(false);
    } catch (e: any) {
      setEmailState('error'); setEmailMsg(e?.message || 'Send failed');
    }
  }

  const isThisWeek = weekStart === weekStartOf(ymd(new Date()));

  return (
    <div style={{ background: '#f8fafc', minHeight: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', padding: '28px 28px 60px' }}>
      {/* Print rules: hide app chrome + controls, expand content */}
      <style>{`
        @media print {
          nav, .no-print { display: none !important; }
          main { margin-left: 0 !important; }
          body { background: #fff !important; }
          .cust-print { box-shadow: none !important; border: none !important; }
          a[href] { color: #111827 !important; text-decoration: none !important; }
          .cust-section { break-inside: avoid; }
        }
      `}</style>

      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 800, color: '#111827' }}>Customer Dashboard</h1>
        <p className="no-print" style={{ margin: '0 0 18px', fontSize: 13, color: '#6b7280' }}>
          Weekly service report for a commercial customer &amp; their properties — live from Aspire
        </p>

        {/* Customer picker */}
        <div className="no-print" style={{ position: 'relative', maxWidth: 460, marginBottom: 16 }}>
          <input
            value={query}
            onChange={e => { setQuery(e.target.value); setPicked(null); }}
            placeholder="Search customer (e.g. Devon)…"
            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, boxSizing: 'border-box' }}
          />
          {results.length > 0 && !picked && (
            <div style={{ position: 'absolute', zIndex: 10, left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, marginTop: 4, boxShadow: '0 6px 20px rgba(0,0,0,0.10)', overflow: 'hidden' }}>
              {results.map(c => (
                <div key={c.company_id} onClick={() => choose(c)}
                     style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 14, borderBottom: '1px solid #f1f5f9' }}
                     onMouseEnter={e => (e.currentTarget.style.background = '#f0fdf4')}
                     onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                  {c.company_name}
                </div>
              ))}
            </div>
          )}
        </div>

        {loading && <div style={{ color: '#6b7280', fontSize: 14, padding: '30px 0', textAlign: 'center' }}>Loading…</div>}
        {error && !loading && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 10, padding: '12px 16px', fontSize: 13 }}>{error}</div>
        )}

        {report && !loading && (
          <div className="cust-print" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ background: '#14532d', color: '#fff', padding: '18px 22px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 800 }}>{report.company_name}</div>
                  <div style={{ opacity: 0.85, fontSize: 13 }}>
                    Week of {pretty(report.week_start)} – {pretty(report.week_end)} · {report.property_count} properties
                  </div>
                </div>
                {/* Week nav + actions */}
                <div className="no-print" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button onClick={() => setWeekStart(addDays(weekStart, -7))} style={btn}>← Prev</button>
                  <button onClick={() => setWeekStart(addDays(weekStart, 7))} style={btn}>Next →</button>
                  {!isThisWeek && <button onClick={() => setWeekStart(weekStartOf(ymd(new Date())))} style={btn}>This week</button>}
                  <button onClick={() => window.print()} style={{ ...btn, background: '#f0fdf4', borderColor: '#86efac', color: '#166534' }}>🖨 Print / PDF</button>
                  <button onClick={() => setEmailOpen(o => !o)} style={{ ...btn, background: '#2563eb', borderColor: '#2563eb', color: '#fff' }}>✉ Email report</button>
                </div>
              </div>
              {/* summary chips */}
              <div style={{ display: 'flex', gap: 18, marginTop: 12, fontSize: 13 }}>
                <span><b>{report.summary.this_week_visits}</b> this week</span>
                <span><b>{report.summary.next_week_visits}</b> next week</span>
                <span><b>{report.summary.construction_projects}</b> construction</span>
                <span><b>{report.summary.photos}</b> photos</span>
              </div>
            </div>

            {/* Email panel */}
            {emailOpen && (
              <div className="no-print" style={{ background: '#eff6ff', borderBottom: '1px solid #bfdbfe', padding: '12px 22px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input value={emailTo} onChange={e => setEmailTo(e.target.value)} placeholder="recipient@example.com, second@…"
                       style={{ flex: 1, minWidth: 220, padding: '8px 10px', borderRadius: 6, border: '1px solid #93c5fd', fontSize: 13 }} />
                <a href={customerEmailPreviewUrl(report.company_id, weekStart)} target="_blank" rel="noreferrer"
                   style={{ ...btn, textDecoration: 'none', display: 'inline-block' }}>👁 Preview</a>
                <button onClick={sendEmail} disabled={emailState === 'sending'}
                        style={{ ...btn, background: '#2563eb', borderColor: '#2563eb', color: '#fff', cursor: emailState === 'sending' ? 'wait' : 'pointer' }}>
                  {emailState === 'sending' ? 'Sending…' : 'Send'}
                </button>
                <span style={{ fontSize: 12, color: '#6b7280' }}>Preview opens the exact email; sending asks you to confirm first.</span>
              </div>
            )}
            {emailMsg && (
              <div className="no-print" style={{ padding: '6px 22px', fontSize: 12, color: emailState === 'error' ? '#b91c1c' : '#15803d' }}>
                {emailState === 'sent' ? '✓ ' : ''}{emailMsg}
              </div>
            )}

            {/* Body */}
            <div style={{ padding: '18px 22px' }}>
              <div className="cust-section" style={{ marginBottom: 22 }}>
                <h2 style={{ fontSize: 17, margin: '0 0 8px' }}>This week</h2>
                <DivisionSection groups={report.this_week} />
              </div>

              <div className="cust-section" style={{ marginBottom: 22 }}>
                <h2 style={{ fontSize: 17, margin: '0 0 8px' }}>Next week <span style={{ fontSize: 13, fontWeight: 500, color: '#9ca3af' }}>(scheduled)</span></h2>
                <DivisionSection groups={report.next_week} />
              </div>

              <div className="cust-section">
                <h2 style={{ fontSize: 17, margin: '0 0 8px' }}>🏗️ Construction</h2>
                {report.construction.projects.length === 0 ? (
                  <div style={{ color: '#9ca3af', fontSize: 13 }}>No active construction projects.</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
                    <thead>
                      <tr style={{ fontSize: 11, textTransform: 'uppercase', color: '#6b7280', textAlign: 'left' }}>
                        <th style={{ padding: '4px 6px' }}>Project</th>
                        <th style={{ padding: '4px 6px' }}>Timeline</th>
                        <th style={{ padding: '4px 6px', textAlign: 'right' }}>Complete</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.construction.projects.map(p => (
                        <tr key={p.opp_id}>
                          <td style={{ padding: '6px', borderTop: '1px solid #f1f5f9' }}>
                            <div style={{ fontWeight: 700 }}>{p.name}</div>
                            <div style={{ fontSize: 12, color: '#6b7280' }}>{p.property} · {p.status}</div>
                          </td>
                          <td style={{ padding: '6px', borderTop: '1px solid #f1f5f9', fontSize: 12 }}>
                            {pretty(p.start_date) || '—'} → {pretty(p.end_date) || '—'}
                          </td>
                          <td style={{ padding: '6px', borderTop: '1px solid #f1f5f9', textAlign: 'right', fontWeight: 700 }}>
                            {p.percent_complete != null ? `${Math.round(p.percent_complete)}%` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {(report.construction.completed.length > 0 || report.construction.scheduled.length > 0) && (
                  <div style={{ marginTop: 6 }}>
                    {report.construction.completed.map(t => <TicketRow key={`c${t.work_ticket_id}`} t={t} />)}
                    {report.construction.scheduled.map(t => <TicketRow key={`s${t.work_ticket_id}`} t={t} />)}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {!picked && !loading && (
          <div style={{ color: '#9ca3af', fontSize: 14, padding: '30px 0', textAlign: 'center' }}>
            Search and pick a customer to view their weekly service report.
          </div>
        )}
      </div>
    </div>
  );
}
