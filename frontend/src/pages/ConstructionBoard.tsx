/**
 * Construction Weekly Schedule board — crew × day grid with multi-day job blocks.
 * Route: /dashboards/construction/board   (login required)
 *
 * Schedule a job → pick employees + hours; the block auto-spans working days
 * (hours ÷ [employees × hours/day], Mon–Thu, Fridays optional). Right-click a
 * block to edit (move start, toggle Fridays, add/remove employees) or delete.
 * Crew roster is portal-owned (no Aspire); left staff can be deactivated.
 * Horizon selector shows 1–12 weeks forward.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getScheduleWeek, createBlock, updateBlock, deleteBlock, createLabel, deleteLabel,
  listCrew, addCrew, updateCrew, deleteCrew, getJobScope, archiveJob, unarchiveJob,
  type ScheduleWeek, type ScheduleBlock, type ScheduleBacklogJob, type BlockInput, type CrewMember, type ScheduleStatus,
} from '../lib/api';

const NAVY = '#1A5376';
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HORIZONS = [1, 2, 4, 8, 12];

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10);
}
function fmtDay(iso: string): string {
  try { return new Date(iso + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }); } catch { return iso; }
}
function workingDates(startIso: string, count: number, includeFriday: boolean): string[] {
  const out: string[] = []; const d = new Date(startIso + 'T00:00:00'); let g = 0;
  while (out.length < count && g < 400) {
    const wd = (d.getDay() + 6) % 7;
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
function nextWorkingDay(iso: string, includeFriday: boolean): string {
  return workingDates(iso, 1, includeFriday)[0] || iso;
}
function shiftWorkingDays(iso: string, n: number, includeFriday: boolean): string {
  if (n <= 0) return iso;
  const arr = workingDates(iso, n + 1, includeFriday);
  return arr[arr.length - 1] || iso;
}
function blockColor(id: number) {
  const hue = (id * 57) % 360;
  return { bg: `hsl(${hue},70%,93%)`, fg: `hsl(${hue},55%,28%)`, border: `hsl(${hue},55%,48%)` };
}
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

type Draft = {
  mode: 'create' | 'edit'; id?: number;
  opportunity_id: number | null; job_label: string; start_date: string;
  hours: string; hours_per_day: string; include_friday: boolean; employees: Set<string>; note: string;
  status: ScheduleStatus; extra_days: number; exceptions: string[]; lead: string;
};

export default function ConstructionBoard() {
  const [week, setWeek] = useState<ScheduleWeek | null>(null);
  const [start, setStart] = useState<string | undefined>(undefined);
  const [weeks, setWeeks] = useState(12);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [dragOver, setDragOver] = useState('');
  const drag = useRef<ScheduleBacklogJob | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; block: ScheduleBlock; row: string; day: string } | null>(null);
  const [bctx, setBctx] = useState<{ x: number; y: number; job: ScheduleBacklogJob; archived: boolean } | null>(null);
  const [showCrew, setShowCrew] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [backlogOpen, setBacklogOpen] = useState(() => { try { return window.innerWidth >= 768; } catch { return true; } });
  const [cascade, setCascade] = useState<{ extended: ScheduleBlock; delta: number; affected: ScheduleBlock[] } | null>(null);
  const [conflict, setConflict] = useState<{ block: ScheduleBlock; conflicts: ScheduleBlock[] } | null>(null);

  async function load(s?: string, w?: number) {
    setLoading(true); setErr('');
    try { const data = await getScheduleWeek(s, w ?? weeks); setWeek(data); setStart(data.week_start); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(start, weeks); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const close = () => { setCtx(null); setBctx(null); };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  async function doArchive(job: ScheduleBacklogJob) { setBctx(null); setBusy(true); try { await archiveJob(job.opportunity_id); await reloadKeepBacklog(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }
  async function doUnarchive(job: ScheduleBacklogJob) { setBctx(null); setBusy(true); try { await unarchiveJob(job.opportunity_id); await reloadKeepBacklog(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }

  // Two blocks collide when they share an employee AND a calendar day.
  function overlaps(a: ScheduleBlock, b: ScheduleBlock): boolean {
    if (!a.employees.some(e => b.employees.includes(e))) return false;
    const bd = new Set(b.dates);
    return a.dates.some(d => bd.has(d));
  }
  function conflictsFor(target: ScheduleBlock): ScheduleBlock[] {
    return blocks.filter(b => b.id !== target.id && overlaps(b, target));
  }

  async function reloadKeepBacklog() {
    // Endpoint is fast (~0.25s) — just refresh everything so backlog/archived
    // reflect scheduling and archive changes immediately.
    try { setWeek(await getScheduleWeek(start, weeks)); } catch { /* ignore */ }
  }

  if (loading && !week) return <div style={{ padding: 40, color: '#9ca3af' }}>Loading the schedule…</div>;

  const crew = week?.crew ?? [];
  const blocks = week?.blocks ?? [];
  const labels = week?.labels ?? [];
  const days = week?.days ?? [];
  const activeCrewNames = crew.map(c => c.name);

  const rowNames: string[] = [];
  for (const c of crew) if (!rowNames.includes(c.name)) rowNames.push(c.name);
  for (const b of blocks) for (const e of b.employees) if (!rowNames.includes(e)) rowNames.push(e);
  for (const l of labels) if (l.lead_name && !rowNames.includes(l.lead_name)) rowNames.push(l.lead_name);
  const crewOptions = rowNames.length ? rowNames : activeCrewNames;

  const matchQ = (j: ScheduleBacklogJob) => !q.trim() || (j.label || '').toLowerCase().includes(q.toLowerCase()) || String(j.opp_number ?? '').includes(q);
  const backlog = (week?.backlog ?? []).filter(matchQ);
  const archived = (week?.archived ?? []).filter(matchQ);

  // Modal employee options = active crew ∪ whoever's already on the block being edited.
  const modalCrew = Array.from(new Set([...activeCrewNames, ...(draft ? Array.from(draft.employees) : [])]));

  function openCreate(job: ScheduleBacklogJob, startDate: string, row?: string) {
    setDraft({ mode: 'create', opportunity_id: job.opportunity_id, job_label: job.label, start_date: startDate,
      hours: job.hours_est != null ? String(job.hours_est) : '', hours_per_day: '10', include_friday: false,
      employees: new Set(row ? [row] : []), note: '', status: 'tentative', extra_days: 0, exceptions: [], lead: row || '' });
  }
  function openEdit(b: ScheduleBlock) {
    setCtx(null);
    setDraft({ mode: 'edit', id: b.id, opportunity_id: b.opportunity_id, job_label: b.job_label, start_date: b.start_date,
      hours: b.hours != null ? String(b.hours) : '', hours_per_day: String(b.hours_per_day || 10),
      include_friday: b.include_friday, employees: new Set(b.employees), note: b.note || '', status: b.status,
      extra_days: b.extra_days || 0, exceptions: b.exceptions || [], lead: b.lead_name || '' });
  }

  async function saveDraft() {
    if (!draft) return;
    if (draft.employees.size === 0) { setErr('Pick at least one employee'); return; }
    setBusy(true); setErr('');
    const payload: BlockInput = {
      opportunity_id: draft.opportunity_id, job_label: draft.job_label, start_date: draft.start_date,
      hours: draft.hours ? Number(draft.hours) : null, hours_per_day: Number(draft.hours_per_day) || 10,
      include_friday: draft.include_friday, employees: Array.from(draft.employees), note: draft.note, status: draft.status,
      extra_days: draft.extra_days, exceptions: draft.exceptions,
      lead_name: draft.employees.has(draft.lead) ? draft.lead : (Array.from(draft.employees)[0] || '') };
    try {
      const saved = draft.mode === 'create' ? await createBlock(payload) : await updateBlock(draft.id!, payload);
      const hits = (saved && saved.employees) ? conflictsFor(saved) : [];
      setDraft(null); await reloadKeepBacklog();
      if (hits.length) setConflict({ block: saved, conflicts: hits });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function toggleFridays(b: ScheduleBlock) { setCtx(null); setBusy(true); try { await updateBlock(b.id, { include_friday: !b.include_friday }); await reloadKeepBacklog(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }
  async function removeBlock(b: ScheduleBlock) { setCtx(null); setBusy(true); try { await deleteBlock(b.id); await reloadKeepBacklog(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }
  async function moveStart(b: ScheduleBlock, delta: number) {
    setCtx(null);
    if (b.status === 'confirmed' && !window.confirm('This job is confirmed (locked). Move it anyway?')) return;
    setBusy(true);
    try {
      const updated = await updateBlock(b.id, { start_date: addDays(b.start_date, delta) });
      const hits = (updated && updated.employees) ? conflictsFor(updated) : [];
      await reloadKeepBacklog();
      if (hits.length) setConflict({ block: updated, conflicts: hits });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function applyConflict(mode: 'push' | 'leave') {
    const c = conflict; setConflict(null);
    if (!c || mode === 'leave') return;
    setBusy(true);
    try {
      // Push each conflicting job to start after this one ends (chained so they
      // don't collide with each other either).
      const ordered = [...c.conflicts].sort((a, b) => a.start_date.localeCompare(b.start_date));
      let cursorEnd = c.block.end_date;
      for (const b of ordered) {
        const ns = nextWorkingDay(addDays(cursorEnd, 1), b.include_friday);
        await updateBlock(b.id, { start_date: ns });
        const span = workingDates(ns, b.days_needed, b.include_friday);
        cursorEnd = span[span.length - 1] || ns;
      }
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); await reloadKeepBacklog(); }
  }
  async function setStatus(b: ScheduleBlock, status: ScheduleStatus) { setCtx(null); setBusy(true); try { await updateBlock(b.id, { status }); await reloadKeepBacklog(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }
  async function extendDays(b: ScheduleBlock, delta: number) {
    setCtx(null); setBusy(true);
    try {
      const updated = await updateBlock(b.id, { extra_days: Math.max(0, (b.extra_days || 0) + delta) });
      if (delta > 0) {
        // Subsequent jobs on the same crew that this extension could push into.
        const affected = blocks.filter(x => x.id !== b.id && x.start_date >= b.start_date
          && x.employees.some(e => b.employees.includes(e)));
        if (affected.length) { setCascade({ extended: updated, delta, affected }); setBusy(false); return; }
      }
      await reloadKeepBacklog();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function applyCascade(mode: 'push' | 'reflow' | 'leave') {
    const c = cascade; setCascade(null);
    if (!c) return;
    setBusy(true);
    try {
      if (mode === 'push') {
        for (const b of c.affected) {
          await updateBlock(b.id, { start_date: shiftWorkingDays(b.start_date, c.delta, b.include_friday) });
        }
      } else if (mode === 'reflow') {
        const ordered = [...c.affected].sort((a, b) => a.start_date.localeCompare(b.start_date));
        let cursorEnd = c.extended.end_date;
        for (const b of ordered) {
          const ns = nextWorkingDay(addDays(cursorEnd, 1), b.include_friday);
          await updateBlock(b.id, { start_date: ns });
          const span = workingDates(ns, b.days_needed, b.include_friday);
          cursorEnd = span[span.length - 1] || ns;
        }
      }
      // 'leave' → nothing
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); await reloadKeepBacklog(); }
  }
  async function removeFromDay(b: ScheduleBlock, row: string, day: string) {
    setCtx(null); setBusy(true);
    const ex = Array.from(new Set([...(b.exceptions || []), `${row}|${day}`]));
    try { await updateBlock(b.id, { exceptions: ex }); await reloadKeepBacklog(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function removeFromJob(b: ScheduleBlock, row: string) {
    setCtx(null);
    if (b.employees.length <= 1) { setErr('A job needs at least one employee — delete it instead.'); return; }
    setBusy(true);
    const employees = b.employees.filter(e => e !== row);
    const ex = (b.exceptions || []).filter(k => !k.startsWith(`${row}|`));
    try { await updateBlock(b.id, { employees, exceptions: ex }); await reloadKeepBacklog(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function addLabel(row: string, day: string) {
    const label = window.prompt('Label for this cell (e.g. Away, Shop, Vacation):'); if (!label || !label.trim()) return;
    setBusy(true); try { await createLabel({ work_date: day, lead_name: row, job_label: label.trim() }); await reloadKeepBacklog(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function removeLabel(id: number) { setBusy(true); try { await deleteLabel(id); await reloadKeepBacklog(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }

  const renderGrid = (slice: string[], widx: number) => (
    <div key={widx} style={{ marginBottom: 14, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '6px 12px', background: '#f1f5f9', fontSize: 12, fontWeight: 800, color: NAVY }}>
        Week of {fmtDay(slice[0])}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `130px repeat(6, minmax(120px, 1fr))`, minWidth: 900 }}>
          <div style={{ ...hcell, borderLeft: 'none' }} />
          {slice.map((d, i) => (
            <div key={d} style={{ ...hcell, background: i === 4 ? '#f1f5f9' : '#f8fafc' }}>
              <div style={{ fontWeight: 800 }}>{DOW[i]}{i === 4 ? ' *' : ''}</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>{fmtDay(d)}</div>
            </div>
          ))}
          {crewOptions.length === 0 && <div style={{ gridColumn: '1 / -1', padding: 16, color: '#9ca3af', fontSize: 13 }}>No crew — add some with 👷 Crew.</div>}
          {crewOptions.map(row => (
            <div key={row} style={{ display: 'contents' }}>
              <div style={lcell}>{row}</div>
              {slice.map(day => {
                const key = `${row}|${day}`;
                const here = blocks.filter(b => b.employees.includes(row) && b.dates.includes(day) && !(b.exceptions || []).includes(`${row}|${day}`));
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
                      const confirmed = b.status === 'confirmed';
                      return (
                        <div key={b.id}
                          onContextMenu={e => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, block: b, row, day }); }}
                          onClick={() => openEdit(b)}
                          title={`${b.job_label}${b.hours ? ` · ${b.hours}h` : ''} · ${b.days_needed} day(s)${b.over_budget ? ` (budget ${b.budget_days})` : ''} · ${confirmed ? 'CONFIRMED (locked)' : 'tentative'} · right-click for options`}
                          style={{ background: c.bg, color: c.fg, border: confirmed ? `1.5px solid ${c.border}` : `1px dashed ${c.border}`, borderLeft: `3px solid ${c.border}`, borderRadius: 5, padding: '3px 6px', marginBottom: 4, fontSize: 12, fontWeight: 700, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {confirmed && '🔒 '}{b.over_budget && '⚠ '}{b.lead_name === row && <span title="Job lead" style={{ color: '#f59e0b' }}>★ </span>}{isStart ? b.job_label : <span style={{ opacity: 0.75 }}>↳ {b.job_label}</span>}
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
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>📅 Construction Weekly Schedule</h1>
          <p style={{ margin: '3px 0 0', color: '#6b7280', fontSize: 13 }}>Drag a job onto a crew/day to schedule it. Right-click a block to edit.</p>
        </div>
        <button onClick={() => setBacklogOpen(o => !o)} style={{ ...navBtn, background: backlogOpen ? '#eff6ff' : '#fff', borderColor: backlogOpen ? '#bfdbfe' : '#e5e7eb' }}>
          📥 Unscheduled ({backlog.length})
        </button>
        <button onClick={() => setShowCrew(true)} style={navBtn}>👷 Crew</button>
        <Link to="/dashboards/construction/plan" style={{ textDecoration: 'none', padding: '8px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontWeight: 700, fontSize: 13 }}>📋 Monthly Plan</Link>
        <select value={weeks} onChange={e => { const w = Number(e.target.value); setWeeks(w); load(start, w); }}
          style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, fontWeight: 700, background: '#fff' }}>
          {HORIZONS.map(w => <option key={w} value={w}>{w === 1 ? '1 week' : `${w} weeks`}</option>)}
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={() => start && load(addDays(start, -7))} style={navBtn}>‹</button>
          <input type="date" value={start || ''} onChange={e => e.target.value && load(e.target.value)}
            style={{ padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, color: '#1f2937' }} />
          <button onClick={() => start && load(addDays(start, 7))} style={navBtn}>›</button>
          <button onClick={() => load(undefined)} style={{ ...navBtn, fontSize: 11, padding: '6px 12px' }}>Today</button>
        </div>
      </div>

      {err && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 14px', color: '#991b1b', marginBottom: 14 }}>{err}</div>}

      {week && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          {backlogOpen && (
          <div style={{ width: 240, flexShrink: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, maxHeight: '82vh', overflowY: 'auto', position: 'sticky', top: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontWeight: 800, fontSize: 13, color: '#0f172a' }}>📥 Unscheduled <span style={{ color: '#9ca3af', fontWeight: 500 }}>({backlog.length})</span></div>
              <button onClick={() => setBacklogOpen(false)} title="Hide list" style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 2 }}>‹</button>
            </div>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search jobs…" style={{ width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, marginBottom: 10 }} />
            {backlog.map(j => (
              <div key={j.opportunity_id} draggable onDragStart={() => { drag.current = j; }} onClick={() => openCreate(j, days[0])}
                onContextMenu={e => { e.preventDefault(); setBctx({ x: e.clientX, y: e.clientY, job: j, archived: false }); }}
                title="Drag onto a crew/day, click to schedule, or right-click to archive"
                style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', marginBottom: 7, cursor: 'grab', background: '#f9fafb' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{j.label}</div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{j.opp_number ? `#${j.opp_number}` : ''}{j.hours_est ? ` · ${j.hours_est}h` : ''}{j.start_date ? ` · ${fmtDay(j.start_date)}` : ''}</div>
              </div>
            ))}
            {backlog.length === 0 && <div style={{ color: '#9ca3af', fontSize: 13 }}>No matching jobs.</div>}

            {(archived.length > 0 || showArchived) && (
              <div style={{ marginTop: 12, borderTop: '1px solid #f1f5f9', paddingTop: 10 }}>
                <button onClick={() => setShowArchived(s => !s)}
                  style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 12, fontWeight: 700, padding: 0 }}>
                  {showArchived ? '▾' : '▸'} 🗄 Archived ({archived.length})
                </button>
                {showArchived && archived.map(j => (
                  <div key={j.opportunity_id}
                    onContextMenu={e => { e.preventDefault(); setBctx({ x: e.clientX, y: e.clientY, job: j, archived: true }); }}
                    title="Right-click to unarchive"
                    style={{ border: '1px dashed #e5e7eb', borderRadius: 8, padding: '7px 10px', marginTop: 7, background: '#fafafa', opacity: 0.75 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: '#6b7280', textDecoration: 'line-through' }}>{j.label}</span>
                      <button onClick={() => doUnarchive(j)} title="Unarchive" style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 13 }}>↩</button>
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{j.opp_number ? `#${j.opp_number}` : ''}{j.hours_est ? ` · ${j.hours_est}h` : ''}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10, fontSize: 12, color: '#6b7280', alignItems: 'center' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 20, height: 12, borderRadius: 4, border: '1px dashed #64748b', background: '#e2e8f0' }} /> Tentative (movable)</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 20, height: 12, borderRadius: 4, border: '1.5px solid #64748b', background: '#e2e8f0' }} /> 🔒 Confirmed (locked)</span>
              <span>· Unscheduled jobs sit in the list on the left.</span>
            </div>
            {chunk(days, 6).map((slice, i) => renderGrid(slice, i))}
            <div style={{ fontSize: 11, color: '#9ca3af' }}>* Fridays are off by default — enable per job when scheduling or via right-click.</div>
          </div>
        </div>
      )}

      {ctx && (
        <div style={{ position: 'fixed', top: ctx.y, left: ctx.x, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', zIndex: 1200, minWidth: 200, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
          {[
            { label: '✏️ Edit job…', fn: () => openEdit(ctx.block) },
            ctx.block.status === 'confirmed'
              ? { label: '🔓 Unlock (set tentative)', fn: () => setStatus(ctx.block, 'tentative') }
              : { label: '✅ Confirm (lock)', fn: () => setStatus(ctx.block, 'confirmed') },
            { label: `➖ Remove ${ctx.row} from ${fmtDay(ctx.day)}`, fn: () => removeFromDay(ctx.block, ctx.row, ctx.day) },
            { label: `👤 Remove ${ctx.row} from whole job`, fn: () => removeFromJob(ctx.block, ctx.row) },
            { label: '✚ Extend 1 day (past budget)', fn: () => extendDays(ctx.block, 1) },
            ...(ctx.block.extra_days > 0 ? [{ label: '✂️ Shorten 1 day', fn: () => extendDays(ctx.block, -1) }] : []),
            { label: ctx.block.include_friday ? '📅 Fridays: on → turn off' : '📅 Add Fridays', fn: () => toggleFridays(ctx.block) },
            { label: '◀ Move start earlier (1 day)', fn: () => moveStart(ctx.block, -1) },
            { label: '▶ Move start later (1 day)', fn: () => moveStart(ctx.block, 1) },
            { label: '🗑 Delete', fn: () => removeBlock(ctx.block), danger: true },
          ].map((it, i) => (
            <button key={i} onClick={it.fn} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, color: it.danger ? '#dc2626' : '#111827', borderTop: i ? '1px solid #f1f5f9' : 'none' }}>{it.label}</button>
          ))}
        </div>
      )}

      {bctx && (
        <div style={{ position: 'fixed', top: bctx.y, left: bctx.x, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', zIndex: 1200, minWidth: 170, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
          <button onClick={() => bctx.archived ? doUnarchive(bctx.job) : doArchive(bctx.job)}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, color: '#111827' }}>
            {bctx.archived ? '↩ Unarchive' : '🗄 Archive (hide from queue)'}
          </button>
        </div>
      )}

      {cascade && (
        <div onClick={() => applyCascade('leave')} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 1260, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '28px 12px' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 460, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', fontWeight: 800, fontSize: 15, color: '#0f172a' }}>
              ⚠ “{cascade.extended.job_label}” now runs {cascade.delta} day{cascade.delta === 1 ? '' : 's'} longer
            </div>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 13, color: '#374151', marginBottom: 12 }}>
                {cascade.affected.length} later job{cascade.affected.length === 1 ? '' : 's'} on the same crew could be affected:
                <div style={{ marginTop: 6, color: '#6b7280' }}>{cascade.affected.map(a => a.job_label).join(', ')}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button onClick={() => applyCascade('push')} style={cascBtn(NAVY, true)}>
                  ⏭ Push the following jobs back {cascade.delta} day{cascade.delta === 1 ? '' : 's'}
                  <div style={cascSub}>Shift every later job on this crew by the same amount.</div>
                </button>
                <button onClick={() => applyCascade('reflow')} style={cascBtn(NAVY, false)}>
                  🔗 Reflow — chain them after this job
                  <div style={cascSub}>Each following job starts right after the one before (by its hours).</div>
                </button>
                <button onClick={() => applyCascade('leave')} style={cascBtn('#6b7280', false)}>
                  ✋ Leave them as-is
                  <div style={cascSub}>Just extend this job; move nothing (may overlap).</div>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {conflict && (
        <div onClick={() => applyConflict('leave')} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 1260, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '28px 12px' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 460, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', fontWeight: 800, fontSize: 15, color: '#b45309' }}>
              ⚠ Double-booked crew
            </div>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 13, color: '#374151', marginBottom: 12 }}>
                “{conflict.block.job_label}” overlaps {conflict.conflicts.length} job{conflict.conflicts.length === 1 ? '' : 's'} already on the schedule for the same crew:
                <div style={{ marginTop: 6, color: '#6b7280' }}>{conflict.conflicts.map(a => a.job_label).join(', ')}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button onClick={() => applyConflict('push')} style={cascBtn(NAVY, true)}>
                  ⏭ Push the other job(s) to after this one
                  <div style={cascSub}>Clears the overlap — they restart when this job finishes.</div>
                </button>
                <button onClick={() => applyConflict('leave')} style={cascBtn('#6b7280', false)}>
                  ✋ Leave as double-booked
                  <div style={cascSub}>Keep both on the same days (you'll sort it out).</div>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {draft && <BlockModal draft={draft} setDraft={setDraft} crew={modalCrew} onSave={saveDraft} busy={busy} />}
      {showCrew && <CrewModal onClose={() => { setShowCrew(false); reloadKeepBacklog(); }} />}

      {busy && <div style={{ position: 'fixed', bottom: 16, right: 16, background: '#0f172a', color: '#fff', padding: '8px 14px', borderRadius: 8, fontSize: 13, zIndex: 1300 }}>Saving…</div>}
    </div>
  );
}

function BlockModal({ draft, setDraft, crew, onSave, busy }: {
  draft: Draft; setDraft: (d: Draft | null) => void; crew: string[]; onSave: () => void; busy: boolean;
}) {
  const empCount = draft.employees.size;
  const hpd = Number(draft.hours_per_day) || 10;
  const budgetDates = blockDates(draft.start_date, draft.hours ? Number(draft.hours) : 0, empCount, hpd, draft.include_friday);
  const dates = workingDates(draft.start_date, budgetDates.length + Math.max(0, draft.extra_days), draft.include_friday);
  const cells = Math.max(0, empCount * dates.length - draft.exceptions.length);
  const scheduledHours = cells * hpd;
  const budgetHours = Number(draft.hours) || 0;
  const toggleEmp = (name: string) => { const s = new Set(draft.employees); s.has(name) ? s.delete(name) : s.add(name); setDraft({ ...draft, employees: s }); };
  const inp: React.CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, fontFamily: 'inherit' };
  return (
    <div onClick={() => setDraft(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 1250, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '28px 12px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 520, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', fontWeight: 800, fontSize: 15, color: '#0f172a' }}>{draft.mode === 'create' ? 'Schedule job' : 'Edit scheduled job'}</div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {draft.opportunity_id != null && <JobScopePanel oppId={draft.opportunity_id} />}
          <div><label style={mlbl}>Job</label><input style={{ ...inp, width: '100%', boxSizing: 'border-box' }} value={draft.job_label} onChange={e => setDraft({ ...draft, job_label: e.target.value })} /></div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 110 }}><label style={mlbl}>Total hours</label><input style={{ ...inp, width: '100%', boxSizing: 'border-box' }} type="number" value={draft.hours} onChange={e => setDraft({ ...draft, hours: e.target.value })} /></div>
            <div style={{ width: 110 }}><label style={mlbl}>Hours/day</label><input style={{ ...inp, width: '100%', boxSizing: 'border-box' }} type="number" value={draft.hours_per_day} onChange={e => setDraft({ ...draft, hours_per_day: e.target.value })} /></div>
            <div style={{ width: 150 }}><label style={mlbl}>Start date</label><input style={{ ...inp, width: '100%', boxSizing: 'border-box' }} type="date" value={draft.start_date} onChange={e => setDraft({ ...draft, start_date: e.target.value })} /></div>
          </div>
          <div>
            <label style={mlbl}>Employees ({empCount}) — ★ marks the job lead</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 4, maxHeight: 180, overflowY: 'auto', border: '1px solid #f1f5f9', borderRadius: 8, padding: 8 }}>
              {crew.map(name => {
                const on = draft.employees.has(name);
                const isLead = on && (draft.lead === name || (!draft.employees.has(draft.lead) && Array.from(draft.employees)[0] === name));
                return (
                  <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151', padding: '2px 0' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 1, minWidth: 0 }}>
                      <input type="checkbox" checked={on} onChange={() => toggleEmp(name)} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                    </label>
                    {on && (
                      <button type="button" title={isLead ? 'Job lead' : 'Make lead'} onClick={() => setDraft({ ...draft, lead: name })}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: isLead ? '#f59e0b' : '#d1d5db', padding: 0, lineHeight: 1 }}>★</button>
                    )}
                  </div>
                );
              })}
              {crew.length === 0 && <div style={{ color: '#9ca3af', fontSize: 13 }}>No crew in the roster.</div>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#374151' }}>
              <input type="checkbox" checked={draft.include_friday} onChange={e => setDraft({ ...draft, include_friday: e.target.checked })} />Work Fridays on this job
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#374151' }}>
              <input type="checkbox" checked={draft.status === 'confirmed'} onChange={e => setDraft({ ...draft, status: e.target.checked ? 'confirmed' : 'tentative' })} />🔒 Confirmed (locked — don't move)
            </label>
          </div>
          {/* Duration / extend */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ ...mlbl, marginBottom: 0 }}>Duration</label>
            <button type="button" onClick={() => setDraft({ ...draft, extra_days: Math.max(0, draft.extra_days - 1) })} disabled={draft.extra_days <= 0}
              style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', cursor: draft.extra_days > 0 ? 'pointer' : 'default', fontSize: 15, fontWeight: 800 }}>−</button>
            <span style={{ fontSize: 13, color: '#374151' }}>{budgetDates.length} budget{draft.extra_days > 0 ? ` + ${draft.extra_days} extra` : ''} = <b>{dates.length} days</b></span>
            <button type="button" onClick={() => setDraft({ ...draft, extra_days: draft.extra_days + 1 })}
              style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 15, fontWeight: 800 }}>+</button>
          </div>
          {draft.exceptions.length > 0 && (
            <div>
              <label style={mlbl}>Day exceptions (person off a day)</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {draft.exceptions.map(k => {
                  const [emp, d] = k.split('|');
                  return (
                    <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#fef3c7', color: '#92400e', borderRadius: 8, padding: '3px 8px', fontSize: 12, fontWeight: 700 }}>
                      {emp} off {fmtDay(d)}
                      <button type="button" onClick={() => setDraft({ ...draft, exceptions: draft.exceptions.filter(x => x !== k) })} style={{ background: 'none', border: 'none', color: '#92400e', cursor: 'pointer', fontSize: 12, padding: 0 }}>×</button>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#374151' }}>
            {empCount === 0 ? 'Pick at least one employee to see the span.'
              : <>
                  <div><b>{dates.length} working day{dates.length === 1 ? '' : 's'}</b> · {fmtDay(dates[0])} → {fmtDay(dates[dates.length - 1])}</div>
                  <div style={{ color: '#9ca3af', marginTop: 2 }}>Scheduled {scheduledHours}h vs budget {budgetHours || '0'}h{draft.exceptions.length ? ` · ${draft.exceptions.length} day exception(s)` : ''}</div>
                  {draft.extra_days > 0 && <div style={{ color: '#b45309', fontWeight: 700, marginTop: 4 }}>⚠ Scheduled {draft.extra_days} day{draft.extra_days === 1 ? '' : 's'} past the budgeted time.</div>}
                </>}
          </div>
        </div>
        <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={() => setDraft(null)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
          <button onClick={onSave} disabled={busy || empCount === 0} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: (busy || empCount === 0) ? '#94a3b8' : NAVY, color: '#fff', fontWeight: 800, fontSize: 14, cursor: busy || empCount === 0 ? 'default' : 'pointer' }}>{draft.mode === 'create' ? 'Schedule' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function JobScopePanel({ oppId }: { oppId: number }) {
  const [scope, setScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getJobScope(oppId).then(r => { if (!cancelled) setScope(r.scope || ''); })
      .catch(() => { if (!cancelled) setScope(''); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [oppId]);
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>📋 Scope</span>
        <a href={`/field/project/${oppId}?tab=scope`} target="_blank" rel="noopener noreferrer"
          style={{ fontSize: 12, fontWeight: 700, color: NAVY, textDecoration: 'none', whiteSpace: 'nowrap' }}>
          Open Construction Job ↗
        </a>
      </div>
      {loading ? <div style={{ fontSize: 13, color: '#9ca3af' }}>Loading scope…</div>
        : scope ? <div style={{ fontSize: 13, color: '#374151', whiteSpace: 'pre-wrap', lineHeight: 1.5, maxHeight: 180, overflowY: 'auto' }}>{scope}</div>
        : <div style={{ fontSize: 13, color: '#9ca3af' }}>No scope notes in Aspire — open the job for full detail.</div>}
    </div>
  );
}

function CrewModal({ onClose }: { onClose: () => void }) {
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() { setLoading(true); try { setCrew(await listCrew(true)); } finally { setLoading(false); } }
  useEffect(() => { load(); }, []);

  async function add() { if (!name.trim()) return; setBusy(true); try { await addCrew(name.trim()); setName(''); await load(); } finally { setBusy(false); } }
  async function toggle(c: CrewMember) { setBusy(true); try { await updateCrew(c.id, { active: !c.active }); await load(); } finally { setBusy(false); } }
  async function rename(c: CrewMember) { const n = window.prompt('Rename crew member:', c.name); if (!n || !n.trim() || n === c.name) return; setBusy(true); try { await updateCrew(c.id, { name: n.trim() }); await load(); } finally { setBusy(false); } }
  async function remove(c: CrewMember) { if (!confirm(`Delete "${c.name}" from the roster? (Use Deactivate for staff who left — this is for typos.)`)) return; setBusy(true); try { await deleteCrew(c.id); await load(); } finally { setBusy(false); } }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 1250, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '28px 12px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 800, fontSize: 15, color: '#0f172a' }}>👷 Crew roster</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, color: '#6b7280', cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ padding: 20 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(); }} placeholder="Add crew member…"
              style={{ flex: 1, padding: '9px 11px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14 }} />
            <button onClick={add} disabled={busy || !name.trim()} style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>Add</button>
          </div>
          {loading ? <div style={{ color: '#9ca3af' }}>Loading…</div> : (
            <div style={{ border: '1px solid #f1f5f9', borderRadius: 8 }}>
              {crew.map((c, i) => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderTop: i ? '1px solid #f1f5f9' : 'none', opacity: c.active ? 1 : 0.55 }}>
                  <span style={{ flex: 1, fontSize: 14, color: '#111827', textDecoration: c.active ? 'none' : 'line-through' }}>{c.name}</span>
                  {!c.active && <span style={{ fontSize: 10, fontWeight: 700, color: '#92400e', background: '#fef3c7', padding: '1px 7px', borderRadius: 10 }}>INACTIVE</span>}
                  <button onClick={() => rename(c)} title="Rename" style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 13 }}>✏️</button>
                  <button onClick={() => toggle(c)} style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: c.active ? '#b91c1c' : '#15803d' }}>
                    {c.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                  <button onClick={() => remove(c)} title="Delete (typos only)" style={{ background: 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer', fontSize: 13 }}>🗑</button>
                </div>
              ))}
              {crew.length === 0 && <div style={{ padding: 12, color: '#9ca3af', fontSize: 13 }}>No crew yet.</div>}
            </div>
          )}
          <div style={{ marginTop: 12, fontSize: 11, color: '#9ca3af', lineHeight: 1.5 }}>
            Deactivating removes someone from new scheduling going forward. Jobs they're already on stay unchanged.
          </div>
        </div>
      </div>
    </div>
  );
}

const navBtn: React.CSSProperties = { padding: '7px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 14, color: '#374151', fontWeight: 700 };
const hcell: React.CSSProperties = { padding: '8px', textAlign: 'center', borderBottom: '2px solid #e5e7eb', borderLeft: '1px solid #f1f5f9', fontSize: 12, color: '#111827' };
const lcell: React.CSSProperties = { padding: '8px', fontWeight: 700, fontSize: 13, color: '#0f172a', borderBottom: '1px solid #f1f5f9', background: '#fafafa', display: 'flex', alignItems: 'center' };
const dcell: React.CSSProperties = { padding: 6, borderBottom: '1px solid #f1f5f9', borderLeft: '1px solid #f1f5f9', minHeight: 54, display: 'flex', flexDirection: 'column' };
const mlbl: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 };
const cascSub: React.CSSProperties = { fontSize: 11, fontWeight: 500, color: '#9ca3af', marginTop: 3 };
function cascBtn(color: string, primary: boolean): React.CSSProperties {
  return {
    textAlign: 'left', padding: '11px 14px', borderRadius: 10, cursor: 'pointer',
    border: `1.5px solid ${primary ? color : '#e5e7eb'}`, background: primary ? color : '#fff',
    color: primary ? '#fff' : '#111827', fontWeight: 800, fontSize: 14,
  };
}
