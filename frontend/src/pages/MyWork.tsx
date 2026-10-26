/**
 * MyWork — "My Action Items": the logged-in user's personal worklist.
 * Open tasks assigned to them + their pending followups, grouped by due bucket
 * (overdue / today / this week / later / no date), with one-tap "Done".
 * Backed by GET /sales/due/mine (identity-linked by user id, with legacy name fallback).
 */
import React, { useEffect, useState } from 'react';
import { listMyDueItems, patchSalesTask, patchSalesActivity, currentUser, DueItem } from '../lib/api';

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

const BUCKETS: { key: DueItem['bucket']; label: string; color: string; bg: string }[] = [
  { key: 'overdue', label: 'Overdue',     color: '#991b1b', bg: '#fef2f2' },
  { key: 'today',   label: 'Today',       color: '#9a3412', bg: '#fff7ed' },
  { key: 'week',    label: 'This week',   color: '#075985', bg: '#f0f9ff' },
  { key: 'later',   label: 'Later',       color: '#3730a3', bg: '#eef2ff' },
  { key: 'someday', label: 'No date',     color: '#475569', bg: '#f8fafc' },
];

export default function MyWork() {
  const me = currentUser();
  const [items, setItems] = useState<DueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  async function load() {
    setLoading(true); setErr('');
    try {
      const r = await listMyDueItems();
      setItems(r.items || []);
    } catch (e: any) {
      setErr(e?.message || 'Could not load your action items.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function markDone(it: DueItem) {
    const tag = `${it.kind}-${it.id}`;
    setBusy(tag);
    try {
      if (it.kind === 'task') await patchSalesTask(it.id, { status: 'done' });
      else await patchSalesActivity(it.id, { next_action_done: true });
      setItems(prev => prev.filter(x => !(x.kind === it.kind && x.id === it.id)));
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
        {me?.name ? `${me.name} · ` : ''}open tasks assigned to you and your pending follow-ups.
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
            {b.rows.map((it, idx) => (
              <div key={`${it.kind}-${it.id}`} style={{ display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 14px', background: '#fff',
                borderTop: idx === 0 ? 'none' : '1px solid #f1f5f9' }}>
                <span title={it.kind === 'task' ? 'Task' : 'Follow-up'} style={{ fontSize: 16 }}>
                  {it.kind === 'task' ? '✅' : '🔔'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{it.title}</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                    {customerLabel(it.customer_key)}
                    {it.customer_key && it.due_date ? ' · ' : ''}
                    {it.due_date ? `due ${pretty(it.due_date)}` : ''}
                  </div>
                </div>
                <button onClick={() => markDone(it)} disabled={busy === `${it.kind}-${it.id}`}
                  style={{ border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8,
                    padding: '6px 12px', fontSize: 13, fontWeight: 600, color: '#15803d',
                    cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {busy === `${it.kind}-${it.id}` ? '…' : 'Done'}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
