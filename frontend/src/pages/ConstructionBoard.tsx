/**
 * Construction Weekly Schedule board — crew × day grid with multi-day job blocks.
 * Route: /dashboards/construction/board   (login required)
 *
 * Schedule a job → pick employees + hours; the block auto-spans working days
 * (hours ÷ [employees × hours/day], Mon–Thu, Fridays optional). Right-click a
 * block to edit (move start, toggle Fridays, add/remove employees) or delete.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getScheduleWeek, createBlock, updateBlock, deleteBlock, createLabel, deleteLabel,
  type ScheduleWeek, type ScheduleBlock, type ScheduleBacklogJob, type BlockInput,
} from '../lib/api';

const NAVY = '#1A5376';
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10);
}
function fmtDay(iso: string): string {
  try { return new Date(iso + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }); } catch { return iso; }
}
function weekLabel(days: string[]): string { return days.length ? `${fmtDay(days[0])} – ${fmtDay(days[days.length - 1])}` : ''; }

// Client-side span preview — mirrors the backend rule (Mon–Thu, Fri optional).
function workingDates(startIso: string, count: number, includeFriday: boolean): string[] {
  const out: string[] = []; const d = new Date(startIso + 'T00:00:00'); let g = 0;
  while (out.length < count && g < 400) {
    const wd = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
    if (wd <= 3 || (wd === 4 && includeFriday)) out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1); g++;
  }
  return out;
}
function blockDates(startIso: string, hours: number | null | undefined, empCount: number, hpd: number, includeFriday: boolean): string[] {
  const h = Number(hours) || 0; const per = (Number(hpd) || 10) || 10; const emp = Math.max(1, empCount);
  const need = h > 0 ? Math.max(1, Math.ceil(h / (emp * per))) : 1;
  return workingDates(startIso, need, includeFriday);
}
function blockColor(id: number) {
  const hue = (id * 57) % 360;
  return { bg: `hsl(${hue},70%,93%)`, fg: `hsl(${hue},55%,28%)`, border: `hsl(${hue},55%,48%)` };
}

type Draft = {
  mode: 'create' | 'edit'; id?: number;
  opportunity_id: number | null; job_label: string; start_date: string;
  hours: string; hours_per_day: string; include_friday: boolean; employees: Set<string>; note: string;
};

export default function ConstructionBoard() {
  const [week, setWeek] = useState<ScheduleWeek | null>(null);
  const [start, setStart] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [dragOver, setDragOver] = useState('');
  const drag = useRef<ScheduleBacklogJob | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; block: ScheduleBlock } | null>(null);

  async function load(s?: string) {
    setLoading(true); setErr('');
    try { const w = await getScheduleWeek(s); setWeek(w); setStart(w.week_start); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(start); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const close = () => setCtx(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  if (loading) return <div style={{ padding: 40, color: '#9ca3af' }}>Loading the week…</div>;

  const crew = week?.crew ?? [];
  const blocks = week?.blocks ?? [];
  const labels = week?.labels ?? [];
  const days = week?.days ?? [];

  // Rows = crew, plus anyone referenced in blocks/labels who isn't in the roster.
  const rowNames: string[] = [];
  for (const c of crew) if (!rowNames.includes(c.name)) rowNames.push(c.name);
  for (const b of blocks) for (const e of b.employees) if (!rowNames.includes(e)) rowNames.push(e);
  for (const l of labels) if (l.lead_name && !rowNames.includes(l.lead_name)) rowNames.push(l.lead_name);

  const crewOptions = rowNames.length ? rowNames : crew.map(c => c.name);
  const backlog = (week?.backlog ?? []).filter(j =>
    !q.trim() || (j.label || '').toLowerCase().includes(q.toLowerCase()) || String(j.opp_number ?? '').includes(q));

  function openCreate(job: ScheduleBacklogJob, startDate: string, row?: string) {
    setDraft({
      mode: 'create', opportunity_id: job.opportunity_id, job_label: job.label,
      start_date: startDate, hours: job.hours_est != null ? String(job.hours_est) : '',
      hours_per_day: '10', include_friday: false,
      employees: new Set(row ? [row] : []), note: '',
    });
  }
  function openEdit(b: ScheduleBlock) {
    setCtx(null);
    setDraft({
      mode: 'edit', id: b.id, opportunity_id: b.opportunity_id, job_label: b.job_label,
      start_date: b.start_date, hours: b.hours != null ? String(b.hours) : '',
      hours_per_day: String(b.hours_per_day || 10), include_friday: b.include_friday,
      employees: new Set(b.employees), note: b.note || '',
    });
  }

  async function saveDraft() {
    if (!draft) return;
    if (draft.employees.size === 0) { setErr('Pick at least one employee'); return; }
    setBusy(true); setErr('');
    const payload: BlockInput = {
      opportunity_id: draft.opportunity_id, job_label: draft.job_label, start_date: draft.start_date,
      hours: draft.hours ? Number(draft.hours) : null, hours_per_day: Number(draft.hours_per_day) || 10,
      include_friday: draft.include_friday, employees: Array.from(draft.employees), note: draft.note,
    };
    try {
      if (draft.mode === 'create') await createBlock(payload);
      else await updateBlock(draft.id!, payload);
      setDraft(null);
      await reloadKeepBacklog();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  // Reload assignments/blocks without refetching the Aspire backlog (snappier).
  async function reloadKeepBacklog() {
    try {
      const w = await getScheduleWeek(start);
      setWeek(prev => prev ? { ...w, backlog: prev.backlog.length ? prev.backlog : w.backlog } : w);
    } catch { /* ignore */ }
  }

  async function toggleFridays(b: ScheduleBlock) {
    setCtx(null); setBusy(true);
    try { await updateBlock(b.id, { include_friday: !b.include_friday }); await reloadKeepBacklog(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function removeBlock(b: ScheduleBlock) {
    setCtx(null); setBusy(true);
    try { await deleteBlock(b.id); await reloadKeepBacklog(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function moveStart(b: ScheduleBlock, delta: number) {
    setCtx(null); setBusy(true);
    try { await updateBlock(b.id, { start_date: addDays(b.start_date, delta) }); await reloadKeepBacklog(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function addLabel(row: string, day: string) {
    const label = window.prompt('Label for this cell (e.g. Away, Shop, Vacation):');
    if (!label || !label.trim()) return;
    setBusy(true);
    try { await createLabel({ work_date: day, lead_name: row, job_label: label.trim() }); await reloadKeepBacklog(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function removeLabel(id: number) {
    setBusy(true);
    try { await deleteLabel(id); await reloadKeepBacklog(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>📅 Construction Weekly Schedule</h1>
          <p style={{ margin: '3px 0 0', color: '#6b7280', fontSize: 13 }}>Drag a job onto a crew/day to schedule it. Right-click a block to edit or remove.</p>
        </div>
        <Link to="/dashboards/construction/plan" style={{ textDecoration: 'none', padding: '8px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontWeight: 700, fontSize: 13 }}>📋 Monthly Plan</Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={() => start && load(addDays(start, -7))} style={navBtn}>‹</button>
          <div style={{ padding: '6px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, fontWeight: 700, fontSize: 14, color: '#1f2937', minWidth: 150, textAlign: 'center' }}>{weekLabel(days)}</div>
          <button onClick={() => start && load(addDays(start, 7))} style={navBtn}>›</button>
          <button onClick={() => load(undefined)} style={{ ...navBtn, fontSize: 11, padding: '6px 12px' }}>This week</button>
        </div>
      </div>

      {err && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 14px', color: '#991b1b', marginBottom: 14 }}>{err}</div>}

      {week && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          {/* Backlog */}
          <div style={{ width: 240, flexShrink: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, maxHeight: '78vh', overflowY: 'auto', position: 'sticky', top: 12 }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: '#0f172a', marginBottom: 8 }}>📥 Backlog <span style={{ color: '#9ca3af', fontWeight: 500 }}>({backlog.length})</span></div>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search jobs…" style={{ width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, marginBottom: 10 }} />
            {backlog.map(j => (
              <div key={j.opportunity_id} draggable
                onDragStart={() => { drag.current = j; }}
                onClick={() => openCreate(j, days[0])}
                title="Drag onto a crew/day, or click to schedule"
                style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', marginBottom: 7, cursor: 'grab', background: '#f9fafb' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{j.label}</div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{j.opp_number ? `#${j.opp_number}` : ''}{j.hours_est ? ` · ${j.hours_est}h` : ''}{j.start_date ? ` · ${fmtDay(j.start_date)}` : ''}</div>
              </div>
            ))}
            {backlog.length === 0 && <div style={{ color: '#9ca3af', fontSize: 13 }}>No matching jobs.</div>}
          </div>

          {/* Grid */}
          <div style={{ flex: 1, overflowX: 'auto', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: `130px repeat(6, minmax(130px, 1fr))`, minWidth: 920 }}>
              <div style={{ ...hcell, borderLeft: 'none' }} />
              {days.map((d, i) => (
                <div key={d} style={{ ...hcell, background: i === 4 ? '#f1f5f9' : '#f8fafc' }}>
                  <div style={{ fontWeight: 800 }}>{DOW[i]}{i === 4 ? ' *' : ''}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{fmtDay(d)}</div>
                </div>
              ))}

              {crewOptions.length === 0 && <div style={{ gridColumn: '1 / -1', padding: 20, color: '#9ca3af', fontSize: 13 }}>No crew yet — add them under Monthly Plan → 👷 Leads.</div>}

              {crewOptions.map(row => (
                <div key={row} style={{ display: 'contents' }}>
                  <div style={lcell}>{row}</div>
                  {days.map(day => {
                    const key = `${row}|${day}`;
                    const here = blocks.filter(b => b.employees.includes(row) && b.dates.includes(day));
                    const labelsHere = labels.filter(l => l.lead_name === row && l.work_date === day);
                    return (
                      <div key={key}
                        onDragOver={e => { e.preventDefault(); if (dragOver !== key) setDragOver(key); }}
                        onDragLeave={() => setDragOver(o => o === key ? '' : o)}
                        onDrop={() => { const j = drag.current; drag.current = null; setDragOver(''); if (j) openCreate(j, day, row); }}
                        style={{ ...dcell, background: dragOver === key ? '#eff6ff' : '#fff', outline: dragOver === key ? `2px dashed ${NAVY}` : 'none' }}>
                        {here.map(b => {
                          const c = blockColor(b.id);
                          const isStart = b.dates[0] === day;
                          return (
                            <div key={b.id}
                              onContextMenu={e => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, block: b }); }}
                              onClick={() => openEdit(b)}
                              title={`${b.job_label}${b.hours ? ` · ${b.hours}h` : ''} · ${b.days_needed} day(s) · right-click to edit`}
                              style={{ background: c.bg, color: c.fg, borderLeft: `3px solid ${c.border}`, borderRadius: 5, padding: '3px 6px', marginBottom: 4, fontSize: 12, fontWeight: 700, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {isStart ? b.job_label : <span style={{ opacity: 0.75 }}>↳ {b.job_label}</span>}
                            </div>
                          );
                        })}
                        {labelsHere.map(l => (
                          <div key={'L' + l.id} style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#f1f5f9', color: '#475569', borderRadius: 5, padding: '3px 6px', marginBottom: 4, fontSize: 12, fontWeight: 600 }}>
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.job_label}</span>
                            <button onClick={() => removeLabel(l.id)} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>×</button>
                          </div>
                        ))}
                        <button onClick={() => addLabel(row, day)} title="Add a label" style={{ background: 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer', fontSize: 14, padding: 0, alignSelf: 'flex-start' }}>+</button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div style={{ padding: '6px 12px', fontSize: 11, color: '#9ca3af' }}>* Fridays are off by default — enable per job when scheduling or via right-click.</div>
          </div>
        </div>
      )}

      {/* Context menu */}
      {ctx && (
        <div style={{ position: 'fixed', top: ctx.y, left: ctx.x, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', zIndex: 1200, minWidth: 190, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
          {[
            { label: '✏️ Edit job…', fn: () => openEdit(ctx.block) },
            { label: ctx.block.include_friday ? '📅 Fridays: on → turn off' : '📅 Add Fridays', fn: () => toggleFridays(ctx.block) },
            { label: '◀ Move start earlier (1 day)', fn: () => moveStart(ctx.block, -1) },
            { label: '▶ Move start later (1 day)', fn: () => moveStart(ctx.block, 1) },
            { label: '🗑 Delete', fn: () => removeBlock(ctx.block), danger: true },
          ].map((it, i) => (
            <button key={i} onClick={it.fn} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, color: it.danger ? '#dc2626' : '#111827', borderTop: i ? '1px solid #f1f5f9' : 'none' }}>{it.label}</button>
          ))}
        </div>
      )}

      {/* Create / edit modal */}
      {draft && (
        <BlockModal draft={draft} setDraft={setDraft} crew={crewOptions} onSave={saveDraft} busy={busy} />
      )}

      {busy && <div style={{ position: 'fixed', bottom: 16, right: 16, background: '#0f172a', color: '#fff', padding: '8px 14px', borderRadius: 8, fontSize: 13, zIndex: 1300 }}>Saving…</div>}
    </div>
  );
}

function BlockModal({ draft, setDraft, crew, onSave, busy }: {
  draft: Draft; setDraft: (d: Draft | null) => void; crew: string[]; onSave: () => void; busy: boolean;
}) {
  const empCount = draft.employees.size;
  const dates = blockDates(draft.start_date, draft.hours ? Number(draft.hours) : 0, empCount, Number(draft.hours_per_day) || 10, draft.include_friday);
  const toggleEmp = (name: string) => {
    const s = new Set(draft.employees);
    s.has(name) ? s.delete(name) : s.add(name);
    setDraft({ ...draft, employees: s });
  };
  const inp: React.CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, fontFamily: 'inherit' };
  return (
    <div onClick={() => setDraft(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 1250, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '28px 12px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 520, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', fontWeight: 800, fontSize: 15, color: '#0f172a' }}>
          {draft.mode === 'create' ? 'Schedule job' : 'Edit scheduled job'}
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={mlbl}>Job</label>
            <input style={{ ...inp, width: '100%', boxSizing: 'border-box' }} value={draft.job_label} onChange={e => setDraft({ ...draft, job_label: e.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 110 }}>
              <label style={mlbl}>Total hours</label>
              <input style={{ ...inp, width: '100%', boxSizing: 'border-box' }} type="number" value={draft.hours} onChange={e => setDraft({ ...draft, hours: e.target.value })} />
            </div>
            <div style={{ width: 110 }}>
              <label style={mlbl}>Hours/day</label>
              <input style={{ ...inp, width: '100%', boxSizing: 'border-box' }} type="number" value={draft.hours_per_day} onChange={e => setDraft({ ...draft, hours_per_day: e.target.value })} />
            </div>
            <div style={{ width: 150 }}>
              <label style={mlbl}>Start date</label>
              <input style={{ ...inp, width: '100%', boxSizing: 'border-box' }} type="date" value={draft.start_date} onChange={e => setDraft({ ...draft, start_date: e.target.value })} />
            </div>
          </div>
          <div>
            <label style={mlbl}>Employees ({empCount})</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 4, maxHeight: 160, overflowY: 'auto', border: '1px solid #f1f5f9', borderRadius: 8, padding: 8 }}>
              {crew.map(name => (
                <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: '#374151', cursor: 'pointer', padding: '2px 0' }}>
                  <input type="checkbox" checked={draft.employees.has(name)} onChange={() => toggleEmp(name)} />
                  {name}
                </label>
              ))}
              {crew.length === 0 && <div style={{ color: '#9ca3af', fontSize: 13 }}>No crew in the roster.</div>}
            </div>
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#374151' }}>
            <input type="checkbox" checked={draft.include_friday} onChange={e => setDraft({ ...draft, include_friday: e.target.checked })} />
            Work Fridays on this job
          </label>
          <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#374151' }}>
            {empCount === 0
              ? 'Pick at least one employee to see the span.'
              : <><b>{dates.length} working day{dates.length === 1 ? '' : 's'}</b> · {fmtDay(dates[0])} → {fmtDay(dates[dates.length - 1])}
                  <span style={{ color: '#9ca3af' }}> ({draft.hours || '0'}h ÷ {empCount} × {draft.hours_per_day || 10}h/day)</span></>}
          </div>
        </div>
        <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={() => setDraft(null)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
          <button onClick={onSave} disabled={busy || empCount === 0} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: (busy || empCount === 0) ? '#94a3b8' : NAVY, color: '#fff', fontWeight: 800, fontSize: 14, cursor: busy || empCount === 0 ? 'default' : 'pointer' }}>
            {draft.mode === 'create' ? 'Schedule' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

const navBtn: React.CSSProperties = { padding: '6px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 15, color: '#374151', fontWeight: 700 };
const hcell: React.CSSProperties = { padding: '10px 8px', textAlign: 'center', borderBottom: '2px solid #e5e7eb', borderLeft: '1px solid #f1f5f9', fontSize: 13, color: '#111827' };
const lcell: React.CSSProperties = { padding: '8px', fontWeight: 700, fontSize: 13, color: '#0f172a', borderBottom: '1px solid #f1f5f9', background: '#fafafa', display: 'flex', alignItems: 'center' };
const dcell: React.CSSProperties = { padding: 6, borderBottom: '1px solid #f1f5f9', borderLeft: '1px solid #f1f5f9', minHeight: 60, display: 'flex', flexDirection: 'column' };
const mlbl: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 };
