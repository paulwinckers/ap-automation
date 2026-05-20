/**
 * InvoiceSummaryReport — weekly progress report by service category.
 * Route: /ap/invoice-summary
 */

import React, { useState, useEffect, useRef } from 'react';

const API = import.meta.env.VITE_API_URL ?? 'https://ap-automation-production.up.railway.app';

// ── Types ──────────────────────────────────────────────────────────────────

interface OppResult {
  OpportunityID: number;
  OpportunityName: string;
  PropertyName?: string;
}

interface MaterialLine {
  receipt_id: number | null;
  vendor_name: string;
  invoice_number: string;
  invoice_date: string;
  amount: number;
  note: string;
  status: string;
}

interface Section {
  service_id: number;
  service_name: string;
  estimated_hours: number;
  hours_to_date: number;
  hours_this_week: number;
  hours_by_day: Record<string, number>;
  remaining_hours: number;
  materials: MaterialLine[];
  materials_total: number;
}

interface Totals {
  estimated_hours: number;
  hours_to_date: number;
  hours_this_week: number;
  remaining_hours: number;
  materials_total: number;
}

interface Report {
  opportunity_id: number;
  opportunity_name: string;
  property_name: string;
  week_start: string;
  week_end: string;
  week_days: string[];
  sections: Section[];
  totals: Totals;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getMostRecentMonday(): string {
  const d = new Date();
  const day = d.getDay(); // 0=Sun,1=Mon,...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function fmtHours(h: number): string {
  if (h === 0) return '—';
  return h.toFixed(1);
}

function fmtCAD(amount: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    minimumFractionDigits: 2,
  }).format(amount);
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function fmtDayHeader(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

function fmtWeekRange(start: string, end: string): string {
  const s = new Date(start + 'T12:00:00');
  const e = new Date(end + 'T12:00:00');
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
  return `${s.toLocaleDateString('en-CA', opts)} – ${e.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })}`;
}

// ── Styles ─────────────────────────────────────────────────────────────────

const DARK_GREEN = '#1e3a2f';
const BORDER     = '#e2e8f0';
const TH_BG      = '#f1f5f9';

const styles = {
  page: {
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    background: '#f8fafc',
    minHeight: '100vh',
    padding: '0 0 60px',
  } as React.CSSProperties,

  header: {
    background: DARK_GREEN,
    color: '#fff',
    padding: '18px 32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as React.CSSProperties,

  headerTitle: {
    fontSize: 20,
    fontWeight: 700,
    margin: 0,
  } as React.CSSProperties,

  headerSub: {
    fontSize: 13,
    color: '#a7c4b5',
    marginTop: 2,
  } as React.CSSProperties,

  printBtn: {
    background: 'rgba(255,255,255,0.15)',
    border: '1px solid rgba(255,255,255,0.3)',
    color: '#fff',
    borderRadius: 6,
    padding: '7px 16px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  } as React.CSSProperties,

  controls: {
    background: '#fff',
    borderBottom: `1px solid ${BORDER}`,
    padding: '16px 32px',
    display: 'flex',
    gap: 12,
    alignItems: 'flex-end',
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,

  label: {
    display: 'block',
    fontSize: 11,
    fontWeight: 600,
    color: '#64748b',
    marginBottom: 4,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  } as React.CSSProperties,

  input: {
    border: `1px solid ${BORDER}`,
    borderRadius: 6,
    padding: '8px 12px',
    fontSize: 14,
    width: 280,
    outline: 'none',
  } as React.CSSProperties,

  dateInput: {
    border: `1px solid ${BORDER}`,
    borderRadius: 6,
    padding: '8px 12px',
    fontSize: 14,
    outline: 'none',
  } as React.CSSProperties,

  genBtn: {
    background: DARK_GREEN,
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '9px 20px',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
    alignSelf: 'flex-end',
  } as React.CSSProperties,

  content: {
    maxWidth: 1100,
    margin: '0 auto',
    padding: '28px 24px',
  } as React.CSSProperties,

  infoCard: {
    background: '#fff',
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: '16px 24px',
    marginBottom: 24,
    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
  } as React.CSSProperties,

  infoRow: {
    display: 'flex',
    gap: 32,
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,

  infoField: {
    flex: 1,
    minWidth: 200,
  } as React.CSSProperties,

  infoFieldLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: '#94a3b8',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    marginBottom: 3,
  } as React.CSSProperties,

  infoFieldValue: {
    fontSize: 15,
    fontWeight: 600,
    color: '#1e293b',
  } as React.CSSProperties,

  sectionCard: (even: boolean) => ({
    background: even ? '#f8fafc' : '#fff',
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    marginBottom: 16,
    overflow: 'hidden',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  } as React.CSSProperties),

  sectionTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '12px 20px',
    background: '#fff',
    borderBottom: `1px solid ${BORDER}`,
  } as React.CSSProperties,

  sectionTitleAccent: {
    width: 4,
    height: 20,
    background: DARK_GREEN,
    borderRadius: 2,
    flexShrink: 0,
  } as React.CSSProperties,

  sectionTitleText: {
    fontSize: 14,
    fontWeight: 700,
    color: '#1e293b',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  } as React.CSSProperties,

  sectionBody: {
    padding: '16px 20px',
  } as React.CSSProperties,

  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 13,
  } as React.CSSProperties,

  th: {
    background: TH_BG,
    padding: '8px 12px',
    textAlign: 'center' as const,
    fontWeight: 700,
    color: '#475569',
    fontSize: 11,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    border: `1px solid ${BORDER}`,
  } as React.CSSProperties,

  td: {
    padding: '8px 12px',
    textAlign: 'center' as const,
    color: '#1e293b',
    border: `1px solid ${BORDER}`,
    fontSize: 14,
  } as React.CSSProperties,

  subHeading: {
    fontSize: 11,
    fontWeight: 700,
    color: '#64748b',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    margin: '16px 0 8px',
  } as React.CSSProperties,

  dayCell: {
    textAlign: 'center' as const,
    minWidth: 60,
  } as React.CSSProperties,

  dayLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: '#475569',
    textTransform: 'uppercase' as const,
  } as React.CSSProperties,

  dayDate: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 1,
  } as React.CSSProperties,

  dayHours: {
    fontSize: 14,
    fontWeight: 600,
    color: '#1e293b',
    marginTop: 4,
  } as React.CSSProperties,

  matTable: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 13,
    marginTop: 4,
  } as React.CSSProperties,

  matTh: {
    background: TH_BG,
    padding: '6px 10px',
    textAlign: 'left' as const,
    fontWeight: 600,
    color: '#475569',
    fontSize: 11,
    border: `1px solid ${BORDER}`,
  } as React.CSSProperties,

  matTd: {
    padding: '6px 10px',
    color: '#1e293b',
    border: `1px solid ${BORDER}`,
    fontSize: 13,
  } as React.CSSProperties,

  matTdRight: {
    padding: '6px 10px',
    color: '#1e293b',
    border: `1px solid ${BORDER}`,
    fontSize: 13,
    textAlign: 'right' as const,
  } as React.CSSProperties,

  sectionTotal: {
    textAlign: 'right' as const,
    fontWeight: 700,
    color: DARK_GREEN,
    fontSize: 13,
    marginTop: 6,
  } as React.CSSProperties,

  totalsRow: {
    background: DARK_GREEN,
    borderRadius: 8,
    overflow: 'hidden',
    marginTop: 8,
  } as React.CSSProperties,

  totalsTable: {
    width: '100%',
    borderCollapse: 'collapse' as const,
  } as React.CSSProperties,

  totalsTh: {
    padding: '10px 16px',
    textAlign: 'center' as const,
    color: '#a7c4b5',
    fontWeight: 700,
    fontSize: 11,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    borderRight: '1px solid rgba(255,255,255,0.1)',
  } as React.CSSProperties,

  totalsTd: {
    padding: '10px 16px',
    textAlign: 'center' as const,
    color: '#fff',
    fontWeight: 700,
    fontSize: 16,
    borderRight: '1px solid rgba(255,255,255,0.1)',
  } as React.CSSProperties,
};

// ── Dropdown ───────────────────────────────────────────────────────────────

function OppSearch({
  onSelect,
}: {
  onSelect: (opp: OppResult) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<OppResult[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<OppResult | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = async (val: string) => {
    if (val.length < 3) { setResults([]); setOpen(false); return; }
    try {
      const res = await fetch(`${API}/invoice-summary/search?q=${encodeURIComponent(val)}`);
      if (!res.ok) return;
      const data = await res.json();
      setResults(data.results || []);
      setOpen(true);
    } catch {
      // ignore
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQ(val);
    setSelected(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(val), 300);
  };

  const handleSelect = (opp: OppResult) => {
    setSelected(opp);
    setQ(opp.OpportunityName);
    setResults([]);
    setOpen(false);
    onSelect(opp);
  };

  return (
    <div style={{ position: 'relative', width: 320 }}>
      <label style={styles.label}>Opportunity</label>
      <input
        type="text"
        placeholder="Search opportunity name…"
        value={q}
        onChange={handleChange}
        onFocus={() => results.length > 0 && setOpen(true)}
        style={{ ...styles.input, width: '100%', boxSizing: 'border-box' }}
      />
      {open && results.length > 0 && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          background: '#fff',
          border: `1px solid ${BORDER}`,
          borderRadius: '0 0 6px 6px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          zIndex: 200,
          maxHeight: 260,
          overflowY: 'auto',
        }}>
          {results.map((r) => (
            <div
              key={r.OpportunityID}
              onClick={() => handleSelect(r)}
              style={{
                padding: '9px 14px',
                cursor: 'pointer',
                borderBottom: `1px solid ${BORDER}`,
                fontSize: 13,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f1f5f9')}
              onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
            >
              <div style={{ fontWeight: 600, color: '#1e293b' }}>{r.OpportunityName}</div>
              {r.PropertyName && (
                <div style={{ color: '#64748b', fontSize: 11, marginTop: 1 }}>{r.PropertyName}</div>
              )}
            </div>
          ))}
        </div>
      )}
      {selected && (
        <div style={{ fontSize: 11, color: '#22c55e', marginTop: 4 }}>
          ID: {selected.OpportunityID}
          {selected.PropertyName ? ` · ${selected.PropertyName}` : ''}
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function InvoiceSummaryReport() {
  const [selectedOpp, setSelectedOpp] = useState<OppResult | null>(null);
  const [weekDate, setWeekDate] = useState(getMostRecentMonday());
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inject print styles
  useEffect(() => {
    const el = document.createElement('style');
    el.id = 'invoice-summary-print';
    el.textContent = `
      @media print {
        .no-print { display: none !important; }
        body { background: #fff !important; }
        nav, header[class*="shell"] { display: none !important; }
      }
    `;
    document.head.appendChild(el);
    return () => { el.remove(); };
  }, []);

  const handleGenerate = async () => {
    if (!selectedOpp) { setError('Please select an opportunity.'); return; }
    if (!weekDate)     { setError('Please pick a week date.');     return; }
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const url = `${API}/invoice-summary/report?opp_id=${selectedOpp.OpportunityID}&week_start=${weekDate}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(body.detail || res.statusText);
      }
      const data: Report = await res.json();
      setReport(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.page}>

      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.headerTitle}>Invoice Summary Report</h1>
          <div style={styles.headerSub}>Darios Landscaping — Weekly Progress Report</div>
        </div>
        <button
          className="no-print"
          style={styles.printBtn}
          onClick={() => window.print()}
        >
          🖨 Print
        </button>
      </div>

      {/* Controls */}
      <div className="no-print" style={styles.controls}>
        <OppSearch onSelect={setSelectedOpp} />

        <div>
          <label style={styles.label}>Week (any day)</label>
          <input
            type="date"
            value={weekDate}
            onChange={e => setWeekDate(e.target.value)}
            style={styles.dateInput}
          />
        </div>

        <button
          style={styles.genBtn}
          onClick={handleGenerate}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Generate Report'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="no-print" style={{
          margin: '16px 32px',
          padding: '12px 16px',
          background: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: 6,
          color: '#b91c1c',
          fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {/* Loading spinner */}
      {loading && (
        <div style={{ textAlign: 'center', padding: 48, color: '#64748b' }}>
          Loading report data…
        </div>
      )}

      {/* Report */}
      {report && !loading && (
        <div style={styles.content}>

          {/* Report info card */}
          <div style={styles.infoCard}>
            <div style={styles.infoRow}>
              <div style={styles.infoField}>
                <div style={styles.infoFieldLabel}>Property</div>
                <div style={styles.infoFieldValue}>{report.property_name || '—'}</div>
              </div>
              <div style={styles.infoField}>
                <div style={styles.infoFieldLabel}>Opportunity</div>
                <div style={styles.infoFieldValue}>{report.opportunity_name}</div>
              </div>
              <div style={{ flex: 2, minWidth: 280 }}>
                <div style={styles.infoFieldLabel}>Week of</div>
                <div style={styles.infoFieldValue}>
                  {fmtWeekRange(report.week_start, report.week_end)}
                </div>
              </div>
            </div>
          </div>

          {/* Sections */}
          {report.sections.length === 0 && (
            <div style={{ textAlign: 'center', padding: 32, color: '#94a3b8', fontSize: 14 }}>
              No service data found for this opportunity and week.
            </div>
          )}

          {report.sections.map((sec, idx) => (
            <div key={sec.service_id} style={styles.sectionCard(idx % 2 === 1)}>

              {/* Section title */}
              <div style={styles.sectionTitle}>
                <div style={styles.sectionTitleAccent} />
                <span style={styles.sectionTitleText}>{sec.service_name}</span>
              </div>

              <div style={styles.sectionBody}>

                {/* Hours summary table */}
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Est Hours</th>
                      <th style={styles.th}>To Date</th>
                      <th style={styles.th}>This Week</th>
                      <th style={styles.th}>Remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={styles.td}>{fmtHours(sec.estimated_hours)}</td>
                      <td style={styles.td}>{fmtHours(sec.hours_to_date)}</td>
                      <td style={{ ...styles.td, fontWeight: 700, color: DARK_GREEN }}>
                        {fmtHours(sec.hours_this_week)}
                      </td>
                      <td style={styles.td}>{fmtHours(sec.remaining_hours)}</td>
                    </tr>
                  </tbody>
                </table>

                {/* Daily hours */}
                <div style={styles.subHeading}>Daily Hours</div>
                <div style={{
                  display: 'flex',
                  gap: 0,
                  border: `1px solid ${BORDER}`,
                  borderRadius: 6,
                  overflow: 'hidden',
                  width: 'fit-content',
                }}>
                  {report.week_days.map((day, di) => {
                    const h = sec.hours_by_day[day] ?? 0;
                    return (
                      <div
                        key={day}
                        style={{
                          ...styles.dayCell,
                          padding: '8px 12px',
                          background: h > 0 ? '#f0fdf4' : '#fff',
                          borderRight: di < 6 ? `1px solid ${BORDER}` : 'none',
                        }}
                      >
                        <div style={styles.dayLabel}>{DAY_LABELS[di]}</div>
                        <div style={styles.dayDate}>{fmtDayHeader(day)}</div>
                        <div style={{
                          ...styles.dayHours,
                          color: h > 0 ? DARK_GREEN : '#cbd5e1',
                        }}>
                          {h > 0 ? h.toFixed(1) : '—'}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Materials */}
                {sec.materials.length > 0 && (
                  <>
                    <div style={styles.subHeading}>Materials (Invoice Date within week)</div>
                    <table style={styles.matTable}>
                      <thead>
                        <tr>
                          <th style={styles.matTh}>Vendor</th>
                          <th style={styles.matTh}>Invoice #</th>
                          <th style={styles.matTh}>Date</th>
                          <th style={{ ...styles.matTh, textAlign: 'right' }}>Amount</th>
                          <th style={styles.matTh}>Note</th>
                          <th style={styles.matTh}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sec.materials.map((m, mi) => (
                          <tr key={mi} style={{ background: mi % 2 === 0 ? '#fff' : '#f8fafc' }}>
                            <td style={styles.matTd}>{m.vendor_name || '—'}</td>
                            <td style={styles.matTd}>{m.invoice_number || '—'}</td>
                            <td style={styles.matTd}>{m.invoice_date || '—'}</td>
                            <td style={styles.matTdRight}>{fmtCAD(m.amount)}</td>
                            <td style={styles.matTd}>{m.note || '—'}</td>
                            <td style={styles.matTd}>{m.status || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={styles.sectionTotal}>
                      Section Total: {fmtCAD(sec.materials_total)}
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}

          {/* Totals */}
          {report.sections.length > 0 && (
            <div style={styles.totalsRow}>
              <table style={styles.totalsTable}>
                <thead>
                  <tr>
                    <th style={styles.totalsTh}>Est Hours</th>
                    <th style={styles.totalsTh}>To Date</th>
                    <th style={styles.totalsTh}>This Week</th>
                    <th style={styles.totalsTh}>Remaining</th>
                    <th style={{ ...styles.totalsTh, borderRight: 'none' }}>Materials Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={styles.totalsTd}>{fmtHours(report.totals.estimated_hours)}</td>
                    <td style={styles.totalsTd}>{fmtHours(report.totals.hours_to_date)}</td>
                    <td style={styles.totalsTd}>{fmtHours(report.totals.hours_this_week)}</td>
                    <td style={styles.totalsTd}>{fmtHours(report.totals.remaining_hours)}</td>
                    <td style={{ ...styles.totalsTd, borderRight: 'none' }}>
                      {fmtCAD(report.totals.materials_total)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
