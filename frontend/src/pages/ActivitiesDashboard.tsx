/**
 * Activities Dashboard
 * Open activities from Aspire, grouped/filtered similarly to the Estimating Dashboard.
 * Route: /dashboards/activities
 */

import React, { useEffect, useState } from 'react';
import { getActivitiesDashboard, Activity, ActivitiesDashboardData } from '../lib/api';

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
            {showGroup !== 'type'   && <SortTh field="activity_type" align="left"   {...sp}>Type</SortTh>}
            {showGroup !== 'status' && <SortTh field="status"        align="left"   {...sp}>Status</SortTh>}
            <SortTh field="priority"      align="center" {...sp}>Priority</SortTh>
            <SortTh field="category"      align="left"   {...sp}>Category</SortTh>
            <SortTh field="created_by"    align="left"   {...sp}>Created By</SortTh>
            <SortTh field="due_date"      align="right"  {...sp}>Due Date</SortTh>
            <SortTh field="modified_date" align="right"  {...sp}>Modified</SortTh>
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
                  {a.notes && (
                    <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, maxWidth: 300,
                      overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                      {a.notes}
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
                {/* Type (shown when not grouped by type) */}
                {showGroup !== 'type' && (
                  <Td><span style={{ fontSize: 11, color: '#475569' }}>{a.activity_type || '—'}</span></Td>
                )}
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
                {/* Category */}
                <Td><span style={{ fontSize: 11, color: '#6b7280' }}>{a.category || '—'}</span></Td>
                {/* Created by */}
                <Td><span style={{ fontSize: 11, color: '#6b7280' }}>{a.created_by || '—'}</span></Td>
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
                {/* Modified date */}
                <Td align="right">
                  <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>{fmtDate(a.modified_date)}</span>
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
            <td colSpan={7} style={{ padding: '6px 10px', fontSize: 11, color: '#6b7280', fontWeight: 600 }}>
              {activities.length} activit{activities.length !== 1 ? 'ies' : 'y'}
            </td>
            <td colSpan={2} />
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
  const [showCompleted,  setShowCompleted]  = useState(false);
  const [includeEmails,  setIncludeEmails]  = useState(false);

  // Filters
  const [search,         setSearch]         = useState('');
  const [filterType,     setFilterType]     = useState('All');
  const [filterStatus,   setFilterStatus]   = useState('All');
  const [filterPriority, setFilterPriority] = useState('All');
  const [filterCategory, setFilterCategory] = useState('All');
  const [filterCreatedBy,setFilterCreatedBy]= useState('All');
  const [groupBy,        setGroupBy]        = useState<'type' | 'status' | 'flat'>('type');

  useEffect(() => {
    setLoading(true); setError(null);
    getActivitiesDashboard(showCompleted, includeEmails)
      .then(setData)
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [showCompleted, includeEmails]);

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

  const { summary, activity_types, statuses, priorities, categories, created_by_list, activities } = data;

  const searchLower = search.trim().toLowerCase();

  const visible = activities.filter(a =>
    (filterType      === 'All' || a.activity_type === filterType) &&
    (filterStatus    === 'All' || a.status        === filterStatus) &&
    (filterPriority  === 'All' || a.priority      === filterPriority) &&
    (filterCategory  === 'All' || a.category      === filterCategory) &&
    (filterCreatedBy === 'All' || a.created_by    === filterCreatedBy) &&
    (!searchLower || (
      a.subject.toLowerCase().includes(searchLower) ||
      a.notes.toLowerCase().includes(searchLower) ||
      a.created_by.toLowerCase().includes(searchLower) ||
      a.category.toLowerCase().includes(searchLower) ||
      String(a.number ?? '').includes(searchLower)
    ))
  );

  // Status tiles — all statuses always shown
  const statusTiles = statuses.map(st => ({
    status: st,
    count:  visible.filter(a => a.status === st).length,
  }));
  const allTileCount = visible.length;

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

      {/* Header + status tiles */}
      <div style={{ padding: '24px 28px 0' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 14 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#0f172a', letterSpacing: '-0.4px' }}>
            📅 Activities
          </h1>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            {showCompleted ? 'all activities' : 'open activities · excludes completed'}
          </span>
        </div>

        {/* Summary tiles — one per status, always shown */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 0 }}>
          {/* All tile */}
          {(() => {
            const active = filterStatus === 'All';
            return (
              <button key="all" onClick={() => setFilterStatus('All')} style={{
                flex: '1 1 110px', padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
                textAlign: 'left', border: `2px solid ${active ? '#2563eb' : '#e5e7eb'}`,
                background: active ? '#eff6ff' : '#fff', transition: 'all 0.12s',
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: active ? '#2563eb' : '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>All</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: active ? '#1d4ed8' : '#1f2937', lineHeight: 1 }}>{allTileCount}</div>
                <div style={{ fontSize: 10, color: active ? '#3b82f6' : '#9ca3af', marginTop: 3 }}>
                  {summary.overdue > 0 ? `${summary.overdue} overdue` : 'none overdue'}
                </div>
              </button>
            );
          })()}

          {statusTiles.map(({ status, count }) => {
            const active = filterStatus === status;
            return (
              <button key={status} onClick={() => setFilterStatus(active ? 'All' : status)} style={{
                flex: '1 1 110px', padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
                textAlign: 'left', border: `2px solid ${active ? '#2563eb' : '#e5e7eb'}`,
                background: active ? '#eff6ff' : '#fff', transition: 'all 0.12s',
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: active ? '#2563eb' : '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{status}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: active ? '#1d4ed8' : '#1f2937', lineHeight: 1 }}>{count}</div>
                <div style={{ fontSize: 10, color: active ? '#3b82f6' : '#9ca3af', marginTop: 3 }}>activities</div>
              </button>
            );
          })}

          {/* Summary stats */}
          {[
            { label: 'Overdue',       value: summary.overdue,       color: summary.overdue > 0 ? '#dc2626' : '#16a34a' },
            { label: 'Due This Week', value: summary.due_this_week, color: summary.due_this_week > 0 ? '#ea580c' : '#16a34a' },
            { label: 'Milestones',    value: summary.milestones,    color: '#7c3aed' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ flex: '1 1 110px', padding: '10px 14px', borderRadius: 8, background: '#fff', border: '1px solid #e5e7eb' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Sticky filter bar ── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: '#f8fafc', borderBottom: '1px solid #e5e7eb',
        padding: '10px 28px',
        display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
      }}>
        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 14, color: '#9ca3af' }}>🔍</span>
          <input
            type="text" placeholder="Search subject, notes, category…"
            value={search} onChange={e => setSearch(e.target.value)}
            style={{
              fontSize: 12, padding: '5px 10px', borderRadius: 6, outline: 'none', width: 220,
              border: `1px solid ${search ? '#2563eb' : '#e5e7eb'}`,
              background: search ? '#eff6ff' : '#fff', color: '#1f2937',
            }}
          />
          {search && <button onClick={() => setSearch('')} style={{ fontSize: 11, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>}
        </div>

        {/* Type */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Type:</label>
          <select value={filterType} onChange={e => setFilterType(e.target.value)} style={SEL(filterType !== 'All')}>
            <option value="All">All</option>
            {activity_types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        {/* Priority */}
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

        {/* Category */}
        {categories.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Category:</label>
            <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} style={SEL(filterCategory !== 'All')}>
              <option value="All">All</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        )}

        {/* Created by */}
        {created_by_list.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Created by:</label>
            <select value={filterCreatedBy} onChange={e => setFilterCreatedBy(e.target.value)} style={SEL(filterCreatedBy !== 'All')}>
              <option value="All">All</option>
              {created_by_list.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
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

        {/* Include emails toggle */}
        <button
          onClick={() => setIncludeEmails(s => !s)}
          style={{
            padding: '5px 12px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
            border: '1px solid #e5e7eb',
            background: includeEmails ? '#7c3aed' : '#fff',
            color:      includeEmails ? '#fff'    : '#6b7280',
            fontWeight: includeEmails ? 700 : 400,
          }}
        >
          {includeEmails ? '✓ Emails Shown' : 'Show Emails'}
        </button>

        {/* Group by */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Group by:</label>
          <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
            {([['type', 'Type'], ['status', 'Status'], ['flat', 'None']] as const).map(([val, label], i) => (
              <button key={val} onClick={() => setGroupBy(val)} style={{
                padding: '5px 12px', fontSize: 12, border: 'none', cursor: 'pointer',
                fontWeight: groupBy === val ? 700 : 400,
                background: groupBy === val ? '#2563eb' : '#fff',
                color:      groupBy === val ? '#fff'    : '#6b7280',
                borderRight: i < 2 ? '1px solid #e5e7eb' : 'none',
              }}>{label}</button>
            ))}
          </div>
        </div>

        <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>{visible.length} showing</span>
      </div>

      {/* Content */}
      <div style={{ padding: '16px 28px 28px' }}>
        {groupBy === 'type' && (
          grouped('activity_type').map(([type, acts]) => (
            <GroupSection key={type} title={type} activities={acts} showGroup="type" />
          ))
        )}
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
