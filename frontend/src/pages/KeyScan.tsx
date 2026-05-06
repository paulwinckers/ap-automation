/**
 * KeyScan.tsx — Public QR-code scan page for physical key check-in/out.
 * No login required. Accessed by scanning a QR code on the key box label.
 */

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getKey, getKeyEmployees, scanKey, transferKey, KeyEntry, KeyLogEntry } from '../lib/api';

const BG      = '#0f172a';
const CARD    = '#1e293b';
const BORDER  = '#334155';
const GREEN   = '#22c55e';
const RED     = '#ef4444';
const BLUE    = '#3b82f6';
const MUTED   = '#94a3b8';

function fmtTs(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
  return d.toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function typeLabel(t: string): string {
  if (t === 'vehicle')        return '🚗 Vehicle Spare';
  if (t === 'property_owner') return '🏠 Property Owner';
  return '📦 Other';
}

function actionIcon(action: string): string {
  if (action === 'out') return '↗';
  if (action === 'in')  return '↩';
  return '🤝';
}

export default function KeyScan() {
  const { id } = useParams<{ id: string }>();
  const keyId = Number(id);

  const [keyData, setKeyData]         = useState<KeyEntry | null>(null);
  const [checkedOut, setCheckedOut]   = useState(false);
  const [log, setLog]                 = useState<KeyLogEntry[]>([]);
  const [employees, setEmployees]     = useState<string[]>([]);
  const [selected, setSelected]       = useState('');
  const [notes, setNotes]             = useState('');
  const [loading, setLoading]         = useState(true);
  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState<{ action: 'in' | 'out' | 'transfer'; name: string; keyName: string; from?: string } | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('key_employee') || '';
    setSelected(saved);

    async function load() {
      try {
        const [keyRes, empRes] = await Promise.all([
          getKey(keyId),
          getKeyEmployees(),
        ]);
        setKeyData(keyRes.key);
        setCheckedOut(keyRes.checked_out);
        setLog(keyRes.log);
        setEmployees(empRes);
        // If saved employee not in list, clear it
        if (saved && !empRes.includes(saved)) setSelected('');
      } catch (e: unknown) {
        setError((e as Error).message || 'Failed to load key');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [keyId]);

  async function handleScan(action: 'in' | 'out') {
    if (!selected) { setError('Please select your name first'); return; }
    setError('');
    setSubmitting(true);
    try {
      await scanKey({ keyId, employeeName: selected, action, notes });
      localStorage.setItem('key_employee', selected);
      setSuccess({ action, name: selected, keyName: keyData?.name || '' });
      // Refresh key state
      const updated = await getKey(keyId);
      setKeyData(updated.key);
      setCheckedOut(updated.checked_out);
      setLog(updated.log);
      setNotes('');
    } catch (e: unknown) {
      setError((e as Error).message || 'Scan failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTransfer() {
    if (!selected) { setError('Please select your name first'); return; }
    setError('');
    setSubmitting(true);
    try {
      const res = await transferKey({ keyId, employeeName: selected, notes });
      localStorage.setItem('key_employee', selected);
      setSuccess({ action: 'transfer', name: selected, keyName: keyData?.name || '', from: res.from });
      const updated = await getKey(keyId);
      setKeyData(updated.key);
      setCheckedOut(updated.checked_out);
      setLog(updated.log);
      setNotes('');
    } catch (e: unknown) {
      setError((e as Error).message || 'Transfer failed');
    } finally {
      setSubmitting(false);
    }
  }

  const s: React.CSSProperties = {
    minHeight: '100vh',
    background: BG,
    color: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding: '0 0 40px',
  };

  if (loading) return (
    <div style={{ ...s, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: MUTED, fontSize: 16 }}>Loading key…</div>
    </div>
  );

  if (error && !keyData) return (
    <div style={{ ...s, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: RED, fontSize: 16, textAlign: 'center', padding: 24 }}>{error}</div>
    </div>
  );

  return (
    <div style={s}>
      {/* Header */}
      <div style={{ background: CARD, borderBottom: `1px solid ${BORDER}`, padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <img src="/darios-logo.png" alt="Darios" style={{ height: 32, objectFit: 'contain' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{keyData?.name || 'Key Box'}</div>
          <div style={{ color: MUTED, fontSize: 12 }}>{keyData ? typeLabel(keyData.key_type) : ''}</div>
        </div>
        <Link to="/" style={{ color: MUTED, fontSize: 12, textDecoration: 'none' }}>Home</Link>
      </div>

      <div style={{ maxWidth: 440, margin: '0 auto', padding: '24px 16px' }}>

        {/* Status Badge */}
        {keyData && (
          <div style={{
            background: checkedOut ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)',
            border: `1px solid ${checkedOut ? RED : GREEN}`,
            borderRadius: 12,
            padding: '16px 20px',
            marginBottom: 24,
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 28, marginBottom: 6 }}>{checkedOut ? '🔴' : '🟢'}</div>
            {checkedOut ? (
              <>
                <div style={{ color: RED, fontWeight: 700, fontSize: 17 }}>Key is Out</div>
                <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
                  With <strong style={{ color: '#fff' }}>{keyData.current_holder}</strong>
                  {keyData.last_scanned ? ` since ${fmtTs(keyData.last_scanned)}` : ''}
                </div>
              </>
            ) : (
              <>
                <div style={{ color: GREEN, fontWeight: 700, fontSize: 17 }}>Available</div>
                <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>Key is in the box</div>
              </>
            )}
            {keyData.description && (
              <div style={{ color: MUTED, fontSize: 12, marginTop: 8 }}>{keyData.description}</div>
            )}
            {keyData.property_name && (
              <div style={{ color: MUTED, fontSize: 12 }}>Property: {keyData.property_name}</div>
            )}
          </div>
        )}

        {/* Success State */}
        {success && (
          <div style={{
            background: 'rgba(34,197,94,0.15)',
            border: `1px solid ${GREEN}`,
            borderRadius: 12,
            padding: '20px',
            textAlign: 'center',
            marginBottom: 24,
          }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>
              {success.action === 'transfer' ? '🤝' : '✅'}
            </div>
            <div style={{ color: GREEN, fontWeight: 700, fontSize: 18 }}>
              {success.action === 'out' ? 'Checked Out' : success.action === 'in' ? 'Checked In' : 'Baton Passed!'}
            </div>
            <div style={{ color: MUTED, fontSize: 14, marginTop: 6 }}>
              {success.action === 'transfer'
                ? <>{success.keyName}<br /><span style={{ color: '#fff' }}>{success.from}</span> → <span style={{ color: '#fff' }}>{success.name}</span></>
                : <>{success.keyName} — {success.name}</>
              }
            </div>
            <button
              onClick={() => setSuccess(null)}
              style={{ marginTop: 16, background: BORDER, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', fontSize: 14, cursor: 'pointer' }}
            >
              Scan Again
            </button>
          </div>
        )}

        {/* Scan Form */}
        {!success && (
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 24 }}>
            <div style={{ fontWeight: 600, marginBottom: 16, fontSize: 15 }}>Who are you?</div>

            <select
              value={selected}
              onChange={e => { setSelected(e.target.value); setError(''); }}
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 8,
                background: '#0f172a', border: `1px solid ${BORDER}`, color: '#fff',
                fontSize: 16, marginBottom: 12, boxSizing: 'border-box',
              }}
            >
              <option value="">— Select your name —</option>
              {employees.map(emp => (
                <option key={emp} value={emp}>{emp}</option>
              ))}
            </select>

            <input
              type="text"
              placeholder="Notes (optional)"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 8,
                background: '#0f172a', border: `1px solid ${BORDER}`, color: '#fff',
                fontSize: 14, marginBottom: 16, boxSizing: 'border-box',
              }}
            />

            {error && (
              <div style={{ color: RED, fontSize: 13, marginBottom: 12 }}>{error}</div>
            )}

            {/* Pass the Baton — shown when key is out AND selected person is not the current holder */}
            {checkedOut && selected && keyData?.current_holder && selected !== keyData.current_holder ? (
              <div>
                {/* Baton info */}
                <div style={{
                  background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.35)',
                  borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13, color: '#fbbf24',
                  textAlign: 'center',
                }}>
                  🔑 Currently with <strong style={{ color: '#fff' }}>{keyData.current_holder}</strong>
                </div>
                <button
                  onClick={handleTransfer}
                  disabled={submitting}
                  style={{
                    width: '100%', padding: '16px', borderRadius: 10, border: 'none',
                    background: submitting ? '#334155' : '#f59e0b',
                    color: '#fff', fontSize: 18, fontWeight: 700,
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    transition: 'background 0.15s', marginBottom: 10,
                  }}
                >
                  {submitting ? 'Recording…' : '🤝 Pass the Baton to Me'}
                </button>
                <button
                  onClick={() => handleScan('in')}
                  disabled={submitting}
                  style={{
                    width: '100%', padding: '11px', borderRadius: 8, border: `1px solid ${BORDER}`,
                    background: 'transparent', color: MUTED, fontSize: 13, fontWeight: 600,
                    cursor: submitting ? 'not-allowed' : 'pointer',
                  }}
                >
                  ↩ Just Return Key to Box
                </button>
              </div>
            ) : (
              <button
                onClick={() => handleScan(checkedOut ? 'in' : 'out')}
                disabled={submitting || !selected}
                style={{
                  width: '100%', padding: '16px', borderRadius: 10, border: 'none',
                  background: submitting || !selected ? '#334155' : checkedOut ? BLUE : GREEN,
                  color: '#fff', fontSize: 18, fontWeight: 700,
                  cursor: submitting || !selected ? 'not-allowed' : 'pointer',
                  transition: 'background 0.15s',
                }}
              >
                {submitting ? 'Recording…' : checkedOut ? '↩ Check In Key' : '↗ Check Out Key'}
              </button>
            )}
          </div>
        )}

        {/* Recent Log */}
        {log.length > 0 && (
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 14, fontSize: 14, color: MUTED }}>Recent Activity</div>
            {log.map(entry => (
              <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${BORDER}` }}>
                <span style={{ fontSize: 16 }}>{actionIcon(entry.action)}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{entry.employee_name}</div>
                  <div style={{ fontSize: 11, color: MUTED }}>{fmtTs(entry.scanned_at)}</div>
                </div>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                  background: entry.action === 'out' ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
                  color: entry.action === 'out' ? RED : GREEN,
                }}>
                  {entry.action === 'out' ? 'OUT' : 'IN'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
