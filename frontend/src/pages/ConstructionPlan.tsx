/**
 * Construction Monthly Plan
 * Leads commit jobs to a month and track progress vs. goal.
 * Route: /dashboards/construction/plan
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  getMonthlyPlan, setMonthlyGoal, addJobToMonth, removeJobFromMonth, getPlanSuggestions,
  listConstructionLeads, upsertConstructionLead, deleteConstructionLead,
  sendCheckins, getCheckinStatus, setJobPlanning,
  MonthlyPlan, PlanJob, PlanSuggestion, ConstructionLead, CheckinStatus,
} from '../lib/api';
import JobPrepChecklist from './JobPrepChecklist';

// Workflow stages (must match the backend STAGES list)
const STAGES = ['New', 'Planning', 'Set for Production', 'Lead Assigned', 'In Production',
                'Complete', 'Ready to Invoice', 'Invoiced', 'Paid'] as const;
const STAGE_COLOR: Record<string, { bg: string; text: string }> = {
  'New':                { bg: '#f1f5f9', text: '#475569' },
  'Planning':           { bg: '#eff6ff', text: '#1d4ed8' },
  'Set for Production':  { bg: '#fef3c7', text: '#92400e' },
  'Lead Assigned':      { bg: '#f3e8ff', text: '#7e22ce' },
  'In Production':      { bg: '#ffedd5', text: '#c2410c' },
  'Complete':           { bg: '#dcfce7', text: '#15803d' },
  'Ready to Invoice':    { bg: '#cffafe', text: '#0e7490' },
  'Invoiced':           { bg: '#e0e7ff', text: '#4338ca' },
  'Paid':               { bg: '#a7f3d0', text: '#065f46' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n: number | null | undefined): string {
  if (n == null || n === 0) return '—';
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n);
}
function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n.toFixed(0)}%`;
}
function fmtH(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n.toFixed(1)}h`;
}
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(m: string): string {
  try {
    const [y, mo] = m.split('-').map(Number);
    // Use local-time constructor — new Date("YYYY-MM-01") is parsed as UTC
    // which shifts the date one month back in Pacific time (UTC-7).
    return new Date(y, mo - 1, 1).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
  } catch { return m; }
}
function prevMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
}
function nextMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function GoalBar({ label, actual, goal, unit = '$' }: {
  label: string; actual: number; goal: number | null; unit?: string;
}) {
  const pct = goal && goal > 0 ? Math.min((actual / goal) * 100, 100) : 0;
  const over = goal && actual > goal;
  const color = over ? '#16a34a' : pct >= 75 ? '#16a34a' : pct >= 40 ? '#f59e0b' : '#ef4444';
  const noGoal = !goal;

  return (
    <div style={{ flex: 1, minWidth: 220 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, alignItems: 'baseline' }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: '#374151' }}>{label}</span>
        <span style={{ fontSize: 13, color: '#6b7280' }}>
          <span style={{ fontWeight: 700, color: '#111827' }}>
            {unit === '$' ? fmt$(actual) : fmtH(actual)}
          </span>
          {goal ? <span style={{ color: '#9ca3af' }}> / {unit === '$' ? fmt$(goal) : fmtH(goal)}</span> : ' (no goal set)'}
        </span>
      </div>
      <div style={{ background: '#e5e7eb', borderRadius: 999, height: 18, overflow: 'hidden' }}>
        {noGoal
          ? <div style={{ width: '100%', height: '100%', background: '#f3f4f6', borderRadius: 999 }} />
          : <div style={{
              width: `${pct}%`, height: '100%',
              background: `linear-gradient(90deg, ${color}99, ${color})`,
              borderRadius: 999, transition: 'width 0.6s ease',
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
              paddingRight: pct > 10 ? 6 : 0,
            }}>
              {pct > 15 && <span style={{ color: '#fff', fontSize: 11, fontWeight: 700 }}>{pct.toFixed(0)}%</span>}
            </div>
        }
      </div>
    </div>
  );
}

// ── Risk badge ────────────────────────────────────────────────────────────────

function RiskBadge({ risk }: { risk: PlanJob['risk'] }) {
  const map = {
    over_budget: { bg: '#fee2e2', fg: '#dc2626', label: '⛔ Over budget' },
    at_risk:     { bg: '#fef3c7', fg: '#d97706', label: '⚠️ At risk' },
    on_track:    { bg: '#dcfce7', fg: '#15803d', label: '✓ On track' },
    complete:    { bg: '#f1f5f9', fg: '#475569', label: '✅ Complete' },
  };
  const { bg, fg, label } = map[risk] || map.on_track;
  return (
    <span style={{
      background: bg, color: fg, padding: '2px 8px',
      borderRadius: 10, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

// ── Inline hours bar ──────────────────────────────────────────────────────────

function HrsBar({ act, est }: { act: number; est: number }) {
  const pct = est > 0 ? Math.min((act / est) * 100, 100) : 0;
  const over = est > 0 && act > est;
  const color = over ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#22c55e';
  return (
    <div>
      <div style={{ fontSize: 12, color: '#374151', marginBottom: 3 }}>
        {fmtH(act)} <span style={{ color: '#9ca3af' }}>/ {fmtH(est)}</span>
      </div>
      <div style={{ background: '#e5e7eb', borderRadius: 999, height: 6, width: 90, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 999 }} />
      </div>
    </div>
  );
}

// ── Goal editor modal ─────────────────────────────────────────────────────────

function GoalEditor({ month, goal, onSave, onClose }: {
  month: string;
  goal: MonthlyPlan['goal'];
  onSave: (g: { revenue_goal: number | null; hours_goal: number | null; notes: string }) => void;
  onClose: () => void;
}) {
  const [rev, setRev]   = useState(goal.revenue_goal != null ? String(goal.revenue_goal) : '');
  const [hrs, setHrs]   = useState(goal.hours_goal != null ? String(goal.hours_goal) : '');
  const [notes, setNotes] = useState(goal.notes || '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    onSave({
      revenue_goal: rev ? parseFloat(rev) : null,
      hours_goal:   hrs ? parseFloat(hrs) : null,
      notes,
    });
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: '#fff', borderRadius: 14, padding: 28,
        width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20, color: '#111827' }}>
          Set Goals — {monthLabel(month)}
        </div>
        <label style={{ display: 'block', marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: '#374151', fontWeight: 600, marginBottom: 6 }}>Revenue Target (CAD)</div>
          <input
            type="number" value={rev} onChange={e => setRev(e.target.value)}
            placeholder="e.g. 250000"
            style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: '#374151', fontWeight: 600, marginBottom: 6 }}>Hours Target</div>
          <input
            type="number" value={hrs} onChange={e => setHrs(e.target.value)}
            placeholder="e.g. 400"
            style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 24 }}>
          <div style={{ fontSize: 13, color: '#374151', fontWeight: 600, marginBottom: 6 }}>Notes</div>
          <textarea
            value={notes} onChange={e => setNotes(e.target.value)}
            rows={2} placeholder="Optional notes for the month"
            style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', resize: 'vertical' }}
          />
        </label>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{
            padding: '8px 18px', borderRadius: 8, border: 'none',
            background: '#1d4ed8', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13,
          }}>Save Goals</button>
        </div>
      </div>
    </div>
  );
}

// ── Add Job panel ─────────────────────────────────────────────────────────────

function AddJobPanel({ month, onAdded, onClose }: {
  month: string;
  onAdded: () => void;
  onClose: () => void;
}) {
  const [suggestions,    setSuggestions]    = useState<PlanSuggestion[]>([]);
  const [scheduledCount, setScheduledCount] = useState(0);
  const [q, setQ]         = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding]   = useState<number | null>(null);

  useEffect(() => {
    getPlanSuggestions(month).then(r => {
      setSuggestions(r.suggestions);
      setScheduledCount(r.scheduled_count ?? 0);
      setLoading(false);
    });
  }, [month]);

  const filtered = q.trim()
    ? suggestions.filter(s =>
        (s.opportunity_name + ' ' + s.property_name).toLowerCase().includes(q.toLowerCase()))
    : suggestions;

  const filteredScheduled = filtered.filter(s => s.has_scheduled);
  const filteredOther     = filtered.filter(s => !s.has_scheduled);

  const add = async (s: PlanSuggestion) => {
    setAdding(s.opportunity_id);
    await addJobToMonth(month, {
      opportunity_id:   s.opportunity_id,
      opportunity_name: s.opportunity_name,
      property_name:    s.property_name,
    });
    onAdded();
  };

  const SuggestionRow = ({ s }: { s: PlanSuggestion }) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 12px', borderRadius: 8, marginBottom: 4,
      background: s.has_scheduled ? '#eff6ff' : '#f9fafb',
      border: `1px solid ${s.has_scheduled ? '#bfdbfe' : '#f3f4f6'}`,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s.property_name || s.opportunity_name}
          </span>
          {s.has_scheduled && (
            <span style={{
              background: '#dbeafe', color: '#1d4ed8', fontSize: 10, fontWeight: 700,
              padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', flexShrink: 0,
            }}>
              📅 {s.ticket_count} ticket{s.ticket_count !== 1 ? 's' : ''} this month
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
          {s.opportunity_name}
          {s.won_dollars > 0 && <span style={{ marginLeft: 8, color: '#374151' }}>{fmt$(s.won_dollars)}</span>}
          {s.hrs_est > 0 && <span style={{ marginLeft: 8 }}>{fmtH(s.hrs_est)} est</span>}
          <span style={{ marginLeft: 8, background: '#e5e7eb', borderRadius: 8, padding: '1px 6px' }}>{s.status}</span>
        </div>
      </div>
      <button
        onClick={() => add(s)}
        disabled={adding === s.opportunity_id}
        style={{
          padding: '5px 14px', borderRadius: 8, border: 'none',
          background: adding === s.opportunity_id ? '#9ca3af' : '#1d4ed8',
          color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13, flexShrink: 0,
        }}
      >
        {adding === s.opportunity_id ? '…' : '+ Add'}
      </button>
    </div>
  );

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: '#fff', borderRadius: 14, padding: 24,
        width: 560, maxHeight: '82vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#111827' }}>Add Job — {monthLabel(month)}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#9ca3af' }}>✕</button>
        </div>
        {!loading && scheduledCount > 0 && (
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
            📅 <strong>{scheduledCount}</strong> job{scheduledCount !== 1 ? 's' : ''} have work tickets scheduled in Aspire for {monthLabel(month)}
          </div>
        )}
        <input
          autoFocus
          placeholder="Search by property or job name…"
          value={q} onChange={e => setQ(e.target.value)}
          style={{
            width: '100%', padding: '9px 14px', border: '1px solid #d1d5db',
            borderRadius: 8, fontSize: 14, marginBottom: 14, boxSizing: 'border-box',
          }}
        />
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading && <div style={{ color: '#9ca3af', padding: 20, textAlign: 'center' }}>Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div style={{ color: '#9ca3af', padding: 20, textAlign: 'center' }}>No results</div>
          )}

          {/* Tier 1 — scheduled work tickets this month */}
          {filteredScheduled.length > 0 && (
            <>
              <div style={{
                fontSize: 11, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase',
                letterSpacing: '0.06em', marginBottom: 8,
              }}>
                📅 Scheduled this month
              </div>
              {filteredScheduled.map(s => <SuggestionRow key={s.opportunity_id} s={s} />)}
            </>
          )}

          {/* Tier 2 — other active construction opps */}
          {filteredOther.length > 0 && (
            <>
              <div style={{
                fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
                letterSpacing: '0.06em', margin: `${filteredScheduled.length > 0 ? 16 : 0}px 0 8px`,
              }}>
                Other Active Jobs
              </div>
              {filteredOther.map(s => <SuggestionRow key={s.opportunity_id} s={s} />)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Leads Manager modal ───────────────────────────────────────────────────────

function LeadsModal({ onClose }: { onClose: () => void }) {
  const [leads,   setLeads]   = useState<ConstructionLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [name,    setName]    = useState('');
  const [email,   setEmail]   = useState('');
  const [display, setDisplay] = useState('');
  const [saving,  setSaving]  = useState(false);

  const load = async () => {
    setLoading(true);
    try { setLeads(await listConstructionLeads()); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    setSaving(true);
    try {
      await upsertConstructionLead(name.trim(), email.trim(), display.trim() || undefined);
      setName(''); setEmail(''); setDisplay('');
      load();
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Remove this lead?')) return;
    await deleteConstructionLead(id);
    load();
  };

  return (
    <div style={OVERLAY}>
      <div style={{ ...MODAL_BOX, maxWidth: 560 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>👷 Lead Directory</h2>
          <button onClick={onClose} style={CLOSE_BTN}>✕</button>
        </div>

        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
          Map Aspire <strong>CrewLeaderName</strong> (exactly as it appears on the work ticket) to an email address. The system uses this to send daily check-ins.
        </p>

        {/* Existing leads */}
        {loading ? <div style={{ textAlign: 'center', color: '#94a3b8', padding: 20 }}>Loading…</div> : (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
            {leads.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
                No leads configured yet
              </div>
            ) : leads.map((l, i) => (
              <div key={l.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                background: i % 2 === 0 ? '#fff' : '#f9fafb',
                borderTop: i > 0 ? '1px solid #f1f5f9' : undefined,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>{l.display_name || l.aspire_name}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>
                    Aspire: <code style={{ background: '#f1f5f9', padding: '1px 5px', borderRadius: 4 }}>{l.aspire_name}</code>
                    &nbsp;· {l.email}
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(l.id)}
                  style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 16, padding: '2px 6px' }}
                >✕</button>
              </div>
            ))}
          </div>
        )}

        {/* Add new lead */}
        <form onSubmit={handleAdd}>
          <div style={{ fontWeight: 600, fontSize: 13, color: '#374151', marginBottom: 10 }}>Add / Update Lead</div>
          <div style={{ display: 'grid', gap: 8 }}>
            <input
              value={name} onChange={e => setName(e.target.value)}
              placeholder="Aspire CrewLeaderName (exact match)"
              required
              style={FIELD_INPUT}
            />
            <input
              value={email} onChange={e => setEmail(e.target.value)}
              placeholder="Email address"
              type="email" required
              style={FIELD_INPUT}
            />
            <input
              value={display} onChange={e => setDisplay(e.target.value)}
              placeholder="Display name for email greeting (optional)"
              style={FIELD_INPUT}
            />
            <button type="submit" disabled={saving} style={{ ...primaryBtn, width: '100%' }}>
              {saving ? 'Saving…' : 'Save Lead'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Check-in Status panel ─────────────────────────────────────────────────────

function CheckinStatusPanel({ month, onClose }: { month: string; onClose: () => void }) {
  const [status,  setStatus]  = useState<CheckinStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [result,  setResult]  = useState('');

  const load = async () => {
    setLoading(true);
    try { setStatus(await getCheckinStatus(month)); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [month]);

  const handleSend = async () => {
    if (!confirm('Send daily check-in emails to all leads with active projects this month?')) return;
    setSending(true);
    try {
      const r = await sendCheckins(month);
      setResult(`✅ Sent ${r.sent} · Skipped ${r.skipped}`);
      load();
    } catch (e: any) {
      setResult(`❌ ${e.message}`);
    } finally { setSending(false); }
  };

  const today = new Date().toISOString().slice(0, 10);
  const todayRows = status.filter(r => r.sent_at.slice(0, 10) === today);

  return (
    <div style={OVERLAY}>
      <div style={{ ...MODAL_BOX, maxWidth: 620 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>📤 Daily Check-ins</h2>
          <button onClick={onClose} style={CLOSE_BTN}>✕</button>
        </div>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
          Check-ins send automatically at 6 AM Pacific. Use the button below to trigger them now.
        </p>

        <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center' }}>
          <button onClick={handleSend} disabled={sending} style={primaryBtn}>
            {sending ? 'Sending…' : '📤 Send Check-ins Now'}
          </button>
          {result && <span style={{ fontSize: 13, color: '#374151' }}>{result}</span>}
        </div>

        {loading ? <div style={{ textAlign: 'center', color: '#94a3b8', padding: 20 }}>Loading…</div> : (
          <>
            {todayRows.length > 0 && (
              <>
                <div style={{ fontWeight: 700, fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Today</div>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
                  {todayRows.map((r, i) => (
                    <div key={r.id} style={{
                      padding: '12px 14px', background: i % 2 === 0 ? '#fff' : '#f9fafb',
                      borderTop: i > 0 ? '1px solid #f1f5f9' : undefined,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>
                            {r.property_name || r.opportunity_name}
                          </div>
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{r.lead_name} · {r.lead_email}</div>
                        </div>
                        {r.responded_at
                          ? <span style={{ background: '#dcfce7', color: '#15803d', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>✓ Responded</span>
                          : <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>Awaiting</span>
                        }
                      </div>
                      {r.approach_notes && (
                        <div style={{ marginTop: 8, background: '#f8fafc', borderRadius: 6, padding: '8px 10px', fontSize: 12, color: '#374151', lineHeight: 1.5 }}>
                          {r.approach_notes}
                          {r.remaining_hours != null && (
                            <span style={{ marginLeft: 8, color: '#15803d', fontWeight: 700 }}>{r.remaining_hours}h remaining est.</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
            {status.filter(r => r.sent_at.slice(0, 10) !== today).length > 0 && (
              <>
                <div style={{ fontWeight: 700, fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Earlier This Month</div>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                  {status.filter(r => r.sent_at.slice(0, 10) !== today).slice(0, 20).map((r, i) => (
                    <div key={r.id} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '10px 14px', background: i % 2 === 0 ? '#fff' : '#f9fafb',
                      borderTop: i > 0 ? '1px solid #f1f5f9' : undefined, fontSize: 12,
                    }}>
                      <span style={{ color: '#374151', fontWeight: 500 }}>{r.property_name || r.opportunity_name}</span>
                      <span style={{ color: '#94a3b8' }}>{r.sent_at.slice(0, 10)}</span>
                      <span style={{ color: '#64748b' }}>{r.lead_name}</span>
                      {r.responded_at
                        ? <span style={{ color: '#15803d', fontWeight: 600 }}>✓</span>
                        : <span style={{ color: '#f59e0b', fontWeight: 600 }}>—</span>
                      }
                    </div>
                  ))}
                </div>
              </>
            )}
            {status.length === 0 && (
              <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: 24 }}>
                No check-ins sent this month yet
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ConstructionPlan() {
  const [month, setMonth]       = useState(currentMonth());
  const [plan, setPlan]         = useState<MonthlyPlan | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [showGoal,      setShowGoal]      = useState(false);
  const [showAdd,       setShowAdd]       = useState(false);
  const [showLeads,     setShowLeads]     = useState(false);
  const [showCheckin,   setShowCheckin]   = useState(false);
  const [prepFor,       setPrepFor]       = useState<number | null>(null);
  // Live prep counts per opp (overrides server value as the user checks items)
  const [prepProgress,  setPrepProgress]  = useState<Record<number, { done: number; total: number }>>({});
  // Construction leads (for the per-job Lead dropdown)
  const [leads, setLeads] = useState<ConstructionLead[]>([]);
  // Optimistic per-job planning state (lead / schedule confirmed / stage)
  const [planningOverride, setPlanningOverride] = useState<Record<number, { lead_name?: string; schedule_confirmed?: boolean; stage?: string }>>({});
  // Work queue — construction jobs not yet in this month's plan (pipeline)
  const [queue, setQueue]               = useState<PlanSuggestion[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueOpen, setQueueOpen]       = useState(true);
  const activeMonthRef = useRef(month);

  const load = useCallback(async () => {
    activeMonthRef.current = month;
    setLoading(true);
    setError('');
    try {
      const data = await getMonthlyPlan(month);
      // Discard stale responses — user may have switched months while this was in-flight
      if (activeMonthRef.current !== month) return;
      setPlan(data);
    } catch (e: any) {
      if (activeMonthRef.current !== month) return;
      setError(e.message || 'Failed to load plan');
    } finally {
      if (activeMonthRef.current === month) setLoading(false);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  const handleSaveGoal = async (g: { revenue_goal: number | null; hours_goal: number | null; notes: string }) => {
    await setMonthlyGoal(month, g);
    setShowGoal(false);
    load();
  };

  const handleRemove = async (oppId: number) => {
    await removeJobFromMonth(month, oppId);
    load();
  };

  // Load construction leads once (Lead dropdown options)
  useEffect(() => { listConstructionLeads().then(setLeads).catch(() => {}); }, []);

  // Work queue — pipeline of jobs not yet in this month's plan
  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    try { const r = await getPlanSuggestions(month); setQueue(r.suggestions || []); }
    catch { setQueue([]); }
    finally { setQueueLoading(false); }
  }, [month]);
  useEffect(() => { loadQueue(); }, [loadQueue]);

  const planUserName = (): string => {
    try { return JSON.parse(localStorage.getItem('ap_user') || '{}').name || ''; } catch { return ''; }
  };

  const updatePlanning = async (oppId: number, patch: { lead_name?: string; schedule_confirmed?: boolean; stage?: string }) => {
    setPlanningOverride(prev => ({ ...prev, [oppId]: { ...prev[oppId], ...patch } }));
    try { await setJobPlanning(oppId, { ...patch, updated_by: planUserName() || undefined }); }
    catch { alert('Could not save — please try again'); load(); }
  };

  const addFromQueue = async (s: PlanSuggestion) => {
    await addJobToMonth(month, {
      opportunity_id: s.opportunity_id, opportunity_name: s.opportunity_name, property_name: s.property_name,
    });
    await Promise.all([load(), loadQueue()]);
  };

  const { goal, jobs, summary } = plan || { goal: { month, revenue_goal: null, hours_goal: null, notes: null }, jobs: [], summary: { job_count: 0, scheduled_count: 0, manual_count: 0, days_left: 0, hrs_est: 0, hrs_act: 0, hrs_est_month: 0, hrs_act_month: 0, revenue_est: 0, revenue_act: 0, revenue_act_month: 0, revenue_est_month: 0 } };


  const overBudget = jobs.filter(j => j.risk === 'over_budget');
  const atRisk     = jobs.filter(j => j.risk === 'at_risk');
  const onTrack    = jobs.filter(j => j.risk === 'on_track');
  const complete   = jobs.filter(j => j.risk === 'complete');

  return (
    <div style={{
      minHeight: '100vh', background: '#f8fafc',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      padding: '24px 20px',
    }}>
      {/* Header */}
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>
              🏗️ Construction Monthly Plan
            </h1>
            <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
              Commit jobs, track progress, update leads
            </p>
          </div>

          {/* Month navigator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => setMonth(prevMonth(month))} style={navBtn}>‹</button>
            <div style={{
              padding: '6px 18px', background: '#fff', border: '1px solid #e5e7eb',
              borderRadius: 8, fontWeight: 700, fontSize: 14, color: '#1f2937',
              minWidth: 130, textAlign: 'center',
            }}>
              {monthLabel(month)}
            </div>
            <button onClick={() => setMonth(nextMonth(month))} style={navBtn}>›</button>
            {month !== currentMonth() && (
              <button onClick={() => setMonth(currentMonth())} style={{ ...navBtn, fontSize: 11, padding: '4px 10px' }}>
                Today
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setShowLeads(true)}   style={secondaryBtn}>👷 Leads</button>
            <button onClick={() => setShowCheckin(true)} style={secondaryBtn}>📤 Check-ins</button>
            <button onClick={() => setShowGoal(true)}    style={secondaryBtn}>⚙️ Goals</button>
            <button onClick={() => setShowAdd(true)}     style={primaryBtn}>+ Add Job</button>
          </div>
        </div>

        {/* Goal progress bars + projected totals */}
        <div style={{
          background: '#fff', borderRadius: 14, padding: '20px 24px',
          border: '1px solid #e5e7eb', marginBottom: 20,
          boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
        }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#374151' }}>Monthly Goals</span>
            {summary.days_left > 0
              ? <span style={{ background: '#eff6ff', color: '#1d4ed8', padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>
                  {summary.days_left}d remaining
                </span>
              : <span style={{ background: '#f1f5f9', color: '#64748b', padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>
                  Month complete
                </span>
            }
            <span style={{ background: '#f1f5f9', color: '#374151', padding: '2px 10px', borderRadius: 20, fontSize: 12 }}>
              {summary.job_count} job{summary.job_count !== 1 ? 's' : ''} committed
            </span>
          </div>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            {/* Revenue bar tracks projected month revenue (sum of committed jobs) vs goal —
                earned is shown in the detail line below and is 0 until tickets complete. */}
            <GoalBar label="Revenue" actual={summary.revenue_est_month} goal={goal.revenue_goal} unit="$" />
            <GoalBar label="Hours" actual={summary.hrs_act_month} goal={goal.hours_goal} unit="h" />
          </div>
          {goal.notes && (
            <div style={{ marginTop: 12, fontSize: 13, color: '#6b7280', fontStyle: 'italic' }}>
              {goal.notes}
            </div>
          )}

          {/* Projected totals — ticket-based, this month only */}
          {!loading && jobs.length > 0 && (
            <div style={{
              marginTop: 16, paddingTop: 16, borderTop: '1px solid #f1f5f9',
              display: 'flex', gap: 32, flexWrap: 'wrap', fontSize: 13,
            }}>
              <div>
                <span style={{ color: '#6b7280' }}>Ticket hours this month: </span>
                <strong style={{ color: '#111827' }}>{fmtH(summary.hrs_act_month)}</strong>
                <span style={{ color: '#9ca3af' }}> actual / </span>
                <strong style={{ color: '#111827' }}>{fmtH(summary.hrs_est_month)}</strong>
                <span style={{ color: '#9ca3af' }}> projected</span>
              </div>
              <div>
                <span style={{ color: '#6b7280' }}>Earned revenue this month: </span>
                <strong style={{ color: '#111827' }}>{fmt$(summary.revenue_act_month)}</strong>
                <span style={{ color: '#9ca3af' }}> earned / </span>
                <strong style={{ color: '#111827' }}>{fmt$(summary.revenue_est_month)}</strong>
                <span style={{ color: '#9ca3af' }}> projected</span>
              </div>
            </div>
          )}
        </div>

        {/* Error / loading */}
        {loading && <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading plan…</div>}
        {error && <div style={{ background: '#fee2e2', color: '#dc2626', padding: 16, borderRadius: 8, marginBottom: 16 }}>{error}</div>}

        {/* Source legend */}
        {!loading && jobs.length > 0 && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' }}>
            <span>📅 <strong>{summary.scheduled_count}</strong> scheduled from Aspire work tickets</span>
            {summary.manual_count > 0 && <span>· 📌 <strong>{summary.manual_count}</strong> manually added</span>}
          </div>
        )}

        {/* Alerts */}
        {!loading && (overBudget.length > 0 || atRisk.length > 0) && (
          <div style={{
            background: '#fef9c3', border: '1px solid #fde047',
            borderRadius: 10, padding: '12px 16px', marginBottom: 16,
            fontSize: 13, color: '#713f12',
          }}>
            {overBudget.length > 0 && <span>⛔ <strong>{overBudget.length}</strong> job{overBudget.length > 1 ? 's' : ''} over budget — review urgently. </span>}
            {atRisk.length > 0 && <span>⚠️ <strong>{atRisk.length}</strong> job{atRisk.length > 1 ? 's' : ''} at risk — hours burning faster than progress.</span>}
          </div>
        )}

        {/* Jobs table */}
        {!loading && jobs.length === 0 && (
          <div style={{
            background: '#fff', borderRadius: 14, padding: 40,
            border: '1px solid #e5e7eb', textAlign: 'center',
            color: '#9ca3af', fontSize: 14,
          }}>
            No jobs committed to {monthLabel(month)} yet.<br />
            <button onClick={() => setShowAdd(true)} style={{ ...primaryBtn, marginTop: 16 }}>
              + Add First Job
            </button>
          </div>
        )}

        {jobs.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e5e7eb' }}>
                  {['Property / Job', 'Lead', 'Confirmed', '% This Month', 'Hours', 'Revenue', 'Stage', 'Prep', ''].map((h, i) => (
                    <th key={i} style={{
                      padding: '8px 10px', textAlign: i === 0 ? 'left' : 'center',
                      fontSize: 11, fontWeight: 700, color: '#6b7280',
                      letterSpacing: '0.06em', textTransform: 'uppercase',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.map((j, idx) => (
                  <React.Fragment key={j.opportunity_id}>
                  <tr style={{
                    borderBottom: idx < jobs.length - 1 ? '1px solid #f3f4f6' : 'none',
                    background: j.risk === 'over_budget' ? '#fff5f5' : j.risk === 'at_risk' ? '#fffbeb' : '#fff',
                  }}>
                    {/* Property / Job */}
                    <td style={{ padding: '8px 10px', verticalAlign: 'middle' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {/* Property name → opens the Construction Job in our system */}
                        <a
                          href={`/field/project/${j.opportunity_id}`}
                          title="Open Construction Job"
                          style={{ fontWeight: 600, fontSize: 13, color: '#111827', textDecoration: 'none' }}
                          onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                          onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                        >
                          {j.property_name || j.opportunity_name}
                        </a>
                        {j.source === 'scheduled' || j.source === 'both'
                          ? <span style={{ background: '#eff6ff', color: '#1d4ed8', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8 }}>
                              📅 {j.completed_tickets}/{j.ticket_count} done
                            </span>
                          : <span style={{ background: '#f5f3ff', color: '#7c3aed', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8 }}>
                              📌 Added
                            </span>
                        }
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                        {/* Opportunity name → opens the opportunity in Aspire */}
                        <a
                          href={j.aspire_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open in Aspire"
                          style={{ color: '#2563eb', textDecoration: 'none' }}
                          onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                          onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                        >
                          {j.opportunity_name} ↗
                        </a>
                        {j.opp_number ? ` · #${j.opp_number}` : ''}
                      </div>
                    </td>

                    {/* Lead */}
                    <td style={{ padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle' }}>
                      {(() => {
                        const lead = planningOverride[j.opportunity_id]?.lead_name ?? j.lead_name ?? '';
                        return (
                          <select
                            value={lead}
                            onChange={e => updatePlanning(j.opportunity_id, { lead_name: e.target.value })}
                            style={{
                              fontSize: 11, padding: '3px 6px', borderRadius: 6, fontFamily: 'inherit', maxWidth: 140,
                              border: '1px solid ' + (lead ? '#c7d2fe' : '#e5e7eb'),
                              background: lead ? '#eef2ff' : '#fff',
                              color: lead ? '#3730a3' : '#9ca3af',
                            }}
                          >
                            <option value="">Assign…</option>
                            {leads.map(l => {
                              const nm = l.display_name || l.aspire_name;
                              return <option key={l.id} value={nm}>{nm}</option>;
                            })}
                          </select>
                        );
                      })()}
                    </td>

                    {/* Confirmed (schedule confirmed with customer) */}
                    <td style={{ padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle' }}>
                      {(() => {
                        const confirmed = planningOverride[j.opportunity_id]?.schedule_confirmed ?? j.schedule_confirmed ?? false;
                        return (
                          <button
                            onClick={() => updatePlanning(j.opportunity_id, { schedule_confirmed: !confirmed })}
                            title={confirmed ? 'Customer-confirmed schedule' : 'Mark schedule confirmed with customer'}
                            style={{
                              fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20, cursor: 'pointer', whiteSpace: 'nowrap',
                              border: '1px solid ' + (confirmed ? '#86efac' : '#e5e7eb'),
                              background: confirmed ? '#dcfce7' : '#f8fafc',
                              color: confirmed ? '#15803d' : '#6b7280',
                            }}
                          >
                            {confirmed ? '✅ Confirmed' : '📅 Confirm'}
                          </button>
                        );
                      })()}
                    </td>

                    {/* % complete this month */}
                    <td style={{ padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle' }}>
                      <div style={{ fontWeight: 700, fontSize: 15, color: j.pct_complete >= 100 ? '#15803d' : '#1f2937' }}>
                        {j.ticket_count > 0 ? fmtPct(j.pct_complete) : '—'}
                      </div>
                      {j.ticket_count > 0 && (
                        <>
                          <div style={{ background: '#e5e7eb', borderRadius: 999, height: 5, width: 60, margin: '4px auto 0', overflow: 'hidden' }}>
                            <div style={{
                              width: `${Math.min(j.pct_complete, 100)}%`, height: '100%', borderRadius: 999,
                              background: j.pct_complete >= 100 ? '#16a34a' : j.pct_complete >= 50 ? '#f59e0b' : '#6b7280',
                            }} />
                          </div>
                          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
                            {j.completed_tickets}/{j.ticket_count} tickets
                          </div>
                        </>
                      )}
                    </td>

                    {/* Hours — month-specific ticket hours, not lifetime job totals */}
                    <td style={{ padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle' }}>
                      {j.ticket_count > 0
                        ? <HrsBar act={j.hrs_act_month} est={j.hrs_est_month} />
                        : <span style={{ color: '#9ca3af', fontSize: 12 }}>—</span>
                      }
                    </td>

                    {/* Revenue — month-specific from WorkTicketRevenues */}
                    <td style={{ padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle' }}>
                      {j.ticket_count > 0 ? (
                        <>
                          <div style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>
                            {j.revenue_act_month > 0 ? fmt$(j.revenue_act_month) : '—'}
                          </div>
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>of {fmt$(j.revenue_est_month)}</div>
                        </>
                      ) : (
                        <>
                          <div style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>—</div>
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>of {fmt$(j.revenue_est)}</div>
                        </>
                      )}
                    </td>

                    {/* Stage */}
                    <td style={{ padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle' }}>
                      {(() => {
                        const stage = planningOverride[j.opportunity_id]?.stage ?? j.stage ?? 'New';
                        const c = STAGE_COLOR[stage] || STAGE_COLOR['New'];
                        return (
                          <select
                            value={stage}
                            onChange={e => updatePlanning(j.opportunity_id, { stage: e.target.value })}
                            title="Job stage"
                            style={{
                              fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 8,
                              border: `1px solid ${c.text}33`, background: c.bg, color: c.text,
                              cursor: 'pointer', fontFamily: 'inherit',
                            }}
                          >
                            {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        );
                      })()}
                    </td>

                    {/* Prep checklist toggle */}
                    <td style={{ padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle' }}>
                      {(() => {
                        const p = prepProgress[j.opportunity_id]
                          ?? { done: j.prep_done ?? 0, total: j.prep_total ?? 6 };
                        const ready = p.total > 0 && p.done === p.total;
                        const open  = prepFor === j.opportunity_id;
                        return (
                          <button
                            onClick={() => setPrepFor(open ? null : j.opportunity_id)}
                            title="Preparedness checklist"
                            style={{
                              padding: '3px 10px', fontSize: 11, fontWeight: 700, borderRadius: 6,
                              border: '1px solid ' + (ready ? '#86efac' : open ? '#2563eb' : '#e5e7eb'),
                              background: ready ? '#dcfce7' : open ? '#eff6ff' : '#f8fafc',
                              color: ready ? '#15803d' : open ? '#1d4ed8' : '#6b7280',
                              cursor: 'pointer', whiteSpace: 'nowrap',
                            }}
                          >
                            {ready ? '✓ Ready' : `${p.done}/${p.total}`} {open ? '▲' : '▼'}
                          </button>
                        );
                      })()}
                    </td>

                    {/* Remove — available on all jobs */}
                    <td style={{ padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle' }}>
                      <button
                        onClick={() => handleRemove(j.opportunity_id)}
                        title={
                          j.source === 'scheduled'
                            ? 'Suppress from this month\'s plan (work ticket stays in Aspire)'
                            : j.source === 'both'
                            ? 'Remove manual pin and suppress from plan'
                            : 'Remove from this month\'s plan'
                        }
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: '#d1d5db', fontSize: 16, padding: '2px 6px', borderRadius: 6,
                        }}
                        onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                        onMouseLeave={e => (e.currentTarget.style.color = '#d1d5db')}
                      >✕</button>
                    </td>
                  </tr>
                  {/* Preparedness checklist panel + link to the Construction Project page */}
                  {prepFor === j.opportunity_id && (
                    <tr>
                      <td colSpan={10} style={{ padding: '14px 16px', background: '#f8fafc', borderTop: '1px solid #e5e7eb' }}>
                        <div style={{ maxWidth: 520 }}>
                          <JobPrepChecklist
                            oppId={j.opportunity_id}
                            onProgress={(done, total) =>
                              setPrepProgress(prev => ({ ...prev, [j.opportunity_id]: { done, total } }))
                            }
                          />
                          <a
                            href={`/field/project/${j.opportunity_id}`}
                            style={{
                              display: 'inline-block', marginTop: 12, padding: '8px 14px',
                              background: '#16a34a', color: '#fff', borderRadius: 8,
                              fontSize: 13, fontWeight: 700, textDecoration: 'none',
                            }}
                          >
                            Open Construction Project →
                          </a>
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Summary totals */}
        {jobs.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 13, color: '#6b7280' }}>
            <strong style={{ color: overBudget.length ? '#dc2626' : atRisk.length ? '#d97706' : '#15803d' }}>
              {complete.length} complete · {onTrack.length} on track · {atRisk.length} at risk · {overBudget.length} over budget
            </strong>
          </div>
        )}

        {/* ── Work Queue — construction jobs not yet in this month's plan ────────── */}
        <div style={{ marginTop: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: '#0f172a' }}>
              📋 Work Queue
              <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600, color: '#6b7280' }}>
                {queueLoading ? 'loading…' : `${queue.length} job${queue.length !== 1 ? 's' : ''} not yet in the plan`}
              </span>
            </h2>
            <button
              onClick={() => setQueueOpen(o => !o)}
              style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', cursor: 'pointer' }}
            >
              {queueOpen ? 'Hide' : 'Show'}
            </button>
          </div>

          {queueOpen && (
            queue.length === 0 && !queueLoading ? (
              <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: '20px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                Nothing in the queue — every active construction job is already in the plan.
              </div>
            ) : (
              <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                {queue.map((s, i) => (
                  <div key={s.opportunity_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: i ? '1px solid #f3f4f6' : 'none' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>
                        {s.property_name || s.opportunity_name}
                        {s.has_scheduled && (
                          <span style={{ marginLeft: 8, background: '#eff6ff', color: '#1d4ed8', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8 }}>
                            📅 {s.ticket_count} scheduled
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                        {s.opportunity_name}{s.status ? ` · ${s.status}` : ''}{s.won_dollars ? ` · ${fmt$(s.won_dollars)}` : ''}
                      </div>
                    </div>
                    <button
                      onClick={() => addFromQueue(s)}
                      style={{ padding: '6px 12px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                      + Add to plan
                    </button>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>

      {/* Modals */}
      {showGoal && plan && (
        <GoalEditor month={month} goal={goal} onSave={handleSaveGoal} onClose={() => setShowGoal(false)} />
      )}
      {showAdd && (
        <AddJobPanel month={month} onAdded={() => { setShowAdd(false); load(); }} onClose={() => setShowAdd(false)} />
      )}
      {showLeads && <LeadsModal onClose={() => setShowLeads(false)} />}
      {showCheckin && <CheckinStatusPanel month={month} onClose={() => setShowCheckin(false)} />}
    </div>
  );
}

// ── Button styles ─────────────────────────────────────────────────────────────

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
  padding: '40px 16px', zIndex: 1000, overflowY: 'auto',
};
const MODAL_BOX: React.CSSProperties = {
  background: '#fff', borderRadius: 14, padding: '28px 24px',
  width: '100%', boxShadow: '0 8px 40px rgba(0,0,0,.18)',
};
const CLOSE_BTN: React.CSSProperties = {
  background: 'none', border: 'none', fontSize: 20,
  color: '#6b7280', cursor: 'pointer', padding: '2px 6px',
};
const FIELD_INPUT: React.CSSProperties = {
  width: '100%', padding: '10px 12px', border: '1.5px solid #e5e7eb',
  borderRadius: 8, fontSize: 14, color: '#111827', boxSizing: 'border-box',
  fontFamily: 'inherit',
};
const primaryBtn: React.CSSProperties = {
  padding: '8px 18px', borderRadius: 8, border: 'none',
  background: '#1d4ed8', color: '#fff',
  cursor: 'pointer', fontWeight: 600, fontSize: 13,
};
const secondaryBtn: React.CSSProperties = {
  padding: '8px 18px', borderRadius: 8,
  border: '1px solid #d1d5db', background: '#fff', color: '#374151',
  cursor: 'pointer', fontWeight: 600, fontSize: 13,
};
const navBtn: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 8,
  border: '1px solid #e5e7eb', background: '#fff',
  cursor: 'pointer', fontSize: 16, color: '#374151',
  fontWeight: 700,
};
