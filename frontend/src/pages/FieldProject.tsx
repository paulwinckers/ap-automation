/**
 * FieldProject — permanent, bookmarkable project page for construction leads.
 * Route: /field/project/:oppId  (public, no login required)
 *
 * Shows live work ticket hours from Aspire, AI coaching tip,
 * check-in history, and a form to submit an update at any time.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { downloadHandoffPack } from '../lib/api';

const API = import.meta.env.VITE_API_URL ?? '';

interface Ticket {
  WorkTicketID:         number;
  WorkTicketNumber:     string | number;
  ServiceName:          string;
  WorkTicketStatusName: string;
  ScheduledStartDate:   string;
  HoursEst:             number | null;
  HoursAct:             number | null;
  HoursScheduled:       number | null;
  HoursUnscheduled:     number | null;
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

interface ActivityComment {
  Comment:           string;
  CreatedDate:       string;
  CreatedByUserName: string;
}

interface SmartPrompt {
  id:        string;
  type:      string;
  icon:      string;
  situation: string;
  question:  string;
  options:   string[];
  actHours?: number;  // for over_hours prompts — used to detect if hours changed
}

interface PromptMemory {
  answer:      string;
  answeredAt:  number;  // epoch ms
  actHours?:   number;  // snapshot of actHours when answered
}

interface Activity {
  ActivityID:           number;
  Subject:              string;
  ActivityType:         string;
  ActivityCategoryName: string;
  Status:               string;
  Notes:                string;
  CreatedDate:          string;
  CompleteDate:         string;
  CreatedByUserName:    string;
  comments:             ActivityComment[];
  IsMileStone:          boolean;
}

interface MaterialItem {
  description: string;
  quantity:    number;
  unit_cost:   number;
  total:       number;
}

interface MaterialPO {
  receipt_id:     number;
  display_number: number | null;
  work_ticket_id: number | null;
  ticket_number:  string | number | null;
  service_name:   string;
  vendor_name:    string;
  received_date:  string;
  total:          number;
  status:         string;
  note:           string;
  items:          MaterialItem[];
  _item_keys?:    string[];  // debug: actual field names from Aspire
}

interface MaterialsData {
  pos:                MaterialPO[];
  tickets_without_po: { WorkTicketID: number; ServiceName: string; WorkTicketNumber: string | number }[];
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
  project_summary:  string;
  smart_prompts:    SmartPrompt[];
  history:          HistoryEntry[];
  activities:       Activity[];
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
  const [handoffLoading, setHandoffLoading] = useState(false);
  const [handoffMsg,     setHandoffMsg]     = useState('');
  // Smart prompt selections: promptId → selected option string
  const [promptSelections, setPromptSelections] = useState<Record<string, string>>({});
  // Show prompts that were previously answered and suppressed
  const [showDismissed, setShowDismissed] = useState(false);

  // ── Prompt memory helpers (localStorage) ─────────────────────────────────
  const promptMemoryKey = (promptId: string) => `pm_${oppId}_${promptId}`;

  function getPromptMemory(promptId: string): PromptMemory | null {
    try {
      const raw = localStorage.getItem(promptMemoryKey(promptId));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function savePromptMemory(promptId: string, answer: string, actHours?: number) {
    try {
      const mem: PromptMemory = { answer, answeredAt: Date.now(), actHours };
      localStorage.setItem(promptMemoryKey(promptId), JSON.stringify(mem));
    } catch {}
  }

  function isPromptSuppressed(p: SmartPrompt): boolean {
    const mem = getPromptMemory(p.id);
    if (!mem || !mem.answer) return false;
    const ageMs = Date.now() - mem.answeredAt;
    if (p.type === 'over_hours') {
      // Re-show if hours increased by more than 1h since last answer
      const hoursIncrease = (p.actHours ?? 0) - (mem.actHours ?? 0);
      return hoursIncrease < 1;
    }
    // Materials / upcoming: suppress for 24h
    return ageMs < 24 * 60 * 60 * 1000;
  }

  // Tab: 'tickets' | 'history' | 'update' | 'materials'
  const [tab, setTab] = useState<'tickets' | 'history' | 'update' | 'materials'>('tickets');

  // Materials tab — lazy-loaded on first open
  const [materialsData,    setMaterialsData]    = useState<MaterialsData | null>(null);
  const [materialsLoading, setMaterialsLoading] = useState(false);
  const [materialsError,   setMaterialsError]   = useState('');

  const loadMaterials = async (force = false) => {
    if (!force && materialsData !== null) return; // already fetched
    setMaterialsLoading(true);
    setMaterialsError('');
    try {
      const r = await fetch(`${API}/checkin/project/${oppId}/materials`);
      if (!r.ok) throw new Error('Failed to load materials');
      setMaterialsData(await r.json());
    } catch (e: any) {
      setMaterialsError(e.message || 'Could not load materials');
    } finally {
      setMaterialsLoading(false);
    }
  };

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

  const handleSubmit = async (e: React.FormEvent, combinedNotes?: string) => {
    e.preventDefault();
    const notes = combinedNotes ?? approachNotes.trim();
    if (!notes) return;
    setSubmitting(true);
    setSubmitMsg('');
    try {
      const r = await fetch(`${API}/checkin/project/${oppId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approach_notes:  notes,
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

  const totalEst        = data.tickets.reduce((s, t) => s + (t.HoursEst ?? 0), 0);
  const totalAct        = data.tickets.reduce((s, t) => s + (t.HoursAct ?? 0), 0);
  const totalScheduled  = data.tickets.reduce((s, t) => s + (t.HoursScheduled ?? 0), 0);
  const totalUnscheduled= data.tickets.reduce((s, t) => s + (t.HoursUnscheduled ?? 0), 0);
  const totalRevenue    = data.tickets.reduce((s, t) => s + (t.Revenue ?? 0), 0);
  const totalEarned     = data.tickets.reduce((s, t) => s + (t.EarnedRevenue ?? 0), 0);
  const totalRem        = totalEst - totalAct;
  const overBudget      = totalAct > totalEst && totalEst > 0;
  const responded  = data.history.filter(h => h.submitted_at).length;

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
        <div style={{ display: 'flex', borderBottom: '1px solid #f1f5f9', overflowX: 'auto' }}>
          {([
            { key: 'tickets',   label: `📋 Tickets (${data.tickets.length})` },
            { key: 'history',   label: `📝 History (${(data.activities || []).filter(a => (a.ActivityType || '').toLowerCase() !== 'email').length + responded})` },
            { key: 'materials', label: '📦 Materials' },
            { key: 'update',    label: '✏️ Update' },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => {
                setTab(key);
                if (key === 'materials') loadMaterials();
              }}
              style={{
                flex: '0 0 auto', padding: '12px 10px', border: 'none', background: 'none',
                fontWeight: tab === key ? 700 : 500,
                fontSize: 12,
                color: tab === key ? '#16a34a' : '#6b7280',
                borderBottom: tab === key ? '2px solid #16a34a' : '2px solid transparent',
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ padding: '20px 16px' }}>

          {/* ── Tickets tab ──────────────────────────────────────────────── */}
          {tab === 'tickets' && (
            <>
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
                  <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 12px', marginBottom: 8, display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
                    {[
                      { label: 'Est Hrs',     value: `${fmtHrs(totalEst)}h` },
                      { label: 'Act Hrs',     value: `${fmtHrs(totalAct)}h`,        alert: overBudget },
                      { label: 'Scheduled',   value: `${fmtHrs(totalScheduled)}h` },
                      { label: 'Unsched.',    value: `${fmtHrs(totalUnscheduled)}h`, alert: totalUnscheduled > 0 },
                      { label: 'Earned Rev',  value: fmtMoney(totalEarned || null),  highlight: totalEarned > 0 },
                      { label: 'Revenue',     value: fmtMoney(totalRevenue || null) },
                    ].map(({ label, value, alert, highlight }) => (
                      <div key={label} style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: alert ? '#ef4444' : highlight ? '#15803d' : '#111827' }}>{value}</div>
                        <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 1 }}>{label}</div>
                      </div>
                    ))}
                  </div>

                  {/* Ticket rows */}
                  <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                    {data.tickets.map((t, i) => {
                      const est   = t.HoursEst ?? 0;
                      const act   = t.HoursAct ?? 0;
                      const sched = t.HoursScheduled ?? 0;
                      const unsched = t.HoursUnscheduled ?? 0;
                      const label = t.ServiceName || `#${t.WorkTicketNumber}`;
                      return (
                        <div key={t.WorkTicketID} style={{
                          padding: '11px 14px',
                          background: i % 2 === 0 ? '#fff' : '#f9fafb',
                          borderTop: i > 0 ? '1px solid #f1f5f9' : undefined,
                        }}>
                          {/* Service name + status */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 1 }}>{label}</div>
                              <div style={{ fontSize: 11, color: '#9ca3af' }}>#{t.WorkTicketNumber} · {fmtDate(t.ScheduledStartDate)}</div>
                            </div>
                            <StatusBadge status={t.WorkTicketStatusName || '—'} />
                          </div>
                          {/* Hours grid: Est / Actual / Scheduled / Unscheduled / Earned / Revenue */}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
                            {[
                              { label: 'Est',      value: `${fmtHrs(est)}h` },
                              { label: 'Actual',   value: `${fmtHrs(act)}h`,    alert: act > est && est > 0 },
                              { label: 'Sched',    value: `${fmtHrs(sched)}h` },
                              { label: 'Unsched',  value: `${fmtHrs(unsched)}h`, alert: unsched > 0 },
                              { label: 'Earned',   value: fmtMoney(t.EarnedRevenue), highlight: (t.EarnedRevenue ?? 0) > 0 },
                              { label: 'Revenue',  value: fmtMoney(t.Revenue) },
                            ].map(({ label, value, alert, highlight }) => (
                              <div key={label} style={{ background: '#f8fafc', borderRadius: 5, padding: '4px 4px', textAlign: 'center' }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: alert ? '#ef4444' : highlight ? '#15803d' : '#111827' }}>{value}</div>
                                <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 1 }}>{label}</div>
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

              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                {data.opp_number && (
                  <button
                    disabled={handoffLoading}
                    onClick={async () => {
                      setHandoffLoading(true);
                      setHandoffMsg('');
                      try {
                        await downloadHandoffPack(Math.round(Number(data.opp_number)));
                        setHandoffMsg('');
                      } catch (e: any) {
                        setHandoffMsg(e.message || 'Download failed');
                      } finally {
                        setHandoffLoading(false);
                      }
                    }}
                    style={{ padding: '13px 16px', background: '#1e3a5f', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: handoffLoading ? 'wait' : 'pointer', whiteSpace: 'nowrap', opacity: handoffLoading ? 0.6 : 1 }}
                  >
                    {handoffLoading ? '⏳' : '📄'} Handoff
                  </button>
                )}
              </div>
              {handoffMsg && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626' }}>{handoffMsg}</div>
              )}
            </>
          )}

          {/* ── History tab ──────────────────────────────────────────────── */}
          {tab === 'history' && (
            <>
              {/* Aspire Activities — filter out Email notification logs, strip HTML from notes */}
              {(() => {
                const stripHtml = (s: string) => {
                  try {
                    const doc = new DOMParser().parseFromString(s, 'text/html');
                    return (doc.body.textContent || '').replace(/\s{2,}/g, ' ').trim();
                  } catch {
                    return s.replace(/<[^>]*>/g, ' ').replace(/\s{2,}/g, ' ').trim();
                  }
                };
                const visibleActs = (data.activities || []).filter(
                  a => (a.ActivityType || '').toLowerCase() !== 'email'
                );
                return (
                  <>
                    <div style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                      Aspire Activities ({visibleActs.length})
                    </div>
                    {visibleActs.length === 0 ? (
                      <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '16px 0 24px' }}>
                        No activities logged in Aspire
                      </div>
                    ) : (
                      <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 24 }}>
                        {visibleActs.map((a, i) => {
                          const plainNotes = stripHtml(a.Notes || '');
                          return (
                            <div key={a.ActivityID} style={{
                              padding: '11px 14px',
                              background: i % 2 === 0 ? '#fff' : '#f9fafb',
                              borderTop: i > 0 ? '1px solid #f1f5f9' : undefined,
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 2 }}>
                                    {a.IsMileStone ? '🏁 ' : ''}{a.Subject || '(no subject)'}
                                  </div>
                                  <div style={{ fontSize: 11, color: '#9ca3af' }}>
                                    {[a.ActivityType, a.ActivityCategoryName].filter(Boolean).join(' · ')}
                                    {a.CreatedByUserName ? ` · ${a.CreatedByUserName}` : ''}
                                  </div>
                                </div>
                                <div style={{ flexShrink: 0, textAlign: 'right' }}>
                                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{a.CompleteDate || a.CreatedDate}</div>
                                  {a.Status && (
                                    <span style={{ fontSize: 10, fontWeight: 600, background: a.Status.toLowerCase().includes('complet') ? '#dcfce7' : '#fef3c7', color: a.Status.toLowerCase().includes('complet') ? '#15803d' : '#92400e', padding: '1px 6px', borderRadius: 8, marginTop: 3, display: 'inline-block' }}>
                                      {a.Status}
                                    </span>
                                  )}
                                </div>
                              </div>
                              {plainNotes && (
                                <div style={{ marginTop: 6, fontSize: 12, color: '#374151', lineHeight: 1.6, background: '#f8fafc', borderRadius: 6, padding: '6px 10px' }}>
                                  {plainNotes.length > 300 ? plainNotes.slice(0, 300) + '…' : plainNotes}
                                </div>
                              )}
                              {(a.comments || []).length > 0 && (
                                <div style={{ marginTop: 8 }}>
                                  {(a.comments || []).map((c, ci) => (
                                    <div key={ci} style={{ marginTop: 6, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '7px 10px' }}>
                                      <div style={{ fontSize: 10, color: '#92400e', fontWeight: 600, marginBottom: 3 }}>
                                        💬 {c.CreatedByUserName}{c.CreatedDate ? ` · ${c.CreatedDate}` : ''}
                                      </div>
                                      <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                                        {stripHtml(c.Comment)}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                );
              })()}

              {/* Check-in History */}
              <div style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                Check-in History ({responded})
              </div>
              {data.history.length === 0 ? (
                <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '16px 0' }}>
                  No check-ins yet
                </div>
              ) : data.history.map((h) => (
                <div key={h.id} style={{ marginBottom: 12, border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
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
                      <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 8 }}>{fmtDate(h.sent_at)}</span>
                    </div>
                    {h.remaining_hours != null && (
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#15803d' }}>{h.remaining_hours}h rem</span>
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
            <form onSubmit={e => {
              e.preventDefault();
              // Prepend prompt selections to approach notes if any selected
              const answered = (data.smart_prompts || []).filter(p => promptSelections[p.id]);
              // Persist answers so they're suppressed on next load
              answered.forEach(p => savePromptMemory(p.id, promptSelections[p.id], p.actHours));
              const promptLines = answered.map(p => `${p.icon} ${p.situation}\n→ ${promptSelections[p.id]}`);
              const combined = promptLines.length > 0
                ? promptLines.join('\n\n') + (approachNotes.trim() ? '\n\n' + approachNotes.trim() : '')
                : approachNotes.trim();
              if (!combined.trim()) return;
              handleSubmit(e, combined);
            }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a', marginBottom: 12 }}>
                Site Update
              </div>

              {/* ── Project Summary ── */}
              {data.project_summary && (
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '14px 16px', marginBottom: 18 }}>
                  <div style={{ fontWeight: 700, fontSize: 11, color: '#475569', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    🗂 Project Status
                  </div>
                  <p style={{ margin: 0, fontSize: 13, color: '#1e293b', lineHeight: 1.65 }}>
                    {data.project_summary}
                  </p>
                </div>
              )}

              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
                Answer the prompts below, then add any notes.
              </div>

              {/* ── Smart Prompts ── */}
              {(() => {
                const allPrompts   = data.smart_prompts || [];
                const visible      = allPrompts.filter(p => !isPromptSuppressed(p));
                const suppressed   = allPrompts.filter(p =>  isPromptSuppressed(p));
                const toRender     = showDismissed ? allPrompts : visible;

                return (
                  <>
                    {toRender.map(p => {
                      const mem = getPromptMemory(p.id);
                      const isSuppressed = isPromptSuppressed(p);
                      return (
                        <div key={p.id} style={{
                          marginBottom: 14,
                          border: `1.5px solid ${isSuppressed ? '#e5e7eb' : p.type === 'over_hours' ? '#fca5a5' : p.type === 'upcoming' ? '#93c5fd' : '#d1d5db'}`,
                          borderRadius: 10,
                          overflow: 'hidden',
                          opacity: isSuppressed ? 0.65 : 1,
                        }}>
                          <div style={{
                            padding: '10px 14px',
                            background: isSuppressed ? '#f9fafb' : p.type === 'over_hours' ? '#fff1f2' : p.type === 'upcoming' ? '#eff6ff' : '#f9fafb',
                          }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: isSuppressed ? '#6b7280' : p.type === 'over_hours' ? '#dc2626' : p.type === 'upcoming' ? '#1d4ed8' : '#374151', marginBottom: 2 }}>
                              {isSuppressed ? '✓ ' : ''}{p.icon} {p.situation}
                            </div>
                            <div style={{ fontSize: 13, color: '#0f172a', fontWeight: 600 }}>
                              {isSuppressed && mem?.answer
                                ? <span style={{ fontWeight: 400, color: '#6b7280', fontSize: 12 }}>Previously: {mem.answer}</span>
                                : p.question}
                            </div>
                          </div>
                          {!isSuppressed && (
                            <div style={{ padding: '8px 10px 10px', background: '#fff', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {p.options.map(opt => {
                                const selected = promptSelections[p.id] === opt;
                                return (
                                  <button
                                    key={opt}
                                    type="button"
                                    onClick={() => {
                                      const newVal = selected ? '' : opt;
                                      setPromptSelections(prev => ({ ...prev, [p.id]: newVal }));
                                      if (newVal) savePromptMemory(p.id, newVal, p.actHours);
                                    }}
                                    style={{
                                      padding: '6px 11px',
                                      borderRadius: 20,
                                      border: selected ? '2px solid #16a34a' : '1.5px solid #d1d5db',
                                      background: selected ? '#dcfce7' : '#fff',
                                      color: selected ? '#15803d' : '#374151',
                                      fontSize: 12,
                                      fontWeight: selected ? 700 : 400,
                                      cursor: 'pointer',
                                      textAlign: 'left',
                                    }}
                                  >
                                    {selected ? '✓ ' : ''}{opt}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {suppressed.length > 0 && !showDismissed && (
                      <button
                        type="button"
                        onClick={() => setShowDismissed(true)}
                        style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 12, cursor: 'pointer', padding: '0 0 14px', textDecoration: 'underline' }}
                      >
                        ↩ Show {suppressed.length} previously answered prompt{suppressed.length !== 1 ? 's' : ''}
                      </button>
                    )}
                    {showDismissed && suppressed.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowDismissed(false)}
                        style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 12, cursor: 'pointer', padding: '0 0 14px', textDecoration: 'underline' }}
                      >
                        ↑ Hide answered prompts
                      </button>
                    )}
                  </>
                );
              })()}

              {/* Coaching tip */}
              {data.ai_tip && (
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
                  <div style={{ fontWeight: 700, fontSize: 11, color: '#15803d', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    💡 Coaching Tip
                  </div>
                  {(data.ai_tip || '').split('\n\n').filter(Boolean).map((p, i, arr) => (
                    <p key={i} style={{ margin: i < arr.length - 1 ? '0 0 6px' : 0, fontSize: 12, color: '#1e293b', lineHeight: 1.5 }}>{p}</p>
                  ))}
                </div>
              )}

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
                  Additional notes <span style={{ color: '#6b7280', fontWeight: 400 }}>(optional if prompts answered)</span>
                </label>
                <textarea
                  rows={4}
                  placeholder="Any other details, plan for tomorrow, or context for the team…"
                  value={approachNotes}
                  onChange={e => setApproachNotes(e.target.value)}
                  style={{ ...INPUT, resize: 'vertical', minHeight: 90 }}
                />
              </div>

              <div style={{ marginBottom: 22 }}>
                <label style={LABEL}>Blockers or issues (optional)</label>
                <textarea
                  rows={2}
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

              {(() => {
                const hasPrompts = (data.smart_prompts || []).some(p => promptSelections[p.id]);
                const canSubmit  = hasPrompts || approachNotes.trim();
                return (
                  <button
                    type="submit"
                    disabled={submitting || !canSubmit}
                    style={{
                      width: '100%', padding: '15px',
                      background: canSubmit ? '#16a34a' : '#94a3b8',
                      color: '#fff', border: 'none', borderRadius: 10,
                      fontWeight: 800, fontSize: 16,
                      cursor: canSubmit ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {submitting ? 'Sending…' : 'Send Update to Team →'}
                  </button>
                );
              })()}
            </form>
          )}

          {/* ── Materials tab ─────────────────────────────────────────── */}
          {tab === 'materials' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Purchase Orders / Materials
                </div>
                <button
                  onClick={() => loadMaterials(true)}
                  style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 12 }}
                >
                  {materialsLoading ? '↻' : '↺ refresh'}
                </button>
              </div>

              {materialsLoading && (
                <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '32px 0' }}>
                  Loading materials…
                </div>
              )}

              {materialsError && !materialsLoading && (
                <div style={{ textAlign: 'center', color: '#dc2626', fontSize: 13, padding: '24px 0' }}>
                  {materialsError}
                </div>
              )}

              {!materialsLoading && materialsData && (
                <>
                  {/* PO list */}
                  {materialsData.pos.length === 0 && materialsData.tickets_without_po.length === 0 && (
                    <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '24px 0' }}>
                      No purchase orders found for this job
                    </div>
                  )}

                  {materialsData.pos.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      {materialsData.pos.map((po) => (
                        <div key={po.receipt_id} style={{
                          border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 10,
                        }}>
                          {/* PO header */}
                          <div style={{
                            background: '#f8fafc', padding: '10px 14px',
                            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                          }}>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: 13, color: '#111827' }}>
                                PO #{po.display_number ?? po.receipt_id}
                              </div>
                              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                                {po.service_name && <span>{po.service_name} · </span>}
                                {po.vendor_name}
                                {po.received_date && <span> · {po.received_date}</span>}
                              </div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>
                                {po.total ? `$${Number(po.total).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                              </div>
                              {po.status && (
                                <span style={{
                                  fontSize: 10, fontWeight: 600, marginTop: 3, display: 'inline-block',
                                  padding: '1px 7px', borderRadius: 8,
                                  background: po.status.toLowerCase().includes('approved') ? '#dcfce7' : po.status.toLowerCase().includes('new') ? '#fef3c7' : '#f1f5f9',
                                  color: po.status.toLowerCase().includes('approved') ? '#15803d' : po.status.toLowerCase().includes('new') ? '#92400e' : '#475569',
                                }}>
                                  {po.status}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Note snippet */}
                          {po.note && (
                            <div style={{ padding: '6px 14px', fontSize: 11, color: '#6b7280', borderTop: '1px solid #f1f5f9', background: '#fff' }}>
                              {po.note}
                            </div>
                          )}

                          {/* Debug: item field names — remove once description key is confirmed */}
                          {po._item_keys && po._item_keys.length > 0 && (
                            <div style={{ padding: '3px 14px', fontSize: 9, color: '#cbd5e1', borderTop: '1px solid #f8fafc', background: '#fff', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                              keys: {po._item_keys.join(', ')}
                            </div>
                          )}

                          {/* Line items (if Aspire returns them) */}
                          {po.items.length > 0 && (
                            <div style={{ borderTop: '1px solid #f1f5f9' }}>
                              {/* Table header */}
                              <div style={{
                                display: 'grid', gridTemplateColumns: '1fr 56px 64px 64px',
                                padding: '5px 14px', background: '#f8fafc',
                                fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em',
                              }}>
                                <div>Item</div><div style={{ textAlign: 'right' }}>Qty</div>
                                <div style={{ textAlign: 'right' }}>Unit</div>
                                <div style={{ textAlign: 'right' }}>Total</div>
                              </div>
                              {po.items.map((item, idx) => (
                                <div key={idx} style={{
                                  display: 'grid', gridTemplateColumns: '1fr 56px 64px 64px',
                                  padding: '6px 14px',
                                  background: idx % 2 === 0 ? '#fff' : '#f9fafb',
                                  fontSize: 12, color: '#374151',
                                  borderTop: '1px solid #f1f5f9',
                                }}>
                                  <div style={{ paddingRight: 8 }}>{item.description}</div>
                                  <div style={{ textAlign: 'right', color: '#6b7280' }}>{item.quantity}</div>
                                  <div style={{ textAlign: 'right', color: '#6b7280' }}>
                                    {item.unit_cost ? `$${Number(item.unit_cost).toFixed(2)}` : '—'}
                                  </div>
                                  <div style={{ textAlign: 'right', fontWeight: 600 }}>
                                    {item.total ? `$${Number(item.total).toFixed(2)}` : '—'}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Tickets without any PO */}
                  {materialsData.tickets_without_po.length > 0 && (
                    <>
                      <div style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                        Tickets Without PO
                      </div>
                      <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                        {materialsData.tickets_without_po.map((t, i) => (
                          <div key={t.WorkTicketID} style={{
                            padding: '11px 14px',
                            background: i % 2 === 0 ? '#fff' : '#f9fafb',
                            borderTop: i > 0 ? '1px solid #f1f5f9' : undefined,
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          }}>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
                                {t.ServiceName || `Ticket #${t.WorkTicketNumber}`}
                              </div>
                              <div style={{ fontSize: 11, color: '#9ca3af' }}>#{t.WorkTicketNumber}</div>
                            </div>
                            <a
                              href="/field/purchase-order"
                              style={{
                                padding: '7px 12px', background: '#16a34a', color: '#fff',
                                borderRadius: 8, fontSize: 12, fontWeight: 700,
                                textDecoration: 'none', whiteSpace: 'nowrap',
                              }}
                            >
                              ＋ Create PO
                            </a>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </>
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
