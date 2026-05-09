/**
 * FieldCheckin — public, tokenised daily check-in form for construction leads.
 * Route: /field/checkin/:token  (no login required)
 *
 * Lead receives this link in their daily email. They see:
 *   • Project name + today's work ticket snapshot
 *   • AI coaching tip
 *   • Form: remaining hours estimate + approach/plan + blockers
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

const API = import.meta.env.VITE_API_URL ?? '';

interface Ticket {
  WorkTicketID:         number;
  WorkTicketNumber:     string | number;
  WorkTicketStatusName: string;
  ScheduledStartDate:   string;
  HoursEst:             number | null;
  HoursAct:             number | null;
}

interface CheckinData {
  opportunity_name:  string;
  property_name:     string;
  lead_name:         string;
  month:             string;
  ai_tip:            string;
  tickets:           Ticket[];
  already_responded: boolean;
  prior_response:    { approach_notes: string; remaining_hours: number | null; blockers: string | null } | null;
  sent_at:           string;
}

function fmtHrs(h: number | null | undefined): string {
  if (h == null) return '—';
  return `${parseFloat(h as any).toFixed(1)}h`;
}

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  let bg = '#fef3c7', fg = '#92400e';
  if (s.includes('complete')) { bg = '#dcfce7'; fg = '#15803d'; }
  else if (s.includes('progress')) { bg = '#dbeafe'; fg = '#1d4ed8'; }
  return (
    <span style={{
      background: bg, color: fg, padding: '2px 9px', borderRadius: 12,
      fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
    }}>{status}</span>
  );
}

function HoursBar({ est, act }: { est: number | null; act: number | null }) {
  const e = est ?? 0;
  const a = act ?? 0;
  const pct = e > 0 ? Math.min((a / e) * 100, 100) : 0;
  const over = e > 0 && a > e;
  const color = over ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#22c55e';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{
        flex: 1, height: 6, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden',
      }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4 }} />
      </div>
      <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 32 }}>{pct.toFixed(0)}%</span>
    </div>
  );
}

export default function FieldCheckin() {
  const { token } = useParams<{ token: string }>();

  const [data,       setData]       = useState<CheckinData | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted,  setSubmitted]  = useState(false);

  // Form state
  const [approachNotes,   setApproachNotes]   = useState('');
  const [remainingHours,  setRemainingHours]  = useState('');
  const [blockers,        setBlockers]        = useState('');

  useEffect(() => {
    fetch(`${API}/checkin/${token}`)
      .then(r => {
        if (!r.ok) return r.json().then(j => Promise.reject(j.detail || 'Link not found'));
        return r.json();
      })
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(typeof e === 'string' ? e : 'This link is invalid or expired.'); setLoading(false); });
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!approachNotes.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/checkin/${token}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approach_notes:  approachNotes.trim(),
          remaining_hours: remainingHours ? parseFloat(remainingHours) : null,
          blockers:        blockers.trim() || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json();
        throw new Error(j.detail || 'Submit failed');
      }
      setSubmitted(true);
    } catch (err: any) {
      alert(err.message || 'Something went wrong — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Loading / error / success states ────────────────────────────────────────

  if (loading) return (
    <div style={SHELL}>
      <div style={{ textAlign: 'center', padding: 60, color: '#64748b' }}>Loading…</div>
    </div>
  );

  if (error) return (
    <div style={SHELL}>
      <div style={{
        background: '#fff', borderRadius: 14, padding: '40px 28px', textAlign: 'center',
        maxWidth: 440, margin: '0 auto',
      }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>🔗</div>
        <div style={{ fontWeight: 700, fontSize: 18, color: '#0f172a', marginBottom: 8 }}>Link unavailable</div>
        <div style={{ color: '#64748b', fontSize: 14 }}>{error}</div>
      </div>
    </div>
  );

  if (submitted || data?.already_responded) {
    const prior = data?.prior_response;
    return (
      <div style={SHELL}>
        <div style={CARD}>
          <div style={{ ...HDR, background: '#16a34a' }}>
            <div style={HDR_LABEL}>✅ Update Submitted</div>
            <div style={HDR_TITLE}>{data?.property_name || data?.opportunity_name}</div>
            <div style={HDR_SUB}>{data?.lead_name}</div>
          </div>
          <div style={{ padding: '28px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 52, marginBottom: 12 }}>🎉</div>
            <div style={{ fontWeight: 700, fontSize: 18, color: '#0f172a', marginBottom: 8 }}>
              Thanks — your update has been sent to the team.
            </div>
            {data?.already_responded && prior && (
              <div style={{ marginTop: 20, textAlign: 'left' }}>
                <div style={SECTION_LABEL}>Your Response</div>
                <div style={NOTE_BOX}>{prior.approach_notes}</div>
                {prior.remaining_hours != null && (
                  <div style={{ marginTop: 12, textAlign: 'center' }}>
                    <span style={{ fontWeight: 700, color: '#15803d' }}>{prior.remaining_hours}h</span>
                    <span style={{ color: '#64748b', fontSize: 13 }}> remaining estimate</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const totalEst = data.tickets.reduce((s, t) => s + (t.HoursEst ?? 0), 0);
  const totalAct = data.tickets.reduce((s, t) => s + (t.HoursAct ?? 0), 0);
  const totalRem = totalEst - totalAct;
  const overBudget = totalAct > totalEst && totalEst > 0;

  const tipParagraphs = (data.ai_tip || '').split('\n\n').filter(Boolean);

  return (
    <div style={SHELL}>
      <div style={CARD}>

        {/* Header */}
        <div style={HDR}>
          <div style={HDR_LABEL}>Daily Project Check-in</div>
          <div style={HDR_TITLE}>{data.property_name || data.opportunity_name}</div>
          <div style={HDR_SUB}>{data.opportunity_name}</div>
        </div>

        <div style={{ padding: '24px 20px' }}>

          {/* Hour summary chips */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
            {[
              { label: 'Est Hours',    value: fmtHrs(totalEst), color: '#1e293b' },
              { label: 'Actual Hours', value: fmtHrs(totalAct), color: overBudget ? '#ef4444' : '#0f172a' },
              { label: 'Remaining',    value: fmtHrs(totalRem), color: totalRem < 0 ? '#ef4444' : '#15803d' },
            ].map(({ label, value, color }) => (
              <div key={label} style={{
                flex: '1 1 80px', background: '#f8fafc', borderRadius: 10, padding: '10px 14px', textAlign: 'center',
              }}>
                <div style={{ fontSize: 20, fontWeight: 800, color }}>{value}</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Work tickets */}
          <div style={{ marginBottom: 20 }}>
            <div style={SECTION_LABEL}>Work Tickets This Month</div>
            <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
              {data.tickets.length === 0 ? (
                <div style={{ padding: 16, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
                  No tickets found for this month
                </div>
              ) : data.tickets.map((t, i) => {
                const est = t.HoursEst ?? 0;
                const act = t.HoursAct ?? 0;
                const rem = est - act;
                return (
                  <div key={t.WorkTicketID} style={{
                    padding: '12px 14px',
                    background: i % 2 === 0 ? '#fff' : '#f8fafc',
                    borderTop: i > 0 ? '1px solid #f1f5f9' : undefined,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <span style={{ fontSize: 12, color: '#64748b' }}>#{t.WorkTicketNumber}</span>
                      <StatusBadge status={t.WorkTicketStatusName || '—'} />
                    </div>
                    <div style={{ display: 'flex', gap: 12, fontSize: 12, marginBottom: 6 }}>
                      <span style={{ color: '#94a3b8' }}>{(t.ScheduledStartDate || '').slice(0, 10) || '—'}</span>
                      <span><span style={{ color: '#94a3b8' }}>Est </span><strong>{fmtHrs(est)}</strong></span>
                      <span><span style={{ color: '#94a3b8' }}>Act </span><strong style={{ color: act > est && est > 0 ? '#ef4444' : undefined }}>{fmtHrs(act)}</strong></span>
                      <span><span style={{ color: '#94a3b8' }}>Rem </span><strong style={{ color: rem < 0 ? '#ef4444' : '#15803d' }}>{fmtHrs(rem)}</strong></span>
                    </div>
                    <HoursBar est={est} act={act} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* AI coaching tip */}
          {data.ai_tip && (
            <div style={{
              background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10,
              padding: '16px 18px', marginBottom: 24,
            }}>
              <div style={{ fontWeight: 700, fontSize: 11, color: '#15803d', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                💡 Coaching Tips for Today
              </div>
              {tipParagraphs.map((p, i) => (
                <p key={i} style={{ margin: i < tipParagraphs.length - 1 ? '0 0 10px' : 0, fontSize: 14, color: '#1e293b', lineHeight: 1.6 }}>
                  {p}
                </p>
              ))}
            </div>
          )}

          {/* Response form */}
          <form onSubmit={handleSubmit}>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a', marginBottom: 18 }}>
              Your Daily Update
            </div>

            {/* Remaining hours */}
            <div style={{ marginBottom: 16 }}>
              <label style={LABEL}>Estimated hours remaining on active ticket(s)</label>
              <input
                type="number"
                min="0"
                step="0.5"
                placeholder="e.g. 12.5"
                value={remainingHours}
                onChange={e => setRemainingHours(e.target.value)}
                style={INPUT}
              />
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                Your best estimate — helps the team plan ahead
              </div>
            </div>

            {/* Approach / plan */}
            <div style={{ marginBottom: 16 }}>
              <label style={LABEL}>
                Today's plan &amp; approach <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <textarea
                required
                rows={5}
                placeholder="What's your plan for moving the project forward today? What will the crew focus on? Any adjustments to the approach?"
                value={approachNotes}
                onChange={e => setApproachNotes(e.target.value)}
                style={{ ...INPUT, resize: 'vertical', minHeight: 120 }}
              />
            </div>

            {/* Blockers */}
            <div style={{ marginBottom: 24 }}>
              <label style={LABEL}>Blockers or issues (optional)</label>
              <textarea
                rows={3}
                placeholder="Anything slowing you down? Weather, materials, access, crew issues…"
                value={blockers}
                onChange={e => setBlockers(e.target.value)}
                style={{ ...INPUT, resize: 'vertical' }}
              />
            </div>

            <button
              type="submit"
              disabled={submitting || !approachNotes.trim()}
              style={{
                width: '100%', padding: '16px', background: approachNotes.trim() ? '#16a34a' : '#94a3b8',
                color: '#fff', border: 'none', borderRadius: 12, fontWeight: 800,
                fontSize: 17, cursor: approachNotes.trim() ? 'pointer' : 'not-allowed',
                transition: 'background .15s',
              }}
            >
              {submitting ? 'Submitting…' : 'Send Update to Team →'}
            </button>
          </form>

        </div>

        <div style={{ padding: '12px 20px', textAlign: 'center', borderTop: '1px solid #f1f5f9' }}>
          <span style={{ fontSize: 11, color: '#cbd5e1' }}>Darios Landscaping · Project Portal</span>
        </div>
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

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
  padding: '22px 20px',
};

const HDR_LABEL: React.CSSProperties = {
  color: '#86efac',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  marginBottom: 6,
};

const HDR_TITLE: React.CSSProperties = {
  color: '#fff',
  fontSize: 22,
  fontWeight: 800,
  lineHeight: 1.2,
};

const HDR_SUB: React.CSSProperties = {
  color: '#4ade80',
  fontSize: 13,
  marginTop: 4,
};

const SECTION_LABEL: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 11,
  color: '#94a3b8',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: 8,
};

const NOTE_BOX: React.CSSProperties = {
  background: '#f8fafc',
  borderRadius: 8,
  padding: '14px 16px',
  fontSize: 14,
  color: '#1e293b',
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
};

const LABEL: React.CSSProperties = {
  display: 'block',
  fontWeight: 600,
  fontSize: 13,
  color: '#374151',
  marginBottom: 6,
};

const INPUT: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  border: '1.5px solid #e2e8f0',
  borderRadius: 10,
  fontSize: 15,
  color: '#0f172a',
  background: '#fff',
  boxSizing: 'border-box',
  outline: 'none',
  fontFamily: 'inherit',
};
