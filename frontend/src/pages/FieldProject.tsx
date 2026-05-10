/**
 * FieldProject — permanent, bookmarkable project page for construction leads.
 * Route: /field/project/:oppId  (public, no login required)
 *
 * Shows live work ticket hours from Aspire, AI coaching tip,
 * check-in history, and a form to submit an update at any time.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

const API = import.meta.env.VITE_API_URL ?? '';

interface Ticket {
  WorkTicketID:         number;
  WorkTicketNumber:     string | number;
  WorkTicketTitle:      string;
  WorkTicketStatusName: string;
  ScheduledStartDate:   string;
  HoursEst:             number | null;
  HoursAct:             number | null;
  CrewLeaderName:       string | null;
  Revenue:              number | null;
  EarnedRevenue:        number | null;
}

interface HistoryEntry {
  id:              number;
  lead_name:       string;
  sent_at:         string;
  month:           string;
  approach_notes:  string | null;
  remaining_hours: number | null;
  blockers:        string | null;
  submitted_at:    string | null;
}

interface ProjectData {
  opportunity_id:   number;
  opportunity_name: string;
  property_name:    string;
  opp_number:       string | number | null;
  status:           string | null;
  hrs_est:          number | null;
  hrs_act:          number | null;
  revenue_est:      number | null;
  revenue_act:      number | null;
  pct_complete:     number | null;
  month:            string;
  tickets:          Ticket[];
  ai_tip:           string | null;
  history:          HistoryEntry[];
}

function fmtHrs(h: number | null | undefined): string {
  if (h == null) return '—';
  return parseFloat(h as any).toFixed(1);
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '—';
  return '$' + parseFloat(v as any).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  return s.slice(0, 10);
}

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7)  return `${days} days ago`;
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

function StatusBadge({ status }: { status: string }) {
  const s = (status || '').toLowerCase();
  let bg = '#fef3c7', fg = '#92400e';
  if (s.includes('complete'))  { bg = '#dcfce7'; fg = '#15803d'; }
  else if (s.includes('progress')) { bg = '#dbeafe'; fg = '#1d4ed8'; }
  else if (s.includes('cancel'))   { bg = '#fee2e2'; fg = '#dc2626'; }
  return (
    <span style={{
      background: bg, color: fg, padding: '2px 9px', borderRadius: 12,
      fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
    }}>{status || '—'}</span>
  );
}

function HoursBar({ est, act }: { est: number | null; act: number | null }) {
  const e = est ?? 0;
  const a = act ?? 0;
  const pct   = e > 0 ? Math.min((a / e) * 100, 100) : 0;
  const color = (e > 0 && a > e) ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#22c55e';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 6, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4 }} />
      </div>
      <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 32 }}>{pct.toFixed(0)}%</span>
    </div>
  );
}

export default function FieldProject() {
  const { oppId } = useParams<{ oppId: string }>();

  const [data,       setData]       = useState<ProjectData | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // Form
  const [approachNotes,  setApproachNotes]  = useState('');
  const [remainingHours, setRemainingHours] = useState('');
  const [blockers,       setBlockers]       = useState('');
  const [submitting,     setSubmitting]     = useState(false);
  const [submitMsg,      setSubmitMsg]      = useState('');

  // Tab: 'tickets' | 'history' | 'update'
  const [tab, setTab] = useState<'tickets' | 'history' | 'update'>('tickets');

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    setError('');
    try {
      const r = await fetch(`${API}/checkin/project/${oppId}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as any).detail || 'Project not found');
      }
      setData(await r.json());
    } catch (e: any) {
      setError(e.message || 'Failed to load project');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, [oppId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!approachNotes.trim()) return;
    setSubmitting(true);
    setSubmitMsg('');
    try {
      const r = await fetch(`${API}/checkin/project/${oppId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approach_notes:  approachNotes.trim(),
          remaining_hours: remainingHours ? parseFloat(remainingHours) : null,
          blockers:        blockers.trim() || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as any).detail || 'Submit failed');
      }
      setSubmitMsg('✅ Update sent to the team.');
      setApproachNotes(''); setRemainingHours(''); setBlockers('');
      setTab('history');
      load(true);   // refresh history quietly
    } catch (err: any) {
      setSubmitMsg(`❌ ${err.message || 'Something went wrong'}`);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Loading / error ──────────────────────────────────────────────────────────

  if (loading) return (
    <div style={SHELL}>
      <div style={{ textAlign: 'center', padding: 60, color: '#64748b' }}>Loading project…</div>
    </div>
  );

  if (error) return (
    <div style={SHELL}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '40px 28px', textAlign: 'center', maxWidth: 440, margin: '0 auto' }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
        <div style={{ fontWeight: 700, fontSize: 18, color: '#0f172a', marginBottom: 8 }}>Project not found</div>
        <div style={{ color: '#64748b', fontSize: 14 }}>{error}</div>
      </div>
    </div>
  );

  if (!data) return null;

  const totalEst      = data.tickets.reduce((s, t) => s + (t.HoursEst ?? 0), 0);
  const totalAct      = data.tickets.reduce((s, t) => s + (t.HoursAct ?? 0), 0);
  const totalRem      = totalEst - totalAct;
  const totalRevenue  = data.tickets.reduce((s, t) => s + (t.Revenue ?? 0), 0);
  const totalEarned   = data.tickets.reduce((s, t) => s + (t.EarnedRevenue ?? 0), 0);
  const overBudget    = totalAct > totalEst && totalEst > 0;
  const responded  = data.history.filter(h => h.submitted_at).length;
  const tipParas   = (data.ai_tip || '').split('\n\n').filter(Boolean);

  return (
    <div style={SHELL}>
      <div style={CARD}>

        {/* Header */}
        <div style={HDR}>
          <div style={HDR_LABEL}>Construction Project</div>
          <div style={HDR_TITLE}>{data.property_name || data.opportunity_name}</div>
          {data.property_name && (
            <div style={HDR_SUB}>{data.opportunity_name}</div>
          )}
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {data.status && (
              <span style={{ background: 'rgba(255,255,255,.15)', color: '#fff', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                {data.status}
              </span>
            )}
            {data.opp_number && (
              <span style={{ background: 'rgba(255,255,255,.10)', color: '#86efac', padding: '3px 10px', borderRadius: 20, fontSize: 11 }}>
                #{data.opp_number}
              </span>
            )}
          </div>
        </div>

        {/* Summary chips */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #f1f5f9' }}>
          {[
            { label: 'Est Hrs',   value: fmtHrs(totalEst) },
            { label: 'Act Hrs',   value: fmtHrs(totalAct), alert: overBudget },
            { label: 'Remaining', value: fmtHrs(totalRem), alert: totalRem < 0 },
            { label: 'Updates',   value: `${responded}` },
          ].map(({ label, value, alert }) => (
            <div key={label} style={{ flex: 1, padding: '12px 4px', textAlign: 'center', borderRight: '1px solid #f1f5f9' }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: alert ? '#ef4444' : '#0f172a' }}>{value}</div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #f1f5f9' }}>
          {(['tickets', 'history', 'update'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1, padding: '12px 4px', border: 'none', background: 'none',
                fontWeight: tab === t ? 700 : 500,
                fontSize: 13,
                color: tab === t ? '#16a34a' : '#6b7280',
                borderBottom: tab === t ? '2px solid #16a34a' : '2px solid transparent',
                cursor: 'pointer', textTransform: 'capitalize',
              }}
            >
              {t === 'tickets' ? `📋 Tickets (${data.tickets.length})` :
               t === 'history' ? `📝 History (${responded})` :
               '✏️ Update'}
            </button>
          ))}
        </div>

        <div style={{ padding: '20px 16px' }}>

          {/* ── Tickets tab ──────────────────────────────────────────────── */}
          {tab === 'tickets' && (
            <>
              {/* AI tip */}
              {data.ai_tip && (
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
                  <div style={{ fontWeight: 700, fontSize: 11, color: '#15803d', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    💡 Coaching Tips
                  </div>
                  {tipParas.map((p, i) => (
                    <p key={i} style={{ margin: i < tipParas.length - 1 ? '0 0 8px' : 0, fontSize: 13, color: '#1e293b', lineHeight: 1.6 }}>{p}</p>
                  ))}
                </div>
              )}

              {/* Header row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Work Tickets ({data.tickets.length})
                </div>
                <button onClick={() => load(true)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 12 }}>
                  {refreshing ? '↻' : '↺ refresh'}
                </button>
              </div>

              {data.tickets.length === 0 ? (
                <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '24px 0' }}>
                  No work tickets found for this job
                </div>
              ) : (
                <>
                  {/* Totals row */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr repeat(4, auto)', gap: '0 12px', padding: '8px 12px', background: '#f8fafc', borderRadius: 8, marginBottom: 6, fontSize: 12, fontWeight: 700, color: '#374151' }}>
                    <span>Totals</span>
                    <span style={{ textAlign: 'right' }}>{fmtHrs(totalEst)}h est</span>
                    <span style={{ textAlign: 'right', color: overBudget ? '#ef4444' : '#374151' }}>{fmtHrs(totalAct)}h act</span>
                    <span style={{ textAlign: 'right', color: totalEarned > 0 ? '#15803d' : '#94a3b8' }}>{fmtMoney(totalEarned || null)}</span>
                    <span style={{ textAlign: 'right', color: '#6b7280' }}>{fmtMoney(totalRevenue || null)}</span>
                  </div>

                  {/* Ticket rows */}
                  <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                    {data.tickets.map((t, i) => {
                      const est = t.HoursEst ?? 0;
                      const act = t.HoursAct ?? 0;
                      const title = t.WorkTicketTitle || `#${t.WorkTicketNumber}`;
                      return (
                        <div key={t.WorkTicketID} style={{
                          padding: '11px 14px',
                          background: i % 2 === 0 ? '#fff' : '#f9fafb',
                          borderTop: i > 0 ? '1px solid #f1f5f9' : undefined,
                        }}>
                          {/* Service name + status */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 5 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 1 }}>{title}</div>
                              <div style={{ fontSize: 11, color: '#9ca3af' }}>#{t.WorkTicketNumber} · {fmtDate(t.ScheduledStartDate)}</div>
                            </div>
                            <StatusBadge status={t.WorkTicketStatusName || '—'} />
                          </div>
                          {/* Hours + revenue */}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginTop: 6 }}>
                            {[
                              { label: 'Est', value: `${fmtHrs(est)}h` },
                              { label: 'Actual', value: `${fmtHrs(act)}h`, alert: act > est && est > 0 },
                              { label: 'Earned', value: fmtMoney(t.EarnedRevenue), highlight: (t.EarnedRevenue ?? 0) > 0 },
                              { label: 'Revenue', value: fmtMoney(t.Revenue) },
                            ].map(({ label, value, alert, highlight }) => (
                              <div key={label} style={{ background: '#f8fafc', borderRadius: 6, padding: '5px 8px', textAlign: 'center' }}>
                                <div style={{ fontSize: 12, fontWeight: 700, color: alert ? '#ef4444' : highlight ? '#15803d' : '#111827' }}>{value}</div>
                                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 1 }}>{label}</div>
                              </div>
                            ))}
                          </div>
                          <div style={{ marginTop: 6 }}>
                            <HoursBar est={est} act={act} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              <button
                onClick={() => setTab('update')}
                style={{ width: '100%', marginTop: 16, padding: '13px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: 'pointer' }}
              >
                ✏️ Submit Today's Update
              </button>
            </>
          )}

          {/* ── History tab ──────────────────────────────────────────────── */}
          {tab === 'history' && (
            <>
              <div style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
                Check-in History
              </div>
              {data.history.length === 0 ? (
                <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '24px 0' }}>
                  No check-ins yet
                </div>
              ) : data.history.map((h, i) => (
                <div key={h.id} style={{
                  marginBottom: 12, border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden',
                }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 14px',
                    background: h.submitted_at ? '#f0fdf4' : '#fffbeb',
                    borderBottom: h.approach_notes ? '1px solid #e2e8f0' : undefined,
                  }}>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: 13, color: '#0f172a' }}>
                        {h.submitted_at ? '✅' : '⏳'} {h.submitted_at ? fmtRelative(h.submitted_at) : 'Awaiting'}
                      </span>
                      <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 8 }}>
                        {fmtDate(h.sent_at)}
                      </span>
                    </div>
                    {h.remaining_hours != null && (
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#15803d' }}>
                        {h.remaining_hours}h rem
                      </span>
                    )}
                  </div>
                  {h.approach_notes && (
                    <div style={{ padding: '10px 14px', fontSize: 13, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                      {h.approach_notes}
                    </div>
                  )}
                  {h.blockers && (
                    <div style={{ padding: '8px 14px', background: '#fff7ed', borderTop: '1px solid #fed7aa', fontSize: 12, color: '#c2410c' }}>
                      ⚠️ {h.blockers}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}

          {/* ── Update tab ───────────────────────────────────────────────── */}
          {tab === 'update' && (
            <form onSubmit={handleSubmit}>
              <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a', marginBottom: 18 }}>
                Submit Your Update
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={LABEL}>Estimated hours remaining on active ticket(s)</label>
                <input
                  type="number" min="0" step="0.5"
                  placeholder="e.g. 12.5"
                  value={remainingHours}
                  onChange={e => setRemainingHours(e.target.value)}
                  style={INPUT}
                />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={LABEL}>
                  Today's plan &amp; approach <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <textarea
                  required rows={5}
                  placeholder="What's your plan for moving the project forward? What will the crew focus on? Any adjustments?"
                  value={approachNotes}
                  onChange={e => setApproachNotes(e.target.value)}
                  style={{ ...INPUT, resize: 'vertical', minHeight: 110 }}
                />
              </div>

              <div style={{ marginBottom: 22 }}>
                <label style={LABEL}>Blockers or issues (optional)</label>
                <textarea
                  rows={3}
                  placeholder="Anything slowing you down?"
                  value={blockers}
                  onChange={e => setBlockers(e.target.value)}
                  style={{ ...INPUT, resize: 'vertical' }}
                />
              </div>

              {submitMsg && (
                <div style={{
                  marginBottom: 14, padding: '10px 14px', borderRadius: 8,
                  background: submitMsg.startsWith('✅') ? '#f0fdf4' : '#fef2f2',
                  color: submitMsg.startsWith('✅') ? '#15803d' : '#dc2626',
                  fontSize: 14, fontWeight: 600,
                }}>
                  {submitMsg}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !approachNotes.trim()}
                style={{
                  width: '100%', padding: '15px',
                  background: approachNotes.trim() ? '#16a34a' : '#94a3b8',
                  color: '#fff', border: 'none', borderRadius: 10,
                  fontWeight: 800, fontSize: 16,
                  cursor: approachNotes.trim() ? 'pointer' : 'not-allowed',
                }}
              >
                {submitting ? 'Sending…' : 'Send Update to Team →'}
              </button>
            </form>
          )}

        </div>

        <div style={{ padding: '12px 16px', borderTop: '1px solid #f1f5f9', textAlign: 'center' }}>
          <span style={{ fontSize: 11, color: '#cbd5e1' }}>Darios Landscaping · Project Portal</span>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const SHELL: React.CSSProperties = {
  minHeight: '100vh',
  background: '#0f172a',
  padding: '16px 12px 48px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};

const CARD: React.CSSProperties = {
  maxWidth: 480,
  margin: '0 auto',
  background: '#fff',
  borderRadius: 16,
  overflow: 'hidden',
  boxShadow: '0 4px 24px rgba(0,0,0,.18)',
};

const HDR: React.CSSProperties = {
  background: '#14532d',
  padding: '22px 20px 18px',
};
const HDR_LABEL: React.CSSProperties = { color: '#86efac', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 };
const HDR_TITLE: React.CSSProperties = { color: '#fff', fontSize: 22, fontWeight: 800, lineHeight: 1.2 };
const HDR_SUB:   React.CSSProperties = { color: '#4ade80', fontSize: 13, marginTop: 4 };

const LABEL: React.CSSProperties = {
  display: 'block', fontWeight: 600, fontSize: 13, color: '#374151', marginBottom: 6,
};

const INPUT: React.CSSProperties = {
  width: '100%', padding: '11px 13px',
  border: '1.5px solid #e2e8f0', borderRadius: 10,
  fontSize: 15, color: '#0f172a', background: '#fff',
  boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit',
};
