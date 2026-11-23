/**
 * TrainingReport — who has finished which course, and who each course is assigned to. HR area.
 * Route: /ops/training
 * Lists everyone whose account has the Training area, anyone assigned a course, and anyone else
 * who has started one. HR assigns courses (optionally with a due date) from the Assign panel.
 * Data: GET /training/report, GET /training/assign/people, POST /training/assign,
 * DELETE /training/assign/{course}/{user} (backend app/api/training.py).
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import {
  assignTrainingCourses, getAssignablePeople, getTrainingReport, remindOverdueTraining, unassignTrainingCourse,
  type AssignablePerson, type TrainingReport as Report,
} from '../lib/api';

const card: CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '16px 18px', marginBottom: 16 };
const th: CSSProperties = { textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
  letterSpacing: '0.04em', padding: '6px 8px', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '9px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 14, color: '#111827', verticalAlign: 'middle' };
const pill = (bg: string, fg: string): CSSProperties => ({ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: bg, color: fg, whiteSpace: 'nowrap' });
const btn: CSSProperties = { fontSize: 14, fontWeight: 600, borderRadius: 8, padding: '8px 14px', border: '1px solid #1f4d2b', background: '#1f4d2b', color: '#fff', cursor: 'pointer' };
const small: CSSProperties = { fontSize: 12, fontWeight: 600, borderRadius: 6, padding: '3px 9px', border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer' };
const label: CSSProperties = { fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 6px' };

const WINTER_PREFIX = 'winter-';

function day(ts: string | null) {
  if (!ts) return '';
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Due dates are plain YYYY-MM-DD: show and compare them as local calendar days. */
function dueLabel(due: string) {
  const [y, m, d] = due.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function todayISO() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function AssignPanel({ courses, onDone, onClose }: {
  courses: Report['courses']; onDone: (msg: string) => void; onClose: () => void;
}) {
  const [people, setPeople] = useState<AssignablePerson[] | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [pickedCourses, setPickedCourses] = useState<Set<string>>(new Set());
  const [pickedPeople, setPickedPeople] = useState<Set<number>>(new Set());
  const [q, setQ] = useState('');
  const [due, setDue] = useState('');
  const [notify, setNotify] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { getAssignablePeople().then(r => setPeople(r.people)).catch(e => setLoadErr(String(e.message || e))); }, []);

  const winterIds = courses.filter(c => c.id.startsWith(WINTER_PREFIX)).map(c => c.id);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (people || []).filter(p => !s || (p.name || '').toLowerCase().includes(s) || (p.email || '').toLowerCase().includes(s));
  }, [people, q]);

  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); return n; };

  async function save() {
    setSaving(true); setErr('');
    try {
      const r = await assignTrainingCourses([...pickedCourses], [...pickedPeople], due, notify);
      const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
      const told = !notify ? ' No one was notified.'
        : r.notified ? ` Notifying ${plural(r.notified, 'person', 'people')} by push and email about their new courses.`
        : ' Everyone already had these courses, so no one was notified again.';
      onDone(`Assigned ${plural(pickedCourses.size, 'course', 'courses')} to ${plural(pickedPeople.size, 'person', 'people')}.${told}`);
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally { setSaving(false); }
  }

  const ready = pickedCourses.size > 0 && pickedPeople.size > 0 && !saving;
  return (
    <div style={{ ...card, borderColor: '#1f4d2b', boxShadow: '0 4px 16px rgba(0,0,0,.06)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Assign courses</h2>
        <button type="button" style={small} onClick={onClose}>Close</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
        <div>
          <p style={label}>1. Courses</p>
          {winterIds.length > 0 && (
            <button type="button" style={{ ...small, marginBottom: 8, borderColor: '#1f4d2b', color: '#1f4d2b' }}
              onClick={() => setPickedCourses(new Set(winterIds))}>❄ Winter crew set (all {winterIds.length})</button>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {courses.map(c => (
              <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
                <input type="checkbox" checked={pickedCourses.has(c.id)} onChange={() => setPickedCourses(s => toggle(s, c.id))} />
                {c.title}
              </label>
            ))}
          </div>
          <p style={{ ...label, marginTop: 16 }}>3. Due date <span style={{ textTransform: 'none', fontWeight: 400, color: '#6b7280' }}>(optional)</span></p>
          <input type="date" value={due} onChange={e => setDue(e.target.value)}
            style={{ fontSize: 14, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14, marginTop: 16, cursor: 'pointer' }}>
            <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} style={{ marginTop: 3 }} />
            <span>Notify them by push and email
              <span style={{ display: 'block', fontSize: 12, color: '#6b7280' }}>Only about courses that are new to them. Changing a due date doesn't re-send.</span>
            </span>
          </label>
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={label}>2. People <span style={{ textTransform: 'none', fontWeight: 400, color: '#6b7280' }}>({pickedPeople.size} picked)</span></p>
          {loadErr && <div style={{ color: '#991b1b', fontSize: 14 }}>Couldn't load people: {loadErr}</div>}
          {!people && !loadErr && <div style={{ fontSize: 14, color: '#6b7280' }}>Loading…</div>}
          {people && (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <input placeholder="Search name or email" value={q} onChange={e => setQ(e.target.value)}
                  style={{ flex: 1, minWidth: 140, fontSize: 14, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }} />
                <button type="button" style={small} onClick={() => setPickedPeople(s => { const n = new Set(s); shown.forEach(p => n.add(p.user_id)); return n; })}>Select shown</button>
                <button type="button" style={small} onClick={() => setPickedPeople(new Set())}>Clear</button>
              </div>
              <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #f3f4f6', borderRadius: 8, padding: '4px 8px' }}>
                {shown.map(p => (
                  <label key={p.user_id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0', fontSize: 14, cursor: 'pointer', borderBottom: '1px solid #f9fafb' }}>
                    <input type="checkbox" checked={pickedPeople.has(p.user_id)} onChange={() => setPickedPeople(s => toggle(s, p.user_id))} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>{p.name}</span>
                      <span style={{ fontSize: 12, color: '#6b7280' }}> · {p.email}{p.training_only ? ' · Training-only' : ''}</span>
                    </span>
                  </label>
                ))}
                {shown.length === 0 && <div style={{ fontSize: 14, color: '#6b7280', padding: '6px 0' }}>No one matches.</div>}
              </div>
              <p style={{ fontSize: 12, color: '#6b7280', margin: '6px 0 0' }}>
                Not listed? Add them on the Users page first. Crew who only need courses can have a Training-only account.
              </p>
            </>
          )}
        </div>
      </div>
      {err && <div style={{ marginTop: 12, color: '#991b1b', fontSize: 14 }}>Couldn't assign: {err}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={{ ...btn, opacity: ready ? 1 : 0.45, cursor: ready ? 'pointer' : 'not-allowed' }} disabled={!ready} onClick={save}>
          {saving ? 'Assigning…' : `Assign ${pickedCourses.size || ''} course${pickedCourses.size === 1 ? '' : 's'} to ${pickedPeople.size || ''} ${pickedPeople.size === 1 ? 'person' : 'people'}`}
        </button>
        <span style={{ fontSize: 13, color: '#6b7280' }}>Re-assigning someone just updates the due date. Their progress is kept.</span>
      </div>
    </div>
  );
}

export default function TrainingReport() {
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [assignedOnly, setAssignedOnly] = useState(false);
  const [busy, setBusy] = useState('');

  const load = () => getTrainingReport().then(setR).catch(e => setErr(String(e.message || e)));
  useEffect(() => { load(); }, []);

  async function remove(courseId: string, userId: number, name: string, title: string) {
    if (!window.confirm(`Remove "${title}" from ${name}'s assigned courses? Their progress is kept.`)) return;
    setBusy(`${courseId}:${userId}`);
    try { await unassignTrainingCourse(courseId, userId); await load(); }
    catch (e: any) { setNote(`Couldn't remove: ${e.message || e}`); }
    finally { setBusy(''); }
  }

  const today = todayISO();
  const overdueTotal = r ? r.people.reduce((n, p) => n + Object.values(p.courses)
    .filter(s => s.assigned && !s.finished_at && !!s.due_date && s.due_date < today).length, 0) : 0;

  async function remindNow() {
    if (!window.confirm(`Send a reminder now to everyone with an overdue course (${overdueTotal} overdue)? Anyone already reminded today is skipped.`)) return;
    setBusy('remind');
    try {
      const res = await remindOverdueTraining();
      setNote(res.people
        ? `Reminded ${res.people} ${res.people === 1 ? 'person' : 'people'} about ${res.courses} overdue course${res.courses === 1 ? '' : 's'} by push and email.`
        : 'No one to remind: everyone overdue was already reminded today.');
      await load();
    } catch (e: any) { setNote(`Couldn't send reminders: ${e.message || e}`); }
    finally { setBusy(''); }
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0, color: '#111827' }}>Training</h1>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>
            Who each course is assigned to, and who has finished it. Overdue courses get an automatic reminder on weekday mornings, then weekly.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 14, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={assignedOnly} onChange={e => setAssignedOnly(e.target.checked)} /> Assigned only
          </label>
          <Link to="/training" style={{ fontSize: 14, fontWeight: 600, color: '#1f4d2b' }}>Open the courses →</Link>
          {overdueTotal > 0 && (
            <button type="button" disabled={busy === 'remind'} onClick={remindNow}
              title="Overdue reminders also go out automatically on weekday mornings (first weekday after the due date, then weekly)"
              style={{ ...btn, background: '#fff', color: '#991b1b', borderColor: '#fca5a5' }}>
              {busy === 'remind' ? 'Sending…' : `🔔 Remind overdue now (${overdueTotal})`}
            </button>
          )}
          {r && !open && <button type="button" style={btn} onClick={() => { setOpen(true); setNote(''); }}>+ Assign courses</button>}
        </div>
      </div>

      {note && <div style={{ ...card, background: '#f0fdf4', borderColor: '#bbf7d0', color: '#166534', padding: '10px 16px' }}>{note}</div>}
      {open && r && <AssignPanel courses={r.courses} onClose={() => setOpen(false)}
        onDone={msg => { setOpen(false); setNote(msg); load(); }} />}

      {err && <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }}>Couldn't load the report: {err}</div>}
      {!r && !err && <div style={card}>Loading…</div>}

      {r && r.courses.map(c => {
        const all = r.people.map(p => ({ p, s: p.courses[c.id] })).filter(x => x.s);
        const rows = assignedOnly ? all.filter(x => x.s.assigned) : all;
        const assigned = all.filter(x => x.s.assigned);
        const assignedDone = assigned.filter(x => x.s.finished_at).length;
        const overdue = assigned.filter(x => !x.s.finished_at && x.s.due_date && x.s.due_date < today).length;
        const finished = rows.filter(x => x.s.finished_at).length;
        const started = rows.filter(x => !x.s.finished_at && x.s.done > 0).length;
        const notStarted = rows.length - finished - started;
        const rank = (x: typeof all[number]) =>
          x.s.assigned && !x.s.finished_at && x.s.due_date && x.s.due_date < today ? 0
          : x.s.assigned && !x.s.finished_at ? 1 : x.s.assigned ? 2 : 3;
        return (
          <div key={c.id} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 10 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{c.title} <span style={{ color: '#6b7280', fontWeight: 500, fontSize: 14 }}>· {c.modules} modules</span></h2>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {assigned.length > 0 && <span style={pill('#dbeafe', '#1e40af')}>{assignedDone} of {assigned.length} assigned finished</span>}
                {overdue > 0 && <span style={pill('#fee2e2', '#991b1b')}>{overdue} overdue</span>}
                <span style={pill('#dcfce7', '#166534')}>{finished} finished</span>
                <span style={pill('#fef3c7', '#92400e')}>{started} in progress</span>
                <span style={pill('#f3f4f6', '#374151')}>{notStarted} not started</span>
              </div>
            </div>
            {rows.length === 0 ? (
              <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>
                {assignedOnly ? 'Not assigned to anyone yet. Use + Assign courses.' : 'No one yet. Use + Assign courses, or give people the Training area on the Users page.'}
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr><th style={th}>Person</th><th style={th}>Assigned</th><th style={th}>Progress</th><th style={th}>Finished</th><th style={th}>Last activity</th></tr></thead>
                  <tbody>
                    {rows.sort((a, b) => rank(a) - rank(b) || (b.s.finished_at ? 1 : 0) - (a.s.finished_at ? 1 : 0) || b.s.done - a.s.done).map(({ p, s }) => {
                      const late = s.assigned && !s.finished_at && !!s.due_date && s.due_date < today;
                      return (
                        <tr key={p.user_id}>
                          <td style={td}>
                            <div style={{ fontWeight: 600 }}>{p.name}</div>
                            <div style={{ fontSize: 12, color: '#6b7280' }}>{p.email}{p.training_only ? ' · Training-only account' : ''}</div>
                          </td>
                          <td style={{ ...td, whiteSpace: 'nowrap' }}>
                            {s.assigned ? (
                              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                <span style={late ? pill('#fee2e2', '#991b1b') : pill('#dbeafe', '#1e40af')}>
                                  {s.due_date ? `${late ? 'Overdue · ' : 'Due '}${dueLabel(s.due_date)}` : 'Assigned'}
                                </span>
                                <button type="button" title="Remove assignment" disabled={busy === `${c.id}:${p.user_id}`}
                                  onClick={() => remove(c.id, p.user_id, p.name, c.title)}
                                  style={{ ...small, padding: '0 6px', color: '#6b7280' }}>✕</button>
                                {late && s.last_reminded_at && (
                                  <span style={{ fontSize: 12, color: '#6b7280' }}>reminded {dueLabel(s.last_reminded_at)}</span>
                                )}
                              </span>
                            ) : <span style={{ color: '#9ca3af' }}>—</span>}
                          </td>
                          <td style={{ ...td, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                            <span style={{ display: 'inline-block', width: 90, height: 6, borderRadius: 9, background: '#e5e7eb', verticalAlign: 'middle', marginRight: 8, overflow: 'hidden' }}>
                              <span style={{ display: 'block', height: '100%', width: `${(s.done / s.total) * 100}%`, background: '#1f4d2b' }} />
                            </span>
                            {s.done} of {s.total}
                          </td>
                          <td style={td}>{s.finished_at ? <span style={pill('#dcfce7', '#166534')}>✓ {day(s.finished_at)}</span> : <span style={{ color: '#9ca3af' }}>Not yet</span>}</td>
                          <td style={{ ...td, color: '#6b7280' }}>{day(s.last_at) || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
