/**
 * TaskThread — the two-way conversation on a task (office ↔ field).
 * Shows the task, its message thread, a reply box, and Mark done. Posting a reply pushes the
 * other participant. Reused by My Action Items now, and the field app later.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getSalesTask, addSalesTaskUpdate, patchSalesTask, type SalesTask } from '../lib/api';

const NAVY = '#1e3a5f';

function when(ts?: string | null): string {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + (ts.includes('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function TaskThread({ taskId, onClose, onChanged }: {
  taskId: number; onClose: () => void; onChanged?: () => void;
}) {
  const [task, setTask] = useState<SalesTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    setLoading(true); setErr('');
    try { setTask((await getSalesTask(taskId)).task); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [taskId]);

  async function postReply() {
    if (!reply.trim()) return;
    setBusy(true); setErr('');
    try { await addSalesTaskUpdate(taskId, reply.trim()); setReply(''); await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function markDone() {
    setBusy(true); setErr('');
    try { await patchSalesTask(taskId, { status: 'done' }); onChanged?.(); onClose(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  const updates = task?.updates ?? [];

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex',
        alignItems: 'flex-start', justifyContent: 'center', padding: 20, zIndex: 300, overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 560, marginTop: 40,
          boxShadow: '0 20px 50px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', maxHeight: '86vh' }}>

        {/* Header */}
        <div style={{ padding: 16, borderBottom: '1px solid #f1f5f9' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a' }}>{task?.title || 'Task'}</div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                {task?.assignee ? `${task.assignee}` : 'unassigned'}
                {task?.due_date ? ` · due ${task.due_date}` : ''}
                {task?.status ? ` · ${task.status}` : ''}
              </div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 20, lineHeight: 1 }}>×</button>
          </div>
          {task?.customer_key && (
            <Link to={`/dashboards/customer/360?key=${encodeURIComponent(task.customer_key)}`}
              style={{ fontSize: 12, fontWeight: 700, color: NAVY, textDecoration: 'none' }}>👤 Open Customer 360 ↗</Link>
          )}
        </div>

        {/* Thread */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {loading && <div style={{ color: '#94a3b8', fontSize: 13 }}>Loading…</div>}
          {!loading && task?.detail && (
            <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, padding: '8px 11px' }}>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>{task.created_by || 'Opened'} · {when(task.created_at)}</div>
              <div style={{ fontSize: 13.5, color: '#111827', whiteSpace: 'pre-wrap' }}>{task.detail}</div>
            </div>
          )}
          {!loading && updates.length === 0 && !task?.detail && (
            <div style={{ color: '#94a3b8', fontSize: 13 }}>No messages yet — start the conversation below.</div>
          )}
          {updates.map(u => (
            <div key={u.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '8px 11px' }}>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>{u.author || 'Someone'} · {when(u.created_at)}</div>
              <div style={{ fontSize: 13.5, color: '#111827', whiteSpace: 'pre-wrap' }}>{u.body}</div>
            </div>
          ))}
        </div>

        {/* Reply + actions */}
        <div style={{ padding: 14, borderTop: '1px solid #f1f5f9' }}>
          {err && <div style={{ color: '#991b1b', fontSize: 12, marginBottom: 8 }}>{err}</div>}
          <textarea value={reply} onChange={e => setReply(e.target.value)} rows={2} placeholder="Reply to the thread…"
            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: 9, border: '1px solid #d1d5db', fontSize: 14, fontFamily: 'inherit', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            {task?.status === 'open' && (
              <button onClick={markDone} disabled={busy}
                style={{ padding: '8px 14px', borderRadius: 9, border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#15803d', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>✓ Mark done</button>
            )}
            <button onClick={postReply} disabled={busy || !reply.trim()}
              style={{ marginLeft: 'auto', padding: '9px 18px', borderRadius: 9, border: 'none',
                background: (busy || !reply.trim()) ? '#94a3b8' : NAVY, color: '#fff', fontWeight: 800, fontSize: 14,
                cursor: (busy || !reply.trim()) ? 'default' : 'pointer' }}>
              {busy ? 'Posting…' : 'Post reply'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
