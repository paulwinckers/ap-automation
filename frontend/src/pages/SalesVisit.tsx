/**
 * SalesVisit — phone-first "walk & annotate" capture for the sales team.
 * Flow: pick a customer → Start visit → for each spot: snap a photo + describe what needs
 * to happen (saved immediately, so nothing's lost) → Finish with an optional followup + task.
 * Each photo keeps its own caption (sales_attachments.caption), so the visit reads like an
 * annotated walk-through. Writes to /sales/* (authed → logged-in rep is created_by).
 * Route: /sales/log
 *
 * NOTE: the photo-by-photo capture pattern is reusable for field crews later (point it at a
 * work ticket / job instead of a sales activity) — the backend attachments model is generic.
 */
import { useEffect, useRef, useState } from 'react';
import {
  searchCustomerEntities, createSalesActivity, uploadSalesAttachment, createSalesTask, patchSalesActivity,
  listSalesAssignees, type CustomerEntity, type Assignee,
} from '../lib/api';

const NAVY = '#1e3a5f';
const TYPES = [
  { v: 'site_visit', label: '📍 Site visit' }, { v: 'call', label: '📞 Call' },
  { v: 'meeting', label: '🤝 Meeting' }, { v: 'note', label: '📝 Note' },
];
const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '11px 12px', borderRadius: 10,
  border: '1px solid #d1d5db', fontSize: 16, fontFamily: 'inherit',
};
const lbl: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 700, color: '#374151', margin: '14px 0 5px' };

interface AddedPhoto { id: number; caption: string; url: string | null; kind: string; }

export default function SalesVisit() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerEntity[]>([]);
  const [picked, setPicked] = useState<CustomerEntity | null>(null);
  const [type, setType] = useState('site_visit');
  const [openingNote, setOpeningNote] = useState('');

  const [activityId, setActivityId] = useState<number | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [added, setAdded] = useState<AddedPhoto[]>([]);
  const photoInput = useRef<HTMLInputElement | null>(null);

  const [followDate, setFollowDate] = useState('');
  const [followNote, setFollowNote] = useState('');
  const [addTask, setAddTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskAssigneeId, setTaskAssigneeId] = useState('');   // user id as string ('' = unassigned)
  const [taskDue, setTaskDue] = useState('');
  const [assignees, setAssignees] = useState<Assignee[]>([]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ photos: number; task?: number } | null>(null);
  const tmr = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load the coworker directory once (for the "assign to" picker — real users, identity-linked).
  useEffect(() => {
    listSalesAssignees().then(r => setAssignees(r.assignees || [])).catch(() => {});
  }, []);

  const customerKey = picked ? `${picked.kind}:${picked.id}` : null;

  useEffect(() => {
    if (picked || q.trim().length < 2) { setResults([]); return; }
    if (tmr.current) clearTimeout(tmr.current);
    tmr.current = setTimeout(async () => {
      try { setResults(await searchCustomerEntities(q.trim())); } catch { setResults([]); }
    }, 300);
    return () => { if (tmr.current) clearTimeout(tmr.current); };
  }, [q, picked]);

  function resetAll() {
    setPicked(null); setQ(''); setType('site_visit'); setOpeningNote('');
    setActivityId(null); setPhoto(null); setCaption(''); setAdded([]);
    setFollowDate(''); setFollowNote(''); setAddTask(false); setTaskTitle(''); setTaskAssigneeId(''); setTaskDue('');
    setDone(null); setErr('');
  }

  async function startVisit() {
    if (!customerKey) { setErr('Pick a customer first.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await createSalesActivity({ customer_key: customerKey, type, body: openingNote.trim() || undefined });
      setActivityId(r.activity.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function addPhoto() {
    if (!activityId || !photo) return;
    setBusy(true); setErr('');
    try {
      const r = await uploadSalesAttachment('activity', activityId, photo, caption.trim() || undefined);
      setAdded(prev => [...prev, { id: r.attachment.id, caption: caption.trim(), url: r.attachment.url, kind: r.attachment.kind }]);
      setPhoto(null); setCaption('');
      if (photoInput.current) photoInput.current.value = '';
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function finishVisit() {
    if (!activityId) return;
    setBusy(true); setErr('');
    try {
      if (followDate || followNote.trim()) {
        await patchSalesActivity(activityId, { next_action_date: followDate || undefined, next_action_note: followNote.trim() || undefined });
      }
      let taskId: number | undefined;
      if (addTask && taskTitle.trim()) {
        const t = await createSalesTask({
          title: taskTitle.trim(), customer_key: customerKey!,
          assignee_user_id: taskAssigneeId ? Number(taskAssigneeId) : undefined,
          due_date: taskDue || undefined, activity_id: activityId,
        });
        taskId = t.task?.id;
      }
      setDone({ photos: added.length, task: taskId });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const page = (kids: React.ReactNode) => (
    <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', padding: 20 }}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>{kids}</div>
    </div>
  );

  if (done) {
    return page(
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 44 }}>✅</div>
        <h2 style={{ margin: '8px 0 4px', color: '#0f172a' }}>Visit saved</h2>
        <p style={{ color: '#6b7280', fontSize: 14 }}>
          {done.photos} annotated photo{done.photos === 1 ? '' : 's'}
          {done.task ? ' · task created' : ''}{followDate ? ` · followup ${followDate}` : ''}.
        </p>
        <button onClick={resetAll} style={{ marginTop: 16, padding: '12px 20px', borderRadius: 10, border: 'none', background: NAVY, color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>Log another</button>
      </div>
    );
  }

  const errBox = err && <div style={{ marginTop: 14, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 14px', color: '#991b1b' }}>{err}</div>;

  // ── Stage 1: pick customer + start ───────────────────────────────────────────
  if (!activityId) {
    return page(<>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>📍 Log a sales visit</h1>
      <p style={{ margin: '3px 0 10px', color: '#6b7280', fontSize: 13 }}>Pick the customer, then walk the site snapping and describing as you go.</p>

      <label style={lbl}>Customer</label>
      {picked ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: '1px solid #bbf7d0', background: '#f0fdf4', borderRadius: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', flex: 1 }}>{picked.kind === 'company' ? '🏢' : '👤'} {picked.name}</span>
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

      <label style={lbl}>Type</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {TYPES.map(t => (
          <button key={t.v} onClick={() => setType(t.v)}
            style={{ padding: '8px 12px', borderRadius: 999, border: `1px solid ${type === t.v ? NAVY : '#d1d5db'}`, background: type === t.v ? '#eff6ff' : '#fff', color: type === t.v ? NAVY : '#374151', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>{t.label}</button>
        ))}
      </div>

      <label style={lbl}>Opening note (optional)</label>
      <textarea value={openingNote} onChange={e => setOpeningNote(e.target.value)} rows={2} placeholder="Overall context for the visit…" style={{ ...inp, resize: 'vertical' }} />

      {errBox}
      <button onClick={startVisit} disabled={busy || !picked}
        style={{ width: '100%', marginTop: 18, padding: 14, borderRadius: 12, border: 'none', background: (busy || !picked) ? '#94a3b8' : NAVY, color: '#fff', fontWeight: 800, fontSize: 16, cursor: (busy || !picked) ? 'default' : 'pointer' }}>
        {busy ? 'Starting…' : 'Start visit →'}
      </button>
    </>);
  }

  // ── Stage 2: the walk (photo + caption loop) + finish ────────────────────────
  return page(<>
    <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#0f172a' }}>📍 {picked?.name}</h1>
    <p style={{ margin: '3px 0 10px', color: '#6b7280', fontSize: 13 }}>Snap a spot, say what needs to happen, add it. Repeat. Each photo is saved as you go.</p>

    {/* running list */}
    {added.length > 0 && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {added.map((a, i) => (
          <div key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'center', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 8 }}>
            <span style={{ width: 26, textAlign: 'center', fontWeight: 800, color: '#9ca3af' }}>{i + 1}</span>
            {a.url && a.kind === 'photo'
              ? <img src={a.url} alt="" style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 6 }} />
              : <span style={{ fontSize: 22 }}>{a.kind === 'video' ? '🎥' : '📎'}</span>}
            <span style={{ flex: 1, fontSize: 13.5, color: '#111827' }}>{a.caption || <em style={{ color: '#9ca3af' }}>no note</em>}</span>
          </div>
        ))}
      </div>
    )}

    {/* add-a-spot */}
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
      <div style={{ fontWeight: 800, fontSize: 13, color: NAVY, marginBottom: 8 }}>Spot {added.length + 1}</div>
      <input ref={photoInput} type="file" accept="image/*,video/*" capture="environment"
        onChange={e => setPhoto(e.target.files?.[0] || null)} style={{ ...inp, padding: 10 }} />
      <textarea value={caption} onChange={e => setCaption(e.target.value)} rows={2}
        placeholder="What needs to happen here?" style={{ ...inp, marginTop: 8, resize: 'vertical' }} />
      <button onClick={addPhoto} disabled={busy || !photo}
        style={{ width: '100%', marginTop: 8, padding: 12, borderRadius: 10, border: 'none', background: (busy || !photo) ? '#94a3b8' : '#047857', color: '#fff', fontWeight: 800, fontSize: 15, cursor: (busy || !photo) ? 'default' : 'pointer' }}>
        {busy ? 'Adding…' : '+ Add this spot'}
      </button>
    </div>

    {/* finish */}
    <label style={lbl}>Followup (optional)</label>
    <div style={{ display: 'flex', gap: 8 }}>
      <input type="date" value={followDate} onChange={e => setFollowDate(e.target.value)} style={{ ...inp, width: 160 }} />
      <input value={followNote} onChange={e => setFollowNote(e.target.value)} placeholder="What to follow up on" style={inp} />
    </div>
    <label style={{ ...lbl, display: 'flex', alignItems: 'center', gap: 8 }}>
      <input type="checkbox" checked={addTask} onChange={e => setAddTask(e.target.checked)} style={{ width: 18, height: 18 }} />
      Add a task for a coworker
    </label>
    {addTask && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input value={taskTitle} onChange={e => setTaskTitle(e.target.value)} placeholder="Task" style={inp} />
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={taskAssigneeId} onChange={e => setTaskAssigneeId(e.target.value)} style={inp}>
            <option value="">Assign to…</option>
            {assignees.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input type="date" value={taskDue} onChange={e => setTaskDue(e.target.value)} style={{ ...inp, width: 160 }} />
        </div>
      </div>
    )}

    {errBox}
    <button onClick={finishVisit} disabled={busy}
      style={{ width: '100%', marginTop: 18, padding: 14, borderRadius: 12, border: 'none', background: busy ? '#94a3b8' : NAVY, color: '#fff', fontWeight: 800, fontSize: 16, cursor: busy ? 'default' : 'pointer' }}>
      {busy ? 'Saving…' : `Finish visit${added.length ? ` · ${added.length} spot${added.length === 1 ? '' : 's'}` : ''}`}
    </button>
  </>);
}
