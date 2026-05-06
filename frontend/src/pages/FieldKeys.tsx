/**
 * FieldKeys.tsx — Field-facing key search and check-in/out page.
 * Public, no login required. Accessible at /field/keys.
 *
 * Flow:
 *   1. Browse / search all keys (filtered by type or name)
 *   2. Tap a key to expand the check-in/out form
 *   3. Pick employee name (saved to localStorage), confirm action
 *   4. Status updates inline
 */

import { useState, useEffect, useRef } from 'react';
import { listKeysPublic, getKeyEmployees, scanKey, transferKey, type KeyEntry } from '../lib/api';

const TYPE_LABELS: Record<string, string> = {
  vehicle:        '🚗 Vehicle Spare',
  property_owner: '🏠 Property Owner',
  other:          '📦 Other',
};

const TYPE_FILTERS = [
  { value: 'all',            label: 'All' },
  { value: 'vehicle',        label: '🚗 Vehicle' },
  { value: 'property_owner', label: '🏠 Property' },
  { value: 'other',          label: '📦 Other' },
];

function fmtTs(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
  return d.toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const S: Record<string, any> = {
  page:     { minHeight: '100vh', background: '#0f172a', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', paddingBottom: 40 },
  header:   { background: '#1e293b', borderBottom: '1px solid #334155', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, position: 'sticky', top: 0, zIndex: 10 },
  logo:     { height: 32, objectFit: 'contain' as const },
  title:    { color: '#fff', fontWeight: 700, fontSize: 16, flex: 1 },
  homeBtn:  { color: '#94a3b8', fontSize: 13, textDecoration: 'none', padding: '6px 10px', borderRadius: 6, border: '1px solid #334155' },
  body:     { padding: '16px', maxWidth: 480, margin: '0 auto' },
  search:   { width: '100%', background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: 15, boxSizing: 'border-box' as const, marginBottom: 10 },
  filters:  { display: 'flex', gap: 6, marginBottom: 14, overflowX: 'auto' as const, paddingBottom: 2 },
  filterBtn:(active: boolean): React.CSSProperties => ({
    flexShrink: 0, padding: '6px 14px', borderRadius: 20, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
    background: active ? '#2563eb' : '#1e293b',
    color:      active ? '#fff'    : '#94a3b8',
  }),
  card:     { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, marginBottom: 10, overflow: 'hidden' as const },
  cardOpen: { background: '#1e293b', border: '1px solid #3b82f6', borderRadius: 12, marginBottom: 10, overflow: 'hidden' as const },
  cardTop:  { padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 },
  dot:      (out: boolean): React.CSSProperties => ({
    width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
    background: out ? '#ef4444' : '#22c55e',
  }),
  keyName:  { color: '#fff', fontWeight: 700, fontSize: 15, flex: 1 },
  badge:    { fontSize: 11, color: '#94a3b8' },
  status:   (out: boolean): React.CSSProperties => ({
    fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
    background: out ? '#7f1d1d' : '#14532d',
    color:      out ? '#fca5a5' : '#86efac',
    whiteSpace: 'nowrap',
  }),
  form:     { borderTop: '1px solid #334155', padding: '14px 16px', background: '#172033' },
  select:   { width: '100%', background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: '10px 12px', color: '#fff', fontSize: 15, marginBottom: 10, boxSizing: 'border-box' as const },
  btnOut:   { width: '100%', padding: 14, borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 16, cursor: 'pointer', background: '#16a34a', color: '#fff' },
  btnIn:    { width: '100%', padding: 14, borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 16, cursor: 'pointer', background: '#2563eb', color: '#fff' },
  btnDis:   { width: '100%', padding: 14, borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 16, cursor: 'not-allowed', background: '#334155', color: '#64748b' },
  success:  { background: '#14532d', border: '1px solid #16a34a', borderRadius: 8, padding: '10px 14px', color: '#86efac', fontSize: 13, fontWeight: 600, marginTop: 10, textAlign: 'center' as const },
  empty:    { color: '#475569', textAlign: 'center' as const, padding: '40px 0', fontSize: 14 },
};

interface KeyCardProps {
  k:         KeyEntry;
  employees: string[];
  onUpdated: (id: number, action: 'in' | 'out', employee: string) => void;
}

function KeyCard({ k, employees, onUpdated }: KeyCardProps) {
  const [open,        setOpen]        = useState(false);
  const [employee,    setEmployee]    = useState(() => localStorage.getItem('key_employee') || '');
  const [returnEmp,   setReturnEmp]   = useState(() => localStorage.getItem('key_employee') || '');
  const [saving,      setSaving]      = useState(false);
  const [done,        setDone]        = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);

  const isOut = k.last_action === 'out';

  function handleOpen() {
    setOpen(o => !o);
    setDone(null);
  }

  function handleEmployee(name: string) {
    setEmployee(name);
    localStorage.setItem('key_employee', name);
  }

  function handleReturnEmp(name: string) {
    setReturnEmp(name);
    localStorage.setItem('key_employee', name);
  }

  async function handleCheckOut() {
    if (!employee) return;
    setSaving(true);
    try {
      await scanKey({ keyId: k.id, employeeName: employee, action: 'out' });
      setDone(`✓ Checked out to ${employee}`);
      onUpdated(k.id, 'out', employee);
      setTimeout(() => { setOpen(false); setDone(null); }, 2000);
    } catch (e: unknown) {
      setDone(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleReturn() {
    if (!returnEmp) return;
    setSaving(true);
    try {
      await scanKey({ keyId: k.id, employeeName: returnEmp, action: 'in' });
      setDone(`✓ Returned by ${returnEmp}`);
      onUpdated(k.id, 'in', returnEmp);
      setTimeout(() => { setOpen(false); setDone(null); }, 2000);
    } catch (e: unknown) {
      setDone(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleTransfer() {
    if (!employee) return;
    setSaving(true);
    try {
      await transferKey({ keyId: k.id, employeeName: employee });
      setDone(`✓ Passed to ${employee}`);
      onUpdated(k.id, 'out', employee);
      setTimeout(() => { setOpen(false); setDone(null); }, 2000);
    } catch (e: unknown) {
      setDone(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  const othersEmployees = employees.filter(n => n !== k.current_holder);

  return (
    <div style={open ? S.cardOpen : S.card}>
      <div style={S.cardTop} onClick={handleOpen}>
        <div style={S.dot(isOut)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.keyName}>{k.name}</div>
          <div style={S.badge}>
            {TYPE_LABELS[k.key_type]}
            {k.property_name ? ` · ${k.property_name}` : ''}
            {k.description   ? ` · ${k.description}`   : ''}
          </div>
        </div>
        <span style={S.status(isOut)}>
          {isOut ? `Out · ${k.current_holder}` : 'Available'}
        </span>
      </div>

      {open && (
        <div style={S.form}>
          {done ? (
            <div style={{
              ...S.success,
              background: done.startsWith('Error') ? '#7f1d1d' : '#14532d',
              borderColor: done.startsWith('Error') ? '#dc2626' : '#16a34a',
              color:       done.startsWith('Error') ? '#fca5a5' : '#86efac',
            }}>{done}</div>
          ) : isOut ? (
            /* ── Key is out: show Pass the Baton + Return sections ── */
            <div>
              {/* Pass the Baton */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ color: '#fbbf24', fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                  🤝 Taking this key?
                </div>
                <select
                  ref={selectRef}
                  style={{ ...S.select, borderColor: '#78350f', marginBottom: 8 }}
                  value={othersEmployees.includes(employee) ? employee : ''}
                  onChange={e => handleEmployee(e.target.value)}
                >
                  <option value="">— Who are you? —</option>
                  {othersEmployees.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <button
                  style={(!employee || !othersEmployees.includes(employee) || saving)
                    ? S.btnDis
                    : { ...S.btnOut, background: '#d97706' }}
                  disabled={!employee || !othersEmployees.includes(employee) || saving}
                  onClick={handleTransfer}
                >
                  {saving ? 'Saving…' : '🤝 Pass the Baton to Me'}
                </button>
              </div>

              {/* Divider */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0' }}>
                <div style={{ flex: 1, height: 1, background: '#334155' }} />
                <span style={{ color: '#475569', fontSize: 11 }}>or</span>
                <div style={{ flex: 1, height: 1, background: '#334155' }} />
              </div>

              {/* Return to box */}
              <div>
                <div style={{ color: '#94a3b8', fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                  ↩ Returning to box?
                </div>
                <div style={{ color: '#64748b', fontSize: 12, marginBottom: 8 }}>
                  Checked out by <strong style={{ color: '#fca5a5' }}>{k.current_holder}</strong> · {fmtTs(k.last_scanned)}
                </div>
                <select
                  style={{ ...S.select, marginBottom: 8 }}
                  value={returnEmp}
                  onChange={e => handleReturnEmp(e.target.value)}
                >
                  <option value="">— Select your name —</option>
                  {employees.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <button
                  style={!returnEmp || saving ? S.btnDis : S.btnIn}
                  disabled={!returnEmp || saving}
                  onClick={handleReturn}
                >
                  {saving ? 'Saving…' : '↩ Return Key'}
                </button>
              </div>
            </div>
          ) : (
            /* ── Key is available: simple check-out ── */
            <div>
              <select
                ref={selectRef}
                style={S.select}
                value={employee}
                onChange={e => handleEmployee(e.target.value)}
              >
                <option value="">— Select your name —</option>
                {employees.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <button
                style={!employee || saving ? S.btnDis : S.btnOut}
                disabled={!employee || saving}
                onClick={handleCheckOut}
              >
                {saving ? 'Saving…' : '🔑 Check Out'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function FieldKeys() {
  const [keys,      setKeys]      = useState<KeyEntry[]>([]);
  const [employees, setEmployees] = useState<string[]>([]);
  const [search,    setSearch]    = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listKeysPublic(), getKeyEmployees()])
      .then(([ks, emps]) => { setKeys(ks); setEmployees(emps); })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Update a key's status inline after a scan (no full reload needed)
  function handleUpdated(id: number, action: 'in' | 'out', employee: string) {
    setKeys(prev => prev.map(k => k.id !== id ? k : {
      ...k,
      last_action:    action,
      current_holder: action === 'out' ? employee : null,
      last_scanned:   new Date().toISOString(),
    }));
  }

  const filtered = keys.filter(k => {
    if (typeFilter !== 'all' && k.key_type !== typeFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const hay = [k.name, k.property_name, k.description, k.current_holder].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Sort: checked-out first (so available don't bury urgent returns), then by name
  const sorted = [...filtered].sort((a, b) => {
    const aOut = a.last_action === 'out' ? 0 : 1;
    const bOut = b.last_action === 'out' ? 0 : 1;
    if (aOut !== bOut) return aOut - bOut;
    return a.name.localeCompare(b.name);
  });

  return (
    <div style={S.page}>
      <div style={S.header}>
        <a href="/" title="Home"><img src="/darios-logo.png" alt="Darios" style={S.logo} /></a>
        <span style={S.title}>🔑 Key Box</span>
        <a href="/" style={S.homeBtn}>🏠 Home</a>
      </div>

      <div style={S.body}>
        <input
          style={S.search}
          placeholder="Search keys…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        <div style={S.filters}>
          {TYPE_FILTERS.map(f => (
            <button
              key={f.value}
              style={S.filterBtn(typeFilter === f.value)}
              onClick={() => setTypeFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {loading && <div style={S.empty}>Loading keys…</div>}
        {error   && <div style={{ ...S.empty, color: '#fca5a5' }}>{error}</div>}

        {!loading && !error && sorted.length === 0 && (
          <div style={S.empty}>No keys found.</div>
        )}

        {sorted.map(k => (
          <KeyCard
            key={k.id}
            k={k}
            employees={employees}
            onUpdated={handleUpdated}
          />
        ))}
      </div>
    </div>
  );
}
