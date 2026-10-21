/**
 * Construction Weekly Schedule board — crew × day grid (replaces the spreadsheet).
 * Route: /dashboards/construction/board   (login required)
 *
 * Won construction jobs appear in the backlog; drag them onto a crew/day cell.
 * Drag a chip between cells to move it. Add a free label (e.g. "Away") per cell.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getScheduleWeek, createAssignment, updateAssignment, deleteAssignment,
  type ScheduleWeek, type ScheduleAssignment, type ScheduleBacklogJob,
} from '../lib/api';

const NAVY = '#1A5376';
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDay(iso: string): string {
  try { return new Date(iso + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }); }
  catch { return iso; }
}
function weekLabel(days: string[]): string {
  if (!days.length) return '';
  return `${fmtDay(days[0])} – ${fmtDay(days[days.length - 1])}`;
}

type DragPayload =
  | { type: 'backlog'; job: ScheduleBacklogJob }
  | { type: 'chip'; asg: ScheduleAssignment };

export default function ConstructionBoard() {
  const [week, setWeek] = useState<ScheduleWeek | null>(null);
  const [start, setStart] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState<string>(''); // "lead|date"
  const drag = useRef<DragPayload | null>(null);
  const [q, setQ] = useState('');

  async function load(s?: string) {
    setLoading(true); setErr('');
    try { const w = await getScheduleWeek(s); setWeek(w); setStart(w.week_start); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(start); /* eslint-disable-next-line */ }, []);

  const assignments = week?.assignments ?? [];
  function setAssignments(next: ScheduleAssignment[]) {
    setWeek(w => w ? { ...w, assignments: next } : w);
  }
  function cellItems(lead: string, day: string) {
    return assignments.filter(a => a.lead_name === lead && a.work_date === day);
  }

  async function onDropCell(lead: string, day: string) {
    const d = drag.current; drag.current = null; setDragOver('');
    if (!d) return;
    setBusy(true);
    try {
      if (d.type === 'backlog') {
        const r = await createAssignment({ work_date: day, lead_name: lead, opportunity_id: d.job.opportunity_id, job_label: d.job.label });
        setAssignments([...assignments, { id: r.id, work_date: day, lead_name: lead, opportunity_id: d.job.opportunity_id, job_label: d.job.label, note: null, sort_order: 0 }]);
      } else {
        if (d.asg.work_date === day && d.asg.lead_name === lead) return;
        await updateAssignment(d.asg.id, { work_date: day, lead_name: lead });
        setAssignments(assignments.map(a => a.id === d.asg.id ? { ...a, work_date: day, lead_name: lead } : a));
      }
    } catch (e) { setErr((e as Error).message); load(start); }
    finally { setBusy(false); }
  }

  async function addFreeLabel(lead: string, day: string) {
    const label = window.prompt('Add a label for this cell (e.g. Away, Shop, Vacation):');
    if (!label || !label.trim()) return;
    setBusy(true);
    try {
      const r = await createAssignment({ work_date: day, lead_name: lead, job_label: label.trim() });
      setAssignments([...assignments, { id: r.id, work_date: day, lead_name: lead, opportunity_id: null, job_label: label.trim(), note: null, sort_order: 0 }]);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function removeChip(id: number) {
    setAssignments(assignments.filter(a => a.id !== id));
    try { await deleteAssignment(id); } catch { load(start); }
  }

  const backlog = (week?.backlog ?? []).filter(j =>
    !q.trim() || (j.label || '').toLowerCase().includes(q.toLowerCase()) || String(j.opp_number ?? '').includes(q)
  );

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', padding: '20px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>📅 Construction Weekly Schedule</h1>
          <p style={{ margin: '3px 0 0', color: '#6b7280', fontSize: 13 }}>Drag jobs from the backlog onto a crew & day. Drag a chip to move it.</p>
        </div>
        <Link to="/dashboards/construction/plan" style={{ textDecoration: 'none', padding: '8px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontWeight: 700, fontSize: 13 }}>📋 Monthly Plan</Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={() => start && load(addDays(start, -7))} style={navBtn}>‹</button>
          <div style={{ padding: '6px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, fontWeight: 700, fontSize: 14, color: '#1f2937', minWidth: 150, textAlign: 'center' }}>
            {week ? weekLabel(week.days) : '…'}
          </div>
          <button onClick={() => start && load(addDays(start, 7))} style={navBtn}>›</button>
          <button onClick={() => load(undefined)} style={{ ...navBtn, fontSize: 11, padding: '6px 12px' }}>This week</button>
        </div>
      </div>

      {err && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 14px', color: '#991b1b', marginBottom: 14 }}>{err}</div>}
      {loading && <div style={{ padding: 40, color: '#9ca3af' }}>Loading the week…</div>}

      {week && !loading && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          {/* Backlog */}
          <div style={{ width: 240, flexShrink: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, maxHeight: '75vh', overflowY: 'auto', position: 'sticky', top: 12 }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: '#0f172a', marginBottom: 8 }}>📥 Backlog <span style={{ color: '#9ca3af', fontWeight: 500 }}>({backlog.length})</span></div>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search jobs…"
              style={{ width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, marginBottom: 10 }} />
            {backlog.map(j => (
              <div key={j.opportunity_id}
                draggable
                onDragStart={() => { drag.current = { type: 'backlog', job: j }; }}
                style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', marginBottom: 7, cursor: 'grab', background: '#f9fafb' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{j.label}</div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                  {j.opp_number ? `#${j.opp_number}` : ''}{j.hours_est ? ` · ${j.hours_est}h` : ''}{j.start_date ? ` · ${fmtDay(j.start_date)}` : ''}
                </div>
              </div>
            ))}
            {backlog.length === 0 && <div style={{ color: '#9ca3af', fontSize: 13 }}>No matching jobs.</div>}
          </div>

          {/* Grid */}
          <div style={{ flex: 1, overflowX: 'auto', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: `120px repeat(6, minmax(130px, 1fr))`, minWidth: 900 }}>
              {/* Header */}
              <div style={{ ...hcell, borderLeft: 'none' }} />
              {week.days.map((d, i) => (
                <div key={d} style={hcell}>
                  <div style={{ fontWeight: 800 }}>{DOW[i]}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{fmtDay(d)}</div>
                </div>
              ))}

              {/* Rows */}
              {week.leads.length === 0 && (
                <div style={{ gridColumn: '1 / -1', padding: 20, color: '#9ca3af', fontSize: 13 }}>
                  No crew leads set up yet — add them under the Monthly Plan → 👷 Leads.
                </div>
              )}
              {week.leads.map(lead => (
                <div key={lead.aspire_name} style={{ display: 'contents' }}>
                  <div style={lcell}>{lead.name}</div>
                  {week.days.map(day => {
                    const key = `${lead.name}|${day}`;
                    const items = cellItems(lead.name, day);
                    return (
                      <div key={key}
                        onDragOver={e => { e.preventDefault(); if (dragOver !== key) setDragOver(key); }}
                        onDragLeave={() => setDragOver(o => o === key ? '' : o)}
                        onDrop={() => onDropCell(lead.name, day)}
                        style={{ ...dcell, background: dragOver === key ? '#eff6ff' : '#fff', outline: dragOver === key ? `2px dashed ${NAVY}` : 'none' }}>
                        {items.map(a => {
                          const isJob = a.opportunity_id != null;
                          return (
                            <div key={a.id}
                              draggable
                              onDragStart={() => { drag.current = { type: 'chip', asg: a }; }}
                              title={a.note || ''}
                              style={{ display: 'flex', alignItems: 'center', gap: 4, background: isJob ? '#eef2ff' : '#f1f5f9', color: isJob ? '#3730a3' : '#475569', borderRadius: 6, padding: '3px 6px', marginBottom: 4, fontSize: 12, fontWeight: 600, cursor: 'grab' }}>
                              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.job_label}</span>
                              <button onClick={() => removeChip(a.id)} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>×</button>
                            </div>
                          );
                        })}
                        <button onClick={() => addFreeLabel(lead.name, day)} title="Add a label" style={{ background: 'none', border: 'none', color: '#cbd5e1', cursor: 'pointer', fontSize: 14, padding: 0, alignSelf: 'flex-start' }}>+</button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {busy && <div style={{ position: 'fixed', bottom: 16, right: 16, background: '#0f172a', color: '#fff', padding: '8px 14px', borderRadius: 8, fontSize: 13 }}>Saving…</div>}
    </div>
  );
}

const navBtn: React.CSSProperties = { padding: '6px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 15, color: '#374151', fontWeight: 700 };
const hcell: React.CSSProperties = { padding: '10px 8px', textAlign: 'center', borderBottom: '2px solid #e5e7eb', borderLeft: '1px solid #f1f5f9', fontSize: 13, color: '#111827', background: '#f8fafc', position: 'sticky', top: 0 };
const lcell: React.CSSProperties = { padding: '8px', fontWeight: 700, fontSize: 13, color: '#0f172a', borderBottom: '1px solid #f1f5f9', background: '#fafafa', display: 'flex', alignItems: 'center' };
const dcell: React.CSSProperties = { padding: 6, borderBottom: '1px solid #f1f5f9', borderLeft: '1px solid #f1f5f9', minHeight: 64, display: 'flex', flexDirection: 'column' };
