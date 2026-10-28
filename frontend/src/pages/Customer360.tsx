/**
 * Customer 360 — one unified view of a commercial customer (Aspire Company):
 * identity + contacts + properties, every job across all divisions, and the
 * portal activity we've attached (stage, schedule, prep, PHA, comms) — joined
 * live by the read-only GET /customer/{company_id}/360 endpoint.
 * Route: /dashboards/customer/360
 */
import { useEffect, useRef, useState } from 'react';
import {
  searchCustomerEntities, getCustomer360, getCustomer360ByContact,
  listSalesActivities, listSalesTasks, createSalesActivity, patchSalesActivity, patchSalesTask,
  createSalesTask, deleteSalesActivity, deleteSalesTask, sendSalesEmail, listSalesAssignees,
  getOpportunityTickets, aspireOpportunityUrl,
  type CustomerEntity, type Customer360, type C360Job, type SalesActivity, type SalesTask, type Assignee,
  type OppTicketSummary,
} from '../lib/api';

const sinp: React.CSSProperties = { padding: '9px 11px', borderRadius: 9, border: '1px solid #d1d5db', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' };

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

function isMaintenance(j: C360Job): boolean {
  return (j.division || '').toLowerCase().includes('maintenance');
}

function CompareRow({ label, est, act, money, neutral }: { label: string; est: number | null; act: number | null; money?: boolean; neutral?: boolean }) {
  const fmt = (v: number | null) => v == null ? '—' : money ? '$' + Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toLocaleString() + 'h';
  const e = est || 0, a = act || 0, diff = a - e;
  const pct = e ? Math.round(100 * diff / e) : null;
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
  const col = neutral ? '#64748b' : (diff > 0.05 ? '#b91c1c' : diff < -0.05 ? '#15803d' : '#64748b');
  const tn: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 14, alignItems: 'baseline', padding: '10px 0', borderTop: '1px solid #f1f5f9' }}>
      <span style={{ fontSize: 13, color: '#475569', fontWeight: 700 }}>{label}</span>
      <span style={{ ...tn, fontSize: 13, color: '#6b7280' }}>est {fmt(est)} · <b style={{ color: '#0f172a' }}>act {fmt(act)}</b></span>
      <span style={{ ...tn, fontSize: 12.5, fontWeight: 800, color: col, minWidth: 90, textAlign: 'right' }}>
        {Math.abs(diff) < 0.05 ? 'on budget' : `${sign}${fmt(Math.abs(diff))}${pct != null ? ` (${sign}${Math.abs(pct)}%)` : ''}`}
      </span>
    </div>
  );
}

function JobCard({ j, onBudget }: { j: C360Job; onBudget?: (j: C360Job) => void }) {
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
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          {isMaintenance(j) && onBudget && (
            <button onClick={() => onBudget(j)}
              style={{ fontSize: 12, fontWeight: 700, color: '#15803d', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 7, padding: '3px 9px', cursor: 'pointer' }}>
              $ Est vs actual
            </button>
          )}
          <a href={`/field/project/${j.opportunity_id}`} style={{ fontSize: 12, fontWeight: 700, color: NAVY, textDecoration: 'none' }}>Open ↗</a>
        </div>
      </div>
      {chips.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>{chips}</div>}
    </div>
  );
}

const TL_ICON: Record<string, string> = { comms: '✉️', schedule: '📅', pha: '🦺' };

// Colour + label per activity type, so the timeline reads at a glance.
const TYPE_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  note:       { bg: '#eef2ff', fg: '#3730a3', label: 'Note' },
  call:       { bg: '#fef9c3', fg: '#854d0e', label: 'Call' },
  meeting:    { bg: '#e0e7ff', fg: '#3730a3', label: 'Meeting' },
  site_visit: { bg: '#dcfce7', fg: '#166534', label: 'Site visit' },
  email:      { bg: '#e0f2fe', fg: '#075985', label: 'Email' },
};
const NOTE_TYPES = ['note', 'call', 'meeting', 'site_visit'] as const;
function typeStyle(t: string) { return TYPE_STYLE[t] || { bg: '#f1f5f9', fg: '#475569', label: t }; }
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px' };

export default function Customer360Page() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerEntity[]>([]);
  const [searching, setSearching] = useState(false);
  const [data, setData] = useState<Customer360 | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [salesActs, setSalesActs] = useState<SalesActivity[]>([]);
  const [salesTasks, setSalesTasks] = useState<SalesTask[]>([]);
  const [nType, setNType] = useState('note');
  const [nBody, setNBody] = useState('');
  const [nDate, setNDate] = useState('');
  const [salesBusy, setSalesBusy] = useState(false);
  // composer mode + task fields + list filtering
  const [mode, setMode] = useState<'note' | 'task'>('note');
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [tTitle, setTTitle] = useState('');
  const [tAssigneeId, setTAssigneeId] = useState<number | ''>('');
  const [tDue, setTDue] = useState('');
  const [filter, setFilter] = useState('all');
  const [find, setFind] = useState('');
  // email composer
  const [eOpen, setEOpen] = useState(false);
  const [eTo, setETo] = useState('');
  const [eCc, setECc] = useState('');
  const [eSubj, setESubj] = useState('');
  const [eBody, setEBody] = useState('');
  const [eBusy, setEBusy] = useState(false);
  const [eMsg, setEMsg] = useState('');
  // maintenance budget (est vs actual) popup
  const [budgetJob, setBudgetJob] = useState<C360Job | null>(null);
  const [budgetData, setBudgetData] = useState<OppTicketSummary | null>(null);
  const [budgetBusy, setBudgetBusy] = useState(false);
  const tmr = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justPicked = useRef(false);

  useEffect(() => { listSalesAssignees().then(r => setAssignees(r.assignees || [])).catch(() => {}); }, []);

  useEffect(() => {
    // Setting the box to the picked name must not re-open the dropdown.
    if (justPicked.current) { justPicked.current = false; setResults([]); return; }
    if (q.trim().length < 2) { setResults([]); return; }
    if (tmr.current) clearTimeout(tmr.current);
    tmr.current = setTimeout(async () => {
      setSearching(true);
      try { setResults(await searchCustomerEntities(q.trim())); } catch { setResults([]); } finally { setSearching(false); }
    }, 300);
    return () => { if (tmr.current) clearTimeout(tmr.current); };
  }, [q]);

  async function pick(e: CustomerEntity) {
    justPicked.current = true;
    if (tmr.current) clearTimeout(tmr.current);
    setResults([]); setSearching(false); setQ(e.name); setLoading(true); setErr(''); setData(null);
    try { setData(e.kind === 'contact' ? await getCustomer360ByContact(e.id) : await getCustomer360(e.id)); }
    catch (err) { setErr((err as Error).message); }
    finally { setLoading(false); }
  }

  const customerKey = data
    ? (data.customer.kind === 'contact' ? `contact:${data.customer.contact_id}` : `company:${data.customer.company_id}`)
    : null;

  async function loadSales(key: string) {
    try {
      const [a, t] = await Promise.all([listSalesActivities(key), listSalesTasks(key)]);
      setSalesActs(a.activities || []); setSalesTasks(t.tasks || []);
    } catch { setSalesActs([]); setSalesTasks([]); }
  }
  useEffect(() => {
    if (customerKey) loadSales(customerKey);
    else { setSalesActs([]); setSalesTasks([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerKey]);

  async function addNote() {
    if (!customerKey || !nBody.trim()) return;
    setSalesBusy(true);
    try {
      await createSalesActivity({ customer_key: customerKey, type: nType, body: nBody.trim(), next_action_date: nDate || undefined });
      setNBody(''); setNDate('');
      await loadSales(customerKey);
    } catch (e) { setErr((e as Error).message); } finally { setSalesBusy(false); }
  }
  async function doFollowupDone(id: number) {
    try { await patchSalesActivity(id, { next_action_done: true }); if (customerKey) await loadSales(customerKey); } catch { /* ignore */ }
  }
  async function doTaskDone(id: number) {
    try { await patchSalesTask(id, { status: 'done' }); if (customerKey) await loadSales(customerKey); } catch { /* ignore */ }
  }
  async function addTask() {
    if (!customerKey || !tTitle.trim()) return;
    setSalesBusy(true);
    try {
      const a = assignees.find(x => x.id === tAssigneeId);
      await createSalesTask({
        customer_key: customerKey, title: tTitle.trim(),
        assignee_user_id: typeof tAssigneeId === 'number' ? tAssigneeId : undefined,
        assignee: a?.name, due_date: tDue || undefined,
      });
      setTTitle(''); setTAssigneeId(''); setTDue('');
      await loadSales(customerKey);
    } catch (e) { setErr((e as Error).message); } finally { setSalesBusy(false); }
  }
  async function delActivity(id: number) {
    if (!window.confirm('Delete this note?')) return;
    try { await deleteSalesActivity(id); if (customerKey) await loadSales(customerKey); } catch (e) { setErr((e as Error).message); }
  }
  async function delTask(id: number) {
    if (!window.confirm('Delete this task?')) return;
    try { await deleteSalesTask(id); if (customerKey) await loadSales(customerKey); } catch (e) { setErr((e as Error).message); }
  }
  function openEmail() {
    const c = data?.customer.contacts.find(x => x.primary && x.email) || data?.customer.contacts.find(x => x.email);
    setETo(c?.email || ''); setECc(''); setESubj(''); setEBody(''); setEMsg(''); setEOpen(true);
  }
  async function doSendEmail() {
    if (!eTo.trim() || !eSubj.trim()) { setEMsg('Recipient and subject are required.'); return; }
    setEBusy(true); setEMsg('');
    try {
      await sendSalesEmail({
        to: eTo.split(/[,;]/).map(s => s.trim()).filter(Boolean),
        cc: eCc.split(/[,;]/).map(s => s.trim()).filter(Boolean),
        subject: eSubj.trim(), body: eBody, customer_key: customerKey || undefined,
      });
      setEOpen(false);
      if (customerKey) await loadSales(customerKey);
    } catch (e) { setEMsg((e as Error).message); } finally { setEBusy(false); }
  }
  async function openBudget(j: C360Job) {
    setBudgetJob(j); setBudgetData(null); setBudgetBusy(true);
    try { setBudgetData(await getOpportunityTickets(j.opportunity_id)); }
    catch { setBudgetData(null); } finally { setBudgetBusy(false); }
  }
  const openTasks = salesTasks.filter(t => t.status === 'open');
  const findL = find.trim().toLowerCase();
  const shownActs = salesActs.filter(a =>
    (filter === 'all' || a.type === filter) &&
    (!findL || `${a.type} ${a.subject || ''} ${a.body || ''}`.toLowerCase().includes(findL)));

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
              {results.map(e => (
                <button key={`${e.kind}-${e.id}`} onClick={() => pick(e)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', borderTop: '1px solid #f1f5f9', background: 'none', cursor: 'pointer', fontSize: 13.5, color: '#111827' }}>
                  <span style={pill(e.kind === 'company' ? '#eef2ff' : '#ecfccb', e.kind === 'company' ? '#3730a3' : '#3f6212')}>
                    {e.kind === 'company' ? '🏢 Company' : '👤 Contact'}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                  {e.sub && <span style={{ fontSize: 11, color: '#9ca3af', flexShrink: 0 }}>{e.sub}</span>}
                </button>
              ))}
              {!searching && results.length === 0 && <div style={{ padding: '10px 12px', color: '#9ca3af', fontSize: 13 }}>No matches.</div>}
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

            {/* Sales notes & tasks */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 800, fontSize: 14, color: '#0f172a' }}>📝 Sales notes &amp; tasks</div>
                <button onClick={openEmail}
                  style={{ marginLeft: 'auto', padding: '7px 14px', borderRadius: 9, border: '1px solid ' + NAVY, background: '#fff', color: NAVY, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                  ✉ Send email
                </button>
              </div>

              {/* composer: Note vs Task */}
              <div style={{ display: 'inline-flex', gap: 2, background: '#f1f5f9', borderRadius: 9, padding: 3, marginBottom: 10 }}>
                {(['note', 'task'] as const).map(m => (
                  <button key={m} onClick={() => setMode(m)}
                    style={{ padding: '6px 16px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                      background: mode === m ? '#fff' : 'transparent', color: mode === m ? NAVY : '#64748b', boxShadow: mode === m ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>
                    {m === 'note' ? 'Note' : 'Task'}
                  </button>
                ))}
              </div>

              {mode === 'note' ? (
                <>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    <select value={nType} onChange={e => setNType(e.target.value)} style={{ ...sinp, width: 130 }}>
                      <option value="note">Note</option><option value="call">Call</option>
                      <option value="meeting">Meeting</option><option value="site_visit">Site visit</option>
                    </select>
                    <textarea value={nBody} onChange={e => setNBody(e.target.value)} rows={2} placeholder="Add a sales note…"
                      style={{ ...sinp, flex: 1, minWidth: 220, resize: 'vertical' }} />
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>Followup</span>
                    <input type="date" value={nDate} onChange={e => setNDate(e.target.value)} style={{ ...sinp, width: 160 }} />
                    <button onClick={addNote} disabled={salesBusy || !nBody.trim()}
                      style={{ marginLeft: 'auto', padding: '9px 18px', borderRadius: 9, border: 'none', background: (salesBusy || !nBody.trim()) ? '#94a3b8' : NAVY, color: '#fff', fontWeight: 800, fontSize: 14, cursor: (salesBusy || !nBody.trim()) ? 'default' : 'pointer' }}>
                      {salesBusy ? 'Saving…' : 'Add note'}
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input value={tTitle} onChange={e => setTTitle(e.target.value)} placeholder="Task — what needs doing?"
                    style={{ ...sinp, flex: 1, minWidth: 220 }} />
                  <select value={tAssigneeId} onChange={e => setTAssigneeId(e.target.value ? Number(e.target.value) : '')} style={{ ...sinp, width: 160 }}>
                    <option value="">Assign to…</option>
                    {assignees.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <input type="date" value={tDue} onChange={e => setTDue(e.target.value)} style={{ ...sinp, width: 160 }} />
                  <button onClick={addTask} disabled={salesBusy || !tTitle.trim()}
                    style={{ marginLeft: 'auto', padding: '9px 18px', borderRadius: 9, border: 'none', background: (salesBusy || !tTitle.trim()) ? '#94a3b8' : NAVY, color: '#fff', fontWeight: 800, fontSize: 14, cursor: (salesBusy || !tTitle.trim()) ? 'default' : 'pointer' }}>
                    {salesBusy ? 'Saving…' : 'Assign task'}
                  </button>
                </div>
              )}

              {openTasks.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 4 }}>Open tasks ({openTasks.length})</div>
                  {openTasks.map(t => (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid #f1f5f9' }}>
                      <span style={{ ...pill('#fef3c7', '#92400e'), flexShrink: 0 }}>Task</span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: '#111827' }}>
                        {t.title}{t.assignee ? ` · ${t.assignee}` : ''}{t.due_date ? ` · due ${pretty(t.due_date)}` : ''}
                      </span>
                      <button onClick={() => doTaskDone(t.id)} style={{ ...pill('#dcfce7', '#15803d'), border: 'none', cursor: 'pointer' }}>✓ Done</button>
                      <button onClick={() => delTask(t.id)} title="Delete task" style={iconBtn}>🗑</button>
                    </div>
                  ))}
                </div>
              )}

              {/* filter + search toolbar */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {['all', ...NOTE_TYPES, 'email'].map(f => {
                    const n = f === 'all' ? salesActs.length : salesActs.filter(a => a.type === f).length;
                    const act = filter === f;
                    const lbl = f === 'all' ? 'All' : typeStyle(f).label;
                    return (
                      <button key={f} onClick={() => setFilter(f)}
                        style={{ padding: '4px 10px', borderRadius: 999, border: '1px solid ' + (act ? NAVY : '#e5e7eb'), background: act ? NAVY : '#fff', color: act ? '#fff' : '#475569', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                        {lbl}{n ? ` ${n}` : ''}
                      </button>
                    );
                  })}
                </div>
                <input value={find} onChange={e => setFind(e.target.value)} placeholder="Search notes…"
                  style={{ ...sinp, marginLeft: 'auto', width: 180, padding: '6px 10px' }} />
              </div>

              {/* scrollable timeline */}
              <div style={{ marginTop: 10, maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
                {salesActs.length === 0 && <div style={{ color: '#9ca3af', fontSize: 13, padding: '6px 0' }}>No sales notes yet — add the first above.</div>}
                {salesActs.length > 0 && shownActs.length === 0 && <div style={{ color: '#9ca3af', fontSize: 13, padding: '6px 0' }}>Nothing matches this filter.</div>}
                {shownActs.map(a => {
                  const ts = typeStyle(a.type);
                  return (
                    <div key={a.id} style={{ padding: '8px 0', borderTop: '1px solid #f1f5f9' }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: '#111827', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          <span style={{ ...pill(ts.bg, ts.fg), marginRight: 6 }}>{ts.label}{a.direction === 'in' ? ' ↓' : a.direction === 'out' ? ' ↑' : ''}</span>
                          {a.subject && a.type === 'email' ? <b>{a.subject}</b> : null}
                          {a.subject && a.type === 'email' ? <div>{a.body}</div> : a.body}
                        </div>
                        <button onClick={() => delActivity(a.id)} title="Delete" style={iconBtn}>🗑</button>
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>
                        {pretty((a.occurred_at || a.created_at || '').slice(0, 10))}{a.created_by ? ` · ${a.created_by}` : ''}
                        {a.next_action_date && !a.next_action_done && (
                          <span style={{ ...pill('#fef3c7', '#92400e'), marginLeft: 6 }}>
                            followup {pretty(a.next_action_date)}{' '}
                            <button onClick={() => doFollowupDone(a.id)} style={{ background: 'none', border: 'none', color: '#92400e', cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 11 }}>done</button>
                          </span>
                        )}
                      </div>
                      {a.attachments && a.attachments.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                          {a.attachments.map(att => att.url ? (att.kind === 'photo'
                            ? <a key={att.id} href={att.url} target="_blank" rel="noreferrer"><img src={att.url} alt="" style={{ width: 54, height: 54, objectFit: 'cover', borderRadius: 6, border: '1px solid #e5e7eb' }} /></a>
                            : <a key={att.id} href={att.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: NAVY }}>{att.kind === 'video' ? '🎥' : '📎'} {att.file_name || 'file'}</a>
                          ) : null)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {/* Jobs */}
              <div style={{ flex: 1, minWidth: 320 }}>
                {active.length === 0 && <div style={{ color: '#9ca3af', fontSize: 13, padding: 12 }}>No active jobs.</div>}
                {[...byProperty.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([prop, pj]) => (
                  <div key={prop} style={{ marginBottom: 16 }}>
                    <div style={{ fontWeight: 800, fontSize: 14, color: NAVY, margin: '2px 0 8px' }}>📍 {prop} <span style={{ color: '#9ca3af', fontWeight: 500 }}>({pj.length})</span></div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {pj.sort((a, b) => (b.start_date || b.won_date || '').localeCompare(a.start_date || a.won_date || '')).map(j => <JobCard key={j.opportunity_id} j={j} onBudget={openBudget} />)}
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
                        {history.sort((a, b) => (b.start_date || b.won_date || '').localeCompare(a.start_date || a.won_date || '')).map(j => <JobCard key={j.opportunity_id} j={j} onBudget={openBudget} />)}
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

      {/* Maintenance budget — estimate vs actual */}
      {budgetJob && (
        <div onClick={() => setBudgetJob(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 20, zIndex: 50, overflowY: 'auto' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, padding: 18, width: '100%', maxWidth: 520, boxShadow: '0 20px 50px rgba(0,0,0,0.25)', marginTop: 50 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a' }}>{budgetJob.name || 'Maintenance contract'}</div>
                <div style={{ fontSize: 12, color: '#9ca3af' }}>
                  {DIV_ICON[budgetJob.division || ''] || '📍'} {budgetJob.division}{budgetJob.number ? ` · #${budgetJob.number}` : ''}
                  {budgetJob.pct_complete != null ? ` · ${Math.round(budgetJob.pct_complete * 100)}% complete` : ''}
                </div>
              </div>
              <button onClick={() => setBudgetJob(null)} style={{ ...iconBtn, marginLeft: 'auto', color: '#94a3b8', fontSize: 20 }}>×</button>
            </div>

            {budgetBusy && <Spinner label="Loading budget…" />}
            {!budgetBusy && !budgetData && <div style={{ color: '#991b1b', fontSize: 13, padding: '10px 0' }}>Couldn't load the estimate vs actual for this job.</div>}
            {!budgetBusy && budgetData && (() => {
              const t = budgetData.totals;
              const contract = budgetJob.won_dollars != null && budgetJob.won_dollars > 0 ? budgetJob.won_dollars : t.price;
              return (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#9ca3af', fontWeight: 700 }}>Estimate vs actual</div>
                  <CompareRow label="Hours" est={t.est_hours} act={t.act_hours} />
                  <CompareRow label="Cost" est={t.est_cost} act={t.act_cost} money />
                  <CompareRow label="Revenue (contract → earned)" est={contract} act={t.revenue} money neutral />
                  <div style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 10 }}>
                    {budgetData.ticket_count} work ticket{budgetData.ticket_count === 1 ? '' : 's'} · cost = labor + materials + equip + sub + other · negative variance = under estimate.
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                    <a href={aspireOpportunityUrl(budgetJob.opportunity_id)} target="_blank" rel="noreferrer"
                      style={{ padding: '9px 16px', borderRadius: 9, background: NAVY, color: '#fff', fontWeight: 800, fontSize: 13.5, textDecoration: 'none' }}>
                      Open estimate in Aspire ↗
                    </a>
                    <button onClick={() => setBudgetJob(null)}
                      style={{ marginLeft: 'auto', padding: '9px 16px', borderRadius: 9, border: '1px solid #e5e7eb', background: '#fff', color: '#475569', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}>Close</button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Email composer */}
      {eOpen && (
        <div onClick={() => !eBusy && setEOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 20, zIndex: 50, overflowY: 'auto' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, padding: 18, width: '100%', maxWidth: 560, boxShadow: '0 20px 50px rgba(0,0,0,0.25)', marginTop: 40 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a' }}>✉ Send email</div>
              <button onClick={() => setEOpen(false)} style={{ ...iconBtn, marginLeft: 'auto', color: '#94a3b8', fontSize: 20 }}>×</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#6b7280' }}>To
                <input value={eTo} onChange={e => setETo(e.target.value)} placeholder="name@example.com (comma-separated)"
                  style={{ ...sinp, width: '100%', marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#6b7280' }}>Cc <span style={{ fontWeight: 400 }}>(optional)</span>
                <input value={eCc} onChange={e => setECc(e.target.value)} placeholder="comma-separated"
                  style={{ ...sinp, width: '100%', marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#6b7280' }}>Subject
                <input value={eSubj} onChange={e => setESubj(e.target.value)} style={{ ...sinp, width: '100%', marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#6b7280' }}>Message
                <textarea value={eBody} onChange={e => setEBody(e.target.value)} rows={8}
                  style={{ ...sinp, width: '100%', marginTop: 3, resize: 'vertical' }} />
              </label>
            </div>
            {eMsg && <div style={{ color: '#991b1b', fontSize: 12, marginTop: 8 }}>{eMsg}</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>Sends from your address and logs to this customer.</span>
              <button onClick={() => setEOpen(false)} disabled={eBusy}
                style={{ marginLeft: 'auto', padding: '9px 16px', borderRadius: 9, border: '1px solid #e5e7eb', background: '#fff', color: '#475569', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
              <button onClick={doSendEmail} disabled={eBusy || !eTo.trim() || !eSubj.trim()}
                style={{ padding: '9px 20px', borderRadius: 9, border: 'none', background: (eBusy || !eTo.trim() || !eSubj.trim()) ? '#94a3b8' : NAVY, color: '#fff', fontWeight: 800, fontSize: 14, cursor: (eBusy || !eTo.trim() || !eSubj.trim()) ? 'default' : 'pointer' }}>
                {eBusy ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
