/**
 * Estimating Dashboard
 * Open opportunities grouped by salesperson, table layout matching ConstructionDashboard.
 * Route: /dashboards/estimating
 */

import React, { useEffect, useState } from 'react';
import {
  getEstimatingDashboard,
  EstimatingDashboardData,
  EstimatingOpp,
  EstimatingSalesperson,
} from '../lib/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD', maximumFractionDigits: 0,
  }).format(n);
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  try {
    return new Date(s + 'T12:00:00').toLocaleDateString('en-CA', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch { return s; }
}

const URGENCY_COLOR: Record<string, string> = {
  overdue: '#dc2626',
  urgent:  '#ea580c',
  soon:    '#d97706',
  ok:      '#16a34a',
  'no-date': '#9ca3af',
};

function urgencyLabel(o: EstimatingOpp): string {
  if (o.urgency === 'overdue')  return `${Math.abs(o.days_until_due ?? 0)}d overdue`;
  if (o.urgency === 'urgent')   return `${o.days_until_due}d`;
  if (o.urgency === 'soon')     return `${o.days_until_due}d`;
  if (o.urgency === 'ok')       return `${o.days_until_due}d`;
  return '—';
}

type SortDir = 'asc' | 'desc';

function useSorted(opps: EstimatingOpp[], defaultField: string) {
  const [sortField, setSortField] = useState(defaultField);
  const [sortDir,   setSortDir]   = useState<SortDir>('asc');

  function onSort(field: string) {
    if (field === sortField) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  }

  const sorted = [...opps].sort((a, b) => {
    const av = (a as unknown as Record<string, unknown>)[sortField];
    const bv = (b as unknown as Record<string, unknown>)[sortField];
    if (typeof av === 'string' || typeof bv === 'string') {
      const as_ = ((av as string) ?? '');
      const bs_ = ((bv as string) ?? '');
      return sortDir === 'asc' ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    }
    const an = (av as number) ?? (sortDir === 'asc' ? Infinity : -Infinity);
    const bn = (bv as number) ?? (sortDir === 'asc' ? Infinity : -Infinity);
    return sortDir === 'asc' ? an - bn : bn - an;
  });

  return { sorted, sortField, sortDir, onSort };
}

// ── Table primitives (matches ConstructionDashboard style) ────────────────────

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
    <th onClick={() => onSort(field)} style={{
      ...TH_BASE, textAlign: align,
      color: active ? '#2563eb' : '#6b7280',
    }}>
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

// ── Opportunity table for one salesperson ─────────────────────────────────────

function OppTable({ opps }: { opps: EstimatingOpp[] }) {
  const { sorted, sortField, sortDir, onSort } = useSorted(opps, 'property');
  const sp = { sortField, sortDir, onSort };
  const total = opps.reduce((s, o) => s + (o.estimated_value ?? 0), 0);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <SortTh field="property"        align="left"  {...sp}>Property / Opportunity</SortTh>
            <SortTh field="stage"           align="left"  {...sp}>Stage</SortTh>
            <SortTh field="opp_type"        align="center" {...sp}>Type</SortTh>
            <SortTh field="division"        align="left"  {...sp}>Division</SortTh>
            <SortTh field="sales_type"      align="left"  {...sp}>Sales Type</SortTh>
            <SortTh field="estimated_value" align="right" {...sp}>Est. Value</SortTh>
            <SortTh field="due_date"        align="right" {...sp}>Due Date</SortTh>
            <SortTh field="days_old"        align="right" {...sp}>Age</SortTh>
          </tr>
        </thead>
        <tbody>
          {sorted.map((o, i) => {
            const duColor = URGENCY_COLOR[o.urgency] ?? '#9ca3af';
            const isContract = o.opp_type === 'Contract';
            return (
              <tr key={o.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                {/* Property (bold) then opp name as link */}
                <Td>
                  <div style={{ fontWeight: 700, fontSize: 12, color: '#111827', marginBottom: 2 }}>
                    {o.property || '—'}
                  </div>
                  <a
                    href={`https://cloud.youraspire.com/app/opportunities/details/${o.id}`}
                    target="_blank" rel="noopener noreferrer"
                    style={{ fontSize: 11, color: '#2563eb', textDecoration: 'none' }}
                    onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                    onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                  >
                    {o.name || '(unnamed)'}
                  </a>
                </Td>
                {/* Stage */}
                <Td>
                  <span style={{ fontSize: 11, color: '#475569' }}>{o.status}</span>
                </Td>
                {/* Type badge */}
                <Td align="center">
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                    background: isContract ? '#dbeafe' : '#fef3c7',
                    color:      isContract ? '#1d4ed8' : '#92400e',
                    border:     `1px solid ${isContract ? '#bfdbfe' : '#fde68a'}`,
                    whiteSpace: 'nowrap',
                  }}>
                    {o.opp_type || '—'}
                  </span>
                </Td>
                {/* Division */}
                <Td>
                  <span style={{ fontSize: 11, color: '#6b7280' }}>{o.division || '—'}</span>
                </Td>
                {/* Sales type */}
                <Td>
                  <span style={{ fontSize: 11, color: '#6b7280' }}>{o.sales_type || '—'}</span>
                </Td>
                {/* Est. value */}
                <Td align="right">
                  <span style={{ fontWeight: 700, color: '#1f2937' }}>{fmt$(o.estimated_value)}</span>
                </Td>
                {/* Due date */}
                <Td align="right">
                  <span style={{ color: duColor, fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap' }}>
                    <span style={{
                      display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                      background: duColor, marginRight: 4, verticalAlign: 'middle',
                    }} />
                    {fmtDate(o.due_date)}
                  </span>
                  <div style={{ fontSize: 10, color: duColor, marginTop: 1 }}>{urgencyLabel(o)}</div>
                </Td>
                {/* Age */}
                <Td align="right">
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>{o.days_old}d</span>
                </Td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr style={{ background: '#f8fafc', borderTop: '2px solid #e5e7eb' }}>
            <td colSpan={5} style={{ padding: '6px 10px', fontSize: 11, color: '#6b7280', fontWeight: 600 }}>
              {opps.length} opportunit{opps.length !== 1 ? 'ies' : 'y'}
            </td>
            <td style={{ padding: '6px 10px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#1f2937' }}>
              {fmt$(total)}
            </td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Salesperson section ────────────────────────────────────────────────────────

function SalespersonSection({ sp, filterType, filterSalesType }: {
  sp: EstimatingSalesperson; filterType: string; filterSalesType: string;
}) {
  const [open, setOpen] = useState(true);

  // Flatten all opps, apply filters
  const allOpps = sp.stages.flatMap(st => st.opportunities);
  const visible = allOpps.filter(o =>
    (filterType === 'All' || o.opp_type === filterType) &&
    (filterSalesType === 'All' || o.sales_type === filterSalesType)
  );

  if (visible.length === 0) return null;

  const totalValue = visible.reduce((s, o) => s + (o.estimated_value ?? 0), 0);
  const overdue    = visible.filter(o => o.urgency === 'overdue').length;

  return (
    <div style={{
      border: '1px solid #e5e7eb', borderRadius: 8,
      overflow: 'hidden', marginBottom: 12,
      background: '#fff',
    }}>
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', background: '#f8fafc',
          border: 'none', borderBottom: open ? '1px solid #e5e7eb' : 'none',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{
          color: '#9ca3af', fontSize: 10,
          transform: open ? 'rotate(90deg)' : 'none',
          display: 'inline-block', transition: 'transform 0.15s',
        }}>▶</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: '#111827', flex: 1 }}>
          {sp.name}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {overdue > 0 && (
            <span style={{
              background: '#fee2e2', color: '#dc2626',
              fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
            }}>
              {overdue} overdue
            </span>
          )}
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            {visible.length} opp{visible.length !== 1 ? 's' : ''}
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1f2937', minWidth: 80, textAlign: 'right' }}>
            {fmt$(totalValue)}
          </span>
        </div>
      </button>

      {/* Table */}
      {open && <OppTable opps={visible} />}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function EstimatingDashboard() {
  const [data, setData]                         = useState<EstimatingDashboardData | null>(null);
  const [loading, setLoading]                   = useState(true);
  const [error, setError]                       = useState<string | null>(null);
  const [filterSalesType, setFilterSalesType]   = useState('All');
  const [filterType, setFilterType]             = useState('All');

  useEffect(() => {
    setLoading(true); setError(null);
    getEstimatingDashboard()
      .then(setData)
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', flexDirection: 'column', gap: 12 }}>
      <div style={{ width: 32, height: 32, border: '3px solid #e2e8f0', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <span style={{ color: '#64748b', fontSize: 13 }}>Loading estimating data…</span>
    </div>
  );

  if (error || !data) return (
    <div style={{ padding: 32 }}>
      <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '14px 18px', color: '#dc2626', fontWeight: 600 }}>
        Failed to load: {error ?? 'Unknown error'}
      </div>
    </div>
  );

  const { summary, sales_types, salespeople } = data;

  const visibleCount = salespeople.reduce((acc, sp) =>
    acc + sp.stages.flatMap(st => st.opportunities).filter(o =>
      (filterType === 'All' || o.opp_type === filterType) &&
      (filterSalesType === 'All' || o.sales_type === filterSalesType)
    ).length, 0);

  return (
    <div style={{ padding: '24px 28px', background: '#f8fafc', minHeight: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#0f172a', letterSpacing: '-0.4px' }}>
          📋 Estimating Pipeline
        </h1>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>open opportunities · excludes Won &amp; Lost</span>
      </div>

      {/* Summary strip */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
        {[
          { label: 'Open',         value: summary.total,          color: '#1f2937' },
          { label: 'Est. Value',   value: fmt$(summary.total_value), color: '#1f2937' },
          { label: 'Overdue',      value: summary.overdue,        color: summary.overdue > 0 ? '#dc2626' : '#16a34a' },
          { label: 'Due This Week',value: summary.due_this_week,  color: summary.due_this_week > 0 ? '#ea580c' : '#16a34a' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{
            background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
            padding: '10px 18px', flex: '1 1 140px',
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Sales Type:</label>
          <select
            value={filterSalesType}
            onChange={e => setFilterSalesType(e.target.value)}
            style={{ fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#1f2937', cursor: 'pointer' }}
          >
            <option value="All">All</option>
            {sales_types.map(st => <option key={st} value={st}>{st}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Type:</label>
          <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
            {(['All', 'Contract', 'Work Order'] as const).map((opt, i) => (
              <button key={opt} onClick={() => setFilterType(opt)} style={{
                padding: '5px 12px', fontSize: 12, border: 'none', cursor: 'pointer',
                fontWeight: filterType === opt ? 700 : 400,
                background: filterType === opt ? '#2563eb' : '#fff',
                color:      filterType === opt ? '#fff' : '#6b7280',
                borderRight: i < 2 ? '1px solid #e5e7eb' : 'none',
              }}>{opt}</button>
            ))}
          </div>
        </div>

        <span style={{ fontSize: 11, color: '#9ca3af' }}>{visibleCount} showing</span>
      </div>

      {/* Salesperson sections */}
      <div>
        {salespeople.map(sp => (
          <SalespersonSection
            key={sp.name} sp={sp}
            filterType={filterType}
            filterSalesType={filterSalesType}
          />
        ))}
      </div>

    </div>
  );
}
