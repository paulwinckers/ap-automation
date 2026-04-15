/**
 * Construction Division Dashboard
 * Three sections: Completed, In Production, In Queue
 * Route: /construction
 */

import React, { useEffect, useState } from 'react';
import {
  getConstructionDashboard,
  ConstructionDashboardData,
  ConstructionJob,
} from '../lib/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n.toFixed(1)}%`;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return s;
  }
}

function progressColor(pct: number): string {
  if (pct >= 75) return '#22c55e';
  if (pct >= 40) return '#f59e0b';
  return '#ef4444';
}

// ── Margin indicator ──────────────────────────────────────────────────────────

const MARGIN_GOOD_PCT = 35;

function MarginDot({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return <span style={{ color: '#9ca3af' }}>—</span>;
  const ok = pct >= MARGIN_GOOD_PCT;
  const color = ok ? '#16a34a' : '#dc2626';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ color, fontWeight: 700 }}>{fmtPct(pct)}</span>
    </span>
  );
}

// ── Two-tone progress bar ─────────────────────────────────────────────────────

function DualProgressBar({
  label, solidValue, projectedValue, target, showProjected, subtitle,
}: {
  label: string;
  solidValue: number;
  projectedValue: number;
  target: number;
  showProjected: boolean;
  subtitle?: string;
}) {
  const solidPct    = Math.min((solidValue / target) * 100, 100);
  const combinedPct = Math.min(((solidValue + projectedValue) / target) * 100, 100);
  const projPct     = Math.max(combinedPct - solidPct, 0);
  const color       = progressColor(showProjected ? combinedPct : solidPct);

  return (
    <div style={{ flex: 1, minWidth: 260 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: '#1f2937' }}>{label}</span>
        <span style={{ fontWeight: 700, fontSize: 15, color }}>
          {fmt$(solidValue)}
          {showProjected && projectedValue > 0 && (
            <span style={{ color: '#93c5fd', fontWeight: 500 }}> +{fmt$(projectedValue)}</span>
          )}
          <span style={{ color: '#9ca3af', fontWeight: 400 }}> / {fmt$(target)}</span>
        </span>
      </div>
      <div style={{
        background: '#e5e7eb', borderRadius: 999, height: 22, overflow: 'hidden',
        boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.12)', display: 'flex',
      }}>
        <div style={{
          width: `${solidPct}%`, height: '100%',
          background: `linear-gradient(90deg, ${color}cc, ${color})`,
          borderRadius: projPct > 0 ? '999px 0 0 999px' : 999,
          transition: 'width 0.8s ease',
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          paddingRight: solidPct > 8 ? 6 : 0, flexShrink: 0,
        }}>
          {solidPct > 12 && (
            <span style={{ color: '#fff', fontSize: 11, fontWeight: 700 }}>{solidPct.toFixed(1)}%</span>
          )}
        </div>
        {showProjected && projPct > 0 && (
          <div style={{
            width: `${projPct}%`, height: '100%',
            background: 'repeating-linear-gradient(45deg,#93c5fd44,#93c5fd44 6px,#bfdbfe88 6px,#bfdbfe88 12px)',
            borderRadius: '0 999px 999px 0', transition: 'width 0.8s ease', flexShrink: 0,
          }} />
        )}
      </div>
      {subtitle && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{subtitle}</div>}
    </div>
  );
}

// ── Collapsible section wrapper ───────────────────────────────────────────────

function Section({ title, count, accent, children }: {
  title: string;
  count: number;
  accent: string;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div style={{
      background: '#fff', borderRadius: 16,
      boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
      border: `1px solid #e5e7eb`,
      borderTop: `3px solid ${accent}`,
      overflow: 'hidden', marginBottom: 20,
    }}>
      <div
        onClick={() => setCollapsed(c => !c)}
        style={{
          padding: '14px 20px',
          borderBottom: collapsed ? 'none' : '1px solid #e5e7eb',
          display: 'flex', alignItems: 'center', gap: 12,
          cursor: 'pointer', background: '#fafafa',
        }}
      >
        <span style={{
          fontSize: 12, color: '#6b7280',
          transform: collapsed ? 'rotate(-90deg)' : 'none',
          transition: 'transform 0.2s', display: 'inline-block',
        }}>▼</span>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#111827', flex: 1 }}>{title}</h2>
        <span style={{
          background: accent + '20', color: accent,
          padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700,
        }}>
          {count} {count === 1 ? 'job' : 'jobs'}
        </span>
      </div>
      {!collapsed && children}
    </div>
  );
}

// ── Shared table primitives ───────────────────────────────────────────────────

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th style={{
      padding: '7px 12px', textAlign: align,
      color: '#6b7280', fontWeight: 600, fontSize: 11,
      borderBottom: '2px solid #e5e7eb', whiteSpace: 'nowrap',
      background: '#f8fafc', textTransform: 'uppercase', letterSpacing: 0.4,
    }}>
      {children}
    </th>
  );
}

function Td({ children, align = 'left', muted, bold, style: extra }: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  muted?: boolean;
  bold?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <td style={{
      padding: '6px 12px', textAlign: align, fontSize: 13,
      color: muted ? '#6b7280' : undefined,
      fontWeight: bold ? 600 : undefined,
      borderBottom: '1px solid #f3f4f6',
      ...extra,
    }}>
      {children}
    </td>
  );
}

function FooterTd({ children, align = 'left', colSpan }: { children: React.ReactNode; align?: 'left' | 'right'; colSpan?: number }) {
  return (
    <td colSpan={colSpan} style={{ padding: '7px 12px', textAlign: align, fontWeight: 700, fontSize: 12, color: '#374151' }}>
      {children}
    </td>
  );
}

// ── Job name cell (shared across all sections) ────────────────────────────────

function JobNameCell({ job }: { job: ConstructionJob }) {
  const display = job.PropertyName || job.OpportunityName || '(unnamed)';
  const sub     = job.PropertyName ? job.OpportunityName : null;
  return (
    <Td>
      <a
        href={`https://cloud.youraspire.com/app/opportunities/details/${job.OpportunityID}`}
        target="_blank"
        rel="noopener noreferrer"
        style={{ fontWeight: 600, color: '#1e40af', fontSize: 13, textDecoration: 'none', display: 'block' }}
        onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
        onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
      >
        {display}
      </a>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{sub}</div>}
    </Td>
  );
}

function fmtHrs(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n.toFixed(1)}h`;
}

// ── Sortable column header ────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc';

function SortTh({
  children, field, sortField, sortDir, onSort, align = 'right',
}: {
  children: React.ReactNode;
  field: string;
  sortField: string;
  sortDir: SortDir;
  onSort: (f: string) => void;
  align?: 'left' | 'right';
}) {
  const active = sortField === field;
  return (
    <th
      onClick={() => onSort(field)}
      style={{
        padding: '7px 12px', textAlign: align, cursor: 'pointer',
        color: active ? '#2563eb' : '#6b7280',
        fontWeight: 600, fontSize: 11, borderBottom: '2px solid #e5e7eb',
        whiteSpace: 'nowrap', background: '#f8fafc',
        textTransform: 'uppercase', letterSpacing: 0.4,
        userSelect: 'none',
      }}
    >
      {children}{active ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>
  );
}

function useSorted(jobs: ConstructionJob[], defaultField: string) {
  const [sortField, setSortField] = useState(defaultField);
  const [sortDir, setSortDir]     = useState<SortDir>('desc');

  function onSort(field: string) {
    if (field === sortField) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortField(field); setSortDir('desc'); }
  }

  const sorted = [...jobs].sort((a, b) => {
    const av = (a as unknown as Record<string, unknown>)[sortField];
    const bv = (b as unknown as Record<string, unknown>)[sortField];
    // String sort (dates, names)
    if (typeof av === 'string' || typeof bv === 'string') {
      const as = (av as string) ?? '';
      const bs = (bv as string) ?? '';
      return sortDir === 'desc' ? bs.localeCompare(as) : as.localeCompare(bs);
    }
    // Numeric sort
    const an = (av as number) ?? (sortDir === 'desc' ? -Infinity : Infinity);
    const bn = (bv as number) ?? (sortDir === 'desc' ? -Infinity : Infinity);
    return sortDir === 'desc' ? bn - an : an - bn;
  });

  return { sorted, sortField, sortDir, onSort };
}

// ── Change-order roll-up badge ────────────────────────────────────────────────

function ContractedCell({ job }: { job: ConstructionJob }) {
  return (
    <Td align="right">
      <span style={{ fontWeight: 400, color: '#6b7280' }}>{fmt$(job.WonDollars)}</span>
      {job.change_order_count != null && job.change_order_count > 0 && (
        <div style={{ fontSize: 11, color: '#7c3aed', marginTop: 2, whiteSpace: 'nowrap' }}>
          +{fmt$(job.change_order_total)} CO ({job.change_order_count})
        </div>
      )}
    </Td>
  );
}

function HoursCell({ actual, estimated }: { actual: number | null | undefined; estimated: number | null | undefined }) {
  const over = (actual ?? 0) > (estimated ?? 0) && estimated != null && actual != null;
  return (
    <Td align="right">
      <span style={{ color: actual != null ? (over ? '#dc2626' : '#374151') : '#9ca3af' }}>
        {fmtHrs(actual)}
      </span>
      <span style={{ color: '#9ca3af' }}> / {fmtHrs(estimated)}</span>
    </Td>
  );
}

// ── Completed jobs table ──────────────────────────────────────────────────────

function CompletedTable({ jobs }: { jobs: ConstructionJob[] }) {
  const { sorted, sortField, sortDir, onSort } = useSorted(jobs, 'WonDollars');
  if (!jobs.length) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No completed jobs this year.</div>;
  }
  const totalRevenue  = jobs.reduce((s, j) => s + (j.ActualEarnedRevenue ?? 0), 0);
  const totalMargin   = jobs.reduce((s, j) => s + (j.ActualGrossMarginDollars ?? 0), 0);
  const totalContract = jobs.reduce((s, j) => s + (j.WonDollars ?? 0), 0);
  const sp = { sortField, sortDir, onSort };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <SortTh field="PropertyName"              align="left"  {...sp}>Job</SortTh>
            <SortTh field="WonDollars"                             {...sp}>Contracted</SortTh>
            <SortTh field="ActualEarnedRevenue"                    {...sp}>Revenue</SortTh>
            <SortTh field="ActualGrossMarginDollars"               {...sp}>Margin $</SortTh>
            <SortTh field="ActualGrossMarginPercent"               {...sp}>Margin %</SortTh>
            <SortTh field="ActualLaborHours"                       {...sp}>Act / Est Hrs</SortTh>
            <SortTh field="CompleteDate"                           {...sp}>Completed</SortTh>
          </tr>
        </thead>
        <tbody>
          {sorted.map((job, i) => (
            <tr key={job.OpportunityID} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
              <JobNameCell job={job} />
              <ContractedCell job={job} />
              <Td align="right" bold>{fmt$(job.ActualEarnedRevenue)}</Td>
              <Td align="right" bold style={{ color: (job.ActualGrossMarginDollars ?? 0) < 0 ? '#dc2626' : '#374151' }}>
                {fmt$(job.ActualGrossMarginDollars)}
              </Td>
              <Td align="right"><MarginDot pct={job.ActualGrossMarginPercent} /></Td>
              <HoursCell actual={job.ActualLaborHours} estimated={job.EstimatedLaborHours} />
              <Td align="right" muted>{fmtDate(job.CompleteDate || job.EndDate)}</Td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ background: '#f8fafc', borderTop: '2px solid #e5e7eb' }}>
            <FooterTd>Total ({jobs.length})</FooterTd>
            <FooterTd align="right">{fmt$(totalContract)}</FooterTd>
            <FooterTd align="right">{fmt$(totalRevenue)}</FooterTd>
            <FooterTd align="right">{fmt$(totalMargin)}</FooterTd>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── In Production table ───────────────────────────────────────────────────────

function InProductionTable({ jobs }: { jobs: ConstructionJob[] }) {
  const { sorted, sortField, sortDir, onSort } = useSorted(jobs, 'WonDollars');
  if (!jobs.length) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No jobs currently in production.</div>;
  }
  const totalContract     = jobs.reduce((s, j) => s + (j.WonDollars ?? 0), 0);
  const totalActualRev    = jobs.reduce((s, j) => s + (j.ActualEarnedRevenue ?? 0), 0);
  const totalActualMargin = jobs.reduce((s, j) => s + (j.ActualGrossMarginDollars ?? 0), 0);
  const sp = { sortField, sortDir, onSort };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <SortTh field="PropertyName"              align="left"  {...sp}>Job</SortTh>
            <SortTh field="WonDollars"                             {...sp}>Contracted</SortTh>
            <SortTh field="ActualEarnedRevenue"                    {...sp}>Revenue (Act.)</SortTh>
            <SortTh field="ActualGrossMarginDollars"               {...sp}>Margin (Act.)</SortTh>
            <SortTh field="EstimatedGrossMarginPercent"            {...sp}>Est. Margin %</SortTh>
            <SortTh field="ActualLaborHours"                       {...sp}>Act / Est Hrs</SortTh>
            <SortTh field="EndDate"                                {...sp}>Est. End</SortTh>
          </tr>
        </thead>
        <tbody>
          {sorted.map((job, i) => (
            <tr key={job.OpportunityID} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
              <JobNameCell job={job} />
              <ContractedCell job={job} />
              <Td align="right" bold style={{ color: '#2563eb' }}>{fmt$(job.ActualEarnedRevenue)}</Td>
              <Td align="right" bold style={{ color: '#2563eb' }}>{fmt$(job.ActualGrossMarginDollars)}</Td>
              <Td align="right"><MarginDot pct={job.EstimatedGrossMarginPercent} /></Td>
              <HoursCell actual={job.ActualLaborHours} estimated={job.EstimatedLaborHours} />
              <Td align="right" muted>{fmtDate(job.EndDate)}</Td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ background: '#f8fafc', borderTop: '2px solid #e5e7eb' }}>
            <FooterTd>Total ({jobs.length})</FooterTd>
            <FooterTd align="right">{fmt$(totalContract)}</FooterTd>
            <FooterTd align="right">{fmt$(totalActualRev)}</FooterTd>
            <FooterTd align="right">{fmt$(totalActualMargin)}</FooterTd>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── In Queue table ────────────────────────────────────────────────────────────

function InQueueTable({ jobs }: { jobs: ConstructionJob[] }) {
  const { sorted, sortField, sortDir, onSort } = useSorted(jobs, 'StartDate');
  if (!jobs.length) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No jobs in queue.</div>;
  }
  const totalContract = jobs.reduce((s, j) => s + (j.WonDollars ?? 0), 0);
  const totalEstRev   = jobs.reduce((s, j) => s + (j.EstimatedDollars ?? 0), 0);
  const sp = { sortField, sortDir, onSort };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <SortTh field="PropertyName"                align="left"  {...sp}>Job</SortTh>
            <Th>Readiness</Th>
            <SortTh field="WonDollars"                               {...sp}>Contracted</SortTh>
            <SortTh field="EstimatedDollars"                         {...sp}>Est. Revenue</SortTh>
            <SortTh field="EstimatedGrossMarginPercent"              {...sp}>Est. Margin %</SortTh>
            <SortTh field="EstimatedLaborHours"                      {...sp}>Est. Hrs</SortTh>
            <SortTh field="StartDate"                                {...sp}>Start Date</SortTh>
          </tr>
        </thead>
        <tbody>
          {sorted.map((job, i) => (
            <tr key={job.OpportunityID} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
              <JobNameCell job={job} />
              {/* Readiness: tags-based indicator — to be wired up once tag field names confirmed */}
              <Td><span style={{ color: '#9ca3af', fontSize: 12 }}>—</span></Td>
              <ContractedCell job={job} />
              <Td align="right" muted>{fmt$(job.EstimatedDollars)}</Td>
              <Td align="right"><MarginDot pct={job.EstimatedGrossMarginPercent} /></Td>
              <Td align="right" muted>{fmtHrs(job.EstimatedLaborHours)}</Td>
              <Td align="right" muted>{fmtDate(job.StartDate)}</Td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ background: '#f8fafc', borderTop: '2px solid #e5e7eb' }}>
            <FooterTd colSpan={2} align="left">Total ({jobs.length})</FooterTd>
            <FooterTd align="right">{fmt$(totalContract)}</FooterTd>
            <FooterTd align="right">{fmt$(totalEstRev)}</FooterTd>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export default function ConstructionDashboard() {
  const [data, setData]               = useState<ConstructionDashboardData | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [showProjected, setShowProjected] = useState(false);
  const [year, setYear]               = useState(2026);
  const [search, setSearch]           = useState('');

  useEffect(() => {
    setLoading(true);
    setData(null);
    setError(null);
    getConstructionDashboard(year)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [year]);

  const q = search.trim().toLowerCase();
  function filterJobs(jobs: ConstructionJob[]) {
    if (!q) return jobs;
    return jobs.filter(j =>
      (j.PropertyName   || '').toLowerCase().includes(q) ||
      (j.OpportunityName || '').toLowerCase().includes(q) ||
      (j.OperationsManagerContactName || '').toLowerCase().includes(q)
    );
  }

  const completedJobs    = filterJobs(data?.completed_jobs    ?? []);
  const inProductionJobs = filterJobs(data?.in_production_jobs ?? []);
  const inQueueJobs      = filterJobs(data?.in_queue_jobs      ?? []);

  const solidRevenue = data?.completed.actual_earned_revenue ?? 0;
  const solidMargin  = data?.completed.actual_gross_margin   ?? 0;
  const projRevenue  = showProjected
    ? (data?.in_production.estimated_revenue ?? 0) + (data?.in_queue.estimated_revenue ?? 0)
    : 0;
  const projMargin   = showProjected
    ? (data?.in_production.estimated_gross_margin ?? 0) + (data?.in_queue.estimated_gross_margin ?? 0)
    : 0;

  const totalJobs =
    (data?.completed.job_count    ?? 0) +
    (data?.in_production.job_count ?? 0) +
    (data?.in_queue.job_count      ?? 0);

  return (
    <div style={{ minHeight: '100vh', background: '#f1f5f9', fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* Header */}
      <div style={{ background: '#1e3a2f', padding: '20px 32px', color: '#fff', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <img src="/darios-logo.png" alt="Dario's" style={{ height: 40, filter: 'brightness(0) invert(1)' }} />
            <div>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>Construction Division</h1>
              <p style={{ margin: '2px 0 0', opacity: 0.7, fontSize: 13 }}>
                {year} Performance Dashboard
                {data && ` · ${totalJobs} jobs`}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={year}
              onChange={e => setYear(Number(e.target.value))}
              style={{ padding: '9px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 14, background: 'rgba(255,255,255,0.15)', color: '#fff', appearance: 'none', outline: 'none' }}
            >
              {[2025, 2026].map(y => (
                <option key={y} value={y} style={{ background: '#1e3a5f', color: '#fff' }}>{y}</option>
              ))}
            </select>
            <button
              onClick={() => setShowProjected(p => !p)}
              style={{ padding: '10px 20px', borderRadius: 999, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 14, transition: 'all 0.2s', background: showProjected ? '#fff' : 'rgba(255,255,255,0.15)', color: showProjected ? '#166534' : '#fff', boxShadow: showProjected ? '0 2px 8px rgba(0,0,0,0.15)' : 'none' }}
            >
              {showProjected ? '✓ Including Projected' : '+ Include Projected'}
            </button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px' }}>

        {loading && (
          <div style={{ textAlign: 'center', padding: 60, color: '#6b7280', fontSize: 16 }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>⏳</div>
            Loading Construction data from Aspire...
          </div>
        )}

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: 24, color: '#991b1b', marginBottom: 24 }}>
            <strong>Unable to load dashboard:</strong> {error}
          </div>
        )}

        {data && (
          <>
            {/* Legend */}
            {showProjected && (
              <div style={{ display: 'flex', gap: 16, marginBottom: 16, fontSize: 13, color: '#6b7280', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 20, height: 10, borderRadius: 2, background: '#22c55e' }} />
                  Completed (actuals)
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 20, height: 10, borderRadius: 2, background: 'repeating-linear-gradient(45deg,#93c5fd44,#93c5fd44 4px,#bfdbfe88 4px,#bfdbfe88 8px)', border: '1px solid #bfdbfe' }} />
                  In Progress + Queue (projected)
                </div>
              </div>
            )}

            {/* KPI Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, marginBottom: 28 }}>

              {/* Revenue */}
              <div style={{ background: '#fff', borderRadius: 16, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>Revenue Progress</div>
                <DualProgressBar label="Revenue" solidValue={solidRevenue} projectedValue={projRevenue} target={data.targets.revenue} showProjected={showProjected} subtitle={`Target: ${fmt$(data.targets.revenue)}`} />
                <div style={{ marginTop: 16, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <div><div style={{ fontSize: 11, color: '#9ca3af' }}>Completed</div><div style={{ fontWeight: 700, fontSize: 16 }}>{fmt$(solidRevenue)}</div></div>
                  {showProjected && <div><div style={{ fontSize: 11, color: '#9ca3af' }}>Projected</div><div style={{ fontWeight: 700, fontSize: 16, color: '#2563eb' }}>{fmt$(projRevenue)}</div></div>}
                  <div><div style={{ fontSize: 11, color: '#9ca3af' }}>To Target</div><div style={{ fontWeight: 700, fontSize: 16, color: '#f59e0b' }}>{fmt$(data.targets.revenue - solidRevenue - (showProjected ? projRevenue : 0))}</div></div>
                </div>
              </div>

              {/* Margin */}
              <div style={{ background: '#fff', borderRadius: 16, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>Margin Progress</div>
                <DualProgressBar label="Gross Margin" solidValue={solidMargin} projectedValue={projMargin} target={data.targets.margin} showProjected={showProjected} subtitle={`Target: ${fmt$(data.targets.margin)}`} />
                <div style={{ marginTop: 16, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <div><div style={{ fontSize: 11, color: '#9ca3af' }}>Completed</div><div style={{ fontWeight: 700, fontSize: 16 }}>{fmt$(solidMargin)}</div></div>
                  {showProjected && <div><div style={{ fontSize: 11, color: '#9ca3af' }}>Projected</div><div style={{ fontWeight: 700, fontSize: 16, color: '#2563eb' }}>{fmt$(projMargin)}</div></div>}
                  <div><div style={{ fontSize: 11, color: '#9ca3af' }}>To Target</div><div style={{ fontWeight: 700, fontSize: 16, color: '#f59e0b' }}>{fmt$(data.targets.margin - solidMargin - (showProjected ? projMargin : 0))}</div></div>
                </div>
              </div>

              {/* Job Summary */}
              <div style={{ background: 'linear-gradient(135deg, #1e3a2f, #166534)', borderRadius: 16, padding: 24, color: '#fff', boxShadow: '0 2px 12px rgba(22,101,52,0.3)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 16 }}>Job Summary</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  {[
                    { label: 'Completed',     value: data.completed.job_count,     color: '#86efac' },
                    { label: 'In Production', value: data.in_production?.job_count ?? 0, color: '#93c5fd' },
                    { label: 'In Queue',      value: data.in_queue?.job_count      ?? 0, color: '#fcd34d' },
                    { label: 'Total',         value: totalJobs,                    color: '#fff' },
                  ].map(({ label, value, color }) => (
                    <div key={label}>
                      <div style={{ opacity: 0.65, fontSize: 12 }}>{label}</div>
                      <div style={{ fontWeight: 800, fontSize: 22, color }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Search bar */}
            <div style={{ position: 'relative', marginBottom: 20 }}>
              <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', fontSize: 16, color: '#9ca3af', pointerEvents: 'none' }}>🔍</span>
              <input
                type="text"
                placeholder="Search by property, job name, or PM…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '10px 14px 10px 40px',
                  borderRadius: 10, border: '1px solid #e5e7eb',
                  fontSize: 14, background: '#fff',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
                  outline: 'none',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = '#2563eb')}
                onBlur={e  => (e.currentTarget.style.borderColor = '#e5e7eb')}
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#9ca3af', lineHeight: 1 }}
                >✕</button>
              )}
            </div>

            {/* Three job sections */}
            <Section title="✅ Completed Jobs" count={completedJobs.length} accent="#16a34a">
              <CompletedTable jobs={completedJobs} />
            </Section>

            <Section title="🔨 In Production" count={inProductionJobs.length} accent="#2563eb">
              <InProductionTable jobs={inProductionJobs} />
            </Section>

            <Section title="📋 In Queue" count={inQueueJobs.length} accent="#f59e0b">
              <InQueueTable jobs={inQueueJobs} />
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
