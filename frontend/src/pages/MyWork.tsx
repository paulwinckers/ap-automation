/**
 * MyWork — "My Action Items": the logged-in user's dashboard, in four sections:
 *   Day-to-day  own tasks + follow-ups (by due date)
 *   Workflows   steps of a set process, grouped by job — today the construction client emails
 *   Projects    upcoming construction jobs — prep items + tasks tied to a planned job
 *   Feed        every chat they're part of (field chats + task threads), newest first, read/unread
 * Above the sections: "Waiting on others" — things their tasks depend on, with Nudge.
 * Any task can be marked "waiting on" a coworker (who gets a linked task) or someone outside.
 * Backed by GET /sales/worklist/mine and GET /sales/feed/mine. ?tab=feed etc. deep-links a section.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  listMyWorklist, patchSalesTask, patchSalesActivity, skipCxAction, setChecklistStatus,
  currentUser, WorklistItem, WaitingItem, Lane, nudgeTask, listMyFeed, markFeedRead, FeedItem,
} from '../lib/api';
import { claudeLink, worklistPrompt } from '../lib/claude';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { ClientCommsModal } from '../components/ClientComms';
import { TaskThread } from '../components/TaskThread';
import { WaitingOnModal } from '../components/WaitingOnModal';
import { enablePush, currentPushState, pushSupported, type PushState } from '../lib/push';

function pretty(date: string | null | undefined): string {
  if (!date) return '';
  const d = new Date(date.length <= 10 ? date + 'T00:00:00' : date);
  if (isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function ago(ts: string): string {
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return '';
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return days < 7 ? `${days}d ago` : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function daysSince(date: string): number {
  const d = new Date(date + 'T00:00:00');
  return isNaN(d.getTime()) ? 0 : Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}
function customerLabel(key?: string | null): string {
  if (!key) return '';
  const [kind, id] = key.split(':');
  return kind === 'company' ? `Company #${id}` : kind === 'contact' ? `Contact #${id}` : key;
}
const keyOf = (it: WorklistItem) => `${it.source}-${it.id}`;

type Tab = Lane | 'feed';
const TABS: { key: Tab; label: string; icon: string; hint: string }[] = [
  { key: 'daily',    label: 'Day-to-day', icon: '✅', hint: 'Your tasks and follow-ups' },
  { key: 'workflow', label: 'Workflows',  icon: '🔁', hint: 'Steps of a set process, by job — client emails today; onboarding next' },
  { key: 'project',  label: 'Projects',   icon: '🏗️', hint: 'Upcoming construction jobs — prep and job tasks' },
  { key: 'feed',     label: 'Feed',       icon: '💬', hint: 'Every chat you’re part of, newest first' },
];

const BUCKETS: { key: WorklistItem['bucket']; label: string; color: string; bg: string }[] = [
  { key: 'overdue', label: 'Overdue',   color: '#991b1b', bg: '#fef2f2' },
  { key: 'today',   label: 'Today',     color: '#9a3412', bg: '#fff7ed' },
  { key: 'week',    label: 'This week', color: '#075985', bg: '#f0f9ff' },
  { key: 'later',   label: 'Later',     color: '#3730a3', bg: '#eef2ff' },
  { key: 'someday', label: 'No date',   color: '#475569', bg: '#f8fafc' },
];
const BUCKET_RANK: Record<string, number> = { overdue: 0, today: 1, week: 2, later: 3, someday: 4 };
const SOURCE_META: Record<WorklistItem['source'], { icon: string; tag: string; tagBg: string; tagColor: string }> = {
  sales_task:     { icon: '✅', tag: 'Task',         tagBg: '#ecfccb', tagColor: '#3f6212' },
  sales_followup: { icon: '🔔', tag: 'Follow-up',    tagBg: '#fef9c3', tagColor: '#854d0e' },
  cx_comms:       { icon: '✉️', tag: 'Client email', tagBg: '#e0e7ff', tagColor: '#3730a3' },
  prep:           { icon: '🧰', tag: 'Job prep',     tagBg: '#fef3c7', tagColor: '#92400e' },
  field_conv:     { icon: '💬', tag: 'Field thread', tagBg: '#cffafe', tagColor: '#155e75' },
};

export default function MyWork() {
  const me = currentUser();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS.find(t => t.key === params.get('tab'))?.key) || 'daily';
  const setTab = (t: Tab) => { setParams(t === 'daily' ? {} : { tab: t }, { replace: true }); setSelected(new Set()); };

  const [items, setItems] = useState<WorklistItem[]>([]);
  const [waiting, setWaiting] = useState<WaitingItem[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [feedUnread, setFeedUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<WorklistItem[]>([]);   // CX items being sent, one at a time
  const [notif, setNotif] = useState<PushState>('default');
  const [threadTask, setThreadTask] = useState<number | null>(null);
  const [waitFor, setWaitFor] = useState<WorklistItem | null>(null);
  useEffect(() => { currentPushState().then(setNotif).catch(() => {}); }, []);

  async function load() {
    setLoading(true); setErr('');
    try {
      const [r, f] = await Promise.all([listMyWorklist(), listMyFeed().catch(() => null)]);
      setItems(r.items || []);
      setWaiting(r.waiting || []);
      if (f) { setFeed(f.items || []); setFeedUnread(f.unread || 0); }
      else setFeedUnread(r.feed_unread || 0);
      setSelected(new Set());
    } catch (e: any) {
      setErr(e?.message || 'Could not load your action items.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  const laneCount = (l: Lane) => items.filter(i => i.lane === l).length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const inLane = tab === 'feed' ? [] : items.filter(it => (it.lane || 'daily') === tab);
    if (!q) return inLane;
    return inLane.filter(it =>
      [it.title, it.job, customerLabel(it.customer_key), it.who]
        .filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [items, query, tab]);

  // Day-to-day groups by due date; Workflows and Projects group by job (most urgent job first).
  const groups = useMemo(() => {
    if (tab === 'daily') {
      return BUCKETS.map(b => ({ key: b.key, label: `${b.label} · `, color: b.color, bg: b.bg,
        rows: filtered.filter(i => i.bucket === b.key) })).filter(g => g.rows.length > 0);
    }
    const byJob = new Map<string, WorklistItem[]>();
    for (const it of filtered) {
      const job = it.job || (it.opportunity_id ? `Job #${it.opportunity_id}` : customerLabel(it.customer_key) || 'Other');
      byJob.set(job, [...(byJob.get(job) || []), it]);
    }
    return [...byJob.entries()]
      .map(([job, rows]) => {
        rows.sort((a, b) => BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket]);
        const worst = rows[0]?.bucket || 'someday';
        const b = BUCKETS.find(x => x.key === worst)!;
        return { key: job, label: `${job} · `, color: worst === 'overdue' || worst === 'today' ? b.color : '#1e3a5f',
          bg: worst === 'overdue' || worst === 'today' ? b.bg : '#f1f5f9', rows, rank: BUCKET_RANK[worst] };
      })
      .sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
  }, [filtered, tab]);

  const filteredFeed = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return feed;
    return feed.filter(f => [f.title, f.context, f.snippet, f.last_author].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [feed, query]);

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
    // Finishing something another person was waiting on changes their list — and possibly our Waiting strip.
    if (targets.some(t => t.blocking || (t.waiting && t.waiting.length))) load();
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

  async function nudge(w: WaitingItem) {
    if (!w.task_id) return;
    setBusy(true); setErr(''); setNote('');
    try {
      const r = await nudgeTask(w.task_id);
      setNote(r.ok ? (r.notified ? `Nudged ${w.who}.` : `Noted on the task — ${w.who} has no alerts on, so tell them directly.`) : (r.error || 'Not sent.'));
    } catch (e: any) { setErr(e?.message || 'Nudge failed.'); }
    finally { setBusy(false); }
  }
  async function clearExternal(w: WaitingItem) {
    setBusy(true); setErr('');
    try { await patchSalesTask(w.for_task_id, { waiting_on: '', waiting_until: '' }); await load(); }
    catch (e: any) { setErr(e?.message || 'Could not update.'); }
    finally { setBusy(false); }
  }

  async function openFeed(f: FeedItem) {
    setFeed(prev => prev.map(x => x.key === f.key ? { ...x, unread: false } : x));
    if (f.unread) setFeedUnread(n => Math.max(0, n - 1));
    markFeedRead([f.key]).catch(() => {});
    if (f.kind === 'task_thread' && f.task_id) setThreadTask(f.task_id);
    else if (f.url) navigate(f.url);
  }
  async function markAllRead() {
    const keys = feed.filter(f => f.unread).map(f => f.key);
    if (!keys.length) return;
    setFeed(prev => prev.map(x => ({ ...x, unread: false })));
    setFeedUnread(0);
    markFeedRead(keys).catch(() => {});
  }

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
  const pill = (bg: string, color: string): React.CSSProperties => ({ background: bg, color, fontSize: 11,
    fontWeight: 700, padding: '1px 7px', borderRadius: 999, whiteSpace: 'nowrap' });

  function row(it: WorklistItem, idx: number) {
    const meta = SOURCE_META[it.source];
    const k = keyOf(it);
    const showJob = tab === 'daily';
    const context = it.source === 'cx_comms'
      ? [showJob ? it.job : '', it.last_sent ? `last sent ${pretty(it.last_sent)}` : 'not sent yet'].filter(Boolean).join(' · ')
      : it.source === 'prep'
      ? [showJob ? it.job : '', it.due_date ? `due ${pretty(it.due_date)}` : ''].filter(Boolean).join(' · ')
      : [customerLabel(it.customer_key), it.due_date ? `due ${pretty(it.due_date)}` : ''].filter(Boolean).join(' · ');
    const blockedBy = it.waiting || [];
    const isBlocked = blockedBy.length > 0;
    return (
      <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', flexWrap: 'wrap',
        background: selected.has(k) ? '#f8fafc' : '#fff', borderTop: idx === 0 ? 'none' : '1px solid #f1f5f9' }}>
        <input type="checkbox" checked={selected.has(k)} onChange={() => toggle(it)} style={{ width: 16, height: 16, flexShrink: 0 }} />
        <span title={meta.tag} style={{ fontSize: 16, opacity: isBlocked ? 0.5 : 1 }}>{isBlocked ? '⏳' : meta.icon}</span>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: isBlocked ? '#64748b' : '#0f172a', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ background: meta.tagBg, color: meta.tagColor, fontSize: 10, fontWeight: 700,
              padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}>{meta.tag}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title}</span>
            {it.unassigned && <span title="No role owner set — shown to admins" style={{ fontSize: 11, color: '#b45309' }}>⚑</span>}
          </div>
          {context && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{context}</div>}
          {(isBlocked || it.blocking) && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
              {blockedBy.map((w, i) => (
                <span key={i} style={pill(w.late ? '#fee2e2' : '#f1f5f9', w.late ? '#991b1b' : '#475569')}
                  title={w.title ? `Waiting on ${w.who}: ${w.title}` : `Waiting on ${w.who}`}>
                  ⏳ Waiting on {w.who}{w.due_date ? ` · ${w.external ? 'chase' : 'by'} ${pretty(w.due_date)}` : ''}
                </span>
              ))}
              {it.blocking && (
                <span style={pill('#ffedd5', '#9a3412')} title={`Needed for: ${it.blocking.title}`}>
                  👀 {it.blocking.who || 'Someone'} is waiting on this
                </span>
              )}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {(it.customer_key || it.opportunity_id) && (
            <Link
              to={it.customer_key
                ? `/dashboards/customer/360?key=${encodeURIComponent(it.customer_key)}`
                : `/field/project/${it.opportunity_id}`}
              title={it.customer_key ? 'Open Customer 360' : 'Open the job'}
              style={{ ...btn, color: '#1e3a5f', textDecoration: 'none', flexShrink: 0 }}>
              {it.customer_key ? '👤 360' : '🏗️ Job'}
            </Link>
          )}
          {it.source === 'sales_task' && (
            <>
              <button onClick={() => setThreadTask(Number(it.id))} title="Open the conversation" style={{ ...btn, color: '#1e3a5f' }}>💬 Thread</button>
              <button onClick={() => setWaitFor(it)} title="This task is waiting on someone else" style={{ ...btn, color: '#475569' }}>⏳ Wait on…</button>
            </>
          )}
          {(() => {
            const p = worklistPrompt(it);
            return p && (
              <a href={claudeLink(p)} target="_blank" rel="noopener noreferrer"
                title="Open Claude with this item ready to act on"
                style={{ ...btn, color: '#9a3412', textDecoration: 'none', flexShrink: 0 }}>✳ Claude</a>
            );
          })()}
          {it.source === 'cx_comms' ? (
            <button onClick={() => startSend([it])} style={{ ...btn, color: '#3730a3' }}>Send…</button>
          ) : (
            <button onClick={() => markDone([it])} disabled={busy} style={{ ...btn, color: '#15803d' }}>Done</button>
          )}
        </div>
      </div>
    );
  }

  const tabCount = (t: Tab) => t === 'feed' ? feedUnread : laneCount(t);
  const emptyText: Record<Tab, string> = {
    daily: "🎉 Nothing on your list. You're all caught up.",
    workflow: 'No workflow steps for you right now. Client emails you own show up here — and onboarding steps once those workflows are built.',
    project: 'Nothing for upcoming jobs. Prep items and tasks tied to a planned construction job show up here.',
    feed: 'No chats in the last 30 days.',
  };

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '24px 16px',
      paddingBottom: selectedItems.length > 0 ? 96 : 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4, gap: 8, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: '#0f172a', margin: 0 }}>My Action Items</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {pushSupported() && (
            notif === 'subscribed'
              ? <span style={{ ...btn, color: '#15803d', cursor: 'default' }} title="You'll get a push when a task is assigned to you">🔔 Alerts on</span>
            : notif === 'denied'
              ? <span style={{ ...btn, color: '#9ca3af', cursor: 'default' }} title="Notifications are blocked — turn them on in your browser/site settings">🔕 Blocked</span>
            : notif === 'unconfigured'
              ? <span style={{ ...btn, color: '#9ca3af', cursor: 'default' }} title="Push isn't switched on yet">🔔 Coming soon</span>
              : <button onClick={async () => setNotif(await enablePush())} style={{ ...btn, color: '#2563eb' }} title="Get a push when a task is assigned to you">🔔 Enable alerts</button>
          )}
          <button onClick={load} style={{ ...btn, color: '#475569' }}>↻ Refresh</button>
        </div>
      </div>
      <div style={{ color: '#64748b', fontSize: 13, marginBottom: 14 }}>
        {me?.name ? `${me.name} · ` : ''}{TABS.find(t => t.key === tab)?.hint}
      </div>

      {/* Waiting on others — what your tasks depend on */}
      {waiting.length > 0 && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, background: '#fafafa', padding: '10px 12px', marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 6 }}>⏳ Waiting on others · {waiting.length}</div>
          {waiting.map((w, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', flexWrap: 'wrap',
              borderTop: i === 0 ? 'none' : '1px solid #eef2f7' }}>
              <div style={{ flex: '1 1 260px', minWidth: 0, fontSize: 13 }}>
                <b style={{ color: '#0f172a' }}>{w.who || 'Someone'}</b>
                <span style={{ color: '#475569' }}>{w.what ? ` — ${w.what}` : ''}</span>
                <div style={{ fontSize: 12, color: '#94a3b8' }}>
                  for “{w.for_title}” · {w.since ? `${daysSince(w.since)}d waiting` : ''}
                  {w.due_date && <span style={{ color: w.late ? '#dc2626' : undefined, fontWeight: w.late ? 700 : undefined }}>
                    {` · ${w.kind === 'external' ? 'chase' : 'needed'} ${pretty(w.due_date)}${w.late ? (w.kind === 'external' ? ' — chase now' : ' — late') : ''}`}
                  </span>}
                </div>
              </div>
              {w.kind === 'person' && w.task_id ? (
                <>
                  <button onClick={() => setThreadTask(w.task_id!)} style={{ ...btn, padding: '4px 10px', fontSize: 12, color: '#1e3a5f' }}>💬 Thread</button>
                  <button onClick={() => nudge(w)} disabled={busy} style={{ ...btn, padding: '4px 10px', fontSize: 12, color: '#9a3412' }}>👋 Nudge</button>
                </>
              ) : (
                <button onClick={() => clearExternal(w)} disabled={busy} title="They got back to you — stop waiting"
                  style={{ ...btn, padding: '4px 10px', fontSize: 12, color: '#15803d' }}>✓ Got it</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, overflowX: 'auto', paddingBottom: 2 }}>
        {TABS.map(t => {
          const on = t.key === tab; const n = tabCount(t.key);
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              ...btn, borderRadius: 999, padding: '7px 14px', display: 'flex', alignItems: 'center', gap: 6,
              background: on ? '#1e3a5f' : '#fff', color: on ? '#fff' : '#334155', borderColor: on ? '#1e3a5f' : '#cbd5e1',
            }}>
              <span>{t.icon}</span>{t.label}
              {n > 0 && <span style={{ background: t.key === 'feed' ? '#dc2626' : (on ? '#ffffff33' : '#e2e8f0'),
                color: t.key === 'feed' ? '#fff' : (on ? '#fff' : '#334155'), fontSize: 11, fontWeight: 700,
                padding: '0 7px', borderRadius: 999 }}>{n}</span>}
            </button>
          );
        })}
      </div>

      {/* Search + select-all */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <input value={query} onChange={e => setQuery(e.target.value)}
          placeholder={tab === 'feed' ? 'Search chats…' : 'Search by job, customer, or text…'}
          style={{ flex: 1, padding: '9px 12px', borderRadius: 10, border: '1px solid #d1d5db', fontSize: 14 }} />
        {tab !== 'feed' && filtered.length > 0 && (
          <label style={{ fontSize: 13, color: '#475569', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={allFilteredSelected} onChange={toggleAll} style={{ width: 16, height: 16 }} />
            Select all
          </label>
        )}
        {tab === 'feed' && feedUnread > 0 && (
          <button onClick={markAllRead} style={{ ...btn, color: '#475569' }}>Mark all read</button>
        )}
      </div>

      {err && <div style={{ background: '#fef2f2', color: '#991b1b', padding: '10px 12px',
        borderRadius: 8, fontSize: 13, marginBottom: 14 }}>{err}</div>}
      {note && <div style={{ background: '#f0fdf4', color: '#166534', padding: '10px 12px',
        borderRadius: 8, fontSize: 13, marginBottom: 14 }}>{note}</div>}

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 14, padding: '40px 0', textAlign: 'center' }}>Loading…</div>
      ) : tab === 'feed' ? (
        filteredFeed.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 15, padding: '48px 0', textAlign: 'center' }}>
            {feed.length === 0 ? emptyText.feed : 'No chats match your search.'}
          </div>
        ) : (
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
            {filteredFeed.map((f, idx) => (
              <button key={f.key} onClick={() => openFeed(f)} style={{
                display: 'flex', gap: 10, width: '100%', textAlign: 'left', cursor: 'pointer', padding: '12px 14px',
                background: f.unread ? '#f0f9ff' : '#fff', border: 'none', borderTop: idx === 0 ? 'none' : '1px solid #f1f5f9',
              }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, marginTop: 7, flexShrink: 0,
                  background: f.unread ? '#2563eb' : 'transparent' }} />
                <span style={{ fontSize: 16 }}>{f.kind === 'field_chat' ? '🦺' : '✅'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontSize: 14, fontWeight: f.unread ? 800 : 600, color: '#0f172a', flex: 1, minWidth: 0,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title}</span>
                    <span style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>{ago(f.last_at)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 1 }}>
                    {[f.kind === 'field_chat' ? 'Field chat' : 'Task thread', f.kind === 'field_chat' ? f.context : customerLabel(f.context), f.tag,
                      f.status === 'resolved' || f.status === 'done' ? '✓ closed' : ''].filter(Boolean).join(' · ')}
                  </div>
                  {f.snippet && <div style={{ fontSize: 13, color: '#475569', marginTop: 3, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.last_author ? <b style={{ color: '#334155' }}>{f.last_author}: </b> : null}{f.snippet}
                  </div>}
                </div>
              </button>
            ))}
          </div>
        )
      ) : filtered.length === 0 ? (
        <div style={{ color: '#64748b', fontSize: 15, padding: '48px 16px', textAlign: 'center' }}>
          {laneCount(tab) === 0 ? emptyText[tab] : 'No items match your search.'}
        </div>
      ) : groups.map(g => (
        <div key={g.key} style={{ marginBottom: 20 }}>
          <div style={{ display: 'inline-block', background: g.bg, color: g.color, fontWeight: 700,
            fontSize: 12, padding: '3px 10px', borderRadius: 999, marginBottom: 8 }}>
            {g.label}{g.rows.length}
          </div>
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
            {g.rows.map((it, idx) => row(it, idx))}
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

      {threadTask != null && (
        <TaskThread taskId={threadTask} onClose={() => setThreadTask(null)} onChanged={load} />
      )}
      {waitFor && (
        <WaitingOnModal task={waitFor} onClose={() => setWaitFor(null)}
          onSaved={(msg) => { setWaitFor(null); setNote(msg); load(); }} />
      )}
    </div>
  );
}
