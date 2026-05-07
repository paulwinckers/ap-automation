/**
 * Construction Monthly Plan
 * Leads commit jobs to a month and track progress vs. goal.
 * Route: /dashboards/construction/plan
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  getMonthlyPlan, setMonthlyGoal, addJobToMonth, removeJobFromMonth, getPlanSuggestions,
  MonthlyPlan, PlanJob, PlanSuggestion,
} from '../lib/api';

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
    return new Date(m + '-01').toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
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
  const [suggestions, setSuggestions] = useState<PlanSuggestion[]>([]);
  const [q, setQ]         = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding]   = useState<number | null>(null);

  useEffect(() => {
    getPlanSuggestions(month).then(r => {
      setSuggestions(r.suggestions);
      setLoading(false);
    });
  }, [month]);

  const filtered = q.trim()
    ? suggestions.filter(s =>
        (s.opportunity_name + ' ' + s.property_name).toLowerCase().includes(q.toLowerCase()))
    : suggestions;

  const add = async (s: PlanSuggestion) => {
    setAdding(s.opportunity_id);
    await addJobToMonth(month, {
      opportunity_id:   s.opportunity_id,
      opportunity_name: s.opportunity_name,
      property_name:    s.property_name,
    });
    onAdded();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: '#fff', borderRadius: 14, padding: 24,
        width: 540, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#111827' }}>Add Job — {monthLabel(month)}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#9ca3af' }}>✕</button>
        </div>
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
          {filtered.map(s => (
            <div key={s.opportunity_id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 12px', borderRadius: 8, marginBottom: 4,
              background: '#f9fafb', border: '1px solid #f3f4f6',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.property_name || s.opportunity_name}
                </div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>
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
          ))}
        </div>
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
  const [showGoal, setShowGoal] = useState(false);
  const [showAdd, setShowAdd]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getMonthlyPlan(month);
      setPlan(data);
    } catch (e: any) {
      setError(e.message || 'Failed to load plan');
    } finally {
      setLoading(false);
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

  const { goal, jobs, summary } = plan || { goal: { month, revenue_goal: null, hours_goal: null, notes: null }, jobs: [], summary: { job_count: 0, scheduled_count: 0, manual_count: 0, days_left: 0, hrs_est: 0, hrs_act: 0, revenue_est: 0, revenue_act: 0 } };

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

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setShowGoal(true)} style={secondaryBtn}>⚙️ Set Goals</button>
            <button onClick={() => setShowAdd(true)} style={primaryBtn}>+ Add Job</button>
          </div>
        </div>

        {/* Goal progress bars */}
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
            <GoalBar label="Revenue" actual={summary.revenue_act} goal={goal.revenue_goal} unit="$" />
            <GoalBar label="Hours" actual={summary.hrs_act} goal={goal.hours_goal} unit="h" />
          </div>
          {goal.notes && (
            <div style={{ marginTop: 12, fontSize: 13, color: '#6b7280', fontStyle: 'italic' }}>
              {goal.notes}
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
                  {['Property / Job', 'Status', '% Done', 'Hours', 'Revenue', 'Risk', ''].map((h, i) => (
                    <th key={i} style={{
                      padding: '10px 16px', textAlign: i >= 2 ? 'center' : 'left',
                      fontSize: 11, fontWeight: 700, color: '#6b7280',
                      letterSpacing: '0.06em', textTransform: 'uppercase',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.map((j, idx) => (
                  <tr key={j.opportunity_id} style={{
                    borderBottom: idx < jobs.length - 1 ? '1px solid #f3f4f6' : 'none',
                    background: j.risk === 'over_budget' ? '#fff5f5' : j.risk === 'at_risk' ? '#fffbeb' : '#fff',
                  }}>
                    {/* Property / Job */}
                    <td style={{ padding: '12px 16px', verticalAlign: 'top' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>
                          {j.property_name || j.opportunity_name}
                        </span>
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
                        {j.opportunity_name}
                        {j.opp_number ? ` · #${j.opp_number}` : ''}
                      </div>
                    </td>

                    {/* Status */}
                    <td style={{ padding: '12px 16px', verticalAlign: 'top' }}>
                      <span style={{
                        background: '#f1f5f9', color: '#475569',
                        padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                      }}>{j.status || '—'}</span>
                    </td>

                    {/* % complete */}
                    <td style={{ padding: '12px 16px', textAlign: 'center', verticalAlign: 'top' }}>
                      <div style={{ fontWeight: 700, fontSize: 15, color: j.pct_complete >= 100 ? '#15803d' : '#1f2937' }}>
                        {fmtPct(j.pct_complete)}
                      </div>
                      <div style={{ background: '#e5e7eb', borderRadius: 999, height: 5, width: 60, margin: '4px auto 0', overflow: 'hidden' }}>
                        <div style={{
                          width: `${Math.min(j.pct_complete, 100)}%`, height: '100%', borderRadius: 999,
                          background: j.pct_complete >= 100 ? '#16a34a' : j.pct_complete >= 50 ? '#f59e0b' : '#6b7280',
                        }} />
                      </div>
                    </td>

                    {/* Hours */}
                    <td style={{ padding: '12px 16px', textAlign: 'center', verticalAlign: 'top' }}>
                      <HrsBar act={j.hrs_act} est={j.hrs_est} />
                    </td>

                    {/* Revenue */}
                    <td style={{ padding: '12px 16px', textAlign: 'center', verticalAlign: 'top' }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>{fmt$(j.revenue_act)}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>of {fmt$(j.revenue_est)}</div>
                    </td>

                    {/* Risk */}
                    <td style={{ padding: '12px 16px', textAlign: 'center', verticalAlign: 'top' }}>
                      <RiskBadge risk={j.risk} />
                    </td>

                    {/* Remove — only for manually added jobs */}
                    <td style={{ padding: '12px 16px', textAlign: 'center', verticalAlign: 'top' }}>
                      {(j.source === 'manual' || j.source === 'both') && (
                        <button
                          onClick={() => handleRemove(j.opportunity_id)}
                          title={j.source === 'both' ? 'Remove manual pin (still shows as scheduled)' : 'Remove from this month\'s plan'}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: '#d1d5db', fontSize: 16, padding: '2px 6px', borderRadius: 6,
                          }}
                          onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                          onMouseLeave={e => (e.currentTarget.style.color = '#d1d5db')}
                        >✕</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Summary totals */}
        {jobs.length > 0 && (
          <div style={{
            marginTop: 16, display: 'flex', gap: 16, flexWrap: 'wrap',
            fontSize: 13, color: '#6b7280',
          }}>
            <span>Totals: <strong style={{ color: '#111827' }}>{fmtH(summary.hrs_act)}</strong> actual / <strong style={{ color: '#111827' }}>{fmtH(summary.hrs_est)}</strong> est hours</span>
            <span>·</span>
            <span><strong style={{ color: '#111827' }}>{fmt$(summary.revenue_act)}</strong> earned / <strong style={{ color: '#111827' }}>{fmt$(summary.revenue_est)}</strong> contracted</span>
            <span>·</span>
            <span><strong style={{ color: overBudget.length ? '#dc2626' : atRisk.length ? '#d97706' : '#15803d' }}>
              {complete.length} complete · {onTrack.length} on track · {atRisk.length} at risk · {overBudget.length} over budget
            </strong></span>
          </div>
        )}
      </div>

      {/* Modals */}
      {showGoal && plan && (
        <GoalEditor month={month} goal={goal} onSave={handleSaveGoal} onClose={() => setShowGoal(false)} />
      )}
      {showAdd && (
        <AddJobPanel month={month} onAdded={() => { setShowAdd(false); load(); }} onClose={() => setShowAdd(false)} />
      )}
    </div>
  );
}

// ── Button styles ─────────────────────────────────────────────────────────────

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
