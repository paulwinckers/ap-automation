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
  total_amount: number | null;
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

function statusBadge(entry: FeedEntry) {
  if (entry.status === 'posted') {
    const dest = entry.destination === 'aspire' ? 'Aspire' : 'QBO';
    return (
      <span style={{ background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: 12, fontSize: 12, fontWeight: 600 }}>
        ✓ {dest}
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
  const [entries, setEntries]     = useState<FeedEntry[]>([]);
  const [counts, setCounts]       = useState<Counts | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [pulse, setPulse]         = useState(false);
  const [retrying, setRetrying]   = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    try {
      const [feedRes, countRes] = await Promise.all([
        fetch(`${API}/invoices/feed?limit=100`),
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

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, 10_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

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
    statCard: (color: string) => ({
      background: '#fff',
      border: `2px solid ${color}`,
      borderRadius: 10,
      padding: '12px 20px',
      minWidth: 130,
      flex: '1 1 130px',
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
          <div style={styles.statCard('#4ade80')}>
            <div style={styles.statLabel}>Posted Today</div>
            <div style={styles.statValue('#16a34a')}>{counts.posted}</div>
            <div style={styles.statSub}>{fmt(counts.posted_today_value)}</div>
          </div>
          <div style={styles.statCard('#fb923c')}>
            <div style={styles.statLabel}>Needs Review</div>
            <div style={styles.statValue('#ea580c')}>{counts.queued}</div>
            <div style={styles.statSub}>{fmt(counts.queued_value)} held</div>
          </div>
          <div style={styles.statCard('#f87171')}>
            <div style={styles.statLabel}>Errors</div>
            <div style={styles.statValue('#dc2626')}>{counts.errors}</div>
            <div style={styles.statSub}>requires attention</div>
          </div>
          <div style={styles.statCard('#60a5fa')}>
            <div style={styles.statLabel}>QBO Bills</div>
            <div style={styles.statValue('#2563eb')}>{counts.qbo}</div>
            <div style={styles.statSub}>overhead</div>
          </div>
          <div style={styles.statCard('#a78bfa')}>
            <div style={styles.statLabel}>Aspire</div>
            <div style={styles.statValue('#7c3aed')}>{counts.aspire}</div>
            <div style={styles.statSub}>job cost</div>
          </div>
        </div>
      )}

      {/* Feed table */}
      <div style={styles.tableWrap}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>Loading feed…</div>
        ) : entries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>No invoices yet.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Received</th>
                <th style={styles.th}>Vendor</th>
                <th style={styles.th}>Amount</th>
                <th style={styles.th}>Tax</th>
                <th style={styles.th}>GL Account</th>
                <th style={styles.th}>GL Name</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Ref #</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id} style={{ background: e.status === 'error' ? '#fff5f5' : e.status === 'queued' ? '#fffbeb' : undefined }}>
                  <td style={{ ...styles.td, color: '#94a3b8', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {timeAgo(e.received_at)}
                  </td>
                  <td style={{ ...styles.td, fontWeight: 500 }}>
                    {e.vendor_name || <span style={{ color: '#94a3b8' }}>Unknown</span>}
                    {e.intake_source === 'email' && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: '#94a3b8' }}>✉</span>
                    )}
                  </td>
                  <td style={{ ...styles.td, fontWeight: 600, textAlign: 'right' }}>
                    {fmt(e.total_amount)}
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
                    {e.status === 'error' && (
                      <button
                        onClick={() => retryInvoice(e.id)}
                        disabled={retrying === e.id}
                        style={{
                          marginLeft: 8, background: '#fef2f2', border: '1px solid #fca5a5',
                          color: '#dc2626', borderRadius: 6, padding: '2px 8px',
                          cursor: retrying === e.id ? 'wait' : 'pointer', fontSize: 11, fontWeight: 600,
                        }}
                      >
                        {retrying === e.id ? '…' : '↺ Retry'}
                      </button>
                    )}
                    {e.error_message && (
                      <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                           title={e.error_message}>
                        {e.error_message}
                      </div>
                    )}
                  </td>
                  <td style={{ ...styles.td, fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>
                    {e.qbo_bill_id || e.aspire_receipt_id || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
