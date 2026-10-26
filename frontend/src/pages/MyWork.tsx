/**
 * MyWork — "My Action Items": the logged-in user's unified morning worklist.
 * Merges three sources into one bucketed list (overdue / today / this week / later / no date):
 *   - sales_task     open tasks assigned to them        → one-tap Done
 *   - sales_followup their pending follow-ups           → one-tap Done
 *   - cx_comms       CX client-comms due they OWN (by role, from CX settings) → Open the job to send
 * Backed by GET /sales/worklist/mine.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listMyWorklist, patchSalesTask, patchSalesActivity, currentUser, WorklistItem } from '../lib/api';

function pretty(date: string | null): string {
  if (!date) return '';
  const d = new Date(date.length <= 10 ? date + 'T00:00:00' : date);
  if (isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function customerLabel(key?: string | null): string {
  if (!key) return '';
  const [kind, id] = key.split(':');
  return kind === 'company' ? `Company #${id}` : kind === 'contact' ? `Contact #${id}` : key;
}

const BUCKETS: { key: WorklistItem['bucket']; label: string; color: string; bg: string }[] = [
  { key: 'overdue', label: 'Overdue',   color: '#991b1b', bg: '#fef2f2' },
  { key: 'today',   label: 'Today',     color: '#9a3412', bg: '#fff7ed' },
  { key: 'week',    label: 'This week', color: '#075985', bg: '#f0f9ff' },
  { key: 'later',   label: 'Later',     color: '#3730a3', bg: '#eef2ff' },
  { key: 'someday', label: 'No date',   color: '#475569', bg: '#f8fafc' },
];

const SOURCE_META: Record<WorklistItem['source'], { icon: string; tag: string; tagBg: string; tagColor: string }> = {
  sales_task:     { icon: '✅', tag: 'Task',      tagBg: '#ecfccb', tagColor: '#3f6212' },
  sales_followup: { icon: '🔔', tag: 'Follow-up', tagBg: '#fef9c3', tagColor: '#854d0e' },
  cx_comms:       { icon: '✉️', tag: 'Client email', tagBg: '#e0e7ff', tagColor: '#3730a3' },
};

export default function MyWork() {
  const me = currentUser();
  const [items, setItems] = useState<WorklistItem[]>([]);
  const [sources, setSources] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  async function load() {
    setLoading(true); setErr('');
    try {
      const r = await listMyWorklist();
      setItems(r.items || []);
      setSources(r.sources || {});
    } catch (e: any) {
      setErr(e?.message || 'Could not load your action items.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function markDone(it: WorklistItem) {
    const tag = `${it.source}-${it.id}`;
    setBusy(tag);
    try {
      if (it.source === 'sales_task') await patchSalesTask(Number(it.id), { status: 'done' });
      else if (it.source === 'sales_followup') await patchSalesActivity(Number(it.id), { next_action_done: true });
      setItems(prev => prev.filter(x => !(x.source === it.source && x.id === it.id)));
    } catch {
      setErr('Could not mark that done — try again.');
    } finally {
      setBusy(null);
    }
  }

  const grouped = BUCKETS.map(b => ({ ...b, rows: items.filter(i => i.bucket === b.key) }))
                         .filter(b => b.rows.length > 0);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: '#0f172a', margin: 0 }}>My Action Items</h1>
        <button onClick={load} style={{ border: '1px solid #e2e8f0', background: '#fff', borderRadius: 8,
          padding: '6px 12px', fontSize: 13, cursor: 'pointer', color: '#475569' }}>↻ Refresh</button>
      </div>
      <div style={{ color: '#64748b', fontSize: 13, marginBottom: 18 }}>
        {me?.name ? `${me.name} · ` : ''}your tasks, follow-ups, and the client emails you're responsible for sending.
      </div>

      {err && <div style={{ background: '#fef2f2', color: '#991b1b', padding: '10px 12px',
        borderRadius: 8, fontSize: 13, marginBottom: 14 }}>{err}</div>}

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 14, padding: '40px 0', textAlign: 'center' }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ color: '#64748b', fontSize: 15, padding: '48px 0', textAlign: 'center' }}>
          🎉 Nothing on your list. You're all caught up.
        </div>
      ) : grouped.map(b => (
        <div key={b.key} style={{ marginBottom: 20 }}>
          <div style={{ display: 'inline-block', background: b.bg, color: b.color, fontWeight: 700,
            fontSize: 12, padding: '3px 10px', borderRadius: 999, marginBottom: 8 }}>
            {b.label} · {b.rows.length}
          </div>
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
            {b.rows.map((it, idx) => {
              const meta = SOURCE_META[it.source];
              const context = it.source === 'cx_comms'
                ? [it.job, it.last_sent ? `last sent ${pretty(it.last_sent)}` : 'not sent yet'].filter(Boolean).join(' · ')
                : [customerLabel(it.customer_key), it.due_date ? `due ${pretty(it.due_date)}` : ''].filter(Boolean).join(' · ');
              return (
                <div key={`${it.source}-${it.id}`} style={{ display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 14px', background: '#fff',
                  borderTop: idx === 0 ? 'none' : '1px solid #f1f5f9' }}>
                  <span title={meta.tag} style={{ fontSize: 16 }}>{meta.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ background: meta.tagBg, color: meta.tagColor, fontSize: 10, fontWeight: 700,
                        padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}>{meta.tag}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title}</span>
                      {it.unassigned && <span title="No role owner set — shown to admins" style={{ fontSize: 11, color: '#b45309' }}>⚑ unassigned</span>}
                    </div>
                    {context && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{context}</div>}
                  </div>
                  {it.source === 'cx_comms' ? (
                    <Link to={`/dashboards/construction/plan?q=${encodeURIComponent(it.job || '')}`}
                      style={{ border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8,
                        padding: '6px 12px', fontSize: 13, fontWeight: 600, color: '#3730a3',
                        cursor: 'pointer', whiteSpace: 'nowrap', textDecoration: 'none' }}>
                      Open
                    </Link>
                  ) : (
                    <button onClick={() => markDone(it)} disabled={busy === `${it.source}-${it.id}`}
                      style={{ border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8,
                        padding: '6px 12px', fontSize: 13, fontWeight: 600, color: '#15803d',
                        cursor: 'pointer', whiteSpace: 'nowrap' }}>
                      {busy === `${it.source}-${it.id}` ? '…' : 'Done'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {!loading && items.length > 0 && (
        <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 8 }}>
          {(sources.sales_task || 0) + (sources.sales_followup || 0)} personal · {sources.cx_comms || 0} client emails
        </div>
      )}
    </div>
  );
}
