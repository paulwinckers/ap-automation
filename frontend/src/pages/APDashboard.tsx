/**
 * AP Dashboard — live activity feed for accounting staff.
 * Polls /invoices/feed every 10 seconds.
 * Route: /ap
 */

import React, { useEffect, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? 'https://ap-automation-production.up.railway.app';

interface FeedEntry {
  id: number;
  status: 'pending' | 'queued' | 'posted' | 'error';
  destination: 'aspire' | 'qbo' | null;
  vendor_name: string | null;
  invoice_number: string | null;
  total_amount: number | null;
  qbo_amount: number | null;
  tax_amount: number | null;
  subtotal: number | null;
  gl_account: string | null;
  gl_name: string | null;
  qbo_bill_id: string | null;
  aspire_receipt_id: string | null;
  received_at: string;
  posted_at: string | null;
  error_message: string | null;
  intake_source: string | null;
  archived: number | null;
  forwarded_to: string | null;
  pdf_r2_key: string | null;
}

interface Counts {
  total: number;
  queued: number;
  posted: number;
  errors: number;
  qbo: number;
  aspire: number;
  queued_value: number;
  posted_today_value: number;
}

function fmt(n: number | null | undefined, currency = 'CAD') {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(n);
}

function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime()) / 1000;
  if (diff < 60)  return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-CA');
}

function forwardedLabel(email: string): string {
  if (email.toLowerCase().includes('keeland')) return 'Keeland';
  if (email.toLowerCase().includes('paul'))    return 'Paul';
  // Show just the part before @ for any other address
  return email.split('@')[0];
}

function statusBadge(entry: FeedEntry) {
  if (entry.status === 'posted') {
    const dest = entry.destination === 'aspire' ? 'Aspire' : 'QBO';
    return (
      <span style={{ background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: 12, fontSize: 12, fontWeight: 600 }}>
        ✓ {dest}
      </span>
    );
  }
  if (entry.forwarded_to) {
    return (
      <span style={{ background: '#e0f2fe', color: '#0369a1', padding: '2px 8px', borderRadius: 12, fontSize: 12, fontWeight: 600 }}
            title={`Emailed to ${entry.forwarded_to}`}>
        📤 Sent to {forwardedLabel(entry.forwarded_to)}
      </span>
    );
  }
  if (entry.status === 'queued') {
    return (
      <span style={{ background: '#fef9c3', color: '#854d0e', padding: '2px 8px', borderRadius: 12, fontSize: 12, fontWeight: 600 }}>
        ⏳ Review
      </span>
    );
  }
  if (entry.status === 'error') {
    return (
      <span style={{ background: '#fee2e2', color: '#991b1b', padding: '2px 8px', borderRadius: 12, fontSize: 12, fontWeight: 600 }}>
        ✗ Error
      </span>
    );
  }
  return (
    <span style={{ background: '#f1f5f9', color: '#475569', padding: '2px 8px', borderRadius: 12, fontSize: 12, fontWeight: 600 }}>
      ○ Pending
    </span>
  );
}

export default function APDashboard() {
  const [entries, setEntries]         = useState<FeedEntry[]>([]);
  const [counts, setCounts]           = useState<Counts | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [pulse, setPulse]             = useState(false);
  const [retrying, setRetrying]       = useState<number | null>(null);
  const [archiving, setArchiving]     = useState<number | null>(null);
  const [syncingQbo, setSyncingQbo]   = useState<number | null>(null);
  const [poInputs, setPoInputs]       = useState<Record<number, string>>({});
  const [poSaving, setPoSaving]       = useState<number | null>(null);
  const [view, setView]               = useState<'active' | 'archived'>('active');
  const [search, setSearch]           = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    try {
      const feedUrl = view === 'archived'
        ? `${API}/invoices/archived?limit=200`
        : `${API}/invoices/feed?limit=100`;

      const [feedRes, countRes] = await Promise.all([
        fetch(feedUrl),
        fetch(`${API}/invoices/counts`),
      ]);
      if (!feedRes.ok || !countRes.ok) throw new Error('API error');
      const feedData  = await feedRes.json();
      const countData = await countRes.json();
      setEntries(feedData.entries ?? []);
      setCounts(countData);
      setLastRefresh(new Date());
      setError(null);
      setPulse(true);
      setTimeout(() => setPulse(false), 600);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function applyPoOverride(id: number) {
    const po = (poInputs[id] || '').trim();
    if (!po) return;
    setPoSaving(id);
    try {
      const res = await fetch(`${API}/invoices/${id}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ po_number: po, reviewed_by: 'dashboard' }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`PO override failed: ${err.detail || res.statusText}`);
      } else {
        setPoInputs(p => { const n = {...p}; delete n[id]; return n; });
        await refresh();
      }
    } catch (e) {
      alert('PO override failed — check Railway logs');
    } finally {
      setPoSaving(null);
    }
  }

  async function retryInvoice(id: number) {
    setRetrying(id);
    try {
      await fetch(`${API}/invoices/${id}/retry`, { method: 'POST' });
      await refresh();
    } catch (e) {
      alert('Retry failed — check Railway logs');
    } finally {
      setRetrying(null);
    }
  }

  async function archiveInvoice(id: number) {
    setArchiving(id);
    try {
      await fetch(`${API}/invoices/${id}/archive`, { method: 'POST' });
      await refresh();
    } catch (e) {
      alert('Archive failed — check Railway logs');
    } finally {
      setArchiving(null);
    }
  }

  async function openPdf(id: number) {
    try {
      const res = await fetch(`${API}/invoices/${id}/pdf`);
      if (!res.ok) { alert('PDF not available for this invoice'); return; }
      const { url } = await res.json();
      window.open(url, '_blank');
    } catch (e) {
      alert('Could not load PDF');
    }
  }

  async function backfillQboAmounts() {
    try {
      const res = await fetch(`${API}/invoices/backfill-qbo-amounts`, { method: 'POST' });
      const data = await res.json();
      await refresh();
      if (data.updated === 0) {
        alert('Nothing to backfill — all QBO entries already have amounts.');
      } else {
        alert(`Backfilled QBO amounts for ${data.updated} invoice${data.updated !== 1 ? 's' : ''}.${data.failed ? ` (${data.failed} could not be fetched)` : ''}`);
      }
    } catch (e) {
      alert('Backfill failed — check Railway logs');
    }
  }

  async function archiveUnknowns() {
    if (!confirm('Archive all entries with no vendor name?')) return;
    try {
      const res = await fetch(`${API}/invoices/archive-unknown`, { method: 'POST' });
      const data = await res.json();
      await refresh();
      alert(`Archived ${data.archived} unknown entries.`);
    } catch (e) {
      alert('Bulk archive failed — check Railway logs');
    }
  }

  async function syncQboAmount(id: number) {
    setSyncingQbo(id);
    try {
      const res = await fetch(`${API}/invoices/${id}/sync-qbo-amount`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const data = await res.json();
      // Update just this entry inline so the row clears immediately
      setEntries(prev => prev.map(e => e.id === id ? { ...e, qbo_amount: data.qbo_amount } : e));
    } catch (e: any) {
      alert(`QBO sync failed: ${e.message}`);
    } finally {
      setSyncingQbo(null);
    }
  }

  async function unarchiveInvoice(id: number) {
    setArchiving(id);
    try {
      await fetch(`${API}/invoices/${id}/unarchive`, { method: 'POST' });
      await refresh();
    } catch (e) {
      alert('Unarchive failed — check Railway logs');
    } finally {
      setArchiving(null);
    }
  }

  // Re-fetch when view changes
  useEffect(() => {
    setLoading(true);
    setEntries([]);
    refresh();
  }, [view]);

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, 10_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  function toggleStatFilter(value: string) {
    setStatusFilter(f => f === value ? 'all' : value);
  }

  const forwardedCount = entries.filter(e => !!e.forwarded_to).length;

  // Filter entries client-side
  const filteredEntries = entries.filter(e => {
    // Status / destination filter
    if (statusFilter === 'forwarded') { if (!e.forwarded_to) return false; }
    else if (statusFilter === 'qbo')    { if (e.destination !== 'qbo')    return false; }
    else if (statusFilter === 'aspire') { if (e.destination !== 'aspire') return false; }
    else if (statusFilter !== 'all' && e.status !== statusFilter)     return false;
    // Search: vendor name, invoice number, GL name, ref
    if (search.trim()) {
      const q = search.toLowerCase();
      const haystack = [
        e.vendor_name,
        e.invoice_number,
        e.gl_name,
        e.gl_account,
        e.qbo_bill_id,
        e.aspire_receipt_id,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const styles = {
    page: {
      fontFamily: "'Inter', system-ui, sans-serif",
      background: '#f8fafc',
      minHeight: '100vh',
      color: '#1e293b',
    } as React.CSSProperties,
    header: {
      background: '#1e3a2f',
      color: '#fff',
      padding: '16px 24px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    } as React.CSSProperties,
    headerTitle: {
      fontSize: 20,
      fontWeight: 700,
      letterSpacing: '-0.3px',
    } as React.CSSProperties,
    refreshIndicator: {
      fontSize: 12,
      color: pulse ? '#4ade80' : '#94a3b8',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      transition: 'color 0.4s',
    } as React.CSSProperties,
    statsBar: {
      display: 'flex',
      gap: 16,
      padding: '16px 24px',
      flexWrap: 'wrap' as const,
    },
    statCard: (color: string, active: boolean) => ({
      background: active ? color + '22' : '#fff',
      border: `2px solid ${active ? color : color + '88'}`,
      borderRadius: 10,
      padding: '12px 20px',
      minWidth: 130,
      flex: '1 1 130px',
      cursor: 'pointer',
      transition: 'background 0.15s, border-color 0.15s',
      userSelect: 'none',
    } as React.CSSProperties),
    statLabel: {
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.8px',
      color: '#64748b',
      marginBottom: 4,
    },
    statValue: (color: string) => ({
      fontSize: 24,
      fontWeight: 700,
      color,
    } as React.CSSProperties),
    statSub: {
      fontSize: 12,
      color: '#94a3b8',
      marginTop: 2,
    } as React.CSSProperties,
    tableWrap: {
      padding: '0 24px 24px',
      overflowX: 'auto' as const,
    },
    table: {
      width: '100%',
      borderCollapse: 'collapse' as const,
      background: '#fff',
      borderRadius: 12,
      overflow: 'hidden',
      boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
    },
    th: {
      background: '#f1f5f9',
      padding: '10px 14px',
      textAlign: 'left' as const,
      fontSize: 11,
      fontWeight: 700,
      color: '#64748b',
      textTransform: 'uppercase' as const,
      letterSpacing: '0.6px',
      borderBottom: '1px solid #e2e8f0',
      whiteSpace: 'nowrap' as const,
    },
    td: {
      padding: '10px 14px',
      fontSize: 13,
      borderBottom: '1px solid #f1f5f9',
      verticalAlign: 'top' as const,
    } as React.CSSProperties,
  };

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <div style={styles.headerTitle}>Dario's AP Dashboard</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>Live activity feed</div>
        </div>
        <div style={styles.refreshIndicator}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: pulse ? '#4ade80' : '#475569',
            display: 'inline-block',
            transition: 'background 0.4s',
          }} />
          {error ? `Error — ${error}` : `Updated ${lastRefresh.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`}
          <button
            onClick={refresh}
            style={{
              marginLeft: 8, background: 'transparent', border: '1px solid #475569',
              color: '#cbd5e1', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 12,
            }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Stats bar */}
      {counts && (
        <div style={styles.statsBar}>
          <div style={styles.statCard('#4ade80', statusFilter === 'posted')} onClick={() => toggleStatFilter('posted')}>
            <div style={styles.statLabel}>Posted Today</div>
            <div style={styles.statValue('#16a34a')}>{counts.posted}</div>
            <div style={styles.statSub}>{fmt(counts.posted_today_value)}</div>
          </div>
          <div style={styles.statCard('#fb923c', statusFilter === 'queued')} onClick={() => toggleStatFilter('queued')}>
            <div style={styles.statLabel}>Needs Review</div>
            <div style={styles.statValue('#ea580c')}>{counts.queued}</div>
            <div style={styles.statSub}>{fmt(counts.queued_value)} held</div>
          </div>
          <div style={styles.statCard('#f87171', statusFilter === 'error')} onClick={() => toggleStatFilter('error')}>
            <div style={styles.statLabel}>Errors</div>
            <div style={styles.statValue('#dc2626')}>{counts.errors}</div>
            <div style={styles.statSub}>requires attention</div>
          </div>
          <div style={styles.statCard('#60a5fa', statusFilter === 'qbo')} onClick={() => toggleStatFilter('qbo')}>
            <div style={styles.statLabel}>QBO Bills</div>
            <div style={styles.statValue('#2563eb')}>{counts.qbo}</div>
            <div style={styles.statSub}>overhead</div>
          </div>
          <div style={styles.statCard('#a78bfa', statusFilter === 'aspire')} onClick={() => toggleStatFilter('aspire')}>
            <div style={styles.statLabel}>Aspire</div>
            <div style={styles.statValue('#7c3aed')}>{counts.aspire}</div>
            <div style={styles.statSub}>job cost posted</div>
          </div>
          <div style={styles.statCard('#22d3ee', statusFilter === 'forwarded')} onClick={() => toggleStatFilter('forwarded')}>
            <div style={styles.statLabel}>Forwarded</div>
            <div style={styles.statValue('#0e7490')}>{forwardedCount}</div>
            <div style={styles.statSub}>pending Aspire entry</div>
          </div>
        </div>
      )}

      {/* Toolbar: tabs + search + filter */}
      <div style={{ padding: '0 24px 12px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {/* View tabs */}
        <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid #e2e8f0' }}>
          <button
            onClick={() => setView('active')}
            style={{
              padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none',
              background: view === 'active' ? '#1e3a2f' : '#fff',
              color: view === 'active' ? '#fff' : '#64748b',
            }}
          >
            Active
          </button>
          <button
            onClick={() => setView('archived')}
            style={{
              padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              border: 'none', borderLeft: '1px solid #e2e8f0',
              background: view === 'archived' ? '#1e3a2f' : '#fff',
              color: view === 'archived' ? '#fff' : '#64748b',
            }}
          >
            📦 Archive
          </button>
        </div>

        {/* Search box */}
        <input
          type="text"
          placeholder="Search vendor, invoice #, GL…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: '1 1 200px', maxWidth: 320, padding: '6px 12px', fontSize: 13,
            border: '1px solid #e2e8f0', borderRadius: 8, outline: 'none',
            background: '#fff', color: '#1e293b',
          }}
        />

        {/* Status filter */}
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          style={{
            padding: '6px 12px', fontSize: 13, border: '1px solid #e2e8f0',
            borderRadius: 8, background: '#fff', color: '#1e293b', cursor: 'pointer',
          }}
        >
          <option value="all">All statuses</option>
          <option value="posted">✓ Posted</option>
          <option value="queued">⏳ Review</option>
          <option value="error">✗ Error</option>
          <option value="pending">○ Pending</option>
          <option value="forwarded">📤 Forwarded (job cost)</option>
          <option value="qbo">QBO Bills</option>
          <option value="aspire">Aspire</option>
        </select>

        {/* Backfill QBO amounts — fetches TotalAmt from QBO for existing posted invoices */}
        <button
          onClick={backfillQboAmounts}
          title="Fetch confirmed QBO amounts for all previously posted invoices"
          style={{
            padding: '6px 12px', fontSize: 12, cursor: 'pointer',
            border: '1px solid #e2e8f0', borderRadius: 8,
            background: '#fff', color: '#64748b',
          }}
        >
          ↻ Sync QBO amounts
        </button>

        {/* Bulk archive unknowns — only in active view */}
        {view === 'active' && (
          <button
            onClick={archiveUnknowns}
            title="Archive all entries with no vendor name"
            style={{
              padding: '6px 12px', fontSize: 12, cursor: 'pointer',
              border: '1px solid #e2e8f0', borderRadius: 8,
              background: '#fff', color: '#94a3b8',
            }}
          >
            🗑 Archive unknowns
          </button>
        )}

        {/* Result count */}
        <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 'auto' }}>
          {filteredEntries.length} {filteredEntries.length === 1 ? 'row' : 'rows'}
          {(search || statusFilter !== 'all') && entries.length !== filteredEntries.length
            ? ` of ${entries.length}` : ''}
        </span>
      </div>

      {/* Feed table */}
      <div style={styles.tableWrap}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>Loading feed…</div>
        ) : filteredEntries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
            {view === 'archived' ? 'No archived invoices.' : search || statusFilter !== 'all' ? 'No results match your filter.' : 'No invoices yet.'}
          </div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Received</th>
                <th style={styles.th}>Vendor</th>
                <th style={styles.th}>Invoice #</th>
                <th style={styles.th}>Amount</th>
                <th style={styles.th}>QBO Total</th>
                <th style={styles.th}>Tax</th>
                <th style={styles.th}>GL Account</th>
                <th style={styles.th}>GL Name</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Ref #</th>
              </tr>
            </thead>
            <tbody>
              {filteredEntries.map(e => {
                const amountMismatch =
                  e.qbo_amount != null &&
                  e.total_amount != null &&
                  Math.abs(e.qbo_amount - e.total_amount) > 0.01;
                const rowBg = amountMismatch
                  ? '#fff3cd'
                  : e.status === 'error' ? '#fff5f5'
                  : e.status === 'queued' ? '#fffbeb'
                  : undefined;
                return (
                <tr key={e.id} style={{ background: rowBg }}>
                  <td style={{ ...styles.td, color: '#94a3b8', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {timeAgo(e.received_at)}
                  </td>
                  <td style={{ ...styles.td, fontWeight: 500 }}>
                    {e.vendor_name || <span style={{ color: '#94a3b8' }}>Unknown</span>}
                    {e.intake_source === 'email' && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: '#94a3b8' }}>✉</span>
                    )}
                  </td>
                  <td style={{ ...styles.td, fontSize: 12, color: '#64748b', fontFamily: 'monospace' }}>
                    {e.invoice_number || '—'}
                  </td>
                  <td style={{ ...styles.td, fontWeight: 600, textAlign: 'right' }}>
                    {fmt(e.total_amount)}
                  </td>
                  <td style={{
                    ...styles.td, textAlign: 'right',
                    fontWeight: amountMismatch ? 700 : undefined,
                    color: amountMismatch ? '#b45309' : e.qbo_amount != null ? '#1e293b' : '#94a3b8',
                    background: amountMismatch ? '#fde68a' : undefined,
                  }}>
                    {e.qbo_amount != null ? (
                      <>
                        {fmt(e.qbo_amount)}
                        {amountMismatch && (
                          <>
                            <span title="Does not match invoice amount"> ⚠</span>
                            <button
                              onClick={() => syncQboAmount(e.id)}
                              disabled={syncingQbo === e.id}
                              title="Re-fetch amount from QBO"
                              style={{
                                marginLeft: 6, padding: '1px 6px', fontSize: 10,
                                cursor: syncingQbo === e.id ? 'wait' : 'pointer',
                                border: '1px solid #d97706', borderRadius: 4,
                                background: '#fef3c7', color: '#92400e', fontWeight: 600,
                              }}
                            >
                              {syncingQbo === e.id ? '…' : '↻'}
                            </button>
                          </>
                        )}
                      </>
                    ) : e.destination === 'qbo' && e.status === 'posted' ? (
                      <span style={{ color: '#94a3b8', fontSize: 11 }}>—</span>
                    ) : ''}
                  </td>
                  <td style={{ ...styles.td, textAlign: 'right', color: e.tax_amount ? '#1e293b' : '#94a3b8' }}>
                    {e.tax_amount ? fmt(e.tax_amount) : '—'}
                  </td>
                  <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 12, color: '#475569' }}>
                    {e.gl_account || '—'}
                  </td>
                  <td style={{ ...styles.td, color: '#475569' }}>
                    {e.gl_name || (e.destination === 'aspire' ? 'Job Cost' : '—')}
                  </td>
                  <td style={styles.td}>
                    {statusBadge(e)}

                    {/* Retry button — error / queued / pending */}
                    {(e.status === 'error' || e.status === 'queued' || e.status === 'pending') && view === 'active' && (
                      <button
                        onClick={() => retryInvoice(e.id)}
                        disabled={retrying === e.id}
                        style={{
                          marginLeft: 8,
                          background: e.status === 'error' ? '#fef2f2' : e.status === 'pending' ? '#f0f9ff' : '#fffbeb',
                          border: `1px solid ${e.status === 'error' ? '#fca5a5' : e.status === 'pending' ? '#7dd3fc' : '#fcd34d'}`,
                          color: e.status === 'error' ? '#dc2626' : e.status === 'pending' ? '#0369a1' : '#b45309',
                          borderRadius: 6, padding: '2px 8px',
                          cursor: retrying === e.id ? 'wait' : 'pointer', fontSize: 11, fontWeight: 600,
                        }}
                      >
                        {retrying === e.id ? '…' : '↺ Retry'}
                      </button>
                    )}

                    {/* Archive button — only for unposted, unforwarded entries */}
                    {view === 'active' && e.status !== 'posted' && !e.forwarded_to && (
                      <button
                        onClick={() => archiveInvoice(e.id)}
                        disabled={archiving === e.id}
                        title="Move to archive"
                        style={{
                          marginLeft: 8,
                          background: '#f8fafc', border: '1px solid #cbd5e1',
                          color: '#64748b', borderRadius: 6, padding: '2px 8px',
                          cursor: archiving === e.id ? 'wait' : 'pointer', fontSize: 11,
                        }}
                      >
                        {archiving === e.id ? '…' : '📦'}
                      </button>
                    )}

                    {/* Unarchive button — archive view */}
                    {view === 'archived' && (
                      <button
                        onClick={() => unarchiveInvoice(e.id)}
                        disabled={archiving === e.id}
                        title="Restore to active feed"
                        style={{
                          marginLeft: 8,
                          background: '#f0fdf4', border: '1px solid #86efac',
                          color: '#16a34a', borderRadius: 6, padding: '2px 8px',
                          cursor: archiving === e.id ? 'wait' : 'pointer', fontSize: 11,
                        }}
                      >
                        {archiving === e.id ? '…' : '↩ Restore'}
                      </button>
                    )}

                    {/* PDF viewer button — only shown when PDF is stored in R2 */}
                    {e.pdf_r2_key && (
                      <button
                        onClick={() => openPdf(e.id)}
                        title="View invoice PDF"
                        style={{
                          marginLeft: 8,
                          background: '#fafaf9', border: '1px solid #d6d3d1',
                          color: '#78716c', borderRadius: 6, padding: '2px 8px',
                          cursor: 'pointer', fontSize: 11,
                        }}
                      >
                        📄
                      </button>
                    )}

                    {/* Error message */}
                    {e.error_message && (
                      <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                           title={e.error_message}>
                        {e.error_message}
                      </div>
                    )}

                    {/* PO override input */}
                    {(e.status === 'queued' || e.status === 'error') && view === 'active' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 }}>
                        <input
                          type="text"
                          placeholder="Enter PO #"
                          value={poInputs[e.id] || ''}
                          onChange={ev => setPoInputs(p => ({ ...p, [e.id]: ev.target.value }))}
                          onKeyDown={ev => ev.key === 'Enter' && applyPoOverride(e.id)}
                          style={{
                            fontSize: 11, padding: '2px 6px', borderRadius: 5,
                            border: '1px solid #cbd5e1', width: 80, outline: 'none',
                          }}
                        />
                        <button
                          onClick={() => applyPoOverride(e.id)}
                          disabled={poSaving === e.id || !poInputs[e.id]}
                          style={{
                            fontSize: 11, padding: '2px 7px', borderRadius: 5,
                            background: '#f0f9ff', border: '1px solid #7dd3fc',
                            color: '#0369a1', fontWeight: 600,
                            cursor: poSaving === e.id ? 'wait' : 'pointer',
                          }}
                        >
                          {poSaving === e.id ? '…' : '✓ PO'}
                        </button>
                      </div>
                    )}
                  </td>
                  <td style={{ ...styles.td, fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>
                    {e.qbo_bill_id ? (
                      <a
                        href={`https://app.qbo.intuit.com/app/bill?txnId=${e.qbo_bill_id}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: '#2563eb', textDecoration: 'none' }}
                        title="Open in QuickBooks"
                      >
                        {e.qbo_bill_id} ↗
                      </a>
                    ) : e.aspire_receipt_id || '—'}
                  </td>
                </tr>
              );})}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
