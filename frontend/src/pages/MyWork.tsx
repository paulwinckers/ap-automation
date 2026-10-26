/**
 * MyWork — "My Action Items": the logged-in user's unified morning worklist.
 * Merges three sources into one bucketed list (overdue / today / this week / later / no date):
 *   - sales_task     open tasks assigned to them
 *   - sales_followup their pending follow-ups
 *   - cx_comms       CX client-comms due they OWN (by role, from CX settings)
 * Features: search, multi-select with bulk actions (Mark N/A, Mark Done), and send client
 * emails via a guided preview/approve queue (ClientCommsModal — one approval per send).
 * Backed by GET /sales/worklist/mine.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  listMyWorklist, patchSalesTask, patchSalesActivity, skipCxAction, setChecklistStatus,
  currentUser, WorklistItem,
} from '../lib/api';
import { ClientCommsModal } from '../components/ClientComms';

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
const keyOf = (it: WorklistItem) => `${it.source}-${it.id}`;

const BUCKETS: { key: WorklistItem['bucket']; label: string; color: string; bg: string }[] = [
  { key: 'overdue', label: 'Overdue',   color: '#991b1b', bg: '#fef2f2' },
  { key: 'today',   label: 'Today',     color: '#9a3412', bg: '#fff7ed' },
  { key: 'week',    label: 'This week', color: '#075985', bg: '#f0f9ff' },
  { key: 'later',   label: 'Later',     color: '#3730a3', bg: '#eef2ff' },
  { key: 'someday', label: 'No date',   color: '#475569', bg: '#f8fafc' },
];
const SOURCE_META: Record<WorklistItem['source'], { icon: string; tag: string; tagBg: string; tagColor: string }> = {
  sales_task:     { icon: '✅', tag: 'Task',         tagBg: '#ecfccb', tagColor: '#3f6212' },
  sales_followup: { icon: '🔔', tag: 'Follow-up',    tagBg: '#fef9c3', tagColor: '#854d0e' },
  cx_comms:       { icon: '✉️', tag: 'Client email', tagBg: '#e0e7ff', tagColor: '#3730a3' },
  prep:           { icon: '🧰', tag: 'Job prep',     tagBg: '#fef3c7', tagColor: '#92400e' },
};

export default function MyWork() {
  const me = currentUser();
  const [items, setItems] = useState<WorklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<WorklistItem[]>([]);   // CX items being sent, one at a time

  async function load() {
    setLoading(true); setErr('');
    try {
      const r = await listMyWorklist();
      setItems(r.items || []);
      setSelected(new Set());
    } catch (e: any) {
      setErr(e?.message || 'Could not load your action items.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(it =>
      [it.title, it.job, customerLabel(it.customer_key), it.who]
        .filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [items, query]);

  const grouped = BUCKETS.map(b => ({ ...b, rows: filtered.filter(i => i.bucket === b.key) }))
                         .filter(b => b.rows.length > 0);

  const selectedItems = items.filter(it => selected.has(keyOf(it)));
  const selCx    = selectedItems.filter(it => it.source === 'cx_comms');
  const selSales = selectedItems.filter(it => it.source !== 'cx_comms');

  function toggle(it: WorklistItem) {
    setSelected(prev => {
      const n = new Set(prev); const k = keyOf(it);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  }
  const allFilteredSelected = filtered.length > 0 && filtered.every(it => selected.has(keyOf(it)));
  function toggleAll() {
    setSelected(prev => {
      if (allFilteredSelected) { const n = new Set(prev); filtered.forEach(it => n.delete(keyOf(it))); return n; }
      const n = new Set(prev); filtered.forEach(it => n.add(keyOf(it))); return n;
    });
  }

  // Apply a per-item async op across a set, drop the ones that succeed, keep going on errors.
  async function bulk(targets: WorklistItem[], op: (it: WorklistItem) => Promise<void>, verb: string) {
    if (targets.length === 0) return;
    setBusy(true); setErr('');
    const doneKeys = new Set<string>(); let failed = 0;
    for (const it of targets) {
      try { await op(it); doneKeys.add(keyOf(it)); } catch { failed++; }
    }
    setItems(prev => prev.filter(it => !doneKeys.has(keyOf(it))));
    setSelected(prev => { const n = new Set(prev); doneKeys.forEach(k => n.delete(k)); return n; });
    setBusy(false);
    if (failed) setErr(`${failed} item(s) couldn't be ${verb} — try again.`);
  }

  const markNA = (targets: WorklistItem[]) => bulk(targets, async (it) => {
    if (it.source === 'sales_task') await patchSalesTask(Number(it.id), { status: 'cancelled' });
    else if (it.source === 'sales_followup') await patchSalesActivity(Number(it.id), { next_action_done: true });
    else if (it.source === 'cx_comms' && it.opportunity_id && it.action_key)
      await skipCxAction(it.opportunity_id, it.action_key, me?.name || undefined);
    else if (it.source === 'prep' && it.opportunity_id && it.item_key)
      await setChecklistStatus(it.opportunity_id, it.item_key, 'na', null, me?.name || undefined);
  }, 'marked N/A');

  const markDone = (targets: WorklistItem[]) => bulk(targets.filter(t => t.source !== 'cx_comms'), async (it) => {
    if (it.source === 'sales_task') await patchSalesTask(Number(it.id), { status: 'done' });
    else if (it.source === 'sales_followup') await patchSalesActivity(Number(it.id), { next_action_done: true });
    else if (it.source === 'prep' && it.opportunity_id && it.item_key)
      await setChecklistStatus(it.opportunity_id, it.item_key, 'complete', null, me?.name || undefined);
  }, 'marked done');

  // Guided send queue: open each selected CX email in the preview/approve modal, one at a time.
  function startSend(targets: WorklistItem[]) {
    const q = targets.filter(it => it.source === 'cx_comms' && it.opportunity_id);
    if (q.length) setQueue(q);
  }
  function closeModal() {
    setQueue(prev => {
      const rest = prev.slice(1);
      if (rest.length === 0) load();   // batch finished → refresh from server (reflects sends)
      return rest;
    });
  }
  const current = queue[0] || null;

  const btn: React.CSSProperties = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8,
    padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' };

  return (
    <div style={{ maxWidth: 780, margin: '0 auto', padding: '24px 16px',
      paddingBottom: selectedItems.length > 0 ? 96 : 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: '#0f172a', margin: 0 }}>My Action Items</h1>
        <button onClick={load} style={{ ...btn, color: '#475569' }}>↻ Refresh</button>
      </div>
      <div style={{ color: '#64748b', fontSize: 13, marginBottom: 14 }}>
        {me?.name ? `${me.name} · ` : ''}your tasks, follow-ups, and the client emails you're responsible for sending.
      </div>

      {/* Search + select-all */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by job, customer, or text…"
          style={{ flex: 1, padding: '9px 12px', borderRadius: 10, border: '1px solid #d1d5db', fontSize: 14 }} />
        {filtered.length > 0 && (
          <label style={{ fontSize: 13, color: '#475569', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={allFilteredSelected} onChange={toggleAll} style={{ width: 16, height: 16 }} />
            Select all
          </label>
        )}
      </div>

      {err && <div style={{ background: '#fef2f2', color: '#991b1b', padding: '10px 12px',
        borderRadius: 8, fontSize: 13, marginBottom: 14 }}>{err}</div>}

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 14, padding: '40px 0', textAlign: 'center' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: '#64748b', fontSize: 15, padding: '48px 0', textAlign: 'center' }}>
          {items.length === 0 ? "🎉 Nothing on your list. You're all caught up." : 'No items match your search.'}
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
              const k = keyOf(it);
              const context = it.source === 'cx_comms'
                ? [it.job, it.last_sent ? `last sent ${pretty(it.last_sent)}` : 'not sent yet'].filter(Boolean).join(' · ')
                : it.source === 'prep'
                ? [it.job, it.due_date ? `due ${pretty(it.due_date)}` : ''].filter(Boolean).join(' · ')
                : [customerLabel(it.customer_key), it.due_date ? `due ${pretty(it.due_date)}` : ''].filter(Boolean).join(' · ');
              return (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
                  background: selected.has(k) ? '#f8fafc' : '#fff', borderTop: idx === 0 ? 'none' : '1px solid #f1f5f9' }}>
                  <input type="checkbox" checked={selected.has(k)} onChange={() => toggle(it)} style={{ width: 16, height: 16, flexShrink: 0 }} />
                  <span title={meta.tag} style={{ fontSize: 16 }}>{meta.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ background: meta.tagBg, color: meta.tagColor, fontSize: 10, fontWeight: 700,
                        padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}>{meta.tag}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title}</span>
                      {it.unassigned && <span title="No role owner set — shown to admins" style={{ fontSize: 11, color: '#b45309' }}>⚑</span>}
                    </div>
                    {context && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{context}</div>}
                  </div>
                  {it.source === 'cx_comms' ? (
                    <button onClick={() => startSend([it])} style={{ ...btn, color: '#3730a3' }}>Send…</button>
                  ) : (
                    <button onClick={() => markDone([it])} disabled={busy} style={{ ...btn, color: '#15803d' }}>Done</button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Sticky bulk action bar */}
      {selectedItems.length > 0 && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 200,
          width: 'min(720px, calc(100% - 32px))', padding: '12px 14px', background: '#0f172a',
          borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          boxShadow: '0 6px 24px rgba(0,0,0,0.28)' }}>
          <span style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600 }}>{selectedItems.length} selected</span>
          <div style={{ flex: 1 }} />
          {selCx.length > 0 && (
            <button onClick={() => startSend(selCx)} disabled={busy}
              style={{ ...btn, background: '#4f46e5', color: '#fff', border: 'none' }}>
              Send {selCx.length} email{selCx.length > 1 ? 's' : ''}…
            </button>
          )}
          {selSales.length > 0 && (
            <button onClick={() => markDone(selSales)} disabled={busy} style={{ ...btn, color: '#15803d' }}>
              Mark {selSales.length} done
            </button>
          )}
          <button onClick={() => markNA(selectedItems)} disabled={busy} style={{ ...btn, color: '#b45309' }}>
            Mark N/A
          </button>
          <button onClick={() => setSelected(new Set())} disabled={busy}
            style={{ ...btn, background: 'transparent', color: '#94a3b8', border: '1px solid #334155' }}>
            Clear
          </button>
        </div>
      )}

      {/* Guided send: one email at a time, each previewed & approved in the modal */}
      {current && current.opportunity_id && (
        <>
          {queue.length > 1 && (
            <div style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 1100,
              background: '#4f46e5', color: '#fff', padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 700 }}>
              Sending {queue.length} emails — {queue.length - 1} after this
            </div>
          )}
          <ClientCommsModal oppId={current.opportunity_id} jobName={current.job || ''}
            initialTemplateKey={current.template_key || undefined} onClose={closeModal} />
        </>
      )}
    </div>
  );
}
