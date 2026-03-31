/**
 * Construction Division Dashboard
 * Shows 2026 revenue & margin progress vs targets, with job-level
 * detail and expandable work tickets (est vs actual hours).
 * Route: /construction
 */

import React, { useEffect, useState } from 'react';
import {
  getConstructionDashboard,
  getJobTickets,
  ConstructionDashboard,
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
  if (pct >= 75) return '#22c55e';  // green
  if (pct >= 40) return '#f59e0b';  // amber
  return '#ef4444';                  // red
}

function statusColor(status: string | null): { bg: string; text: string } {
  const s = (status || '').toLowerCase();
  if (s.includes('complete') || s.includes('closed'))  return { bg: '#dcfce7', text: '#166534' };
  if (s.includes('progress') || s.includes('active'))  return { bg: '#dbeafe', text: '#1e40af' };
  if (s.includes('cancel') || s.includes('lost'))      return { bg: '#fee2e2', text: '#991b1b' };
  if (s.includes('won') || s.includes('approved'))     return { bg: '#ede9fe', text: '#4c1d95' };
  return { bg: '#f3f4f6', text: '#374151' };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ProgressBar({
  label, value, target, subtitle,
}: {
  label: string; value: number; target: number; subtitle?: string;
}) {
  const pct = Math.min((value / target) * 100, 100);
  const color = progressColor(pct);
  return (
    <div style={{ flex: 1, minWidth: 260 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: '#1f2937' }}>{label}</span>
        <span style={{ fontWeight: 700, fontSize: 15, color }}>
          {fmt$(value)} <span style={{ color: '#9ca3af', fontWeight: 400 }}>/ {fmt$(target)}</span>
        </span>
      </div>
      <div style={{
        background: '#e5e7eb', borderRadius: 999, height: 22, overflow: 'hidden',
        boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.12)',
      }}>
        <div style={{
          width: `${pct}%`,
          height: '100%',
          background: `linear-gradient(90deg, ${color}cc, ${color})`,
          borderRadius: 999,
          transition: 'width 0.8s ease',
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          paddingRight: pct > 8 ? 8 : 0,
        }}>
          {pct > 10 && (
            <span style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}>
              {pct.toFixed(1)}%
            </span>
          )}
        </div>
      </div>
      {subtitle && (
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{subtitle}</div>
      )}
    </div>
  );
}

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

function WorkTicketsTable({ tickets, loading }: { tickets: WorkTicket[]; loading: boolean }) {
  if (loading) {
    return (
      <div style={{ padding: '12px 0', color: '#6b7280', fontSize: 13 }}>
        Loading work tickets...
      </div>
    );
  }
  if (tickets.length === 0) {
    return <div style={{ padding: '12px 0', color: '#9ca3af', fontSize: 13 }}>No work tickets found.</div>;
  }
  return (
    <div style={{ overflowX: 'auto', marginTop: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            {['Ticket', 'Type', 'Status', 'Est Hrs', 'Act Hrs', 'Hrs Δ', 'Est Cost', 'Act Cost'].map(h => (
              <th key={h} style={{
                padding: '6px 10px', textAlign: 'left', color: '#6b7280',
                fontWeight: 600, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tickets.map((t, i) => {
            const hrsDelta = (t.ActualLaborHours ?? 0) - (t.EstimatedLaborHours ?? 0);
            const deltaColor = hrsDelta > 0 ? '#ef4444' : hrsDelta < 0 ? '#22c55e' : '#6b7280';
            return (
              <tr key={t.WorkTicketID} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                <td style={{ padding: '6px 10px', color: '#111827', fontWeight: 500 }}>
                  {t.WorkTicketTitle || `Ticket #${t.WorkTicketID}`}
                </td>
                <td style={{ padding: '6px 10px', color: '#6b7280' }}>{t.WorkTicketType || '—'}</td>
                <td style={{ padding: '6px 10px' }}><StatusBadge status={t.WorkTicketStatusName} /></td>
                <td style={{ padding: '6px 10px', color: '#374151' }}>{fmtHrs(t.EstimatedLaborHours)}</td>
                <td style={{ padding: '6px 10px', color: '#374151' }}>{fmtHrs(t.ActualLaborHours)}</td>
                <td style={{ padding: '6px 10px', color: deltaColor, fontWeight: 600 }}>
                  {t.ActualLaborHours != null && t.EstimatedLaborHours != null
                    ? `${hrsDelta > 0 ? '+' : ''}${hrsDelta.toFixed(1)} h`
                    : '—'}
                </td>
                <td style={{ padding: '6px 10px', color: '#374151' }}>{fmt$(t.BudgetedCost)}</td>
                <td style={{ padding: '6px 10px', color: '#374151' }}>{fmt$(t.ActualCost)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function JobRow({
  job, index,
}: {
  job: ConstructionJob;
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tickets, setTickets] = useState<WorkTicket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketsLoaded, setTicketsLoaded] = useState(false);

  async function toggleExpand() {
    if (!expanded && !ticketsLoaded) {
      setTicketsLoading(true);
      try {
        const res = await getJobTickets(job.OpportunityID);
        setTickets(res.tickets);
        setTicketsLoaded(true);
      } catch {
        setTickets([]);
        setTicketsLoaded(true);
      } finally {
        setTicketsLoading(false);
      }
    }
    setExpanded(e => !e);
  }

  const revenue = job.ActualEarnedRevenue ?? job.WonDollars ?? 0;
  const margin  = job.ActualGrossMarginDollars ?? 0;
  const marginPct = job.ActualGrossMarginPercent ?? job.EstimatedGrossMarginPercent;
  const estRevenue = job.EstimatedDollars ?? job.WonDollars;

  return (
    <>
      <tr
        style={{
          background: index % 2 === 0 ? '#fff' : '#f9fafb',
          cursor: 'pointer',
          transition: 'background 0.15s',
        }}
        onClick={toggleExpand}
        onMouseEnter={e => (e.currentTarget.style.background = '#eff6ff')}
        onMouseLeave={e => (e.currentTarget.style.background = index % 2 === 0 ? '#fff' : '#f9fafb')}
      >
        <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 13, width: 32 }}>
          <span style={{ fontSize: 12, transition: 'transform 0.2s', display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
            ▶
          </span>
        </td>
        <td style={{ padding: '10px 12px' }}>
          <div style={{ fontWeight: 600, color: '#111827', fontSize: 14 }}>
            {job.OpportunityName || '(unnamed)'}
          </div>
          {job.PropertyName && (
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{job.PropertyName}</div>
          )}
          {job.OperationsManagerContactName && (
            <div style={{ fontSize: 12, color: '#9ca3af' }}>PM: {job.OperationsManagerContactName}</div>
          )}
        </td>
        <td style={{ padding: '10px 12px' }}>
          <StatusBadge status={job.JobStatusName || job.OpportunityStatusName} />
        </td>
        <td style={{ padding: '10px 12px', color: '#374151', fontSize: 14, textAlign: 'right' }}>
          {fmt$(job.WonDollars)}
        </td>
        <td style={{ padding: '10px 12px', color: '#374151', fontSize: 14, textAlign: 'right' }}>
          <div style={{ fontWeight: 600 }}>{fmt$(revenue)}</div>
          {estRevenue && revenue !== estRevenue && (
            <div style={{ fontSize: 11, color: '#9ca3af' }}>est {fmt$(estRevenue)}</div>
          )}
        </td>
        <td style={{ padding: '10px 12px', fontSize: 14, textAlign: 'right' }}>
          <div style={{ color: margin < 0 ? '#ef4444' : '#374151', fontWeight: 600 }}>
            {fmt$(margin)}
          </div>
          {marginPct != null && (
            <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmtPct(marginPct)}</div>
          )}
        </td>
        <td style={{ padding: '10px 12px', textAlign: 'right' }}>
          {job.PercentComplete != null ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
              <div style={{ width: 60, height: 8, background: '#e5e7eb', borderRadius: 999, overflow: 'hidden' }}>
                <div style={{
                  width: `${Math.min(job.PercentComplete, 100)}%`,
                  height: '100%',
                  background: progressColor(job.PercentComplete),
                  borderRadius: 999,
                }} />
              </div>
              <span style={{ fontSize: 12, color: '#6b7280', minWidth: 32 }}>
                {job.PercentComplete.toFixed(0)}%
              </span>
            </div>
          ) : '—'}
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: '#f0f9ff' }}>
          <td colSpan={7} style={{ padding: '0 12px 12px 40px' }}>
            <WorkTicketsTable tickets={tickets} loading={ticketsLoading} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export default function ConstructionDashboard() {
  const [data, setData] = useState<ConstructionDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<'WonDollars' | 'ActualEarnedRevenue' | 'ActualGrossMarginDollars' | 'PercentComplete'>('WonDollars');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  useEffect(() => {
    getConstructionDashboard(2026)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function toggleSort(field: typeof sortField) {
    if (sortField === field) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortField(field); setSortDir('desc'); }
  }

  const sortedJobs = data ? [...data.jobs].sort((a, b) => {
    const av = (a[sortField] ?? 0) as number;
    const bv = (b[sortField] ?? 0) as number;
    return sortDir === 'desc' ? bv - av : av - bv;
  }) : [];

  const SortHeader = ({ label, field }: { label: string; field: typeof sortField }) => (
    <th
      onClick={() => toggleSort(field)}
      style={{
        padding: '10px 12px', textAlign: 'right', cursor: 'pointer',
        color: sortField === field ? '#2563eb' : '#6b7280',
        fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap',
        borderBottom: '2px solid #e5e7eb', userSelect: 'none',
      }}
    >
      {label} {sortField === field ? (sortDir === 'desc' ? '↓' : '↑') : ''}
    </th>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#f1f5f9', fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* Header */}
      <div style={{
        background: 'linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)',
        padding: '24px 32px', color: '#fff',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
      }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: -0.5 }}>
                Construction Division
              </h1>
              <p style={{ margin: '4px 0 0', opacity: 0.8, fontSize: 14 }}>
                2026 Performance Dashboard
                {data && ` · ${data.totals.job_count} jobs`}
              </p>
            </div>
            <div style={{ fontSize: 13, opacity: 0.7 }}>
              Powered by Aspire
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px' }}>

        {loading && (
          <div style={{
            textAlign: 'center', padding: 60, color: '#6b7280', fontSize: 16,
          }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>⏳</div>
            Loading Construction data from Aspire...
          </div>
        )}

        {error && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12,
            padding: 24, color: '#991b1b', marginBottom: 24,
          }}>
            <strong>Unable to load dashboard:</strong> {error}
          </div>
        )}

        {data && (
          <>
            {/* KPI Progress Cards */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 20, marginBottom: 28,
            }}>

              {/* Revenue card */}
              <div style={{
                background: '#fff', borderRadius: 16, padding: 24,
                boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '1px solid #e5e7eb',
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
                  Revenue Progress
                </div>
                <ProgressBar
                  label="Earned Revenue"
                  value={data.totals.actual_earned_revenue}
                  target={data.targets.revenue}
                  subtitle={`Contracted: ${fmt$(data.totals.won_dollars)} · Target: ${fmt$(data.targets.revenue)}`}
                />
                <div style={{ marginTop: 16, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Contracted</div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: '#1f2937' }}>{fmt$(data.totals.won_dollars)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Earned</div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: '#2563eb' }}>{fmt$(data.totals.actual_earned_revenue)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Remaining</div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: '#f59e0b' }}>
                      {fmt$(data.targets.revenue - data.totals.actual_earned_revenue)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Margin card */}
              <div style={{
                background: '#fff', borderRadius: 16, padding: 24,
                boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '1px solid #e5e7eb',
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
                  Margin Progress
                </div>
                <ProgressBar
                  label="Gross Margin"
                  value={data.totals.actual_gross_margin}
                  target={data.targets.margin}
                  subtitle={`Target: ${fmt$(data.targets.margin)} · Est: ${fmt$(data.totals.estimated_gross_margin)}`}
                />
                <div style={{ marginTop: 16, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Actual Margin</div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: '#1f2937' }}>{fmt$(data.totals.actual_gross_margin)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Est Margin</div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: '#6b7280' }}>{fmt$(data.totals.estimated_gross_margin)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>To Target</div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: '#f59e0b' }}>
                      {fmt$(data.targets.margin - data.totals.actual_gross_margin)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Jobs summary card */}
              <div style={{
                background: 'linear-gradient(135deg, #1e3a5f, #2563eb)', borderRadius: 16, padding: 24,
                boxShadow: '0 2px 12px rgba(37,99,235,0.3)', color: '#fff',
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 16 }}>
                  Job Summary
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  {[
                    { label: 'Total Jobs', value: data.totals.job_count },
                    {
                      label: 'Complete',
                      value: data.jobs.filter(j => (j.JobStatusName || j.OpportunityStatusName || '').toLowerCase().includes('complet')).length,
                    },
                    {
                      label: 'In Progress',
                      value: data.jobs.filter(j => (j.JobStatusName || j.OpportunityStatusName || '').toLowerCase().includes('progress')).length,
                    },
                    {
                      label: 'Avg Margin %',
                      value: (() => {
                        const withMargin = data.jobs.filter(j => j.ActualGrossMarginPercent != null);
                        if (!withMargin.length) return '—';
                        const avg = withMargin.reduce((s, j) => s + (j.ActualGrossMarginPercent ?? 0), 0) / withMargin.length;
                        return `${avg.toFixed(1)}%`;
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
            <div style={{
              background: '#fff', borderRadius: 16,
              boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '1px solid #e5e7eb',
              overflow: 'hidden',
            }}>
              <div style={{
                padding: '16px 20px', borderBottom: '1px solid #e5e7eb',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>
                  Jobs
                </h2>
                <span style={{ fontSize: 12, color: '#9ca3af' }}>
                  Click a row to expand work tickets
                </span>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      <th style={{ padding: '10px 12px', width: 32, borderBottom: '2px solid #e5e7eb' }} />
                      <th style={{
                        padding: '10px 12px', textAlign: 'left',
                        color: '#6b7280', fontWeight: 600, fontSize: 13,
                        borderBottom: '2px solid #e5e7eb',
                      }}>Job</th>
                      <th style={{
                        padding: '10px 12px', textAlign: 'left',
                        color: '#6b7280', fontWeight: 600, fontSize: 13,
                        borderBottom: '2px solid #e5e7eb',
                      }}>Status</th>
                      <SortHeader label="Contracted" field="WonDollars" />
                      <SortHeader label="Earned Revenue" field="ActualEarnedRevenue" />
                      <SortHeader label="Gross Margin" field="ActualGrossMarginDollars" />
                      <SortHeader label="% Complete" field="PercentComplete" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedJobs.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
                          No Construction jobs found for 2026.
                        </td>
                      </tr>
                    ) : (
                      sortedJobs.map((job, i) => (
                        <JobRow key={job.OpportunityID} job={job} index={i} />
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Table footer totals */}
              {sortedJobs.length > 0 && (
                <div style={{
                  padding: '12px 20px', borderTop: '2px solid #e5e7eb',
                  background: '#f8fafc', display: 'flex', gap: 32, flexWrap: 'wrap',
                }}>
                  <div style={{ fontSize: 13 }}>
                    <span style={{ color: '#6b7280' }}>Total Contracted: </span>
                    <strong>{fmt$(data.totals.won_dollars)}</strong>
                  </div>
                  <div style={{ fontSize: 13 }}>
                    <span style={{ color: '#6b7280' }}>Total Earned: </span>
                    <strong style={{ color: '#2563eb' }}>{fmt$(data.totals.actual_earned_revenue)}</strong>
                  </div>
                  <div style={{ fontSize: 13 }}>
                    <span style={{ color: '#6b7280' }}>Total Margin: </span>
                    <strong style={{ color: progressColor((data.totals.actual_gross_margin / data.targets.margin) * 100) }}>
                      {fmt$(data.totals.actual_gross_margin)}
                    </strong>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
