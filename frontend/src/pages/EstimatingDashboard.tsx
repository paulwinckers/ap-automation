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

const PHASE_ORDER = ['New', 'Qualified', 'In Design', 'Estimating', 'Reviewed', 'Delivered'];

function phaseSort(a: string, b: string) {
  const ai = PHASE_ORDER.indexOf(a);
  const bi = PHASE_ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
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

// ── Opportunity table ─────────────────────────────────────────────────────────

function OppTable({ opps, showSalesperson = false }: { opps: EstimatingOpp[]; showSalesperson?: boolean }) {
  const { sorted, sortField, sortDir, onSort } = useSorted(opps, 'property');
  const sp = { sortField, sortDir, onSort };
  const total = opps.reduce((s, o) => s + (o.estimated_value ?? 0), 0);
  // Total columns: 11 base + 1 if salesperson shown = 12
  const totalCols = showSalesperson ? 12 : 11;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <SortTh field="property"        align="left"   {...sp}>Property / Opportunity</SortTh>
            {showSalesperson && <SortTh field="salesperson" align="left" {...sp}>Salesperson</SortTh>}
            <SortTh field="status"          align="left"   {...sp}>Phase</SortTh>
            <SortTh field="opp_type"        align="center" {...sp}>Type</SortTh>
            <SortTh field="division"        align="left"   {...sp}>Division</SortTh>
            <SortTh field="sales_type"      align="left"   {...sp}>Sales Type</SortTh>
            <SortTh field="estimated_value" align="right"  {...sp}>Est. Value</SortTh>
            <SortTh field="created_date"    align="right"  {...sp}>Created</SortTh>
            <SortTh field="due_date"        align="right"  {...sp}>Bid Due</SortTh>
            <SortTh field="start_date"      align="right"  {...sp}>Start</SortTh>
            <SortTh field="end_date"        align="right"  {...sp}>End</SortTh>
            <SortTh field="days_old"        align="right"  {...sp}>Age</SortTh>
          </tr>
        </thead>
        <tbody>
          {sorted.map((o, i) => {
            const duColor = URGENCY_COLOR[o.urgency] ?? '#9ca3af';
            const isContract = o.opp_type === 'Contract';
            return (
              <tr key={o.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                {/* Property (bold) then #Num – Opp Name as link */}
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
                    {o.opp_number ? `#${o.opp_number} – ` : ''}{o.name || '(unnamed)'}
                  </a>
                </Td>
                {/* Salesperson (flat view only) */}
                {showSalesperson && (
                  <Td><span style={{ fontSize: 11, color: '#374151' }}>{(o as unknown as Record<string,string>)['salesperson'] || '—'}</span></Td>
                )}
                {/* Phase */}
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
                <Td><span style={{ fontSize: 11, color: '#6b7280' }}>{o.division || '—'}</span></Td>
                {/* Sales type */}
                <Td><span style={{ fontSize: 11, color: '#6b7280' }}>{o.sales_type || '—'}</span></Td>
                {/* Est. value */}
                <Td align="right">
                  <span style={{ fontWeight: 700, color: '#1f2937' }}>{fmt$(o.estimated_value)}</span>
                </Td>
                {/* Created date */}
                <Td align="right">
                  <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDate(o.created_date)}</span>
                </Td>
                {/* Bid due date */}
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
                {/* Start date */}
                <Td align="right">
                  <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDate(o.start_date)}</span>
                </Td>
                {/* End date */}
                <Td align="right">
                  <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDate(o.end_date)}</span>
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
            <td colSpan={showSalesperson ? 6 : 5} style={{ padding: '6px 10px', fontSize: 11, color: '#6b7280', fontWeight: 600 }}>
              {opps.length} opportunit{opps.length !== 1 ? 'ies' : 'y'}
            </td>
            <td style={{ padding: '6px 10px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#1f2937' }}>
              {fmt$(total)}
            </td>
            <td colSpan={totalCols - (showSalesperson ? 7 : 6)} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Salesperson section ────────────────────────────────────────────────────────

function SalespersonSection({ sp, matchesFilters }: {
  sp: EstimatingSalesperson; matchesFilters: (o: EstimatingOpp) => boolean;
}) {
  // Collapsed by default
  const [open, setOpen] = useState(false);

  const allOpps = sp.stages.flatMap(st => st.opportunities);
  const visible = allOpps.filter(matchesFilters);

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

// ── Status section ────────────────────────────────────────────────────────────

function StatusSection({ status, opps }: { status: string; opps: EstimatingOpp[] }) {
  const [open, setOpen] = useState(false);

  if (opps.length === 0) return null;

  const totalValue = opps.reduce((s, o) => s + (o.estimated_value ?? 0), 0);
  const overdue    = opps.filter(o => o.urgency === 'overdue').length;

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
        <span style={{ fontWeight: 700, fontSize: 14, color: '#111827', flex: 1 }}>{status}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {overdue > 0 && (
            <span style={{ background: '#fee2e2', color: '#dc2626', fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10 }}>
              {overdue} overdue
            </span>
          )}
          <span style={{ fontSize: 12, color: '#6b7280' }}>{opps.length} opp{opps.length !== 1 ? 's' : ''}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1f2937', minWidth: 80, textAlign: 'right' }}>{fmt$(totalValue)}</span>
        </div>
      </button>
      {open && <OppTable opps={opps} showSalesperson />}
    </div>
  );
}

// ── Select style shared ───────────────────────────────────────────────────────

const SELECT_STYLE = (active: boolean): React.CSSProperties => ({
  fontSize: 12, padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
  border: `1px solid ${active ? '#2563eb' : '#e5e7eb'}`,
  background: active ? '#2563eb' : '#fff',
  color:      active ? '#fff'    : '#1f2937',
  fontWeight: active ? 700       : 400,
});

// ── Main page ─────────────────────────────────────────────────────────────────

export default function EstimatingDashboard() {
  const [data, setData]                           = useState<EstimatingDashboardData | null>(null);
  const [loading, setLoading]                     = useState(true);
  const [error, setError]                         = useState<string | null>(null);
  const [filterSalesperson,   setFilterSalesperson]   = useState('All');
  const [filterSalesType,     setFilterSalesType]     = useState('All');
  const [filterType,          setFilterType]           = useState('All');
  const [filterPhase,         setFilterPhase]          = useState('All');
  const [filterStartYear,     setFilterStartYear]      = useState('2026');
  const [groupBy, setGroupBy] = useState<'salesperson' | 'status' | 'flat'>('salesperson');

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

  const { sales_types, phases, salespeople } = data;

  // Salesperson names for the filter dropdown
  const salespersonNames = salespeople.map(s => s.name);

  // Visible sections (salesperson filter applied at top level)
  const visibleSalespeople = filterSalesperson === 'All'
    ? salespeople
    : salespeople.filter(s => s.name === filterSalesperson);

  // Base filter — everything EXCEPT phase, used to compute the phase tiles
  const baseMatch = (o: EstimatingOpp) =>
    (filterType      === 'All' || o.opp_type   === filterType) &&
    (filterSalesType === 'All' || o.sales_type === filterSalesType) &&
    (filterStartYear === 'All' || !o.start_date || o.start_date.startsWith(filterStartYear));

  const matchesFilters = (o: EstimatingOpp) =>
    baseMatch(o) &&
    (filterPhase === 'All' || o.status === filterPhase);

  // All opps matching base filters (for phase tile computation)
  const baseOpps = visibleSalespeople.flatMap(sp =>
    sp.stages.flatMap(st => st.opportunities).filter(baseMatch)
  );

  // Per-phase stats for the tiles — always show all six workflow phases, even if empty
  const phaseTiles = PHASE_ORDER
    .map(phase => {
      const opps = baseOpps.filter(o => o.status === phase);
      return { phase, count: opps.length, value: opps.reduce((s, o) => s + o.estimated_value, 0) };
    });

  const allTile = {
    count: baseOpps.length,
    value: baseOpps.reduce((s, o) => s + o.estimated_value, 0),
  };

  const visibleCount = visibleSalespeople.reduce((acc, sp) =>
    acc + sp.stages.flatMap(st => st.opportunities).filter(matchesFilters).length, 0);

  return (
    <div style={{ background: '#f8fafc', minHeight: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>

      {/* Non-sticky header + phase tiles */}
      <div style={{ padding: '24px 28px 0' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 14 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#0f172a', letterSpacing: '-0.4px' }}>
            📋 Estimating Pipeline
          </h1>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>open opportunities · excludes Won &amp; Lost</span>
        </div>

        {/* Dynamic phase tiles — click to filter */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 0 }}>
          {/* "All" tile */}
          {(() => {
            const active = filterPhase === 'All';
            return (
              <button
                key="all"
                onClick={() => setFilterPhase('All')}
                style={{
                  flex: '1 1 130px', padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
                  textAlign: 'left', border: `2px solid ${active ? '#2563eb' : '#e5e7eb'}`,
                  background: active ? '#eff6ff' : '#fff',
                  boxShadow: active ? '0 0 0 1px #2563eb22' : 'none',
                  transition: 'all 0.12s',
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 700, color: active ? '#2563eb' : '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>All Phases</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: active ? '#1d4ed8' : '#1f2937', lineHeight: 1 }}>{allTile.count}</div>
                <div style={{ fontSize: 11, color: active ? '#3b82f6' : '#6b7280', marginTop: 3 }}>{fmt$(allTile.value)}</div>
              </button>
            );
          })()}

          {/* One tile per phase */}
          {phaseTiles.map(({ phase, count, value }) => {
            const active = filterPhase === phase;
            return (
              <button
                key={phase}
                onClick={() => setFilterPhase(active ? 'All' : phase)}
                style={{
                  flex: '1 1 130px', padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
                  textAlign: 'left', border: `2px solid ${active ? '#2563eb' : '#e5e7eb'}`,
                  background: active ? '#eff6ff' : '#fff',
                  boxShadow: active ? '0 0 0 1px #2563eb22' : 'none',
                  transition: 'all 0.12s',
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 700, color: active ? '#2563eb' : '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{phase}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: active ? '#1d4ed8' : '#1f2937', lineHeight: 1 }}>{count}</div>
                <div style={{ fontSize: 11, color: active ? '#3b82f6' : '#6b7280', marginTop: 3 }}>{fmt$(value)}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Sticky filter bar ── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: '#f8fafc',
        borderBottom: '1px solid #e5e7eb',
        padding: '10px 28px',
        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
      }}>
        {/* Salesperson */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Salesperson:</label>
          <select value={filterSalesperson} onChange={e => setFilterSalesperson(e.target.value)} style={SELECT_STYLE(filterSalesperson !== 'All')}>
            <option value="All">All</option>
            {salespersonNames.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        {/* Sales Type */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Sales Type:</label>
          <select value={filterSalesType} onChange={e => setFilterSalesType(e.target.value)} style={SELECT_STYLE(filterSalesType !== 'All')}>
            <option value="All">All</option>
            {sales_types.map(st => <option key={st} value={st}>{st}</option>)}
          </select>
        </div>

        {/* Start Year */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Start Year:</label>
          <select value={filterStartYear} onChange={e => setFilterStartYear(e.target.value)} style={SELECT_STYLE(filterStartYear !== 'All')}>
            <option value="All">All</option>
            {['2024', '2025', '2026', '2027'].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {/* Contract / Work Order toggle */}
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

        {/* Group by 3-way toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Group by:</label>
          <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
            {([['salesperson', 'Salesperson'], ['status', 'Status'], ['flat', 'None']] as const).map(([val, label], i) => (
              <button key={val} onClick={() => setGroupBy(val)} style={{
                padding: '5px 12px', fontSize: 12, border: 'none', cursor: 'pointer',
                fontWeight: groupBy === val ? 700 : 400,
                background: groupBy === val ? '#2563eb' : '#fff',
                color:      groupBy === val ? '#fff' : '#6b7280',
                borderRight: i < 2 ? '1px solid #e5e7eb' : 'none',
              }}>{label}</button>
            ))}
          </div>
        </div>

        <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>{visibleCount} showing</span>
      </div>

      {/* Content — grouped by salesperson / status / flat */}
      <div style={{ padding: '16px 28px 28px' }}>
        {groupBy === 'salesperson' && (
          visibleSalespeople.map(sp => (
            <SalespersonSection key={sp.name} sp={sp} matchesFilters={matchesFilters} />
          ))
        )}

        {groupBy === 'status' && (() => {
          // Flatten all visible opps with salesperson attached, then group by status
          const allOpps = visibleSalespeople.flatMap(sp =>
            sp.stages.flatMap(st =>
              st.opportunities.filter(matchesFilters).map(o => ({ ...o, salesperson: sp.name }))
            )
          );
          // Collect unique statuses in phase order
          const statuses = [...new Set(allOpps.map(o => o.status))].sort(phaseSort);
          return statuses.map(status => (
            <StatusSection
              key={status}
              status={status}
              opps={allOpps.filter(o => o.status === status)}
            />
          ));
        })()}

        {groupBy === 'flat' && (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
            <OppTable
              showSalesperson
              opps={visibleSalespeople.flatMap(sp =>
                sp.stages.flatMap(st =>
                  st.opportunities.filter(matchesFilters).map(o => ({ ...o, salesperson: sp.name }))
                )
              )}
            />
          </div>
        )}
      </div>

    </div>
  );
}
