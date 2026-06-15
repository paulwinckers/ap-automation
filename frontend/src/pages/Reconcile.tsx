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
  pdf_r2_key: string | null;
  intake_source: string;
  reconciled: number;       // 0 or 1
  reconciled_at: string | null;
  reconciled_note: string | null;
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

function prevPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function fmt(n: number | null | undefined, currency = 'CAD'): string {
  if (n == null) return '—';
  return `$${Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

// ── Local diff cache (localStorage) ───────────────────────────────────────────
// Stores the last-fetched diffs per period so the page shows data instantly
// on revisit while fresh data loads in the background.
// Closed periods are cached forever (snapshots never change).
// Open periods are cached for 4 hours (matching backend D1 cache TTL).

const OPEN_CACHE_TTL_MS  = 4 * 60 * 60 * 1000; // 4 hours
const _lsKey = (period: string) => `reconcile:diffs:v1:${period}`;

function readLocalDiffs(period: string, isClosed: boolean): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(_lsKey(period));
    if (!raw) return null;
    const { diffs, ts, closed } = JSON.parse(raw) as { diffs: Record<string, unknown>; ts: number; closed?: boolean };
    if (closed || isClosed) return diffs; // frozen periods never expire
    if (Date.now() - ts > OPEN_CACHE_TTL_MS) return null; // stale
    return diffs;
  } catch { return null; }
}

function writeLocalDiffs(period: string, diffs: Record<string, unknown>, isClosed: boolean) {
  try {
    localStorage.setItem(_lsKey(period), JSON.stringify({ diffs, ts: Date.now(), closed: isClosed }));
  } catch { /* storage full — silently skip */ }
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Reconcile() {
  const [periods, setPeriods]           = useState<Period[]>([]);
  const [activePeriod, setActivePeriod] = useState<string>(currentPeriod());
  const [statements, setStatements]     = useState<Statement[]>([]);
  const [diffs, setDiffs]               = useState<Record<number, { source: string; data: DiffResult } | null>>({});
  const [uploading, setUploading]       = useState(false);
  const [refreshing, setRefreshing]     = useState<number | null>(null);
  const [expandedDiff, setExpandedDiff] = useState<number | null>(null);
  const [links, setLinks]               = useState<Record<string, QboLink | null>>({});
  const [linkingFor, setLinkingFor]     = useState<string | null>(null); // statement_name being linked
  const [vendorSearch, setVendorSearch] = useState('');
  const [vendorResults, setVendorResults] = useState<{id: string; name: string; active: boolean}[]>([]);
  const [searchingVendors, setSearchingVendors] = useState(false);
  const [attachingPdf, setAttachingPdf] = useState<number | null>(null);
  const [loadingDiffs, setLoadingDiffs] = useState(false);
  const [loadingStatements, setLoadingStatements] = useState(false);
  const [diffsError, setDiffsError] = useState<string | null>(null);
  const [reconcilingId, setReconcilingId] = useState<number | null>(null);
  const [reconcileFilter, setReconcileFilter] = useState<'all' | 'reconciled' | 'unreconciled'>('all');
  const loadPeriodRef = useRef<string>('');
  const fileRef    = useRef<HTMLInputElement>(null);
  const pdfRefs    = useRef<Record<number, HTMLInputElement | null>>({});

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
    // Track which period this load is for so stale responses can be discarded
    loadPeriodRef.current = period;
    setLoadingStatements(true);
    setDiffsError(null);
    try {
      // Ensure period exists
      await fetch(`${API}/reconcile/periods/${period}`, { method: 'POST' });
      const res = await fetch(`${API}/reconcile/periods/${period}/statements`);
      const data = await res.json();
      // Guard against stale responses — if the user switched periods while this
      // request was in-flight, discard the result to prevent overwriting newer data
      if (loadPeriodRef.current !== period) return;
      setStatements(data.statements || []);
      setDiffs({});
      setLoadingStatements(false);
      await loadPeriods();
      const stmts = data.statements || [];
      await loadLinks(stmts);
      // Load all diffs in a single parallel request (much faster than N serial calls)
      if (stmts.length > 0) {
        loadAllDiffs(period);
      }
    } catch (err) {
      if (loadPeriodRef.current !== period) return;
      setLoadingStatements(false);
      setDiffsError(`Failed to load statements: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function loadAllDiffs(period: string) {
    // ── Show cached data instantly (stale-while-revalidate) ──────────────────
    const cached = readLocalDiffs(period, false);
    if (cached) setDiffs(cached as any);

    setLoadingDiffs(true);
    setDiffsError(null);
    try {
      const res = await fetch(`${API}/reconcile/periods/${period}/diffs`);
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        let detail = errText;
        try { detail = JSON.parse(errText)?.detail ?? errText; } catch { /* non-JSON */ }
        // If we showed cached data, don't overlay it with an error banner
        if (!cached) setDiffsError(`QBO data failed (${res.status}): ${String(detail).slice(0, 300)}`);
        return;
      }
      const data = await res.json();
      const freshDiffs = data.diffs || {};
      setDiffs(freshDiffs);
      writeLocalDiffs(period, freshDiffs, false);
    } catch (err) {
      if (!cached) setDiffsError(`QBO connection error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingDiffs(false);
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
    // Use POST body endpoint — PUT path breaks for vendor names containing '/' or other
    // URL-special characters (e.g. "Westbank Nursery Ltd/dba Dogwood Nursery").
    await fetch(`${API}/reconcile/vendor-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement_name: statementName, qbo_vendor_id: vendor.id, qbo_vendor_name: vendor.name }),
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

  async function loadDiff(statementId: number, force = false) {
    setRefreshing(statementId);
    try {
      const url = force
        ? `${API}/reconcile/statements/${statementId}/diff?force=true`
        : `${API}/reconcile/statements/${statementId}/diff`;
      const res = await fetch(url);
      const data = await res.json();
      setDiffs(prev => {
        const next = { ...prev, [statementId]: data };
        // Persist updated diffs to localStorage so next visit is instant
        writeLocalDiffs(activePeriod, next, false);
        return next;
      });
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
      const data = await res.json();
      if (data.pdf_warning) {
        alert(`Statement extracted successfully, but:\n\n⚠️ ${data.pdf_warning}\n\nThe statement data is saved but the original PDF file was not stored.`);
      }
      await loadStatements(activePeriod);
    } catch (err) {
      alert('Upload failed — check Railway logs');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  /** Refresh one statement row in-place without reloading the whole list or re-fetching all diffs. */
  async function refreshStatement(statementId: number) {
    const res = await fetch(`${API}/reconcile/statements/${statementId}`);
    if (!res.ok) return;
    const data = await res.json();
    setStatements(prev => prev.map(s => s.id === statementId ? { ...s, ...data } : s));
  }

  async function toggleReconcile(stmt: Statement) {
    const isReconciled = stmt.reconciled === 1;
    setReconcilingId(stmt.id);
    try {
      if (isReconciled) {
        await fetch(`${API}/reconcile/statements/${stmt.id}/reconcile`, { method: 'DELETE' });
        // Unreconciled — refresh statement row then force-reload its diff from QBO
        await refreshStatement(stmt.id);
        await loadDiff(stmt.id, true);
      } else {
        const note = prompt(`Optional note for reconciling ${stmt.vendor_name}:`) ?? undefined;
        await fetch(`${API}/reconcile/statements/${stmt.id}/reconcile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: note || null }),
        });
        // Reconciled — refresh statement row then reload its diff (returns locked snapshot)
        await refreshStatement(stmt.id);
        await loadDiff(stmt.id);
      }
    } finally {
      setReconcilingId(null);
    }
  }

  async function handleDelete(statementId: number, vendorName: string) {
    if (!confirm(`Delete ${vendorName} statement?`)) return;
    await fetch(`${API}/reconcile/statements/${statementId}`, { method: 'DELETE' });
    // Remove from local state — no full reload needed
    setStatements(prev => prev.filter(s => s.id !== statementId));
    setDiffs(prev => { const n = { ...prev }; delete n[statementId]; return n; });
  }

  async function handleAttachPdf(statementId: number, file: File) {
    setAttachingPdf(statementId);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API}/reconcile/statements/${statementId}/pdf`, { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`PDF upload failed: ${err.detail || res.statusText}`);
        return;
      }
      // Just refresh this one statement's pdf_r2_key — no full reload
      await refreshStatement(statementId);
    } catch {
      alert('PDF upload failed — check Railway logs');
    } finally {
      setAttachingPdf(null);
    }
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
          {Array.from({ length: 6 }, (_, i) => {
            const d = new Date();
            d.setDate(1);
            d.setMonth(d.getMonth() - i);
            const p = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const found = periods.find(x => x.period === p);
            const label = found?.label || d.toLocaleString('default', { month: 'long', year: 'numeric' });
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
                {label}
              </button>
            );
          })}
        </div>

        {/* Toolbar */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 24, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{
            padding: '8px 18px', background: '#1e3a2f', color: '#fff',
            borderRadius: 8, cursor: uploading ? 'wait' : 'pointer',
            fontSize: 14, fontWeight: 600, opacity: uploading ? 0.7 : 1,
          }}>
            {uploading ? 'Uploading…' : '⬆ Upload Statement'}
            <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" style={{ display: 'none' }} onChange={handleUpload} disabled={uploading} />
          </label>
          <button
            onClick={() => window.print()}
            style={{
              padding: '8px 18px', background: '#fff', border: '1.5px solid #1e3a2f',
              color: '#1e3a2f', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600,
            }}
          >
            🖨 Print / Export PDF
          </button>
          {/* Reconcile filter toggle */}
          <div style={{ display: 'flex', border: '1.5px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}>
            {(['all', 'unreconciled', 'reconciled'] as const).map(opt => (
              <button key={opt} onClick={() => setReconcileFilter(opt)} style={{
                padding: '6px 14px', fontSize: 13, fontWeight: 500, border: 'none',
                borderRight: opt !== 'reconciled' ? '1px solid #e2e8f0' : 'none',
                cursor: 'pointer',
                background: reconcileFilter === opt ? '#1e3a2f' : '#fff',
                color: reconcileFilter === opt ? '#fff' : '#64748b',
              }}>
                {opt === 'all' ? 'All' : opt === 'unreconciled' ? 'Unreconciled' : 'Reconciled'}
              </button>
            ))}
          </div>
          <span style={{ marginLeft: 'auto', fontSize: 13, color: '#94a3b8' }}>
            {statements.filter(s =>
              reconcileFilter === 'all' ? true :
              reconcileFilter === 'reconciled' ? s.reconciled === 1 :
              s.reconciled !== 1
            ).length} vendor{statements.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Loading state */}
        {loadingStatements && (
          <div style={{ textAlign: 'center', padding: '80px 0', color: '#94a3b8' }}>
            <div style={{ fontSize: 36, marginBottom: 16, display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginTop: 8 }}>Loading statements…</div>
          </div>
        )}

        {/* Empty state */}
        {!loadingStatements && statements.length === 0 && (
          <div style={{ textAlign: 'center', padding: '80px 0', color: '#94a3b8' }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>📄</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>No statements uploaded yet</div>
            <div style={{ fontSize: 13, marginTop: 8 }}>Upload a vendor statement PDF to get started</div>
          </div>
        )}

        {/* Loading banner — only shown when there are non-reconciled statements being fetched */}
        {loadingDiffs && statements.some(s => !s.reconciled) && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
            padding: '10px 16px', background: '#eff6ff', borderRadius: 8,
            border: '1px solid #bfdbfe', color: '#1d4ed8', fontSize: 13, fontWeight: 500,
          }}>
            <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', fontSize: 16 }}>⟳</span>
            Pulling QBO data for {statements.filter(s => !s.reconciled).length} vendor{statements.filter(s => !s.reconciled).length !== 1 ? 's' : ''}…
          </div>
        )}

        {/* Error banner — shown when diffs or statements fail to load */}
        {diffsError && !loadingDiffs && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 16,
            padding: '12px 16px', background: '#fef2f2', borderRadius: 8,
            border: '1px solid #fecaca', color: '#dc2626', fontSize: 13,
          }}>
            <span style={{ fontSize: 16, flexShrink: 0 }}>⚠</span>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>Could not load QBO data</div>
              <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{diffsError}</div>
              <button onClick={() => { setDiffsError(null); loadAllDiffs(activePeriod); }} style={{
                marginTop: 8, padding: '4px 12px', fontSize: 12, fontWeight: 600,
                border: '1px solid #fca5a5', borderRadius: 6, background: '#fff',
                cursor: 'pointer', color: '#dc2626',
              }}>↺ Retry</button>
            </div>
          </div>
        )}
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

        {/* Column headers — widths must match row cells exactly */}
        {!loadingStatements && statements.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', padding: '4px 12px 6px 20px',
            fontSize: 11, fontWeight: 700, color: '#94a3b8',
            textTransform: 'uppercase', letterSpacing: '.04em',
          }}>
            <div style={{ width: 185, flexShrink: 0 }}>Vendor</div>
            <div style={{ width: 94, flexShrink: 0 }}>Date</div>
            <div style={{ width: 124, flexShrink: 0 }}>Per Statement</div>
            <div style={{ width: 124, flexShrink: 0 }}>Per QBO</div>
            <div style={{ width: 108, flexShrink: 0 }}>Difference</div>
            <div style={{ width: 140, flexShrink: 0 }}>Status</div>
            <div style={{ width: 148, flexShrink: 0 }}>QBO Link</div>
            <div style={{ width: 88, flexShrink: 0, textAlign: 'center' }}>Reconciled</div>
            <div style={{ flex: 1 }}>Actions</div>
          </div>
        )}

        {/* Statement cards */}
        {!loadingStatements && statements.filter(s =>
          reconcileFilter === 'all' ? true :
          reconcileFilter === 'reconciled' ? s.reconciled === 1 :
          s.reconciled !== 1
        ).map(stmt => {
          const diffData = diffs[stmt.id];
          const diff = diffData?.data?.diff;
          const summary = diff?.summary;
          const isLoading = refreshing === stmt.id || (loadingDiffs && diffData === undefined);
          const isExpanded = expandedDiff === stmt.id;

          const qboBalForBorder = (diffData?.data as DiffResult | undefined)?.qbo_total_balance ?? null;
          const isManuallyReconciled = stmt.reconciled === 1;
          const isBalanced = qboBalForBorder !== null && Math.abs((stmt.closing_balance ?? 0) - qboBalForBorder) < 0.01;
          const hasData = qboBalForBorder !== null;
          const borderColor = isManuallyReconciled ? '#2563eb' : !hasData ? '#e2e8f0' : isBalanced ? '#16a34a' : '#dc2626';

          return (
            <div key={stmt.id} style={{
              background: '#fff', borderRadius: 12,
              border: '1px solid #e2e8f0',
              borderLeft: `4px solid ${borderColor}`,
              marginBottom: 8, overflow: 'hidden',
            }}>
              {/* Fixed-grid row — all widths match the column header exactly */}
              {(() => {
                const qboBalance = (diffData?.data as DiffResult | undefined)?.qbo_total_balance ?? null;
                const balDiff = qboBalance !== null ? (stmt.closing_balance ?? 0) - qboBalance : null;
                const diffColor = balDiff === null ? '#94a3b8' : Math.abs(balDiff) < 0.01 ? '#16a34a' : '#dc2626';
                // Shared cell style
                const cell: React.CSSProperties = { flexShrink: 0, overflow: 'hidden' };
                const iconBtn: React.CSSProperties = {
                  width: 28, height: 26, padding: 0, fontSize: 13, border: '1px solid #e2e8f0',
                  borderRadius: 6, background: '#f8fafc', cursor: 'pointer', color: '#64748b',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                };
                return (
                  <div style={{
                    padding: '9px 12px', display: 'flex', alignItems: 'center',
                    borderBottom: isExpanded ? '1px solid #f1f5f9' : 'none',
                    cursor: 'pointer',
                  }} onClick={() => setExpandedDiff(isExpanded ? null : stmt.id)}>

                    {/* Vendor */}
                    <div title={stmt.vendor_name} style={{
                      ...cell, width: 185,
                      fontWeight: 600, fontSize: 13, color: '#1e293b',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {stmt.vendor_name}
                    </div>

                    {/* Date */}
                    <div style={{ ...cell, width: 94, fontSize: 12, color: '#64748b' }}>
                      {stmt.statement_date || '—'}
                    </div>

                    {/* Per Statement */}
                    <div style={{ ...cell, width: 124, fontSize: 13, fontWeight: 600, color: '#1e293b' }}>
                      {fmt(stmt.closing_balance, stmt.currency)}
                    </div>

                    {/* Per QBO */}
                    <div style={{ ...cell, width: 124, fontSize: 13, fontWeight: 600, color: '#1e293b' }}>
                      {isLoading
                        ? <span style={{ color: '#94a3b8' }}>…</span>
                        : diffData?.source === 'error'
                          ? <span style={{ color: '#dc2626', fontSize: 11 }} title={(diffData as any).error}>⚠ Error</span>
                          : qboBalance !== null ? fmt(qboBalance, stmt.currency) : '—'}
                    </div>

                    {/* Difference */}
                    <div style={{ ...cell, width: 108, fontSize: 13, fontWeight: 700, color: diffColor }}>
                      {balDiff === null ? '—' : `${balDiff >= 0 ? '+' : ''}${fmt(balDiff, '')}`}
                    </div>

                    {/* Status badge — match summary only */}
                    <div style={{ ...cell, width: 140 }}>
                      {summary && !isLoading ? (
                        <span style={{
                          display: 'inline-block', fontSize: 11, fontWeight: 700,
                          padding: '2px 7px', borderRadius: 20, whiteSpace: 'nowrap',
                          maxWidth: 136, overflow: 'hidden', textOverflow: 'ellipsis',
                          background: summary.mismatch_count > 0 || summary.missing_from_qbo > 0 ? '#fef2f2'
                            : summary.extra_in_qbo > 0 ? '#fffbeb' : '#f0fdf4',
                          color: diffSummaryColor(diffData!.data),
                        }}>
                          {summary.mismatch_count === 0 && summary.missing_from_qbo === 0 && summary.extra_in_qbo === 0
                            ? `✓ ${summary.matched_count} matched`
                            : `⚠ ${[
                                summary.missing_from_qbo > 0 ? `${summary.missing_from_qbo} missing` : '',
                                summary.mismatch_count   > 0 ? `${summary.mismatch_count} mismatch` : '',
                                summary.extra_in_qbo     > 0 ? `${summary.extra_in_qbo} extra`     : '',
                              ].filter(Boolean).join(' · ')}`}
                        </span>
                      ) : null}
                    </div>

                    {/* QBO link */}
                    <div style={{ ...cell, width: 148 }} onClick={e => e.stopPropagation()}>

                      {links[stmt.vendor_name] ? (
                        <span title={links[stmt.vendor_name]!.qbo_vendor_name} style={{
                          display: 'flex', alignItems: 'center', gap: 3, maxWidth: 144,
                          background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 7,
                          padding: '2px 6px', color: '#15803d',
                        }}>
                          <span style={{ fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            🔗 {links[stmt.vendor_name]!.qbo_vendor_name}
                          </span>
                          <button onClick={() => removeLink(stmt.vendor_name)} title="Remove link"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: 0, fontSize: 10, flexShrink: 0 }}>✕</button>
                        </span>
                      ) : (
                        <button onClick={() => { setLinkingFor(stmt.vendor_name); setVendorSearch(''); setVendorResults([]); }}
                          style={{ padding: '2px 7px', fontSize: 11, border: '1px dashed #cbd5e1',
                            borderRadius: 7, background: '#f8fafc', cursor: 'pointer', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                          + Link QBO
                        </button>
                      )}
                    </div>

                    {/* Reconcile checkmark column */}
                    <div style={{ width: 88, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => toggleReconcile(stmt)}
                        disabled={reconcilingId === stmt.id}
                        title={isManuallyReconciled
                          ? `Reconciled${stmt.reconciled_at ? ` on ${new Date(stmt.reconciled_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}` : ''}${stmt.reconciled_note ? ` — ${stmt.reconciled_note}` : ''}\nClick to unreconcile`
                          : 'Mark as reconciled'}
                        style={{
                          width: 30, height: 30, padding: 0, border: 'none', borderRadius: '50%',
                          background: 'none', cursor: reconcilingId === stmt.id ? 'wait' : 'pointer',
                          fontSize: 20, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: isManuallyReconciled ? '#2563eb' : '#e2e8f0',
                          transition: 'color .15s',
                        }}
                        onMouseEnter={e => { if (!isManuallyReconciled) (e.currentTarget as HTMLButtonElement).style.color = '#93c5fd'; }}
                        onMouseLeave={e => { if (!isManuallyReconciled) (e.currentTarget as HTMLButtonElement).style.color = '#e2e8f0'; }}
                      >
                        {reconcilingId === stmt.id ? '…' : '✓'}
                      </button>
                    </div>

                    {/* Actions — compact icon buttons */}
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}
                      onClick={e => e.stopPropagation()}>

                      {/* View PDF */}
                      {stmt.pdf_r2_key && (
                        <button onClick={async () => {
                          const res = await fetch(`${API}/reconcile/statements/${stmt.id}/pdf`);
                          if (!res.ok) { alert('No PDF stored'); return; }
                          const { url } = await res.json();
                          window.open(url, '_blank');
                        }} style={iconBtn} title="View PDF">📄</button>
                      )}

                      {/* Attach / replace PDF */}
                      <label style={{
                        ...iconBtn,
                        cursor: attachingPdf === stmt.id ? 'wait' : 'pointer',
                        border: stmt.pdf_r2_key ? '1px solid #86efac' : '1.5px solid #f59e0b',
                        background: stmt.pdf_r2_key ? '#f0fdf4' : '#fffbeb',
                        color: stmt.pdf_r2_key ? '#15803d' : '#b45309',
                      }} title={stmt.pdf_r2_key ? 'Replace PDF' : 'Attach PDF'}>
                        {attachingPdf === stmt.id ? '⏳' : '📎'}
                        <input type="file" accept=".pdf,.png,.jpg,.jpeg" style={{ display: 'none' }}
                          ref={el => { pdfRefs.current[stmt.id] = el; }}
                          disabled={attachingPdf !== null}
                          onChange={e => {
                            const f = e.target.files?.[0];
                            if (f) handleAttachPdf(stmt.id, f);
                            if (pdfRefs.current[stmt.id]) pdfRefs.current[stmt.id]!.value = '';
                          }} />
                      </label>

                      {/* Refresh QBO */}
                      <button onClick={() => loadDiff(stmt.id, true)} disabled={isLoading}
                        style={{ ...iconBtn, fontSize: 14 }} title="Refresh from QBO">↺</button>

                      {/* Move to prev month — statement leaves this period, so remove from list */}
                      <button onClick={async () => {
                        const prev = prevPeriod(activePeriod);
                        if (!confirm(`Move ${stmt.vendor_name} to ${prev}?`)) return;
                        await fetch(`${API}/reconcile/statements/${stmt.id}/move`, {
                          method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ period: prev }),
                        });
                        setStatements(p => p.filter(s => s.id !== stmt.id));
                        setDiffs(p => { const n = { ...p }; delete n[stmt.id]; return n; });
                      }} style={iconBtn} title={`Move to ${prevPeriod(activePeriod)}`}>←</button>

                      {/* Delete */}
                      <button onClick={() => handleDelete(stmt.id, stmt.vendor_name)}
                        style={{ ...iconBtn, border: '1px solid #fecaca', background: '#fff', color: '#dc2626' }}
                        title="Delete statement">✕</button>

                      {/* Expand toggle */}
                      <span style={{ fontSize: 12, color: '#94a3b8', width: 16, textAlign: 'center', flexShrink: 0 }}>
                        {isExpanded ? '▲' : '▼'}
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* Expanded diff table */}
              {isExpanded && diff && (
                <div style={{ padding: '0 20px 20px' }}>
                  {/* Source indicator */}
                  <div style={{ fontSize: 11, color: '#94a3b8', margin: '12px 0 8px', textAlign: 'right' }}>
                    {diffData?.source === 'reconciled' ? `✓ Reconciled snapshot · locked ${(diffData as any).reconciled_at ? new Date((diffData as any).reconciled_at).toLocaleDateString() : ''}`
                      : diffData?.source === 'snapshot' ? '🔒 Frozen snapshot'
                      : `⟳ Live QBO · refreshed ${diffData?.data?.refreshed_at ? new Date(diffData.data.refreshed_at).toLocaleTimeString() : ''}`}
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
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f0fdf4')}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}
                  >
                    <span>{v.name}</span>
                    {!v.active && (
                      <span style={{
                        fontSize: 10, background: '#fef3c7', color: '#92400e',
                        border: '1px solid #fcd34d', borderRadius: 4, padding: '1px 5px',
                        flexShrink: 0,
                      }}>inactive</span>
                    )}
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
