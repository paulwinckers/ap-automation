/**
 * WaitingOnModal — "this task is waiting on someone".
 *   Coworker   → they get a linked task ("Paul is waiting on this"); when they finish it,
 *                this task un-blocks and its owner gets a notification.
 *   Outside    → a customer / supplier / anyone without a login: their name + a date to chase.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { addWaitingOn, listSalesAssignees, type Assignee, type WorklistItem, currentUser } from '../lib/api';

const NAVY = '#1e3a5f';

export function WaitingOnModal({ task, onClose, onSaved }: {
  task: WorklistItem; onClose: () => void; onSaved: (message: string) => void;
}) {
  const me = currentUser();
  const [mode, setMode] = useState<'person' | 'outside'>('person');
  const [people, setPeople] = useState<Assignee[]>([]);
  const [who, setWho] = useState<number | ''>('');
  const [what, setWhat] = useState('');
  const [byDate, setByDate] = useState('');
  const [outside, setOutside] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    listSalesAssignees().then(r => setPeople((r.assignees || []).filter(a => a.id !== me?.id))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setErr('');
    if (mode === 'person') {
      if (!who) return setErr('Pick who you’re waiting on.');
      if (!what.trim()) return setErr('Say what you need from them.');
    } else if (!outside.trim()) return setErr('Who are you waiting on?');
    setBusy(true);
    try {
      if (mode === 'person') {
        await addWaitingOn(Number(task.id), { assignee_user_id: Number(who), title: what.trim(), due_date: byDate || undefined });
        const name = people.find(p => p.id === who)?.name || 'They';
        onSaved(`${name} has a new task — you’ll be notified when it’s done.`);
      } else {
        await addWaitingOn(Number(task.id), { external: outside.trim(), followup_date: byDate || undefined });
        onSaved(`Marked as waiting on ${outside.trim()}.`);
      }
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  const field: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', fontSize: 14,
    border: '1px solid #d1d5db', borderRadius: 8, marginTop: 4 };
  const label: CSSProperties = { fontSize: 12, fontWeight: 600, color: '#475569', display: 'block', marginTop: 12 };
  const seg = (on: boolean): CSSProperties => ({ flex: 1, padding: '8px 10px', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', border: 'none', borderRadius: 8, background: on ? '#fff' : 'transparent', color: on ? NAVY : '#64748b',
    boxShadow: on ? '0 1px 3px rgba(0,0,0,0.12)' : 'none' });

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 'min(440px, 100%)',
        padding: 20, boxShadow: '0 10px 40px rgba(0,0,0,0.25)' }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#0f172a' }}>⏳ Waiting on someone</div>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>for “{task.title}”</div>

        <div style={{ display: 'flex', gap: 4, background: '#f1f5f9', padding: 4, borderRadius: 10, marginTop: 14 }}>
          <button style={seg(mode === 'person')} onClick={() => setMode('person')}>A coworker</button>
          <button style={seg(mode === 'outside')} onClick={() => setMode('outside')}>Someone outside</button>
        </div>

        {mode === 'person' ? (
          <>
            <label style={label}>Who
              <select value={who} onChange={e => setWho(e.target.value ? Number(e.target.value) : '')} style={field}>
                <option value="">Choose a person…</option>
                {people.map(p => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}
              </select>
            </label>
            <label style={label}>What you need from them
              <input value={what} onChange={e => setWhat(e.target.value)} placeholder="e.g. Estimate for the Wong backyard" style={field} />
            </label>
            <label style={label}>Need it by
              <input type="date" value={byDate} onChange={e => setByDate(e.target.value)} style={field} />
            </label>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 8 }}>
              They get a task that says you’re waiting on it. You’ll get a notification when they finish.
            </div>
          </>
        ) : (
          <>
            <label style={label}>Who
              <input value={outside} onChange={e => setOutside(e.target.value)} placeholder="e.g. Customer — Mandy Wong, or Brock White" style={field} />
            </label>
            <label style={label}>Chase them on
              <input type="date" value={byDate} onChange={e => setByDate(e.target.value)} style={field} />
            </label>
          </>
        )}

        {err && <div style={{ color: '#b91c1c', fontSize: 13, marginTop: 10 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button onClick={onClose} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={busy} style={{ padding: '8px 14px', borderRadius: 8, border: 'none',
            background: NAVY, color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
