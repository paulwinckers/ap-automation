/**
 * Vendor Statement Reconciliation page
 * /reconcile
 *
 * - Upload vendor statement PDFs for the current month
 * - See live diff against QBO bills
 * - Refresh any vendor to re-query QBO
 * - Close Month to freeze and snapshot
 * - Print/export a closed period
 */

import { useEffect, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? 'https://ap-automation-production.up.railway.app';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Period {
  id: number;
  period: string;
  label: string;
  status: 'open' | 'closed';
  closed_at: string | null;
}

interface Statement {
  id: number;
  period_id: number;
  vendor_name: string;
  statement_date: string | null;
  closing_balance: number | null;
  currency: string;
  aging_current: number;
  aging_1_30: number;
  aging_31_60: number;
  aging_61_90: number;
  aging_over_90: number;
  pdf_filename: string | null;
  intake_source: string;
}

interface QboLink {
  qbo_vendor_id: string;
  qbo_vendor_name: string;
}

interface DiffRow {
  invoice_number: string;
  date?: string;
  stmt_amount?: number;
  qbo_amount?: number;
  difference?: number;
  raw_description?: string;
  qbo_bill_id?: string;
  qbo_date?: string;
  qbo_balance?: number;
}

interface DiffResult {
  vendor_name: string;
  statement_date: string | null;
  closing_balance: number | null;
  qbo_total_balance: number | null;
  currency: string;
  diff: {
    matched: DiffRow[];
    amount_mismatch: DiffRow[];
    in_stmt_not_qbo: DiffRow[];
    in_qbo_not_stmt: DiffRow[];
    summary: {
      matched_count: number;
      mismatch_count: number;
      missing_from_qbo: number;
      extra_in_qbo: number;
      total_discrepancy: number;
    };
  };
  refreshed_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function fmt(n: number | null | undefined, currency = 'CAD'): string {
  if (n == null) return '—';
  return `$${Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Reconcile() {
  const [periods, setPeriods]           = useState<Period[]>([]);
  const [activePeriod, setActivePeriod] = useState<string>(currentPeriod());
  const [statements, setStatements]     = useState<Statement[]>([]);
  const [periodStatus, setPeriodStatus] = useState<'open' | 'closed'>('open');
  const [diffs, setDiffs]               = useState<Record<number, { source: string; data: DiffResult } | null>>({});
  const [uploading, setUploading]       = useState(false);
  const [refreshing, setRefreshing]     = useState<number | null>(null);
  const [closing, setClosing]           = useState(false);
  const [expandedDiff, setExpandedDiff] = useState<number | null>(null);
  const [links, setLinks]               = useState<Record<string, QboLink | null>>({});
  const [linkingFor, setLinkingFor]     = useState<string | null>(null); // statement_name being linked
  const [vendorSearch, setVendorSearch] = useState('');
  const [vendorResults, setVendorResults] = useState<{id: string; name: string}[]>([]);
  const [searchingVendors, setSearchingVendors] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadPeriods(); }, []);
  useEffect(() => {
    setStatements([]);
    setDiffs({});
    loadStatements(activePeriod);
  }, [activePeriod]);

  async function loadPeriods() {
    const res = await fetch(`${API}/reconcile/periods`);
    const data = await res.json();
    setPeriods(data.periods || []);
  }

  async function loadStatements(period: string) {
    // Ensure period exists
    await fetch(`${API}/reconcile/periods/${period}`, { method: 'POST' });
    const res = await fetch(`${API}/reconcile/periods/${period}/statements`);
    const data = await res.json();
    // Guard against stale responses — if the user switched periods while this
    // request was in-flight, discard the result to prevent overwriting newer data
    setActivePeriod(current => {
      if (current !== period) return current;
      setStatements(data.statements || []);
      setPeriodStatus(data.period?.status || 'open');
      setDiffs({});
      return current;
    });
    await loadPeriods();
    const stmts = data.statements || [];
    await loadLinks(stmts);
    // Auto-load diffs for all statements
    for (const stmt of stmts) {
      loadDiff(stmt.id);
    }
  }

  async function loadLinks(stmts: Statement[]) {
    const entries = await Promise.all(
      stmts.map(async s => {
        const res = await fetch(`${API}/reconcile/vendor-links/${encodeURIComponent(s.vendor_name)}`);
        const data = await res.json();
        return [s.vendor_name, data?.qbo_vendor_id ? data : null] as [string, QboLink | null];
      })
    );
    setLinks(Object.fromEntries(entries));
  }

  async function searchQboVendors(q: string) {
    setVendorSearch(q);
    if (q.length < 2) { setVendorResults([]); return; }
    setSearchingVendors(true);
    try {
      const res = await fetch(`${API}/reconcile/qbo-vendors/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setVendorResults(data.vendors || []);
    } finally {
      setSearchingVendors(false);
    }
  }

  async function saveLink(statementName: string, vendor: {id: string; name: string}) {
    await fetch(`${API}/reconcile/vendor-links/${encodeURIComponent(statementName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qbo_vendor_id: vendor.id, qbo_vendor_name: vendor.name }),
    });
    setLinks(prev => ({ ...prev, [statementName]: { qbo_vendor_id: vendor.id, qbo_vendor_name: vendor.name } }));
    setLinkingFor(null);
    setVendorSearch('');
    setVendorResults([]);
    // Refresh the diff for this statement
    const stmt = statements.find(s => s.vendor_name === statementName);
    if (stmt) loadDiff(stmt.id);
  }

  async function removeLink(statementName: string) {
    await fetch(`${API}/reconcile/vendor-links/${encodeURIComponent(statementName)}`, { method: 'DELETE' });
    setLinks(prev => ({ ...prev, [statementName]: null }));
  }

  async function loadDiff(statementId: number) {
    setRefreshing(statementId);
    try {
      const res = await fetch(`${API}/reconcile/statements/${statementId}/diff`);
      const data = await res.json();
      setDiffs(prev => ({ ...prev, [statementId]: data }));
    } finally {
      setRefreshing(null);
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('period', activePeriod);
      form.append('file', file);
      const res = await fetch(`${API}/reconcile/upload`, { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Upload failed: ${err.detail || res.statusText}`);
        return;
      }
      await loadStatements(activePeriod);
    } catch (err) {
      alert('Upload failed — check Railway logs');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleClosePeriod() {
    if (!confirm(`Close ${activePeriod} and freeze all QBO snapshots? This cannot be undone.`)) return;
    setClosing(true);
    try {
      const res = await fetch(`${API}/reconcile/periods/${activePeriod}/close`, { method: 'POST' });
      if (!res.ok) {
        alert('Close failed — check Railway logs');
        return;
      }
      await loadStatements(activePeriod);
    } finally {
      setClosing(false);
    }
  }

  async function handleDelete(statementId: number, vendorName: string) {
    if (!confirm(`Delete ${vendorName} statement?`)) return;
    await fetch(`${API}/reconcile/statements/${statementId}`, { method: 'DELETE' });
    await loadStatements(activePeriod);
  }

  const diffSummaryColor = (d: DiffResult) => {
    const s = d.diff.summary;
    if (s.mismatch_count > 0 || s.missing_from_qbo > 0) return '#dc2626';
    if (s.extra_in_qbo > 0) return '#d97706';
    return '#16a34a';
  };

  return (
    <div style={{ fontFamily: 'Inter,Arial,sans-serif', background: '#f8fafc', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ background: '#1e3a2f', padding: '16px 32px', display: 'flex', alignItems: 'center', gap: 16 }}>
        <img src="/darios-logo.png" alt="Dario's" style={{ height: 36 }} />
        <div>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: 18 }}>Vendor Statement Reconciliation</div>
          <div style={{ color: '#86efac', fontSize: 12 }}>Compare vendor statements against QBO open bills</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <a href="/ap" style={{ color: '#86efac', fontSize: 13, textDecoration: 'none' }}>← AP Dashboard</a>
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 24px' }}>

        {/* Period tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Generate last 6 months as period options */}
          {Array.from({ length: 6 }, (_, i) => {
            const d = new Date();
            d.setDate(1); // prevent month overflow (e.g. Mar 30 - 1 month = Mar 2)
            d.setMonth(d.getMonth() - i);
            const p = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const found = periods.find(x => x.period === p);
            const label = found?.label || d.toLocaleString('default', { month: 'long', year: 'numeric' });
            const isClosed = found?.status === 'closed';
            return (
              <button
                key={p}
                onClick={() => setActivePeriod(p)}
                style={{
                  padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  border: `2px solid ${activePeriod === p ? '#1e3a2f' : '#e2e8f0'}`,
                  borderRadius: 20, background: activePeriod === p ? '#1e3a2f' : '#fff',
                  color: activePeriod === p ? '#fff' : '#64748b',
                }}
              >
                {label}{isClosed ? ' 🔒' : ''}
              </button>
            );
          })}
        </div>

        {/* Toolbar */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 24, alignItems: 'center', flexWrap: 'wrap' }}>
          {periodStatus === 'open' && (
            <>
              <label style={{
                padding: '8px 18px', background: '#1e3a2f', color: '#fff',
                borderRadius: 8, cursor: uploading ? 'wait' : 'pointer',
                fontSize: 14, fontWeight: 600, opacity: uploading ? 0.7 : 1,
              }}>
                {uploading ? 'Uploading…' : '⬆ Upload Statement'}
                <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" style={{ display: 'none' }} onChange={handleUpload} disabled={uploading} />
              </label>

              {statements.length > 0 && (
                <button
                  onClick={handleClosePeriod}
                  disabled={closing}
                  style={{
                    padding: '8px 18px', background: '#fff', color: '#dc2626',
                    border: '1.5px solid #dc2626', borderRadius: 8,
                    cursor: closing ? 'wait' : 'pointer', fontSize: 14, fontWeight: 600,
                  }}
                >
                  {closing ? 'Closing…' : '🔒 Close Month'}
                </button>
              )}
            </>
          )}

          {periodStatus === 'closed' && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#16a34a', fontWeight: 600 }}>🔒 Period closed — view is frozen</span>
              <button
                onClick={() => window.print()}
                style={{
                  padding: '8px 18px', background: '#fff', border: '1.5px solid #1e3a2f',
                  color: '#1e3a2f', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600,
                }}
              >
                🖨 Print / Export PDF
              </button>
            </div>
          )}

          <span style={{ marginLeft: 'auto', fontSize: 13, color: '#94a3b8' }}>
            {statements.length} vendor{statements.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Empty state */}
        {statements.length === 0 && (
          <div style={{ textAlign: 'center', padding: '80px 0', color: '#94a3b8' }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>📄</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>No statements uploaded yet</div>
            <div style={{ fontSize: 13, marginTop: 8 }}>Upload a vendor statement PDF to get started</div>
          </div>
        )}

        {/* Statement cards */}
        {statements.map(stmt => {
          const diffData = diffs[stmt.id];
          const diff = diffData?.data?.diff;
          const summary = diff?.summary;
          const isLoading = refreshing === stmt.id;
          const isExpanded = expandedDiff === stmt.id;

          return (
            <div key={stmt.id} style={{
              background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0',
              marginBottom: 16, overflow: 'hidden',
            }}>
              {/* Card header */}
              <div style={{
                padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16,
                borderBottom: isExpanded ? '1px solid #f1f5f9' : 'none',
                cursor: 'pointer',
              }} onClick={() => setExpandedDiff(isExpanded ? null : stmt.id)}>
                {/* Vendor + summary */}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 16, color: '#1e293b' }}>{stmt.vendor_name}</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                    {stmt.statement_date || '—'} · Statement: {fmt(stmt.closing_balance, stmt.currency)}
                    {diffData?.data && (() => {
                      const d = diffData.data as DiffResult;
                      const qboBalance = d.qbo_total_balance ?? null;
                      if (qboBalance === null) return null;
                      const diff = (stmt.closing_balance ?? 0) - qboBalance;
                      const diffColor = Math.abs(diff) < 0.01 ? '#16a34a' : '#dc2626';
                      return (
                        <>
                          {' · '}QBO: <span style={{ color: '#1e293b', fontWeight: 600 }}>{fmt(qboBalance, stmt.currency)}</span>
                          {' · '}Diff: <span style={{ color: diffColor, fontWeight: 700 }}>{diff >= 0 ? '+' : ''}{fmt(diff, stmt.currency)}</span>
                        </>
                      );
                    })()}
                  </div>
                </div>

                {/* Aging pills */}
                <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                  {[
                    { label: 'Current', val: stmt.aging_current },
                    { label: '1-30d', val: stmt.aging_1_30 },
                    { label: '31-60d', val: stmt.aging_31_60 },
                    { label: '61-90d', val: stmt.aging_61_90 },
                    { label: '90+d', val: stmt.aging_over_90 },
                  ].filter(b => b.val > 0).map(b => (
                    <span key={b.label} style={{
                      background: b.label === 'Current' ? '#f0fdf4' : b.label === '1-30d' ? '#fffbeb' : '#fef2f2',
                      color: b.label === 'Current' ? '#16a34a' : b.label === '1-30d' ? '#d97706' : '#dc2626',
                      padding: '2px 8px', borderRadius: 10, fontWeight: 600,
                    }}>
                      {b.label}: {fmt(b.val, '')}
                    </span>
                  ))}
                </div>

                {/* Match status badge */}
                {summary && !isLoading && (
                  <div style={{
                    background: summary.mismatch_count > 0 || summary.missing_from_qbo > 0 ? '#fef2f2' :
                      summary.extra_in_qbo > 0 ? '#fffbeb' : '#f0fdf4',
                    color: diffSummaryColor(diffData!.data),
                    padding: '4px 12px', borderRadius: 20, fontWeight: 700, fontSize: 13,
                  }}>
                    {summary.mismatch_count === 0 && summary.missing_from_qbo === 0 && summary.extra_in_qbo === 0
                      ? `✓ ${summary.matched_count} matched`
                      : `⚠ ${summary.missing_from_qbo} missing · ${summary.mismatch_count} mismatch · ${summary.extra_in_qbo} extra`
                    }
                  </div>
                )}
                {isLoading && <span style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</span>}

                {/* QBO vendor link badge */}
                <div style={{ fontSize: 11 }} onClick={e => e.stopPropagation()}>
                  {links[stmt.vendor_name] ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4,
                      background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8,
                      padding: '2px 8px', color: '#15803d', whiteSpace: 'nowrap' }}>
                      🔗 {links[stmt.vendor_name]!.qbo_vendor_name}
                      <button onClick={() => removeLink(stmt.vendor_name)} title="Remove link"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: 0, fontSize: 11 }}>✕</button>
                    </span>
                  ) : (
                    <button onClick={() => { setLinkingFor(stmt.vendor_name); setVendorSearch(''); setVendorResults([]); }}
                      style={{ padding: '2px 8px', fontSize: 11, border: '1px dashed #cbd5e1',
                        borderRadius: 8, background: '#f8fafc', cursor: 'pointer', color: '#64748b' }}>
                      🔗 Link QBO vendor
                    </button>
                  )}
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
                  {periodStatus === 'open' && (
                    <button onClick={() => loadDiff(stmt.id)} disabled={isLoading} style={{
                      padding: '4px 12px', fontSize: 12, border: '1px solid #e2e8f0',
                      borderRadius: 6, background: '#f8fafc', cursor: 'pointer', color: '#64748b',
                    }}>↺ Refresh</button>
                  )}
                  <button onClick={async () => {
                    const res = await fetch(`${API}/reconcile/statements/${stmt.id}/pdf`);
                    if (!res.ok) { alert('No PDF stored for this statement'); return; }
                    const { url } = await res.json();
                    window.open(url, '_blank');
                  }} style={{
                    padding: '4px 12px', fontSize: 12, border: '1px solid #e2e8f0',
                    borderRadius: 6, background: '#f8fafc', cursor: 'pointer', color: '#64748b',
                  }} title="Download original PDF">⬇ PDF</button>
                  {periodStatus === 'open' && (
                    <button onClick={() => handleDelete(stmt.id, stmt.vendor_name)} style={{
                      padding: '4px 12px', fontSize: 12, border: '1px solid #fecaca',
                      borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#dc2626',
                    }}>✕</button>
                  )}
                  <span style={{ fontSize: 18, color: '#94a3b8' }}>{isExpanded ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Expanded diff table */}
              {isExpanded && diff && (
                <div style={{ padding: '0 20px 20px' }}>
                  {/* Source indicator */}
                  <div style={{ fontSize: 11, color: '#94a3b8', margin: '12px 0 8px', textAlign: 'right' }}>
                    {diffData?.source === 'snapshot' ? '🔒 Frozen snapshot' : `⟳ Live QBO · refreshed ${diffData?.data?.refreshed_at ? new Date(diffData.data.refreshed_at).toLocaleTimeString() : ''}`}
                  </div>

                  {/* Summary row */}
                  <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                    {[
                      { label: '✓ Matched', val: summary!.matched_count, color: '#16a34a', bg: '#f0fdf4' },
                      { label: '⚠ Amount mismatch', val: summary!.mismatch_count, color: '#d97706', bg: '#fffbeb' },
                      { label: '❌ Missing from QBO', val: summary!.missing_from_qbo, color: '#dc2626', bg: '#fef2f2' },
                      { label: '◎ In QBO, not on stmt', val: summary!.extra_in_qbo, color: '#7c3aed', bg: '#faf5ff' },
                    ].map(s => (
                      <div key={s.label} style={{
                        flex: '1 1 140px', padding: '10px 14px', borderRadius: 8,
                        background: s.bg, color: s.color, fontWeight: 700, fontSize: 13,
                      }}>
                        {s.label}<br />
                        <span style={{ fontSize: 22 }}>{s.val}</span>
                      </div>
                    ))}
                    {summary!.total_discrepancy !== 0 && (
                      <div style={{
                        flex: '1 1 140px', padding: '10px 14px', borderRadius: 8,
                        background: '#fef2f2', color: '#dc2626', fontWeight: 700, fontSize: 13,
                      }}>
                        Total discrepancy<br />
                        <span style={{ fontSize: 22 }}>{fmt(summary!.total_discrepancy, stmt.currency)}</span>
                      </div>
                    )}
                  </div>

                  {/* Mismatch rows */}
                  {diff.amount_mismatch.length > 0 && (
                    <DiffSection title="⚠ Amount Mismatch" color="#d97706" bg="#fffbeb">
                      <DiffTable rows={diff.amount_mismatch} type="mismatch" currency={stmt.currency} />
                    </DiffSection>
                  )}

                  {/* Missing from QBO */}
                  {diff.in_stmt_not_qbo.length > 0 && (
                    <DiffSection title="❌ On Statement — Not in QBO" color="#dc2626" bg="#fef2f2">
                      <DiffTable rows={diff.in_stmt_not_qbo} type="missing_qbo" currency={stmt.currency} />
                    </DiffSection>
                  )}

                  {/* In QBO not on statement */}
                  {diff.in_qbo_not_stmt.length > 0 && (
                    <DiffSection title="◎ In QBO — Not on Statement" color="#7c3aed" bg="#faf5ff">
                      <DiffTable rows={diff.in_qbo_not_stmt} type="extra_qbo" currency={stmt.currency} />
                    </DiffSection>
                  )}

                  {/* All matched */}
                  {diff.matched.length > 0 && (
                    <details style={{ marginTop: 12 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 13, color: '#16a34a', fontWeight: 600 }}>
                        ✓ {diff.matched.length} matched invoices
                      </summary>
                      <DiffTable rows={diff.matched} type="matched" currency={stmt.currency} />
                    </details>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Print styles */}
      <style>{`
        @media print {
          button, label, a { display: none !important; }
          .no-print { display: none !important; }
          body { background: white; }
        }
      `}</style>

      {/* QBO vendor link modal */}
      {linkingFor && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }} onClick={() => setLinkingFor(null)}>
          <div style={{
            background: '#fff', borderRadius: 12, padding: 24, width: 420, maxWidth: '90vw',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Link QBO Vendor</div>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>
              Statement: <strong>{linkingFor}</strong>
            </div>
            <input
              autoFocus
              placeholder="Search QBO vendor name…"
              value={vendorSearch}
              onChange={e => searchQboVendors(e.target.value)}
              style={{
                width: '100%', padding: '8px 12px', fontSize: 14, borderRadius: 8,
                border: '1.5px solid #e2e8f0', outline: 'none', boxSizing: 'border-box',
              }}
            />
            {searchingVendors && (
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 8 }}>Searching…</div>
            )}
            {vendorResults.length > 0 && (
              <div style={{ marginTop: 8, border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
                {vendorResults.map(v => (
                  <div key={v.id}
                    onClick={() => saveLink(linkingFor, v)}
                    style={{
                      padding: '10px 14px', cursor: 'pointer', fontSize: 14,
                      borderBottom: '1px solid #f1f5f9',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f0fdf4')}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}
                  >
                    {v.name}
                  </div>
                ))}
              </div>
            )}
            {vendorSearch.length >= 2 && !searchingVendors && vendorResults.length === 0 && (
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 8 }}>No QBO vendors found</div>
            )}
            <button onClick={() => setLinkingFor(null)} style={{
              marginTop: 16, width: '100%', padding: '8px', fontSize: 13,
              border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer',
              background: '#f8fafc', color: '#64748b',
            }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DiffSection({ title, color, bg, children }: {
  title: string; color: string; bg: string; children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color, background: bg, padding: '6px 12px', borderRadius: '6px 6px 0 0' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function DiffTable({ rows, type, currency }: {
  rows: DiffRow[]; type: 'matched' | 'mismatch' | 'missing_qbo' | 'extra_qbo'; currency: string;
}) {
  const fmt = (n: number | null | undefined) =>
    n != null ? `$${Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 2 })}` : '—';

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ background: '#f8fafc', color: '#64748b' }}>
          <th style={th}>Invoice #</th>
          <th style={th}>Date</th>
          <th style={th}>Statement Amount</th>
          {type !== 'missing_qbo' && <th style={th}>QBO Amount</th>}
          {type === 'mismatch' && <th style={th}>Difference</th>}
          {type === 'extra_qbo' && <th style={th}>QBO Balance</th>}
          {type === 'missing_qbo' && <th style={th}>Description</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
            <td style={td}>{row.invoice_number}</td>
            <td style={td}>{row.date || row.qbo_date || '—'}</td>
            <td style={td}>{fmt(row.stmt_amount)}</td>
            {type !== 'missing_qbo' && <td style={td}>{fmt(row.qbo_amount)}</td>}
            {type === 'mismatch' && (
              <td style={{ ...td, color: (row.difference || 0) > 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>
                {row.difference != null ? (row.difference > 0 ? '+' : '') + fmt(row.difference) : '—'}
              </td>
            )}
            {type === 'extra_qbo' && <td style={td}>{fmt(row.qbo_balance)}</td>}
            {type === 'missing_qbo' && <td style={{ ...td, color: '#64748b', fontSize: 12 }}>{row.raw_description || '—'}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const th: React.CSSProperties = {
  padding: '6px 12px', textAlign: 'left', fontWeight: 600, fontSize: 12,
};
const td: React.CSSProperties = {
  padding: '6px 12px',
};
