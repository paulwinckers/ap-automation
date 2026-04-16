/**
 * Activities Dashboard
 * Open activities from Aspire, grouped/filtered similarly to the Estimating Dashboard.
 * Route: /dashboards/activities
 */

import React, { useEffect, useState, useRef } from 'react';
import { getActivitiesDashboard, Activity, ActivitiesDashboardData } from '../lib/api';

// ── Notes popup ───────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function CommentsCell({ comments }: { comments: { meta: string; text: string }[] }) {
  const [open, setOpen] = useState(false);
  if (!comments.length) return <span style={{ color: '#d1d5db' }}>—</span>;

  const latest = comments[comments.length - 1];
  const preview = latest.text.length > 70 ? latest.text.slice(0, 70) + '…' : latest.text;

  return (
    <div style={{ position: 'relative' }}>
      <span
        onClick={() => comments.length > 1 || latest.text.length > 70 ? setOpen(o => !o) : undefined}
        style={{ fontSize: 11, color: '#374151', cursor: 'pointer', lineHeight: 1.4 }}
      >
        {preview}
        {(comments.length > 1 || latest.text.length > 70) && (
          <span style={{ color: '#2563eb', marginLeft: 4, fontWeight: 600 }}>
            {comments.length > 1 ? `+${comments.length - 1} more` : '···'}
          </span>
        )}
      </span>
      {open && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setOpen(false)}>
          <div style={{
            background: '#fff', borderRadius: 12, padding: '20px 24px',
            maxWidth: 560, width: '90%', maxHeight: '70vh', overflowY: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>Comment History</span>
              <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#9ca3af' }}>✕</button>
            </div>
            {comments.map((c, i) => (
              <div key={i} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: i < comments.length - 1 ? '1px solid #f1f5f9' : 'none' }}>
                <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 4, whiteSpace: 'pre-line' }}>{c.meta}</div>
                <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>{c.text}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(s: string | null): string {
  if (!s) return '—';
  try {
    return new Date(s + 'T12:00:00').toLocaleDateString('en-CA', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch { return s; }
}

const URGENCY_COLOR: Record<string, string> = {
  overdue:  '#dc2626',
  urgent:   '#ea580c',
  soon:     '#d97706',
  ok:       '#16a34a',
  'no-date':'#9ca3af',
};

const PRIORITY_STYLE: Record<string, { bg: string; color: string; border: string }> = {
  High:   { bg: '#fee2e2', color: '#dc2626', border: '#fecaca' },
  Medium: { bg: '#fef3c7', color: '#92400e', border: '#fde68a' },
  Low:    { bg: '#f0fdf4', color: '#166534', border: '#bbf7d0' },
};

function urgencyLabel(a: Activity): string {
  if (a.urgency === 'overdue') return `${Math.abs(a.days_until_due ?? 0)}d overdue`;
  if (a.days_until_due != null) return `${a.days_until_due}d`;
  return '—';
}

type SortDir = 'asc' | 'desc';

function useSorted(items: Activity[], defaultField: string) {
  const [sortField, setSortField] = useState(defaultField);
  const [sortDir,   setSortDir]   = useState<SortDir>('asc');

  function onSort(field: string) {
    if (field === sortField) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  }

  const sorted = [...items].sort((a, b) => {
    const av = (a as unknown as Record<string, unknown>)[sortField];
    const bv = (b as unknown as Record<string, unknown>)[sortField];
    if (typeof av === 'string' || typeof bv === 'string') {
      return sortDir === 'asc'
        ? ((av as string) ?? '').localeCompare((bv as string) ?? '')
        : ((bv as string) ?? '').localeCompare((av as string) ?? '');
    }
    const an = (av as number) ?? (sortDir === 'asc' ? Infinity : -Infinity);
    const bn = (bv as number) ?? (sortDir === 'asc' ? Infinity : -Infinity);
    return sortDir === 'asc' ? an - bn : bn - an;
  });

  return { sorted, sortField, sortDir, onSort };
}

// ── Table primitives ──────────────────────────────────────────────────────────

const TH_BASE: React.CSSProperties = {
  padding: '7px 10px', fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: 0.4,
  borderBottom: '2px solid #e5e7eb', background: '#f8fafc',
  whiteSpace: 'nowrap', userSelect: 'none', cursor: 'pointer',
};

function SortTh({ children, field, sortField, sortDir, onSort, align = 'left' }: {
  children: React.ReactNode; field: string; sortField: string;
  sortDir: SortDir; onSort: (f: string) => void; align?: 'left' | 'right' | 'center';
}) {
  const active = sortField === field;
  return (
    <th onClick={() => onSort(field)} style={{ ...TH_BASE, textAlign: align, color: active ? '#2563eb' : '#6b7280' }}>
      {children}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

function Td({ children, align = 'left', style }: {
  children: React.ReactNode; align?: 'left' | 'right' | 'center'; style?: React.CSSProperties;
}) {
  return (
    <td style={{ padding: '6px 10px', fontSize: 12, textAlign: align, verticalAlign: 'middle', ...style }}>
      {children}
    </td>
  );
}

// ── Activity table ────────────────────────────────────────────────────────────

function ActivityTable({ activities, showGroup }: { activities: Activity[]; showGroup?: string }) {
  const { sorted, sortField, sortDir, onSort } = useSorted(activities, 'due_date');
  const sp = { sortField, sortDir, onSort };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <SortTh field="subject"       align="left"   {...sp}>Subject</SortTh>
            <SortTh field="property_name" align="left"   {...sp}>Property</SortTh>
            <th style={{ ...TH_BASE, textAlign: 'left', color: '#6b7280' }}>Assigned To</th>
            <th style={{ ...TH_BASE, textAlign: 'left', color: '#6b7280' }}>Comments</th>
            {showGroup !== 'status' && <SortTh field="status" align="left" {...sp}>Status</SortTh>}
            <SortTh field="priority"      align="center" {...sp}>Priority</SortTh>
            <SortTh field="due_date"      align="right"  {...sp}>Due Date</SortTh>
            <th style={{ ...TH_BASE, textAlign: 'center' }}></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a, i) => {
            const duColor  = URGENCY_COLOR[a.urgency] ?? '#9ca3af';
            const priStyle = PRIORITY_STYLE[a.priority] ?? { bg: '#f1f5f9', color: '#475569', border: '#e2e8f0' };
            const aspireUrl = a.opportunity_id
              ? `https://cloud.youraspire.com/app/opportunities/details/${a.opportunity_id}`
              : null;
            return (
              <tr key={a.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                {/* Subject */}
                <Td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    {a.is_milestone && <span title="Milestone" style={{ fontSize: 10 }}>🏁</span>}
                    {aspireUrl ? (
                      <a href={aspireUrl} target="_blank" rel="noopener noreferrer"
                        style={{ fontWeight: 600, color: '#2563eb', fontSize: 12, textDecoration: 'none' }}
                        onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                        onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                      >
                        {a.subject}
                      </a>
                    ) : (
                      <span style={{ fontWeight: 600, fontSize: 12, color: '#111827' }}>{a.subject}</span>
                    )}
                  </div>
                  {a.comments.length > 0 && (
                    <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, maxWidth: 300,
                      overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                      {a.comments[a.comments.length - 1].text}
                    </div>
                  )}
                </Td>
                {/* Property */}
                <Td>
                  {a.property_name ? (
                    <span style={{ fontSize: 11, color: '#374151', fontWeight: 500 }}>{a.property_name}</span>
                  ) : (
                    <span style={{ color: '#d1d5db' }}>—</span>
                  )}
                </Td>
                {/* Assigned To */}
                <Td>
                  {a.assigned_to.length > 0 ? (
                    <span style={{ fontSize: 11, color: '#374151' }}>{a.assigned_to.join(', ')}</span>
                  ) : (
                    <span style={{ color: '#d1d5db' }}>—</span>
                  )}
                </Td>
                {/* Comments */}
                <Td style={{ maxWidth: 220 }}>
                  <CommentsCell comments={a.comments} />
                </Td>
                {/* Status (shown when not grouped by status) */}
                {showGroup !== 'status' && (
                  <Td><span style={{ fontSize: 11, color: '#6b7280' }}>{a.status || '—'}</span></Td>
                )}
                {/* Priority badge */}
                <Td align="center">
                  {a.priority ? (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                      background: priStyle.bg, color: priStyle.color,
                      border: `1px solid ${priStyle.border}`, whiteSpace: 'nowrap',
                    }}>
                      {a.priority}
                    </span>
                  ) : <span style={{ color: '#d1d5db' }}>—</span>}
                </Td>
                {/* Due date */}
                <Td align="right">
                  <span style={{ color: duColor, fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap' }}>
                    <span style={{
                      display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                      background: duColor, marginRight: 4, verticalAlign: 'middle',
                    }} />
                    {fmtDate(a.due_date)}
                  </span>
                  {a.due_date && (
                    <div style={{ fontSize: 10, color: duColor, marginTop: 1 }}>{urgencyLabel(a)}</div>
                  )}
                </Td>
                {/* Open in Aspire */}
                <Td align="center">
                  {a.id && (
                    <a
                      href={`https://cloud.youraspire.com/app/activities/details/${a.id}`}
                      target="_blank" rel="noopener noreferrer"
                      style={{
                        fontSize: 11, padding: '3px 8px', borderRadius: 5,
                        border: '1px solid #d1d5db', background: '#f8fafc',
                        color: '#2563eb', fontWeight: 600, whiteSpace: 'nowrap',
                        textDecoration: 'none', display: 'inline-block',
                      }}
                    >
                      Open ↗
                    </a>
                  )}
                </Td>
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={8} style={{ padding: '20px', textAlign: 'center', color: '#9ca3af', fontSize: 12 }}>
                No activities match the current filters
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr style={{ background: '#f8fafc', borderTop: '2px solid #e5e7eb' }}>
            <td colSpan={8} style={{ padding: '6px 10px', fontSize: 11, color: '#6b7280', fontWeight: 600 }}>
              {activities.length} activit{activities.length !== 1 ? 'ies' : 'y'}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Collapsible group section ─────────────────────────────────────────────────

function GroupSection({ title, activities, showGroup }: {
  title: string; activities: Activity[]; showGroup: string;
}) {
  const [open, setOpen] = useState(false);
  if (activities.length === 0) return null;
  const overdue = activities.filter(a => a.urgency === 'overdue').length;

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', marginBottom: 12, background: '#fff' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', background: '#f8fafc',
          border: 'none', borderBottom: open ? '1px solid #e5e7eb' : 'none',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ color: '#9ca3af', fontSize: 10, transform: open ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform 0.15s' }}>▶</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: '#111827', flex: 1 }}>{title}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {overdue > 0 && (
            <span style={{ background: '#fee2e2', color: '#dc2626', fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10 }}>
              {overdue} overdue
            </span>
          )}
          <span style={{ fontSize: 12, color: '#6b7280' }}>{activities.length} activit{activities.length !== 1 ? 'ies' : 'y'}</span>
        </div>
      </button>
      {open && <ActivityTable activities={activities} showGroup={showGroup} />}
    </div>
  );
}

// ── Select style ──────────────────────────────────────────────────────────────

const SEL = (active: boolean): React.CSSProperties => ({
  fontSize: 12, padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
  border: `1px solid ${active ? '#2563eb' : '#e5e7eb'}`,
  background: active ? '#2563eb' : '#fff',
  color:      active ? '#fff'    : '#1f2937',
  fontWeight: active ? 700       : 400,
});

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ActivitiesDashboard() {
  const [data,          setData]          = useState<ActivitiesDashboardData | null>(null);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [showCompleted,    setShowCompleted]    = useState(false);

  // Filters
  const [search,           setSearch]           = useState('');
  const [filterAssignedTo, setFilterAssignedTo] = useState('All');
  const [filterPriority,   setFilterPriority]   = useState('All');
  const [filterStatus,     setFilterStatus]     = useState('All');
  const [groupBy,          setGroupBy]          = useState<'status' | 'flat'>('flat');

  useEffect(() => {
    setLoading(true); setError(null);
    getActivitiesDashboard(showCompleted)
      .then(setData)
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [showCompleted]);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', flexDirection: 'column', gap: 12 }}>
      <div style={{ width: 32, height: 32, border: '3px solid #e2e8f0', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <span style={{ color: '#64748b', fontSize: 13 }}>Loading activities…</span>
    </div>
  );

  if (error || !data) return (
    <div style={{ padding: 32 }}>
      <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '14px 18px', color: '#dc2626', fontWeight: 600 }}>
        Failed to load: {error ?? 'Unknown error'}
      </div>
    </div>
  );

  const { statuses, priorities, assigned_to_list, activities } = data;

  const searchLower = search.trim().toLowerCase();

  const visible = activities.filter(a =>
    (filterAssignedTo === 'All' || a.assigned_to.includes(filterAssignedTo)) &&
    (filterStatus     === 'All' || a.status   === filterStatus) &&
    (filterPriority   === 'All' || a.priority === filterPriority) &&
    (!searchLower || (
      a.subject.toLowerCase().includes(searchLower) ||
      a.property_name.toLowerCase().includes(searchLower) ||
      a.assigned_to.join(' ').toLowerCase().includes(searchLower) ||
      a.comments.map(c => c.text).join(' ').toLowerCase().includes(searchLower)
    ))
  );

  // Group visible activities
  function grouped(key: keyof Activity) {
    const map = new Map<string, Activity[]>();
    for (const a of visible) {
      const k = String(a[key] || 'Unknown');
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(a);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  return (
    <div style={{ background: '#f8fafc', minHeight: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>

      {/* ── Sticky filter bar ── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: '#f8fafc', borderBottom: '1px solid #e5e7eb',
        padding: '10px 28px',
        display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
      }}>
        {/* Assigned To */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Assigned To:</label>
          <select value={filterAssignedTo} onChange={e => setFilterAssignedTo(e.target.value)} style={SEL(filterAssignedTo !== 'All')}>
            <option value="All">All</option>
            {assigned_to_list.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        {/* Status */}
        {statuses.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Status:</label>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={SEL(filterStatus !== 'All')}>
              <option value="All">All</option>
              {statuses.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        {/* Priority */}
        {priorities.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Priority:</label>
            <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
              {(['All', 'High', 'Medium', 'Low'] as const).map((opt, i) => (
                <button key={opt} onClick={() => setFilterPriority(opt)} style={{
                  padding: '5px 10px', fontSize: 12, border: 'none', cursor: 'pointer',
                  fontWeight: filterPriority === opt ? 700 : 400,
                  background: filterPriority === opt ? '#2563eb' : '#fff',
                  color:      filterPriority === opt ? '#fff'    : '#6b7280',
                  borderRight: i < 3 ? '1px solid #e5e7eb' : 'none',
                }}>{opt}</button>
              ))}
            </div>
          </div>
        )}

        {/* Show completed toggle */}
        <button
          onClick={() => setShowCompleted(s => !s)}
          style={{
            padding: '5px 12px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
            border: '1px solid #e5e7eb',
            background: showCompleted ? '#2563eb' : '#fff',
            color:      showCompleted ? '#fff'    : '#6b7280',
            fontWeight: showCompleted ? 700 : 400,
          }}
        >
          {showCompleted ? '✓ Showing Completed' : 'Show Completed'}
        </button>

        {/* Group by + Search on the right */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Group by:</label>
            <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
              {([['status', 'Status'], ['flat', 'None']] as const).map(([val, label], i) => (
                <button key={val} onClick={() => setGroupBy(val)} style={{
                  padding: '5px 12px', fontSize: 12, border: 'none', cursor: 'pointer',
                  fontWeight: groupBy === val ? 700 : 400,
                  background: groupBy === val ? '#2563eb' : '#fff',
                  color:      groupBy === val ? '#fff'    : '#6b7280',
                  borderRight: i < 1 ? '1px solid #e5e7eb' : 'none',
                }}>{label}</button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 14, color: '#9ca3af' }}>🔍</span>
            <input
              type="text" placeholder="Search…"
              value={search} onChange={e => setSearch(e.target.value)}
              style={{
                fontSize: 12, padding: '5px 10px', borderRadius: 6, outline: 'none', width: 160,
                border: `1px solid ${search ? '#2563eb' : '#e5e7eb'}`,
                background: search ? '#eff6ff' : '#fff', color: '#1f2937',
              }}
            />
            {search && <button onClick={() => setSearch('')} style={{ fontSize: 11, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>}
          </div>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>{visible.length} showing</span>
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: '16px 28px 28px' }}>
        {groupBy === 'status' && (
          grouped('status').map(([status, acts]) => (
            <GroupSection key={status} title={status} activities={acts} showGroup="status" />
          ))
        )}
        {groupBy === 'flat' && (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
            <ActivityTable activities={visible} showGroup="flat" />
          </div>
        )}
      </div>

    </div>
  );
}
