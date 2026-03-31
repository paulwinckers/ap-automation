/**
 * Construction Division Dashboard
 * Default: completed jobs only (actuals).
 * Toggle: include projected (adds Won/In-Progress estimated numbers).
 * Route: /construction
 */

import React, { useEffect, useState } from 'react';
import {
  getConstructionDashboard,
  getJobTickets,
  ConstructionDashboardData,
  DivisionTotals,
  ConstructionJob,
  WorkTicket,
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

function fmtHrs(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n.toFixed(1)} h`;
}

function progressColor(pct: number): string {
  if (pct >= 75) return '#22c55e';
  if (pct >= 40) return '#f59e0b';
  return '#ef4444';
}

function isComplete(job: ConstructionJob): boolean {
  // In Aspire, OpportunityStatusName stays "Won" even after work is done.
  // JobStatusName is what changes to "Complete" when work is finished.
  return (job.JobStatusName || '').toLowerCase().includes('complete');
}

function statusColor(job: ConstructionJob): { bg: string; text: string } {
  if (isComplete(job))                                                        return { bg: '#dcfce7', text: '#166534' };
  const s = (job.OpportunityStatusName || '').toLowerCase();
  if (s.includes('progress') || s.includes('won'))                           return { bg: '#dbeafe', text: '#1e40af' };
  if (s.includes('cancel') || s.includes('lost'))                            return { bg: '#fee2e2', text: '#991b1b' };
  return { bg: '#f3f4f6', text: '#374151' };
}

// ── Two-tone progress bar ─────────────────────────────────────────────────────
// solidValue = completed actuals  (solid fill)
// projectedValue = in-progress estimated (lighter striped fill)

function DualProgressBar({
  label,
  solidValue,
  projectedValue,
  target,
  showProjected,
  subtitle,
}: {
  label: string;
  solidValue: number;
  projectedValue: number;
  target: number;
  showProjected: boolean;
  subtitle?: string;
}) {
  const solidPct     = Math.min((solidValue / target) * 100, 100);
  const combinedPct  = Math.min(((solidValue + projectedValue) / target) * 100, 100);
  const projPct      = Math.max(combinedPct - solidPct, 0);
  const color        = progressColor(showProjected ? combinedPct : solidPct);

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
        {/* Solid: completed actuals */}
        <div style={{
          width: `${solidPct}%`,
          height: '100%',
          background: `linear-gradient(90deg, ${color}cc, ${color})`,
          borderRadius: projPct > 0 ? '999px 0 0 999px' : 999,
          transition: 'width 0.8s ease',
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          paddingRight: solidPct > 8 ? 6 : 0,
          flexShrink: 0,
        }}>
          {solidPct > 12 && (
            <span style={{ color: '#fff', fontSize: 11, fontWeight: 700 }}>
              {solidPct.toFixed(1)}%
            </span>
          )}
        </div>
        {/* Striped: projected */}
        {showProjected && projPct > 0 && (
          <div style={{
            width: `${projPct}%`,
            height: '100%',
            background: `repeating-linear-gradient(
              45deg,
              #93c5fd44,
              #93c5fd44 6px,
              #bfdbfe88 6px,
              #bfdbfe88 12px
            )`,
            borderRadius: '0 999px 999px 0',
            transition: 'width 0.8s ease',
            flexShrink: 0,
          }} />
        )}
      </div>
      {subtitle && (
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{subtitle}</div>
      )}
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string | null }) {
  const { bg, text } = statusColor(status);
  return (
    <span style={{
      background: bg, color: text,
      padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>
      {status || '—'}
    </span>
  );
}

// ── Work tickets ──────────────────────────────────────────────────────────────

function WorkTicketsTable({ tickets, loading }: { tickets: WorkTicket[]; loading: boolean }) {
  if (loading) return <div style={{ padding: '12px 0', color: '#6b7280', fontSize: 13 }}>Loading work tickets...</div>;
  if (!tickets.length) return <div style={{ padding: '12px 0', color: '#9ca3af', fontSize: 13 }}>No work tickets found.</div>;
  return (
    <div style={{ overflowX: 'auto', marginTop: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            {['Ticket', 'Type', 'Status', 'Est Hrs', 'Act Hrs', 'Hrs Δ', 'Est Cost', 'Act Cost'].map(h => (
              <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#6b7280', fontWeight: 600, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tickets.map((t, i) => {
            const hrsDelta = (t.ActualLaborHours ?? 0) - (t.EstimatedLaborHours ?? 0);
            const deltaColor = hrsDelta > 0 ? '#ef4444' : hrsDelta < 0 ? '#22c55e' : '#6b7280';
            return (
              <tr key={t.WorkTicketID} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                <td style={{ padding: '6px 10px', fontWeight: 500 }}>{t.WorkTicketTitle || `Ticket #${t.WorkTicketID}`}</td>
                <td style={{ padding: '6px 10px', color: '#6b7280' }}>{t.WorkTicketType || '—'}</td>
                <td style={{ padding: '6px 10px' }}><StatusBadge status={t.WorkTicketStatusName} /></td>
                <td style={{ padding: '6px 10px' }}>{fmtHrs(t.EstimatedLaborHours)}</td>
                <td style={{ padding: '6px 10px' }}>{fmtHrs(t.ActualLaborHours)}</td>
                <td style={{ padding: '6px 10px', color: deltaColor, fontWeight: 600 }}>
                  {t.ActualLaborHours != null && t.EstimatedLaborHours != null
                    ? `${hrsDelta > 0 ? '+' : ''}${hrsDelta.toFixed(1)} h` : '—'}
                </td>
                <td style={{ padding: '6px 10px' }}>{fmt$(t.BudgetedCost)}</td>
                <td style={{ padding: '6px 10px' }}>{fmt$(t.ActualCost)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Job row ───────────────────────────────────────────────────────────────────

function JobRow({ job, index, showProjected }: { job: ConstructionJob; index: number; showProjected: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [tickets, setTickets] = useState<WorkTicket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketsLoaded, setTicketsLoaded] = useState(false);

  const complete = isComplete(job);

  // For completed jobs use actuals; for in-progress use estimates
  const revenue = complete
    ? (job.ActualEarnedRevenue ?? job.WonDollars ?? 0)
    : (job.EstimatedDollars ?? job.WonDollars ?? 0);
  const margin = complete
    ? (job.ActualGrossMarginDollars ?? 0)
    : (job.EstimatedGrossMarginDollars ?? 0);
  const marginPct = complete
    ? job.ActualGrossMarginPercent
    : job.EstimatedGrossMarginPercent;

  async function toggleExpand() {
    if (!expanded && !ticketsLoaded) {
      setTicketsLoading(true);
      try {
        const res = await getJobTickets(job.OpportunityID);
        setTickets(res.tickets);
        setTicketsLoaded(true);
      } catch { setTickets([]); setTicketsLoaded(true); }
      finally { setTicketsLoading(false); }
    }
    setExpanded(e => !e);
  }

  return (
    <>
      <tr
        onClick={toggleExpand}
        style={{ cursor: 'pointer', background: index % 2 === 0 ? '#fff' : '#f9fafb' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#eff6ff')}
        onMouseLeave={e => (e.currentTarget.style.background = index % 2 === 0 ? '#fff' : '#f9fafb')}
      >
        <td style={{ padding: '10px 12px', width: 32, color: '#6b7280', fontSize: 12 }}>
          <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'none' }}>▶</span>
        </td>
        <td style={{ padding: '10px 12px' }}>
          <a
            href={`https://cloud.youraspire.com/app/opportunities/details/${job.OpportunityID}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            style={{ fontWeight: 600, color: '#1e40af', fontSize: 14, textDecoration: 'none' }}
            onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
            onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
          >
            {job.OpportunityName || '(unnamed)'}
          </a>
          {job.PropertyName && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{job.PropertyName}</div>}
          {job.OperationsManagerContactName && <div style={{ fontSize: 12, color: '#9ca3af' }}>PM: {job.OperationsManagerContactName}</div>}
        </td>
        <td style={{ padding: '10px 12px' }}>
          <StatusBadge status={job.OpportunityStatusName} />
        </td>
        <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: 14 }}>{fmt$(job.WonDollars)}</td>
        <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: 14 }}>
          <div style={{ fontWeight: 600, color: complete ? '#374151' : '#2563eb' }}>{fmt$(revenue)}</div>
          {!complete && <div style={{ fontSize: 11, color: '#9ca3af' }}>projected</div>}
        </td>
        <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: 14 }}>
          <div style={{ fontWeight: 600, color: margin < 0 ? '#ef4444' : '#374151' }}>{fmt$(margin)}</div>
          {marginPct != null && <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmtPct(marginPct)}</div>}
        </td>
        <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: 13 }}>
          {job.EstimatedLaborHours != null || job.ActualLaborHours != null ? (
            <div>
              <span style={{ color: '#374151' }}>{fmtHrs(job.ActualLaborHours)}</span>
              <span style={{ color: '#9ca3af' }}> / {fmtHrs(job.EstimatedLaborHours)}</span>
              {job.ActualLaborHours != null && job.EstimatedLaborHours != null && (
                <div style={{
                  fontSize: 11, fontWeight: 600,
                  color: job.ActualLaborHours > job.EstimatedLaborHours ? '#ef4444' : '#22c55e',
                }}>
                  {job.ActualLaborHours > job.EstimatedLaborHours ? '+' : ''}
                  {(job.ActualLaborHours - job.EstimatedLaborHours).toFixed(1)} h
                </div>
              )}
            </div>
          ) : '—'}
        </td>
        <td style={{ padding: '10px 12px', textAlign: 'right' }}>
          {job.PercentComplete != null ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
              <div style={{ width: 60, height: 8, background: '#e5e7eb', borderRadius: 999, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(job.PercentComplete, 100)}%`, height: '100%', background: progressColor(job.PercentComplete), borderRadius: 999 }} />
              </div>
              <span style={{ fontSize: 12, color: '#6b7280', minWidth: 32 }}>{job.PercentComplete.toFixed(0)}%</span>
            </div>
          ) : '—'}
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: '#f0f9ff' }}>
          <td colSpan={8} style={{ padding: '0 12px 12px 40px' }}>
            <WorkTicketsTable tickets={tickets} loading={ticketsLoading} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export default function ConstructionDashboard() {
  const [data, setData] = useState<ConstructionDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showProjected, setShowProjected] = useState(false);
  const [year, setYear] = useState(2026);
  const [sortField, setSortField] = useState<'WonDollars' | 'ActualEarnedRevenue' | 'ActualGrossMarginDollars' | 'PercentComplete'>('WonDollars');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  useEffect(() => {
    setLoading(true);
    setData(null);
    setError(null);
    getConstructionDashboard(year)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [year]);

  function toggleSort(field: typeof sortField) {
    if (sortField === field) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortField(field); setSortDir('desc'); }
  }

  const visibleJobs = data
    ? data.jobs.filter(j => showProjected ? true : isComplete(j))
    : [];

  const sortedJobs = [...visibleJobs].sort((a, b) => {
    const av = (a[sortField] ?? 0) as number;
    const bv = (b[sortField] ?? 0) as number;
    return sortDir === 'desc' ? bv - av : av - bv;
  });

  // Totals to display
  const completed   = data?.completed;
  const in_progress = data?.in_progress;
  const projRevenue = showProjected ? (in_progress?.estimated_revenue ?? 0) : 0;
  const projMargin  = showProjected ? (in_progress?.estimated_gross_margin ?? 0) : 0;
  const solidRevenue = completed?.actual_earned_revenue ?? 0;
  const solidMargin  = completed?.actual_gross_margin ?? 0;

  const SortHeader = ({ label, field }: { label: string; field: typeof sortField }) => (
    <th onClick={() => toggleSort(field)} style={{
      padding: '10px 12px', textAlign: 'right', cursor: 'pointer',
      color: sortField === field ? '#2563eb' : '#6b7280',
      fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap',
      borderBottom: '2px solid #e5e7eb', userSelect: 'none',
    }}>
      {label} {sortField === field ? (sortDir === 'desc' ? '↓' : '↑') : ''}
    </th>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#f1f5f9', fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* Header */}
      <div style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)', padding: '24px 32px', color: '#fff', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: -0.5 }}>Construction Division</h1>
            <p style={{ margin: '4px 0 0', opacity: 0.8, fontSize: 14 }}>
              {year} Performance Dashboard
              {data && ` · ${data.completed.job_count} completed · ${data.in_progress.job_count} in progress`}
            </p>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Year picker */}
            <select
              value={year}
              onChange={e => setYear(Number(e.target.value))}
              style={{
                padding: '9px 14px', borderRadius: 999, border: 'none', cursor: 'pointer',
                fontWeight: 700, fontSize: 14, background: 'rgba(255,255,255,0.15)',
                color: '#fff', appearance: 'none', outline: 'none',
              }}
            >
              {[2024, 2025, 2026].map(y => (
                <option key={y} value={y} style={{ background: '#1e3a5f', color: '#fff' }}>{y}</option>
              ))}
            </select>

            {/* Toggle */}
            <button
              onClick={() => setShowProjected(p => !p)}
              style={{
                padding: '10px 20px', borderRadius: 999, border: 'none', cursor: 'pointer',
                fontWeight: 700, fontSize: 14, transition: 'all 0.2s',
                background: showProjected ? '#fff' : 'rgba(255,255,255,0.15)',
                color: showProjected ? '#2563eb' : '#fff',
                boxShadow: showProjected ? '0 2px 8px rgba(0,0,0,0.15)' : 'none',
              }}
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
                  In Progress (projected)
                </div>
              </div>
            )}

            {/* KPI Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, marginBottom: 28 }}>

              {/* Revenue */}
              <div style={{ background: '#fff', borderRadius: 16, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>Revenue Progress</div>
                <DualProgressBar
                  label="Revenue"
                  solidValue={solidRevenue}
                  projectedValue={projRevenue}
                  target={data.targets.revenue}
                  showProjected={showProjected}
                  subtitle={`Target: ${fmt$(data.targets.revenue)}`}
                />
                <div style={{ marginTop: 16, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Completed</div>
                    <div style={{ fontWeight: 700, fontSize: 16 }}>{fmt$(solidRevenue)}</div>
                  </div>
                  {showProjected && (
                    <div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>Projected</div>
                      <div style={{ fontWeight: 700, fontSize: 16, color: '#2563eb' }}>{fmt$(projRevenue)}</div>
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>To Target</div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: '#f59e0b' }}>
                      {fmt$(data.targets.revenue - solidRevenue - (showProjected ? projRevenue : 0))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Margin */}
              <div style={{ background: '#fff', borderRadius: 16, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>Margin Progress</div>
                <DualProgressBar
                  label="Gross Margin"
                  solidValue={solidMargin}
                  projectedValue={projMargin}
                  target={data.targets.margin}
                  showProjected={showProjected}
                  subtitle={`Target: ${fmt$(data.targets.margin)}`}
                />
                <div style={{ marginTop: 16, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Completed</div>
                    <div style={{ fontWeight: 700, fontSize: 16 }}>{fmt$(solidMargin)}</div>
                  </div>
                  {showProjected && (
                    <div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>Projected</div>
                      <div style={{ fontWeight: 700, fontSize: 16, color: '#2563eb' }}>{fmt$(projMargin)}</div>
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>To Target</div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: '#f59e0b' }}>
                      {fmt$(data.targets.margin - solidMargin - (showProjected ? projMargin : 0))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Summary card */}
              <div style={{ background: 'linear-gradient(135deg, #1e3a5f, #2563eb)', borderRadius: 16, padding: 24, color: '#fff', boxShadow: '0 2px 12px rgba(37,99,235,0.3)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 16 }}>Job Summary</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  {[
                    { label: 'Complete', value: data.completed.job_count },
                    { label: 'In Progress', value: data.in_progress.job_count },
                    { label: 'Total Jobs', value: data.completed.job_count + data.in_progress.job_count },
                    {
                      label: 'Avg Margin %',
                      value: (() => {
                        const jobs = data.jobs.filter(j => j.ActualGrossMarginPercent != null);
                        if (!jobs.length) return '—';
                        return `${(jobs.reduce((s, j) => s + (j.ActualGrossMarginPercent ?? 0), 0) / jobs.length).toFixed(1)}%`;
                      })(),
                    },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <div style={{ opacity: 0.65, fontSize: 12 }}>{label}</div>
                      <div style={{ fontWeight: 800, fontSize: 22 }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Jobs Table */}
            <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>
                  {showProjected ? 'All Jobs (Completed + In Progress)' : 'Completed Jobs'}
                  <span style={{ marginLeft: 8, fontSize: 13, fontWeight: 400, color: '#9ca3af' }}>
                    {sortedJobs.length} jobs
                  </span>
                </h2>
                <span style={{ fontSize: 12, color: '#9ca3af' }}>Click a row to expand work tickets</span>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      <th style={{ padding: '10px 12px', width: 32, borderBottom: '2px solid #e5e7eb' }} />
                      <th style={{ padding: '10px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 600, fontSize: 13, borderBottom: '2px solid #e5e7eb' }}>Job</th>
                      <th style={{ padding: '10px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 600, fontSize: 13, borderBottom: '2px solid #e5e7eb' }}>Status</th>
                      <SortHeader label="Contracted" field="WonDollars" />
                      <SortHeader label="Revenue" field="ActualEarnedRevenue" />
                      <SortHeader label="Margin" field="ActualGrossMarginDollars" />
                      <th style={{ padding: '10px 12px', textAlign: 'right', color: '#6b7280', fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', borderBottom: '2px solid #e5e7eb' }}>Est / Act Hrs</th>
                      <SortHeader label="% Complete" field="PercentComplete" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedJobs.length === 0 ? (
                      <tr><td colSpan={8} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No jobs found.</td></tr>
                    ) : (
                      sortedJobs.map((job, i) => (
                        <JobRow key={job.OpportunityID} job={job} index={i} showProjected={showProjected} />
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Footer totals */}
              {sortedJobs.length > 0 && (
                <div style={{ padding: '12px 20px', borderTop: '2px solid #e5e7eb', background: '#f8fafc', display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 13 }}>
                    <span style={{ color: '#6b7280' }}>Completed Revenue: </span>
                    <strong>{fmt$(solidRevenue)}</strong>
                  </div>
                  {showProjected && (
                    <div style={{ fontSize: 13 }}>
                      <span style={{ color: '#6b7280' }}>+ Projected: </span>
                      <strong style={{ color: '#2563eb' }}>{fmt$(projRevenue)}</strong>
                    </div>
                  )}
                  <div style={{ fontSize: 13 }}>
                    <span style={{ color: '#6b7280' }}>Completed Margin: </span>
                    <strong style={{ color: progressColor((solidMargin / data.targets.margin) * 100) }}>{fmt$(solidMargin)}</strong>
                  </div>
                  {showProjected && (
                    <div style={{ fontSize: 13 }}>
                      <span style={{ color: '#6b7280' }}>+ Projected Margin: </span>
                      <strong style={{ color: '#2563eb' }}>{fmt$(projMargin)}</strong>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
