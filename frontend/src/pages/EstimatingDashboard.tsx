/**
 * Estimating Dashboard
 * Shows all open (non-Won, non-Lost) opportunities grouped by salesperson → stage.
 * Route: /dashboards/estimating
 */

import React, { useEffect, useState } from 'react';
import {
  getEstimatingDashboard,
  EstimatingDashboardData,
  EstimatingOpp,
  EstimatingSalesperson,
} from '../lib/api';

// ── Colour tokens ─────────────────────────────────────────────────────────────

const C = {
  overdue: '#dc2626',
  urgent:  '#ea580c',
  soon:    '#d97706',
  ok:      '#16a34a',
  noDate:  '#9ca3af',
  blue:    '#2563eb',
  bg:      '#f8fafc',
  card:    '#ffffff',
  border:  '#e2e8f0',
  dark:    '#0f172a',
  muted:   '#64748b',
};

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
  } catch {
    return s;
  }
}

function urgencyColor(u: EstimatingOpp['urgency']): string {
  return u === 'overdue' ? C.overdue
       : u === 'urgent'  ? C.urgent
       : u === 'soon'    ? C.soon
       : u === 'ok'      ? C.ok
       : C.noDate;
}

function urgencyLabel(u: EstimatingOpp['urgency'], days: number | null): string {
  if (u === 'overdue') return `${Math.abs(days ?? 0)}d overdue`;
  if (u === 'urgent')  return `Due in ${days}d`;
  if (u === 'soon')    return `Due in ${days}d`;
  if (u === 'ok')      return `Due in ${days}d`;
  return 'No due date';
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({
  label, value, color,
}: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`, borderRadius: 8,
      padding: '18px 24px', flex: 1, minWidth: 160,
    }}>
      <div style={{ fontSize: 12, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: color ?? C.dark }}>
        {value}
      </div>
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  const isContract = type === 'Contract';
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
      padding: '2px 7px', borderRadius: 4,
      background: isContract ? '#dbeafe' : '#fef3c7',
      color:      isContract ? '#1d4ed8' : '#92400e',
      border:     `1px solid ${isContract ? '#bfdbfe' : '#fde68a'}`,
      flexShrink: 0,
    }}>
      {type || 'Unknown'}
    </span>
  );
}

function OppCard({ opp, visible }: { opp: EstimatingOpp; visible: boolean }) {
  const duColor  = urgencyColor(opp.urgency);
  const duLabel  = urgencyLabel(opp.urgency, opp.days_until_due);
  const isOverdue = opp.urgency === 'overdue';

  if (!visible) return null;

  return (
    <div style={{
      background: C.card,
      border: `1px solid ${isOverdue ? '#fecaca' : C.border}`,
      borderLeft: `3px solid ${duColor}`,
      borderRadius: 8,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      {/* Row 1: name + type badge */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, fontWeight: 600, fontSize: 14, color: C.dark, lineHeight: 1.3 }}>
          {opp.name}
        </div>
        <TypeBadge type={opp.opp_type} />
      </div>

      {/* Row 2: property + division tag */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {opp.property && (
          <span style={{ fontSize: 12, color: C.muted }}>{opp.property}</span>
        )}
        {opp.division && (
          <span style={{
            fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
            background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0',
            textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>
            {opp.division}
          </span>
        )}
        {opp.sales_type && (
          <span style={{
            fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
            background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0',
            textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>
            {opp.sales_type}
          </span>
        )}
      </div>

      {/* Row 3: value, due date, age */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginTop: 2 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: C.dark }}>
          {fmt$(opp.estimated_value)}
        </span>
        <span style={{
          fontSize: 12, fontWeight: 600, color: duColor,
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <span style={{
            display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
            background: duColor, flexShrink: 0,
          }} />
          {opp.due_date ? fmtDate(opp.due_date) : '—'}
          <span style={{ fontWeight: 400, color: duColor }}>({duLabel})</span>
        </span>
        <span style={{ fontSize: 11, color: C.muted, marginLeft: 'auto' }}>
          {opp.days_old}d old
        </span>
      </div>
    </div>
  );
}

function StageGroup({ stage, opportunities, filterType, filterSalesType }: {
  stage: string;
  opportunities: EstimatingOpp[];
  filterType: string;
  filterSalesType: string;
}) {
  const visible = opportunities.filter(o =>
    (filterType === 'All' || o.opp_type === filterType) &&
    (filterSalesType === 'All' || o.sales_type === filterSalesType)
  );
  if (visible.length === 0) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: C.muted,
        textTransform: 'uppercase', letterSpacing: '0.08em',
        marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span>{stage}</span>
        <span style={{
          background: '#e2e8f0', color: C.muted,
          borderRadius: 10, padding: '0 7px', fontSize: 10, fontWeight: 700,
        }}>
          {visible.length}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {visible.map(o => (
          <OppCard key={o.id} opp={o} visible />
        ))}
      </div>
    </div>
  );
}

function SalespersonSection({ sp, filterType, filterSalesType }: {
  sp: EstimatingSalesperson;
  filterType: string;
  filterSalesType: string;
}) {
  const [open, setOpen] = useState(true);

  // Count visible opps respecting filters
  const visibleCount = sp.stages.reduce((acc, st) =>
    acc + st.opportunities.filter(o =>
      (filterType === 'All' || o.opp_type === filterType) &&
      (filterSalesType === 'All' || o.sales_type === filterSalesType)
    ).length, 0
  );

  if (visibleCount === 0) return null;

  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`, borderRadius: 8,
      overflow: 'hidden', marginBottom: 16,
    }}>
      {/* Section header */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 18px', background: 'transparent', border: 'none',
          cursor: 'pointer', textAlign: 'left',
          borderBottom: open ? `1px solid ${C.border}` : 'none',
        }}
      >
        {/* Chevron */}
        <span style={{ color: C.muted, fontSize: 12, transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block' }}>
          ▶
        </span>
        <span style={{ fontWeight: 700, fontSize: 15, color: C.dark, flex: 1 }}>
          {sp.name}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {sp.overdue > 0 && (
            <span style={{
              background: '#fee2e2', color: C.overdue,
              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
            }}>
              {sp.overdue} overdue
            </span>
          )}
          <span style={{ fontSize: 13, color: C.muted }}>
            {visibleCount} opp{visibleCount !== 1 ? 's' : ''}
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.dark }}>
            {fmt$(sp.total_value)}
          </span>
        </div>
      </button>

      {/* Stages */}
      {open && (
        <div style={{ padding: '14px 18px' }}>
          {sp.stages.map(st => (
            <StageGroup
              key={st.stage}
              stage={st.stage}
              opportunities={st.opportunities}
              filterType={filterType}
              filterSalesType={filterSalesType}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function EstimatingDashboard() {
  const [data, setData]               = useState<EstimatingDashboardData | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [filterSalesType, setFilterSalesType] = useState('All');
  const [filterType, setFilterType]   = useState('All'); // 'All' | 'Contract' | 'Work Order'

  useEffect(() => {
    setLoading(true);
    setError(null);
    getEstimatingDashboard()
      .then(setData)
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  // ── Loading ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', flexDirection: 'column', gap: 12 }}>
        <div style={{ width: 36, height: 36, border: '3px solid #e2e8f0', borderTopColor: C.blue, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <span style={{ color: C.muted, fontSize: 14 }}>Loading estimating data…</span>
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (error || !data) {
    return (
      <div style={{ padding: 32 }}>
        <div style={{
          background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
          padding: '16px 20px', color: C.overdue, fontWeight: 600,
        }}>
          Failed to load estimating dashboard: {error ?? 'Unknown error'}
        </div>
      </div>
    );
  }

  const { summary, sales_types, salespeople } = data;

  return (
    <div style={{ padding: '28px 32px', background: C.bg, minHeight: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>

      {/* ── Page header ─────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.dark, letterSpacing: '-0.5px' }}>
          📋 Estimating Pipeline
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: C.muted }}>
          Open opportunities by salesperson · excludes Won &amp; Lost
        </p>
      </div>

      {/* ── Summary bar ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
        <SummaryCard label="Total Opportunities" value={summary.total} />
        <SummaryCard label="Total Est. Value"    value={fmt$(summary.total_value)} />
        <SummaryCard label="Overdue"             value={summary.overdue}       color={summary.overdue > 0 ? C.overdue : C.ok} />
        <SummaryCard label="Due This Week"       value={summary.due_this_week} color={summary.due_this_week > 0 ? C.urgent : C.ok} />
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24, alignItems: 'center' }}>

        {/* Sales type dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: C.muted }}>Sales Type:</label>
          <select
            value={filterSalesType}
            onChange={e => setFilterSalesType(e.target.value)}
            style={{
              fontSize: 13, padding: '6px 10px', borderRadius: 6,
              border: `1px solid ${C.border}`, background: C.card, color: C.dark,
              cursor: 'pointer',
            }}
          >
            <option value="All">All</option>
            {sales_types.map(st => (
              <option key={st} value={st}>{st}</option>
            ))}
          </select>
        </div>

        {/* Contract / Work Order toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: C.muted }}>Type:</label>
          <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: `1px solid ${C.border}` }}>
            {(['All', 'Contract', 'Work Order'] as const).map(opt => (
              <button
                key={opt}
                onClick={() => setFilterType(opt)}
                style={{
                  padding: '6px 14px', fontSize: 13, border: 'none',
                  cursor: 'pointer', fontWeight: filterType === opt ? 700 : 400,
                  background: filterType === opt ? C.blue : C.card,
                  color:      filterType === opt ? '#fff' : C.muted,
                  transition: 'background 0.15s, color 0.15s',
                  borderRight: opt !== 'Work Order' ? `1px solid ${C.border}` : 'none',
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>

        {/* Visible count */}
        <span style={{ fontSize: 12, color: C.muted, marginLeft: 4 }}>
          {salespeople.reduce((acc, sp) =>
            acc + sp.stages.reduce((a2, st) =>
              a2 + st.opportunities.filter(o =>
                (filterType === 'All' || o.opp_type === filterType) &&
                (filterSalesType === 'All' || o.sales_type === filterSalesType)
              ).length, 0), 0
          )} opportunities shown
        </span>
      </div>

      {/* ── Salespeople ─────────────────────────────────────────────────────── */}
      <div>
        {salespeople.map(sp => (
          <SalespersonSection
            key={sp.name}
            sp={sp}
            filterType={filterType}
            filterSalesType={filterSalesType}
          />
        ))}
      </div>

    </div>
  );
}
