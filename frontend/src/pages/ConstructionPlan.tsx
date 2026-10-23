/**
 * Construction Monthly Plan
 * Leads commit jobs to a month and track progress vs. goal.
 * Route: /dashboards/construction/plan
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  getMonthlyPlan, setMonthlyGoal, addJobToMonth, removeJobFromMonth, getPlanSuggestions,
  listConstructionLeads, upsertConstructionLead, deleteConstructionLead,
  sendCheckins, getCheckinStatus, setJobPlanning, listPHA,
  getScheduleWeek, updateBlock,
  listCxTemplates, skipCxAction, unskipCxAction, listCxSkips, currentUser,
  MonthlyPlan, PlanJob, PlanSuggestion, ConstructionLead, CheckinStatus, CxTemplate, CxSkip,
} from '../lib/api';
import JobPrepChecklist from './JobPrepChecklist';
import ProjectHazardAssessment from '../components/ProjectHazardAssessment';
import { ClientCommsModal, CxSetupModal } from '../components/ClientComms';

// opportunity_id → best PHA status (submitted beats draft)
type PHAStatus = 'outstanding' | 'draft' | 'completed';
type PHAInfo = { status: PHAStatus; id: number; submitted_at?: string | null };
type PHAMap = Map<number, PHAInfo>;

// opportunity_id → its schedule block (from the board; the window's source of truth)
type BlockInfo = { id: number; status: 'tentative' | 'confirmed'; start: string; window_week: string; lead: string };
type BlockMap = Map<number, BlockInfo>;
function mondayOf(iso: string): string {
  try { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
  catch { return iso; }
}

function PHABadge({ info, onClick }: { info: PHAInfo | undefined; onClick: () => void }) {
  const cfg = info?.status === 'completed'
    ? { bg: '#dcfce7', fg: '#15803d', label: '✅ PHA' }
    : info?.status === 'draft'
    ? { bg: '#dbeafe', fg: '#1d4ed8', label: '📝 PHA draft' }
    : { bg: '#fef3c7', fg: '#92400e', label: '⚠ No PHA' };
  const submittedOn = info?.submitted_at ? new Date(info.submitted_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick(); }}
      title={info?.status === 'completed' ? `PHA submitted${submittedOn ? ' ' + submittedOn : ''} — view` : info?.status === 'draft' ? 'PHA in draft — continue' : 'Create project hazard assessment'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, background: cfg.bg, color: cfg.fg,
        border: 'none', borderRadius: 8, padding: '1px 7px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
      }}
    >
      {cfg.label}
    </button>
  );
}

// Workflow stages (must match the backend STAGES list)
const STAGES = ['New', 'Planning', 'Set for Production', 'Lead Assigned', 'In Production',
                'Complete', 'Ready to Invoice', 'Invoiced', 'Paid'] as const;
// Stages that mean a job is out of production → Completed bucket (must match backend COMPLETE_STAGES)
const COMPLETE_STAGES = new Set(['Complete', 'Ready to Invoice', 'Invoiced', 'Paid']);
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
function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}
// Change orders are named like "… CO2 …" / "… CO 4 …" and share the base job's OpportunityNumber.
const CO_RE = /\bco\s*\d+\b/i;
function isChangeOrder(name: string | null | undefined): boolean {
  return CO_RE.test(name || '');
}
interface JobGroup { base: PlanJob; children: PlanJob[]; }
/** Group jobs by shared opp_number (base job first, change-order rows as children). */
function groupJobs(list: PlanJob[]): JobGroup[] {
  const groups = new Map<string, PlanJob[]>();
  const order: string[] = [];
  for (const j of list) {
    const key = j.opp_number != null ? `n:${j.opp_number}` : `id:${j.opportunity_id}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(j);
  }
  return order.map(key => {
    const arr = [...groups.get(key)!].sort((a, b) => a.opportunity_id - b.opportunity_id);
    const baseIdx = arr.findIndex(j => !isChangeOrder(j.opportunity_name));
    const base = baseIdx >= 0 ? arr[baseIdx] : arr[0];
    const children = arr.filter(j => j !== base);
    return { base, children };
  });
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
  // Optimistic per-job planning state (lead / schedule confirmed / stage / queued)
  const [planningOverride, setPlanningOverride] = useState<Record<number, { lead_name?: string; schedule_confirmed?: boolean; stage?: string; queued?: boolean }>>({});
  // Stage filter for the active plan table ('all' = show every stage)
  const [stageFilter, setStageFilter] = useState<string>('all');
  // Work queue — construction jobs not yet in this month's plan (pipeline)
  const [queue, setQueue]               = useState<PlanSuggestion[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueOpen, setQueueOpen]       = useState(true);
  const [showUpcoming,  setShowUpcoming]  = useState(true);
  const [showCompleted, setShowCompleted] = useState(false);
  const [phaMap,        setPhaMap]        = useState<PHAMap>(new Map());
  const [phaModalJob,   setPhaModalJob]   = useState<PlanJob | null>(null);
  const [view,          setView]          = useState<'pipeline' | 'monthly'>('pipeline');
  const [commsJob,      setCommsJob]      = useState<PlanJob | null>(null);
  const [commsTmpl,     setCommsTmpl]     = useState<string | undefined>(undefined);
  const [showCxSetup,   setShowCxSetup]   = useState(false);
  const [cxTemplates,   setCxTemplates]   = useState<CxTemplate[]>([]);
  const [cxSkips,       setCxSkips]       = useState<CxSkip[]>([]);
  const [showEmailCenter, setShowEmailCenter] = useState(false);
  const [hoverComms,    setHoverComms]    = useState<number | null>(null);
  const [commsFor,      setCommsFor]      = useState<number | null>(null);
  const [emailFilter,   setEmailFilter]   = useState<'all' | 'due' | 'overdue'>('all');
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

  const updatePlanning = async (oppId: number, patch: { lead_name?: string; schedule_confirmed?: boolean; stage?: string; queued?: boolean }) => {
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

  // Effective (override-aware) reads for optimistic UI
  async function loadPha() {
    try {
      const all = await listPHA();
      const m: PHAMap = new Map();
      for (const a of all) {
        if (a.opportunity_id == null) continue;
        const status: PHAStatus = a.status === 'submitted' ? 'completed' : 'draft';
        const prev = m.get(a.opportunity_id);
        if (!prev || (prev.status !== 'completed' && status === 'completed')) {
          m.set(a.opportunity_id, { status, id: a.id, submitted_at: a.submitted_at });
        }
      }
      setPhaMap(m);
    } catch { /* non-fatal — badges fall back to "No PHA" */ }
  }
  useEffect(() => { loadPha(); }, []);

  // Schedule blocks from the board = the window's source of truth. Loaded client-side
  // (the board endpoints are live) so the pipeline's Scheduled/Confirmed + windows work
  // regardless of whether the backend lifecycle field has deployed yet.
  const [blockMap, setBlockMap] = useState<BlockMap>(new Map());
  async function loadBlocks() {
    try {
      const wk = await getScheduleWeek(undefined, 14); // ~3-month horizon from this week
      const m: BlockMap = new Map();
      for (const b of wk.blocks) {
        if (b.opportunity_id == null) continue;
        const info: BlockInfo = { id: b.id, status: b.status, start: b.start_date, window_week: mondayOf(b.start_date), lead: b.lead_name || '' };
        const prev = m.get(b.opportunity_id);
        // confirmed beats tentative; else earliest start
        if (!prev || (prev.status !== 'confirmed' && info.status === 'confirmed') ||
            (prev.status === info.status && info.start < prev.start)) {
          m.set(b.opportunity_id, info);
        }
      }
      setBlockMap(m);
    } catch { /* non-fatal — windows fall back to the job's start date */ }
  }
  useEffect(() => { loadBlocks(); }, []);

  // Comms templates (for the hover list + Email Action Center) + dismissed actions.
  async function loadCxMeta() {
    try { const [t, s] = await Promise.all([listCxTemplates(), listCxSkips()]); setCxTemplates(t); setCxSkips(s); }
    catch { /* non-fatal */ }
  }
  useEffect(() => { loadCxMeta(); }, []);

  // The comms journey for a job: ordered templates with sent date + whether due now.
  const commsSummary = (j: PlanJob) => {
    const sent = j.comms_sent || {};
    const dueKeys = new Set((j.actions || []).filter(a => a.target.startsWith('comms:')).map(a => a.target.slice(6)));
    return cxTemplates.map(t => ({ key: t.key, title: t.title, sentAt: sent[t.key] || null, due: dueKeys.has(t.key) }));
  };
  const lastComms = (j: PlanJob) => {
    const sent = j.comms_sent || {};
    let best: { key: string; at: string } | null = null;
    for (const [k, at] of Object.entries(sent)) if (at && (!best || at > best.at)) best = { key: k, at };
    if (!best) return null;
    const t = cxTemplates.find(x => x.key === best!.key);
    return { title: t?.title || best.key, at: best.at };
  };
  async function skipAction(j: PlanJob, actionKey: string) {
    try { await skipCxAction(j.opportunity_id, actionKey, currentUser()?.name); await Promise.all([load(), loadCxMeta()]); }
    catch { /* ignore */ }
  }
  async function unskipAction(oppId: number, actionKey: string) {
    try { await unskipCxAction(oppId, actionKey); await Promise.all([load(), loadCxMeta()]); }
    catch { /* ignore */ }
  }

  const effStage  = (j: PlanJob) => planningOverride[j.opportunity_id]?.stage ?? j.stage ?? 'New';
  const effQueued = (j: PlanJob) => planningOverride[j.opportunity_id]?.queued ?? j.queued ?? false;
  // Which bucket a job is in — mirrors the backend _plan_bucket so a stage/park change
  // re-buckets the row immediately (optimistic), before the next reload.
  const effBucket = (j: PlanJob): 'active' | 'upcoming' | 'completed' | 'parked' => {
    if (effQueued(j)) return 'parked';
    if (COMPLETE_STAGES.has(effStage(j)) || (j.pct_complete_job ?? 0) >= 1) return 'completed';
    const sm = (j.start_date || '').slice(0, 7);
    if (sm && sm <= month) return 'active';
    return 'upcoming';
  };
  const activeGroups    = groupJobs(jobs.filter(j => effBucket(j) === 'active'
                            && (stageFilter === 'all' || effStage(j) === stageFilter)));
  const upcomingGroups  = groupJobs(jobs.filter(j => effBucket(j) === 'upcoming'));
  const completedGroups = groupJobs(jobs.filter(j => effBucket(j) === 'completed'));
  const parkedGroups    = groupJobs(jobs.filter(j => effBucket(j) === 'parked'));

  // Render one job row (shared by the active table and the parked section).
  const renderJobRow = (j: PlanJob, opts: { isChild: boolean; parked: boolean }) => {
    const { isChild, parked } = opts;
    return (
      <React.Fragment key={j.opportunity_id}>
        <tr style={{
          borderBottom: '1px solid #f3f4f6',
          background: parked ? '#fafafa'
            : j.risk === 'over_budget' ? '#fff5f5' : j.risk === 'at_risk' ? '#fffbeb' : '#fff',
        }}>
          {/* Property / Job */}
          <td style={{ padding: '8px 10px', verticalAlign: 'middle', paddingLeft: isChild ? 30 : 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {isChild && <span style={{ color: '#9ca3af', fontSize: 12 }}>↳</span>}
              {isChild && (
                <span style={{ background: '#fef3c7', color: '#92400e', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8 }}>
                  Change order
                </span>
              )}
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
            {!isChild && (
              <div style={{ marginTop: 4 }}>
                <PHABadge info={phaMap.get(j.opportunity_id)} onClick={() => setPhaModalJob(j)} />
              </div>
            )}
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

          {/* Won date */}
          <td style={{ padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 12, color: '#4b5563', whiteSpace: 'nowrap' }}>
            {fmtDate(j.won_date)}
          </td>

          {/* Start date */}
          <td style={{ padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 12, color: '#4b5563', whiteSpace: 'nowrap' }}>
            {fmtDate(j.start_date)}
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

          {/* Hours */}
          <td style={{ padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle' }}>
            {j.ticket_count > 0
              ? <HrsBar act={j.hrs_act_month} est={j.hrs_est_month} />
              : <span style={{ color: '#9ca3af', fontSize: 12 }}>—</span>
            }
          </td>

          {/* Revenue */}
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
              const stage = effStage(j);
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

          {/* Action — park (active) or restore / hard-remove (parked) */}
          <td style={{ padding: '8px 10px', textAlign: 'center', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
            {parked ? (
              <>
                <button
                  onClick={() => updatePlanning(j.opportunity_id, { queued: false })}
                  title="Restore to the active plan"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#16a34a', fontSize: 16, padding: '2px 6px', borderRadius: 6 }}
                >↑</button>
                <button
                  onClick={() => handleRemove(j.opportunity_id)}
                  title="Remove from this month's plan"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#d1d5db', fontSize: 16, padding: '2px 6px', borderRadius: 6 }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#d1d5db')}
                >✕</button>
              </>
            ) : (
              <button
                onClick={() => updatePlanning(j.opportunity_id, { queued: true })}
                title="Park to Queued / Parked (stays plannable)"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#d1d5db', fontSize: 16, padding: '2px 6px', borderRadius: 6 }}
                onMouseEnter={e => (e.currentTarget.style.color = '#d97706')}
                onMouseLeave={e => (e.currentTarget.style.color = '#d1d5db')}
              >✕</button>
            )}
          </td>
        </tr>

        {/* Preparedness checklist panel */}
        {prepFor === j.opportunity_id && (
          <tr>
            <td colSpan={10} style={{ padding: '14px 16px', background: '#f8fafc', borderTop: '1px solid #e5e7eb' }}>
              <div style={{ maxWidth: 560 }}>
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
    );
  };

  const TABLE_HEADERS = ['Property / Job', 'Lead', 'Won', 'Start', '% This Month', 'Hours', 'Revenue', 'Stage', 'Prep', ''];

  // Render a bucket's table (shared by Active / Upcoming / Completed / Parked sections).
  const renderBucketTable = (groups: JobGroup[], parked: boolean) => (
    <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e5e7eb' }}>
            {TABLE_HEADERS.map((h, i) => (
              <th key={i} style={{
                padding: '8px 10px', textAlign: i === 0 ? 'left' : 'center',
                fontSize: 11, fontWeight: 700, color: '#6b7280',
                letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.flatMap(g => [
            renderJobRow(g.base, { isChild: false, parked }),
            ...g.children.map(c => renderJobRow(c, { isChild: true, parked })),
          ])}
        </tbody>
      </table>
    </div>
  );
  const sectionHeader = (emoji: string, title: string, count: number, open: boolean, toggle: () => void) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '24px 0 10px', flexWrap: 'wrap', gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: '#0f172a' }}>
        {emoji} {title}
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{count} job{count !== 1 ? 's' : ''}</span>
      </h2>
      <button onClick={toggle} style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', cursor: 'pointer' }}>
        {open ? 'Hide' : 'Show'}
      </button>
    </div>
  );

  // ── Lifecycle pipeline (Phase A overhaul) ──────────────────────────────────
  const LIFECYCLE: { key: string; label: string; accent: string; hint?: string }[] = [
    { key: 'intake',        label: '🆕 Intake',                accent: '#64748b', hint: 'Just won — not planned yet' },
    { key: 'planning',      label: '📝 Planning',              accent: '#7c3aed', hint: 'Getting ready to schedule' },
    { key: 'scheduled',     label: '🗓️ Scheduled (tentative)', accent: '#2563eb', hint: 'On the board — client has a window' },
    { key: 'confirmed',     label: '✅ Confirmed',             accent: '#15803d', hint: 'Dates locked with the client' },
    { key: 'in_production', label: '🔨 In Production',         accent: '#d97706' },
    { key: 'complete',      label: '🏁 Complete',              accent: '#16a34a' },
    { key: 'paid',          label: '💰 Paid',                  accent: '#0891b2' },
    { key: 'parked',        label: '⏸️ Parked',                accent: '#9ca3af' },
  ];
  const schedOf = (j: PlanJob) => blockMap.get(j.opportunity_id);

  // Lifecycle is computed from reliable existing fields + the live board blocks, so it
  // is correct even before the backend lifecycle field deploys.
  const lifeOf = (j: PlanJob): string => {
    if (j.lifecycle === 'paid') return 'paid';
    if (effQueued(j)) return 'parked';
    if (j.lifecycle === 'complete' || j.risk === 'complete' || (j.pct_complete_job || 0) >= 1) return 'complete';
    if ((j.hrs_act || 0) > 0) return 'in_production';
    const s = schedOf(j);
    if (s?.status === 'confirmed') return 'confirmed';
    if (s?.status === 'tentative') return 'scheduled';
    if (j.lifecycle === 'intake') return 'intake';
    if ((j.prep_done || 0) > 0 || (planningOverride[j.opportunity_id]?.lead_name ?? j.lead_name)) return 'planning';
    return j.source === 'manual' ? 'planning' : 'intake';
  };

  const windowText = (j: PlanJob): string => {
    const s = schedOf(j);
    if (s?.status === 'confirmed') return `Confirmed · ${fmtDate(s.start)}`;
    if (s?.status === 'tentative') return `Week of ${fmtDate(s.window_week)}`;
    if (j.start_date) return `Starts ${fmtDate(j.start_date)}`;
    return 'No date yet';
  };

  // Days until a tentative block starts (for the "confirm soon" nudge).
  const daysUntil = (iso: string): number => {
    try { return Math.round((new Date(iso + 'T00:00:00').getTime() - Date.now()) / 86400000); }
    catch { return 9999; }
  };

  async function confirmDates(j: PlanJob, confirmed: boolean) {
    const s = schedOf(j);
    if (!s) return;
    try { await updateBlock(s.id, { status: confirmed ? 'confirmed' : 'tentative' }); await loadBlocks(); }
    catch { /* ignore */ }
  }

  const ACTION_STYLE: Record<string, { bg: string; fg: string }> = {
    overdue: { bg: '#fee2e2', fg: '#b91c1c' },
    due:     { bg: '#fef3c7', fg: '#92400e' },
    soon:    { bg: '#dbeafe', fg: '#1d4ed8' },
  };
  function runAction(j: PlanJob, target: string) {
    if (target.startsWith('comms:')) { setCommsTmpl(target.slice(6)); setCommsJob(j); }
    else if (target === 'pha') { setPhaModalJob(j); }
    else if (target === 'board') { window.open('/dashboards/construction/board', '_blank'); }
  }
  const ActionChip = ({ j, a }: { j: PlanJob; a: NonNullable<PlanJob['actions']>[number] }) => {
    const c = ACTION_STYLE[a.severity] || ACTION_STYLE.due;
    const icon = a.severity === 'overdue' ? '🔴' : a.severity === 'due' ? '🟠' : '🔵';
    return (
      <button onClick={() => runAction(j, a.target)} title={a.severity === 'overdue' ? 'Overdue' : a.severity === 'soon' ? 'Coming up' : 'Due now'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: c.bg, color: c.fg, border: 'none', borderRadius: 999, padding: '3px 10px', fontSize: 11.5, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        {icon} {a.label}
      </button>
    );
  };

  const renderPipelineRow = (j: PlanJob, children: PlanJob[]) => {
    const prep = prepProgress[j.opportunity_id] ?? { done: j.prep_done ?? 0, total: j.prep_total ?? 6 };
    const ready = prep.total > 0 && prep.done === prep.total;
    const open = prepFor === j.opportunity_id;
    const commsOpen = commsFor === j.opportunity_id;
    return (
      <div key={j.opportunity_id} style={{ borderTop: '1px solid #f3f4f6', padding: '5px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 2, minWidth: 200, lineHeight: 1.3 }}>
            <a href={`/field/project/${j.opportunity_id}`} style={{ fontWeight: 700, fontSize: 13, color: '#111827', textDecoration: 'none' }}
               onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')} onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>
              {j.property_name || j.opportunity_name}
            </a>
            <span style={{ fontSize: 11.5, color: '#9ca3af' }}>
              {j.opp_number ? `  ·  #${j.opp_number}` : ''}{j.property_name && j.opportunity_name ? `  ·  ${j.opportunity_name}` : ''}{children.length ? `  ·  +${children.length} CO` : ''}
              {schedOf(j)?.lead ? <span style={{ color: '#b45309', fontWeight: 700 }}>{'  ·  ★ '}{schedOf(j)!.lead}</span> : ''}
            </span>
          </div>
          {/* Window / date + confirm action */}
          {(() => {
            const s = schedOf(j);
            const soon = s?.status === 'tentative' && daysUntil(s.start) <= 14;
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                <a href="/dashboards/construction/board" title="Open the schedule board"
                   style={{ fontSize: 11.5, fontWeight: 700, color: s?.status === 'confirmed' ? '#15803d' : s?.status === 'tentative' ? '#1d4ed8' : '#9ca3af', textDecoration: 'none' }}>
                  {windowText(j)}
                </a>
                {soon && <span title="Starts within 2 weeks — confirm the date with the client" style={{ background: '#fef3c7', color: '#92400e', fontSize: 10, fontWeight: 800, padding: '1px 6px', borderRadius: 8 }}>confirm soon</span>}
                {s?.status === 'tentative' && (
                  <button onClick={() => confirmDates(j, true)} title="Lock these dates with the client"
                    style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 6, border: '1px solid #86efac', background: '#dcfce7', color: '#15803d', cursor: 'pointer' }}>Confirm</button>
                )}
                {s?.status === 'confirmed' && (
                  <button onClick={() => confirmDates(j, false)} title="Unlock (back to tentative)"
                    style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#6b7280', cursor: 'pointer' }}>🔓</button>
                )}
                {!s && <a href="/dashboards/construction/board" style={{ fontSize: 10.5, fontWeight: 700, color: '#1d4ed8', textDecoration: 'none' }}>Schedule →</a>}
              </div>
            );
          })()}
          {/* Readiness */}
          <button onClick={() => setPrepFor(open ? null : j.opportunity_id)} title="Preparedness checklist"
            style={{ padding: '3px 9px', fontSize: 11, fontWeight: 700, borderRadius: 6, border: '1px solid ' + (ready ? '#86efac' : open ? '#2563eb' : '#e5e7eb'), background: ready ? '#dcfce7' : open ? '#eff6ff' : '#f8fafc', color: ready ? '#15803d' : open ? '#1d4ed8' : '#6b7280', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {ready ? '✓ Ready' : `Prep ${prep.done}/${prep.total}`}
          </button>
          {/* PHA */}
          <PHABadge info={phaMap.get(j.opportunity_id)} onClick={() => setPhaModalJob(j)} />
          {/* Client comms — styled like the prep dropdown */}
          {(() => {
            const dueCount = (j.actions || []).filter(a => a.target.startsWith('comms:')).length;
            const anySent = Object.keys(j.comms_sent || {}).length > 0;
            const label = commsOpen ? '✉️ Comms' : dueCount ? `✉️ ${dueCount} due` : anySent ? '✉️ Sent' : '✉️ Comms';
            return (
              <button onClick={() => setCommsFor(commsOpen ? null : j.opportunity_id)} title="Client comms"
                style={{ padding: '3px 9px', fontSize: 11, fontWeight: 700, borderRadius: 6,
                  border: '1px solid ' + (commsOpen ? '#2563eb' : dueCount ? '#fcd34d' : anySent ? '#86efac' : '#e5e7eb'),
                  background: commsOpen ? '#eff6ff' : dueCount ? '#fffbeb' : anySent ? '#dcfce7' : '#f8fafc',
                  color: commsOpen ? '#1d4ed8' : dueCount ? '#92400e' : anySent ? '#15803d' : '#6b7280',
                  cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {label}
              </button>
            );
          })()}
          {/* Revenue */}
          <div style={{ fontSize: 12, color: '#6b7280', minWidth: 80, textAlign: 'right' }}>{fmt$(j.revenue_est || j.revenue_est_month || 0)}</div>
        </div>
        {open && (
          <div style={{ marginTop: 10, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, maxWidth: 560 }}>
            <JobPrepChecklist oppId={j.opportunity_id} onProgress={(done, total) => setPrepProgress(prev => ({ ...prev, [j.opportunity_id]: { done, total } }))} />
          </div>
        )}
        {commsOpen && (() => {
          const skipSet = new Set(cxSkips.filter(s => s.opportunity_id === j.opportunity_id).map(s => s.action_key));
          const dueSet = new Set((j.actions || []).filter(a => a.target.startsWith('comms:')).map(a => a.key));
          const actKey = (tk: string) => (tk === 'handoff' ? 'welcome' : tk);
          const sent = j.comms_sent || {};
          return (
            <div style={{ marginTop: 10, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, maxWidth: 560 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Client comms</div>
              {cxTemplates.length === 0 ? <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</div> :
                cxTemplates.map(t => {
                  const ak = actKey(t.key);
                  const sentAt = sent[t.key] || null;
                  const skipped = skipSet.has(ak);
                  const due = dueSet.has(ak);
                  const icon = sentAt ? '✅' : skipped ? '⊘' : due ? '🟠' : '○';
                  const color = sentAt ? '#111827' : skipped ? '#9ca3af' : due ? '#92400e' : '#6b7280';
                  return (
                    <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 2px', borderTop: '1px solid #eef2f7', fontSize: 12.5 }}>
                      <span style={{ width: 16 }}>{icon}</span>
                      <span style={{ flex: 1, color, textDecoration: skipped ? 'line-through' : 'none' }}>{t.title}</span>
                      <span style={{ color: '#9ca3af', fontSize: 11, whiteSpace: 'nowrap' }}>{sentAt ? fmtDate(sentAt) : skipped ? 'N/A' : due ? 'due' : ''}</span>
                      <button onClick={() => { setCommsTmpl(t.key); setCommsJob(j); }}
                        style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: '#1A5376', color: '#fff', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>
                        {sentAt ? 'Resend' : 'Send'}
                      </button>
                      {skipped
                        ? <button onClick={() => unskipAction(j.opportunity_id, ak)} style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#2563eb', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>Undo N/A</button>
                        : <button onClick={() => skipAction(j, ak)} title="Mark not necessary" style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#6b7280', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>N/A</button>}
                    </div>
                  );
                })}
            </div>
          );
        })()}
      </div>
    );
  };

  const renderPipeline = () => {
    const groups = groupJobs(jobs);
    const SEV = { overdue: 0, due: 1, soon: 2 } as Record<string, number>;
    const needs = groups.map(g => g.base).filter(b => (b.actions?.length || 0) > 0)
      .sort((a, b) => (SEV[a.actions![0].severity] ?? 9) - (SEV[b.actions![0].severity] ?? 9));
    void needs;
    return (
      <div>

        {LIFECYCLE.map(stage => {
          const rows = groups.filter(g => lifeOf(g.base) === stage.key);
          if (!rows.length) return null;
          return (
            <div key={stage.key} style={{ background: '#fff', border: '1px solid #e5e7eb', borderTop: `3px solid ${stage.accent}`, borderRadius: 12, marginBottom: 16, overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', background: '#fafafa', display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 800, fontSize: 14, color: '#0f172a' }}>{stage.label}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: stage.accent }}>{rows.length}</span>
                {stage.hint && <span style={{ fontSize: 11, color: '#9ca3af' }}>— {stage.hint}</span>}
              </div>
              {rows.map(g => renderPipelineRow(g.base, g.children))}
            </div>
          );
        })}
        {groups.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No construction jobs in the plan.</div>}
      </div>
    );
  };

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
              🏗️ Construction Planning
            </h1>
            <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
              Jobs from intake through completion
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
            <div style={{ display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 8, overflow: 'hidden' }}>
              {(['pipeline', 'monthly'] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  style={{ padding: '8px 14px', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13, background: view === v ? '#1d4ed8' : '#fff', color: view === v ? '#fff' : '#374151' }}>
                  {v === 'pipeline' ? '📋 Pipeline' : '🎯 Monthly'}
                </button>
              ))}
            </div>
            <a href="/dashboards/construction/board" style={{ ...secondaryBtn, textDecoration: 'none', display: 'inline-block' }}>📅 Weekly Board</a>
            {(() => {
              const n = jobs.filter(j => (j.actions || []).some(a => a.target.startsWith('comms:'))).length;
              return (
                <button onClick={() => setShowEmailCenter(true)} style={{ ...secondaryBtn, borderColor: n ? '#fcd34d' : '#d1d5db', background: n ? '#fffbeb' : '#fff', color: n ? '#92400e' : '#374151' }}>
                  📨 Email Action Center{n ? ` (${n})` : ''}
                </button>
              );
            })()}
            <button onClick={() => setShowCheckin(true)} style={secondaryBtn}>📤 Check-ins</button>
            <button onClick={() => setShowCxSetup(true)} style={secondaryBtn}>✉️ Comms setup</button>
            <button onClick={() => setShowGoal(true)}    style={secondaryBtn}>⚙️ Goals</button>
          </div>
        </div>

        {view === 'pipeline' && renderPipeline()}

        {view === 'monthly' && (<>
        {/* PHA safety summary — across active + upcoming jobs */}
        {(() => {
          const bases = [...activeGroups, ...upcomingGroups].map(g => g.base);
          const total = bases.length;
          if (!total) return null;
          let done = 0, draft = 0;
          for (const b of bases) {
            const st = phaMap.get(b.opportunity_id)?.status;
            if (st === 'completed') done++;
            else if (st === 'draft') draft++;
          }
          const outstanding = total - done - draft;
          const pill = (bg: string, fg: string, label: string, n: number) => (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: bg, color: fg, padding: '4px 12px', borderRadius: 999, fontSize: 13, fontWeight: 800 }}>
              <span style={{ fontSize: 15 }}>{n}</span>{label}
            </span>
          );
          return (
            <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', boxShadow: '0 1px 4px rgba(0,0,0,0.05)', padding: '12px 18px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a', textTransform: 'uppercase', letterSpacing: 0.4 }}>🦺 Hazard Assessments</div>
              <div style={{ fontSize: 13, color: '#6b7280' }}>{done + draft} of {total} active &amp; upcoming jobs started</div>
              <div style={{ flex: 1 }} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {outstanding > 0 && pill('#fef3c7', '#92400e', 'outstanding', outstanding)}
                {draft > 0 && pill('#dbeafe', '#1d4ed8', 'draft', draft)}
                {pill('#dcfce7', '#15803d', 'submitted', done)}
              </div>
            </div>
          );
        })()}

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
            No construction jobs for {monthLabel(month)} yet.<br />
            <span style={{ fontSize: 13 }}>Won jobs flow in automatically from Aspire and the schedule board.</span>
          </div>
        )}

        {jobs.length > 0 && (
          <>
            {/* Stage filter */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Stage</span>
              <select
                value={stageFilter}
                onChange={e => setStageFilter(e.target.value)}
                style={{ fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#1f2937', fontFamily: 'inherit', cursor: 'pointer' }}
              >
                <option value="all">All stages</option>
                {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>
                {activeGroups.length} active job{activeGroups.length !== 1 ? 's' : ''}
              </span>
            </div>

            {activeGroups.length === 0 ? (
              <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: '20px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                No active jobs{stageFilter !== 'all' ? ' in this stage' : ' this month'}.
              </div>
            ) : renderBucketTable(activeGroups, false)}
          </>
        )}

        {/* Upcoming — future Start Date (or no date yet); fully plannable, incl. prep */}
        {upcomingGroups.length > 0 && (
          <div>
            {sectionHeader('\uD83D\uDCC5', 'Upcoming', upcomingGroups.length, showUpcoming, () => setShowUpcoming(o => !o))}
            {showUpcoming && renderBucketTable(upcomingGroups, false)}
          </div>
        )}

        {/* Completed / Out of Production — Stage is Complete / Ready to Invoice / Invoiced / Paid */}
        {completedGroups.length > 0 && (
          <div>
            {sectionHeader('\u2705', 'Completed / Out of Production', completedGroups.length, showCompleted, () => setShowCompleted(o => !o))}
            {showCompleted && renderBucketTable(completedGroups, false)}
          </div>
        )}

        {/* Queued / Parked — manually parked from the active plan, still fully plannable */}
        {parkedGroups.length > 0 && (
          <div>
            {sectionHeader('\uD83C\uDD7F\uFE0F', 'Queued / Parked', parkedGroups.length, true, () => {})}
            {renderBucketTable(parkedGroups, true)}
          </div>
        )}

        {/* Summary totals */}
        {jobs.length > 0 && (
          <div style={{ marginTop: 16, fontSize: 13, color: '#6b7280' }}>
            <strong style={{ color: '#0f172a' }}>
              {activeGroups.length} active \u00b7 {upcomingGroups.length} upcoming \u00b7 {completedGroups.length} completed{parkedGroups.length ? ` \u00b7 ${parkedGroups.length} parked` : ''}
            </strong>
          </div>
        )}
        </>)}
      </div>

      {/* Modals */}
      {showGoal && plan && (
        <GoalEditor month={month} goal={goal} onSave={handleSaveGoal} onClose={() => setShowGoal(false)} />
      )}
      {showCheckin && <CheckinStatusPanel month={month} onClose={() => setShowCheckin(false)} />}
      {showCxSetup && <CxSetupModal onClose={() => setShowCxSetup(false)} />}
      {showEmailCenter && (() => {
        const bases = groupJobs(jobs).map(g => g.base);
        const byId = new Map(bases.map(b => [b.opportunity_id, b]));
        const SEVR = { overdue: 0, due: 1, soon: 2 } as Record<string, number>;
        let items = bases.flatMap(b => (b.actions || []).filter(a => a.target.startsWith('comms:')).map(a => ({ b, a })));
        if (emailFilter === 'overdue') items = items.filter(x => x.a.severity === 'overdue');
        else if (emailFilter === 'due') items = items.filter(x => x.a.severity === 'due');
        items.sort((x, y) => (SEVR[x.a.severity] ?? 9) - (SEVR[y.a.severity] ?? 9));
        const tmplTitle = (k: string) => cxTemplates.find(t => t.key === k)?.title || k;
        return (
          <div onClick={() => setShowEmailCenter(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 1250, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '24px 12px', overflowY: 'auto' }}>
            <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 720, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 800, fontSize: 15, color: '#0f172a' }}>📨 Email Action Center</span>
                <div style={{ display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 8, overflow: 'hidden' }}>
                  {(['all', 'overdue', 'due'] as const).map(f => (
                    <button key={f} onClick={() => setEmailFilter(f)} style={{ padding: '5px 12px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, background: emailFilter === f ? '#1d4ed8' : '#fff', color: emailFilter === f ? '#fff' : '#374151' }}>
                      {f === 'all' ? 'All' : f === 'overdue' ? 'Overdue' : 'Due'}
                    </button>
                  ))}
                </div>
                <button onClick={() => setShowEmailCenter(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 20, color: '#6b7280', cursor: 'pointer' }}>×</button>
              </div>
              <div style={{ padding: 16, maxHeight: '70vh', overflowY: 'auto' }}>
                {items.length === 0 ? <div style={{ color: '#9ca3af', fontSize: 14, padding: 16, textAlign: 'center' }}>Nothing {emailFilter !== 'all' ? emailFilter : 'outstanding'} — all caught up. 🎉</div> : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {items.map(({ b, a }) => {
                        const c = ACTION_STYLE[a.severity] || ACTION_STYLE.due;
                        return (
                          <tr key={b.opportunity_id + a.key} style={{ borderTop: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '8px 6px', fontSize: 13, fontWeight: 700, color: '#111827' }}>{b.property_name || b.opportunity_name}</td>
                            <td style={{ padding: '8px 6px' }}><span style={{ background: c.bg, color: c.fg, borderRadius: 999, padding: '2px 9px', fontSize: 11.5, fontWeight: 800, whiteSpace: 'nowrap' }}>{a.severity === 'overdue' ? '🔴' : '🟠'} {a.label}</span></td>
                            <td style={{ padding: '8px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                              <button onClick={() => { setShowEmailCenter(false); runAction(b, a.target); }} style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: '#1A5376', color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer', marginRight: 6 }}>Compose</button>
                              <button onClick={() => skipAction(b, a.key)} title="Mark not necessary" style={{ padding: '5px 10px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: '#6b7280', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>Not necessary</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {cxSkips.length > 0 && (
                  <div style={{ marginTop: 16, borderTop: '1px solid #f1f5f9', paddingTop: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: '#6b7280', marginBottom: 6 }}>Marked not necessary</div>
                    {cxSkips.map(s => (
                      <div key={s.opportunity_id + s.action_key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#9ca3af', padding: '3px 2px' }}>
                        <span style={{ flex: 1 }}>{(byId.get(s.opportunity_id)?.property_name || byId.get(s.opportunity_id)?.opportunity_name || `#${s.opportunity_id}`)} — {tmplTitle(s.action_key === 'welcome' ? 'handoff' : s.action_key)}</span>
                        <button onClick={() => unskipAction(s.opportunity_id, s.action_key)} style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>Undo</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
      {commsJob && <ClientCommsModal oppId={commsJob.opportunity_id} jobName={commsJob.property_name || commsJob.opportunity_name} initialTemplateKey={commsTmpl} onClose={() => { setCommsJob(null); setCommsTmpl(undefined); load(); }} />}

      {/* PHA modal — create / review a project hazard assessment for a job */}
      {phaModalJob && (
        <div
          onClick={() => { setPhaModalJob(null); loadPha(); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '24px 12px', overflowY: 'auto' }}
        >
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 980, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, background: '#fff', borderRadius: '16px 16px 0 0', zIndex: 2 }}>
              <div style={{ fontWeight: 800, fontSize: 15, color: '#0f172a' }}>
                {phaModalJob.property_name || phaModalJob.opportunity_name || 'Project'}
                <span style={{ color: '#9ca3af', fontWeight: 500, fontSize: 13, marginLeft: 8 }}>#{phaModalJob.opp_number ?? '—'}</span>
              </div>
              <button onClick={() => { setPhaModalJob(null); loadPha(); }}
                style={{ background: 'none', border: 'none', fontSize: 22, color: '#6b7280', cursor: 'pointer', lineHeight: 1, padding: 4 }}>×</button>
            </div>
            <div style={{ padding: '18px 20px' }}>
              <ProjectHazardAssessment
                oppId={phaModalJob.opportunity_id}
                prefill={{
                  project_name:    phaModalJob.opportunity_name || undefined,
                  site_address:    phaModalJob.property_name || undefined,
                  job_number:      phaModalJob.opp_number != null ? String(phaModalJob.opp_number) : undefined,
                  crew_lead:       phaModalJob.lead_name || undefined,
                  planned_start:   phaModalJob.start_date ? phaModalJob.start_date.slice(0, 10) : undefined,
                }}
                onSaved={loadPha}
              />
            </div>
          </div>
        </div>
      )}
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
