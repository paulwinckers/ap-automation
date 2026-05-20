/**
 * InvoiceSummaryReport — progress report by service category over a date range.
 * Route: /ap/invoice-summary
 */

import React, { useState, useEffect, useRef } from 'react';

const API = import.meta.env.VITE_API_URL ?? 'https://ap-automation-production.up.railway.app';

// ── Types ──────────────────────────────────────────────────────────────────

interface PropertyResult {
  PropertyID: number;
  PropertyName: string;
  OpportunityName?: string;
}

interface OppResult {
  OpportunityID: number;
  OpportunityName: string;
  PropertyName?: string;
  OpportunityStatusName?: string;
  WonDollars?: number;
  StartDate?: string;
  EndDate?: string;
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
  hours_in_period: number;
  hours_by_day: Record<string, number>;
  remaining_hours: number;
  materials: MaterialLine[];
  materials_total: number;
}

interface Totals {
  estimated_hours: number;
  hours_to_date: number;
  hours_in_period: number;
  remaining_hours: number;
  materials_total: number;
}

interface Report {
  opportunity_id: number;
  opportunity_name: string;
  property_name: string;
  period_start: string;
  period_end: string;
  period_days: string[];
  sections: Section[];
  totals: Totals;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getMonday(d = new Date()): string {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function getSunday(d = new Date()): string {
  const day = d.getDay();
  const diff = day === 0 ? 0 : 7 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function fmtHours(h: number): string {
  if (h === 0) return '—';
  return h.toFixed(1);
}

function fmtCAD(amount: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD', minimumFractionDigits: 2,
  }).format(amount);
}

function fmtDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

function fmtDayCol(iso: string): { dow: string; date: string } {
  const d = new Date(iso + 'T12:00:00');
  return {
    dow:  d.toLocaleDateString('en-CA', { weekday: 'short' }),
    date: d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }),
  };
}

function fmtPeriod(start: string, end: string): string {
  const s = new Date(start + 'T12:00:00');
  const e = new Date(end   + 'T12:00:00');
  const opts: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', year: 'numeric' };
  return `${s.toLocaleDateString('en-CA', opts)} – ${e.toLocaleDateString('en-CA', opts)}`;
}

// ── Styles ─────────────────────────────────────────────────────────────────

const DARK_GREEN = '#1e3a2f';
const BORDER     = '#e2e8f0';
const TH_BG      = '#f1f5f9';

const S = {
  page:       { fontFamily: 'Inter, system-ui, sans-serif', background: '#f8fafc', minHeight: '100vh', padding: '0 0 60px' } as React.CSSProperties,
  header:     { background: DARK_GREEN, color: '#fff', padding: '18px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } as React.CSSProperties,
  headerTitle:{ fontSize: 20, fontWeight: 700, margin: 0 } as React.CSSProperties,
  headerSub:  { fontSize: 13, color: '#a7c4b5', marginTop: 2 } as React.CSSProperties,
  printBtn:   { background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: '#fff', borderRadius: 6, padding: '7px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600 } as React.CSSProperties,
  controls:   { background: '#fff', borderBottom: `1px solid ${BORDER}`, padding: '16px 32px', display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' as const } as React.CSSProperties,
  label:      { display: 'block', fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: '0.05em' } as React.CSSProperties,
  input:      { border: `1px solid ${BORDER}`, borderRadius: 6, padding: '8px 12px', fontSize: 14, outline: 'none', background: '#fff' } as React.CSSProperties,
  genBtn:     { background: DARK_GREEN, color: '#fff', border: 'none', borderRadius: 6, padding: '9px 20px', cursor: 'pointer', fontSize: 14, fontWeight: 600 } as React.CSSProperties,
  content:    { maxWidth: 1200, margin: '0 auto', padding: '28px 24px' } as React.CSSProperties,
  infoCard:   { background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '16px 24px', marginBottom: 24, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' } as React.CSSProperties,
  infoRow:    { display: 'flex', gap: 32, flexWrap: 'wrap' as const } as React.CSSProperties,
  infoField:  { flex: 1, minWidth: 180 } as React.CSSProperties,
  infoLbl:    { fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 3 } as React.CSSProperties,
  infoVal:    { fontSize: 15, fontWeight: 600, color: '#1e293b' } as React.CSSProperties,
  sectionCard:(even: boolean) => ({ background: even ? '#f8fafc' : '#fff', border: `1px solid ${BORDER}`, borderRadius: 8, marginBottom: 16, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' } as React.CSSProperties),
  secTitle:   { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', background: '#fff', borderBottom: `1px solid ${BORDER}` } as React.CSSProperties,
  secAccent:  { width: 4, height: 20, background: DARK_GREEN, borderRadius: 2, flexShrink: 0 } as React.CSSProperties,
  secText:    { fontSize: 14, fontWeight: 700, color: '#1e293b', textTransform: 'uppercase' as const, letterSpacing: '0.05em' } as React.CSSProperties,
  secBody:    { padding: '16px 20px' } as React.CSSProperties,
  table:      { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 } as React.CSSProperties,
  th:         { background: TH_BG, padding: '8px 12px', textAlign: 'center' as const, fontWeight: 700, color: '#475569', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.05em', border: `1px solid ${BORDER}` } as React.CSSProperties,
  td:         { padding: '8px 12px', textAlign: 'center' as const, color: '#1e293b', border: `1px solid ${BORDER}`, fontSize: 14 } as React.CSSProperties,
  subHd:      { fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase' as const, letterSpacing: '0.06em', margin: '16px 0 8px' } as React.CSSProperties,
  matTh:      { background: TH_BG, padding: '6px 10px', textAlign: 'left' as const, fontWeight: 600, color: '#475569', fontSize: 11, border: `1px solid ${BORDER}` } as React.CSSProperties,
  matTd:      { padding: '6px 10px', color: '#1e293b', border: `1px solid ${BORDER}`, fontSize: 13 } as React.CSSProperties,
  matTdR:     { padding: '6px 10px', color: '#1e293b', border: `1px solid ${BORDER}`, fontSize: 13, textAlign: 'right' as const } as React.CSSProperties,
  secTotal:   { textAlign: 'right' as const, fontWeight: 700, color: DARK_GREEN, fontSize: 13, marginTop: 6 } as React.CSSProperties,
  totalsRow:  { background: DARK_GREEN, borderRadius: 8, overflow: 'hidden', marginTop: 8 } as React.CSSProperties,
  totalsTable:{ width: '100%', borderCollapse: 'collapse' as const } as React.CSSProperties,
  totalsTh:   { padding: '10px 16px', textAlign: 'center' as const, color: '#a7c4b5', fontWeight: 700, fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.06em', borderRight: '1px solid rgba(255,255,255,0.1)' } as React.CSSProperties,
  totalsTd:   { padding: '10px 16px', textAlign: 'center' as const, color: '#fff', fontWeight: 700, fontSize: 16, borderRight: '1px solid rgba(255,255,255,0.1)' } as React.CSSProperties,
};

// ── Property → Opportunity two-step search ─────────────────────────────────

interface PropertyOppSearchProps {
  onSelect: (opp: OppResult) => void;
}

function PropertyOppSearch({ onSelect }: PropertyOppSearchProps) {
  const [q,           setQ]           = useState('');
  const [propResults, setPropResults] = useState<PropertyResult[]>([]);
  const [propOpen,    setPropOpen]    = useState(false);
  const [selProp,     setSelProp]     = useState<PropertyResult | null>(null);
  const [opps,        setOpps]        = useState<OppResult[]>([]);
  const [oppsLoading, setOppsLoading] = useState(false);
  const [selOpp,      setSelOpp]      = useState<OppResult | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = async (val: string) => {
    if (val.length < 2) { setPropResults([]); setPropOpen(false); return; }
    try {
      const res = await fetch(`${API}/invoice-summary/search?q=${encodeURIComponent(val)}`);
      if (!res.ok) return;
      const data = await res.json();
      setPropResults(data.results || []);
      setPropOpen(true);
    } catch { /* ignore */ }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQ(val);
    setSelProp(null);
    setOpps([]);
    setSelOpp(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(val), 300);
  };

  const selectProp = async (p: PropertyResult) => {
    setSelProp(p);
    setQ(p.PropertyName);
    setPropResults([]);
    setPropOpen(false);
    setSelOpp(null);
    setOppsLoading(true);
    try {
      const res = await fetch(`${API}/invoice-summary/property-opps?property_id=${p.PropertyID}`);
      if (!res.ok) return;
      const data = await res.json();
      setOpps(data.opportunities || []);
    } catch { /* ignore */ }
    finally { setOppsLoading(false); }
  };

  const selectOpp = (opp: OppResult) => {
    setSelOpp(opp);
    onSelect(opp);
  };

  const clearAll = () => {
    setQ(''); setSelProp(null); setOpps([]); setSelOpp(null);
    setPropResults([]); setPropOpen(false);
  };

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>

      {/* Step 1 — Property */}
      <div>
        <label style={S.label}>Property</label>
        <div style={{ position: 'relative', width: 280 }}>
          <input
            type="text"
            placeholder="Search property name…"
            value={q}
            onChange={handleChange}
            onFocus={() => propResults.length > 0 && setPropOpen(true)}
            style={{ ...S.input, width: '100%', boxSizing: 'border-box' }}
          />
          {selProp && (
            <button
              onClick={clearAll}
              title="Clear"
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 16, lineHeight: 1, padding: 0 }}
            >×</button>
          )}
          {propOpen && propResults.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0,
              background: '#fff', border: `1px solid ${BORDER}`,
              borderRadius: '0 0 6px 6px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              zIndex: 200, maxHeight: 260, overflowY: 'auto',
            }}>
              {propResults.map(p => (
                <div
                  key={p.PropertyID}
                  onClick={() => selectProp(p)}
                  style={{ padding: '9px 14px', cursor: 'pointer', borderBottom: `1px solid ${BORDER}`, fontSize: 13 }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f1f5f9')}
                  onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                >
                  <div style={{ fontWeight: 600, color: '#1e293b' }}>{p.PropertyName}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Step 2 — Opportunity (shown after property is selected) */}
      {selProp && (
        <div>
          <label style={S.label}>Opportunity</label>
          {oppsLoading ? (
            <div style={{ fontSize: 13, color: '#94a3b8', paddingTop: 8 }}>Loading…</div>
          ) : opps.length === 0 ? (
            <div style={{ fontSize: 13, color: '#94a3b8', paddingTop: 8 }}>No opportunities found</div>
          ) : (
            <div style={{
              border: `1px solid ${BORDER}`, borderRadius: 6, background: '#fff',
              maxHeight: 200, overflowY: 'auto', minWidth: 320,
            }}>
              {opps.map(opp => {
                const active = selOpp?.OpportunityID === opp.OpportunityID;
                return (
                  <div
                    key={opp.OpportunityID}
                    onClick={() => selectOpp(opp)}
                    style={{
                      padding: '9px 14px', cursor: 'pointer',
                      borderBottom: `1px solid ${BORDER}`,
                      background: active ? '#f0fdf4' : '#fff',
                      borderLeft: `3px solid ${active ? DARK_GREEN : 'transparent'}`,
                    }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#f8fafc'; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = '#fff'; }}
                  >
                    <div style={{ fontWeight: 600, color: '#1e293b', fontSize: 13 }}>
                      {opp.OpportunityName}
                    </div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                      {opp.OpportunityStatusName && (
                        <span style={{ fontSize: 11, color: '#64748b' }}>{opp.OpportunityStatusName}</span>
                      )}
                      {opp.WonDollars != null && (
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>
                          {new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(opp.WonDollars)}
                        </span>
                      )}
                      {opp.StartDate && (
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>
                          {opp.StartDate.slice(0, 10)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function InvoiceSummaryReport() {
  const [selectedOpp, setSelectedOpp] = useState<OppResult | null>(null);
  const [dateFrom,    setDateFrom]    = useState(getMonday());
  const [dateTo,      setDateTo]      = useState(getSunday());
  const [report,      setReport]      = useState<Report | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  // Inject print styles
  useEffect(() => {
    const el = document.createElement('style');
    el.id = 'invoice-summary-print';
    el.textContent = `
      @media print {
        .no-print { display: none !important; }
        body { background: #fff !important; }
        nav, aside { display: none !important; }
      }
    `;
    document.head.appendChild(el);
    return () => { el.remove(); };
  }, []);

  const handleGenerate = async () => {
    if (!selectedOpp) { setError('Please select an opportunity first.'); return; }
    if (!dateFrom || !dateTo) { setError('Please choose a date range.'); return; }
    setLoading(true); setError(null); setReport(null);
    try {
      const url = `${API}/invoice-summary/report?opp_id=${selectedOpp.OpportunityID}&date_from=${dateFrom}&date_to=${dateTo}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(body.detail || res.statusText);
      }
      setReport(await res.json());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={S.page}>

      {/* Header */}
      <div style={S.header}>
        <div>
          <h1 style={S.headerTitle}>Invoice Summary Report</h1>
          <div style={S.headerSub}>Darios Landscaping — Progress Report by Service Category</div>
        </div>
        <button className="no-print" style={S.printBtn} onClick={() => window.print()}>
          🖨 Print
        </button>
      </div>

      {/* Controls */}
      <div className="no-print" style={S.controls}>

        {/* Property → Opportunity */}
        <PropertyOppSearch onSelect={setSelectedOpp} />

        {/* Date range */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div>
            <label style={S.label}>From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              style={S.input}
            />
          </div>
          <div>
            <label style={S.label}>To</label>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              style={S.input}
            />
          </div>
        </div>

        <button style={S.genBtn} onClick={handleGenerate} disabled={loading}>
          {loading ? 'Loading…' : 'Generate Report'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="no-print" style={{ margin: '16px 32px', padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#b91c1c', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: 'center', padding: 48, color: '#64748b' }}>
          Loading report data…
        </div>
      )}

      {/* Report */}
      {report && !loading && (
        <div style={S.content}>

          {/* Info card */}
          <div style={S.infoCard}>
            <div style={S.infoRow}>
              <div style={S.infoField}>
                <div style={S.infoLbl}>Property</div>
                <div style={S.infoVal}>{report.property_name || '—'}</div>
              </div>
              <div style={S.infoField}>
                <div style={S.infoLbl}>Opportunity</div>
                <div style={S.infoVal}>{report.opportunity_name}</div>
              </div>
              <div style={{ flex: 2, minWidth: 280 }}>
                <div style={S.infoLbl}>Period</div>
                <div style={S.infoVal}>{fmtPeriod(report.period_start, report.period_end)}</div>
              </div>
            </div>
          </div>

          {/* No data */}
          {report.sections.length === 0 && (
            <div style={{ textAlign: 'center', padding: 32, color: '#94a3b8', fontSize: 14 }}>
              No service data found for this opportunity and date range.
            </div>
          )}

          {/* Sections */}
          {report.sections.map((sec, idx) => (
            <div key={sec.service_id} style={S.sectionCard(idx % 2 === 1)}>

              <div style={S.secTitle}>
                <div style={S.secAccent} />
                <span style={S.secText}>{sec.service_name}</span>
              </div>

              <div style={S.secBody}>

                {/* Hours summary */}
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={S.th}>Est Hours</th>
                      <th style={S.th}>Hours to Date</th>
                      <th style={S.th}>Hours in Period</th>
                      <th style={S.th}>Remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={S.td}>{fmtHours(sec.estimated_hours)}</td>
                      <td style={S.td}>{fmtHours(sec.hours_to_date)}</td>
                      <td style={{ ...S.td, fontWeight: 700, color: DARK_GREEN }}>
                        {fmtHours(sec.hours_in_period)}
                      </td>
                      <td style={S.td}>{fmtHours(sec.remaining_hours)}</td>
                    </tr>
                  </tbody>
                </table>

                {/* Daily hours */}
                <div style={S.subHd}>Daily Hours</div>
                <div style={{ overflowX: 'auto' }}>
                  <div style={{
                    display: 'flex', gap: 0,
                    border: `1px solid ${BORDER}`, borderRadius: 6,
                    overflow: 'hidden', width: 'fit-content', minWidth: '100%',
                  }}>
                    {report.period_days.map((day, di) => {
                      const h = sec.hours_by_day[day] ?? 0;
                      const { dow, date: dateStr } = fmtDayCol(day);
                      return (
                        <div
                          key={day}
                          style={{
                            textAlign: 'center', padding: '8px 10px',
                            background: h > 0 ? '#f0fdf4' : '#fff',
                            borderRight: di < report.period_days.length - 1 ? `1px solid ${BORDER}` : 'none',
                            minWidth: 58, flex: '1 0 58px',
                          }}
                        >
                          <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', textTransform: 'uppercase' as const }}>{dow}</div>
                          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>{dateStr}</div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: h > 0 ? DARK_GREEN : '#cbd5e1', marginTop: 4 }}>
                            {h > 0 ? h.toFixed(1) : '—'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Materials */}
                {sec.materials.length > 0 && (
                  <>
                    <div style={S.subHd}>Materials — Invoice Date within Period</div>
                    <table style={{ ...S.table, marginTop: 4 }}>
                      <thead>
                        <tr>
                          <th style={S.matTh}>Vendor</th>
                          <th style={S.matTh}>Invoice #</th>
                          <th style={S.matTh}>Invoice Date</th>
                          <th style={{ ...S.matTh, textAlign: 'right' }}>Amount</th>
                          <th style={S.matTh}>Note</th>
                          <th style={S.matTh}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sec.materials.map((m, mi) => (
                          <tr key={mi} style={{ background: mi % 2 === 0 ? '#fff' : '#f8fafc' }}>
                            <td style={S.matTd}>{m.vendor_name || '—'}</td>
                            <td style={S.matTd}>{m.invoice_number || '—'}</td>
                            <td style={S.matTd}>{m.invoice_date ? fmtDate(m.invoice_date) : '—'}</td>
                            <td style={S.matTdR}>{fmtCAD(m.amount)}</td>
                            <td style={{ ...S.matTd, color: '#64748b', fontSize: 12 }}>{m.note || '—'}</td>
                            <td style={S.matTd}>{m.status || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={S.secTotal}>Section Total: {fmtCAD(sec.materials_total)}</div>
                  </>
                )}

              </div>
            </div>
          ))}

          {/* Totals */}
          {report.sections.length > 0 && (
            <div style={S.totalsRow}>
              <table style={S.totalsTable}>
                <thead>
                  <tr>
                    <th style={S.totalsTh}>Est Hours</th>
                    <th style={S.totalsTh}>Hours to Date</th>
                    <th style={S.totalsTh}>Hours in Period</th>
                    <th style={S.totalsTh}>Remaining</th>
                    <th style={{ ...S.totalsTh, borderRight: 'none' }}>Materials Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={S.totalsTd}>{fmtHours(report.totals.estimated_hours)}</td>
                    <td style={S.totalsTd}>{fmtHours(report.totals.hours_to_date)}</td>
                    <td style={S.totalsTd}>{fmtHours(report.totals.hours_in_period)}</td>
                    <td style={S.totalsTd}>{fmtHours(report.totals.remaining_hours)}</td>
                    <td style={{ ...S.totalsTd, borderRight: 'none' }}>{fmtCAD(report.totals.materials_total)}</td>
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
