/**
 * SalesVisit — phone-first capture for the sales team. Pick a customer (company or
 * residential contact), jot a note / log a site visit, snap photos/videos, optionally set
 * a followup and spin off a task for a coworker. Writes to the /sales/* API (authed, so the
 * logged-in rep is recorded as created_by). Route: /sales/log
 */
import { useEffect, useRef, useState } from 'react';
import {
  searchCustomerEntities, createSalesActivity, uploadSalesAttachment, createSalesTask,
  type CustomerEntity,
} from '../lib/api';

const NAVY = '#1e3a5f';
const TYPES = [
  { v: 'site_visit', label: '📍 Site visit' }, { v: 'call', label: '📞 Call' },
  { v: 'meeting', label: '🤝 Meeting' }, { v: 'note', label: '📝 Note' }, { v: 'email', label: '✉️ Email' },
];

const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '11px 12px', borderRadius: 10,
  border: '1px solid #d1d5db', fontSize: 16, fontFamily: 'inherit',
};
const lbl: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 700, color: '#374151', margin: '14px 0 5px' };

export default function SalesVisit() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerEntity[]>([]);
  const [picked, setPicked] = useState<CustomerEntity | null>(null);
  const [type, setType] = useState('site_visit');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [followDate, setFollowDate] = useState('');
  const [followNote, setFollowNote] = useState('');
  const [addTask, setAddTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskAssignee, setTaskAssignee] = useState('');
  const [taskDue, setTaskDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ activity: number; photos: number; task?: number } | null>(null);
  const tmr = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (picked || q.trim().length < 2) { setResults([]); return; }
    if (tmr.current) clearTimeout(tmr.current);
    tmr.current = setTimeout(async () => {
      try { setResults(await searchCustomerEntities(q.trim())); } catch { setResults([]); }
    }, 300);
    return () => { if (tmr.current) clearTimeout(tmr.current); };
  }, [q, picked]);

  function reset() {
    setPicked(null); setQ(''); setType('site_visit'); setNote(''); setFiles([]);
    setFollowDate(''); setFollowNote(''); setAddTask(false); setTaskTitle(''); setTaskAssignee(''); setTaskDue('');
    setDone(null); setErr('');
  }

  async function submit() {
    if (!picked) { setErr('Pick a customer first.'); return; }
    if (!note.trim() && files.length === 0) { setErr('Add a note or at least one photo.'); return; }
    setBusy(true); setErr('');
    try {
      const customer_key = `${picked.kind}:${picked.id}`;
      const r = await createSalesActivity({
        customer_key, type, body: note.trim() || undefined,
        next_action_date: followDate || undefined, next_action_note: followNote.trim() || undefined,
      });
      const activityId = r.activity.id;
      let photos = 0;
      for (const f of files) {
        try { await uploadSalesAttachment('activity', activityId, f); photos++; }
        catch { /* keep going; report count */ }
      }
      let taskId: number | undefined;
      if (addTask && taskTitle.trim()) {
        const t = await createSalesTask({
          title: taskTitle.trim(), customer_key, assignee: taskAssignee.trim() || undefined,
          due_date: taskDue || undefined, activity_id: activityId,
        });
        taskId = t.task?.id;
      }
      setDone({ activity: activityId, photos, task: taskId });
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  if (done) {
    return (
      <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', padding: 20 }}>
        <div style={{ maxWidth: 520, margin: '0 auto', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 44 }}>✅</div>
          <h2 style={{ margin: '8px 0 4px', color: '#0f172a' }}>Logged</h2>
          <p style={{ color: '#6b7280', fontSize: 14 }}>
            Visit saved{done.photos ? ` with ${done.photos} photo${done.photos === 1 ? '' : 's'}` : ''}
            {done.task ? ` · task created for your coworker` : ''}
            {followDate ? ` · followup ${followDate}` : ''}.
          </p>
          <button onClick={reset} style={{ marginTop: 16, padding: '12px 20px', borderRadius: 10, border: 'none', background: NAVY, color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
            Log another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', padding: 20 }}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>📍 Log a sales visit</h1>
        <p style={{ margin: '3px 0 10px', color: '#6b7280', fontSize: 13 }}>Notes, photos, and followups from the field — in seconds.</p>

        {/* Customer */}
        <label style={lbl}>Customer</label>
        {picked ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: '1px solid #bbf7d0', background: '#f0fdf4', borderRadius: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', flex: 1 }}>
              {picked.kind === 'company' ? '🏢' : '👤'} {picked.name}
            </span>
            <button onClick={() => { setPicked(null); setQ(''); }} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>change</button>
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search customer or lead…" style={inp} />
            {results.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginTop: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', maxHeight: 260, overflowY: 'auto' }}>
                {results.map(e => (
                  <button key={`${e.kind}-${e.id}`} onClick={() => { setPicked(e); setResults([]); }}
                    style={{ display: 'flex', gap: 8, width: '100%', textAlign: 'left', padding: '10px 12px', border: 'none', borderTop: '1px solid #f1f5f9', background: 'none', cursor: 'pointer', fontSize: 14 }}>
                    <span>{e.kind === 'company' ? '🏢' : '👤'}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>{e.sub}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Type */}
        <label style={lbl}>Type</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {TYPES.map(t => (
            <button key={t.v} onClick={() => setType(t.v)}
              style={{ padding: '8px 12px', borderRadius: 999, border: `1px solid ${type === t.v ? NAVY : '#d1d5db'}`, background: type === t.v ? '#eff6ff' : '#fff', color: type === t.v ? NAVY : '#374151', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Note */}
        <label style={lbl}>Notes</label>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={4} placeholder="What did you see / discuss? Scope, budget, next steps…" style={{ ...inp, resize: 'vertical' }} />

        {/* Photos / videos */}
        <label style={lbl}>Photos / videos</label>
        <input type="file" accept="image/*,video/*" multiple capture="environment"
          onChange={e => setFiles(prev => [...prev, ...Array.from(e.target.files || [])])}
          style={{ ...inp, padding: 10 }} />
        {files.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {files.map((f, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#f1f5f9', borderRadius: 8, padding: '4px 8px', fontSize: 12 }}>
                {f.type.startsWith('video') ? '🎥' : '🖼'} {f.name.slice(0, 18)}
                <button onClick={() => setFiles(files.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', padding: 0 }}>×</button>
              </span>
            ))}
          </div>
        )}

        {/* Followup */}
        <label style={lbl}>Followup (optional)</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="date" value={followDate} onChange={e => setFollowDate(e.target.value)} style={{ ...inp, width: 160 }} />
          <input value={followNote} onChange={e => setFollowNote(e.target.value)} placeholder="What to follow up on" style={inp} />
        </div>

        {/* Task */}
        <label style={{ ...lbl, display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={addTask} onChange={e => setAddTask(e.target.checked)} style={{ width: 18, height: 18 }} />
          Add a task for a coworker
        </label>
        {addTask && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10 }}>
            <input value={taskTitle} onChange={e => setTaskTitle(e.target.value)} placeholder="Task (e.g. verify NW grade)" style={inp} />
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={taskAssignee} onChange={e => setTaskAssignee(e.target.value)} placeholder="Assign to" style={inp} />
              <input type="date" value={taskDue} onChange={e => setTaskDue(e.target.value)} style={{ ...inp, width: 160 }} />
            </div>
          </div>
        )}

        {err && <div style={{ marginTop: 14, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 14px', color: '#991b1b' }}>{err}</div>}

        <button onClick={submit} disabled={busy}
          style={{ width: '100%', marginTop: 18, padding: '14px', borderRadius: 12, border: 'none', background: busy ? '#94a3b8' : NAVY, color: '#fff', fontWeight: 800, fontSize: 16, cursor: busy ? 'default' : 'pointer' }}>
          {busy ? 'Saving…' : 'Save visit'}
        </button>
      </div>
    </div>
  );
}
