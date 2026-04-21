/**
 * KeysAdmin.tsx — Admin page for managing the physical key box.
 * Login required. Two tabs: Keys (with QR codes) and Activity Log.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listKeys, createKey, updateKey, deactivateKey, getKeyFullLog,
  searchAspireProperties, KeyEntry, KeyLogEntry,
} from '../lib/api';

const BG     = '#0f172a';
const CARD   = '#1e293b';
const BORDER = '#334155';
const GREEN  = '#22c55e';
const RED    = '#ef4444';
const BLUE   = '#3b82f6';
const MUTED  = '#94a3b8';
const YELLOW = '#f59e0b';

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

function typeBadge(t: string) {
  const label = t === 'vehicle' ? 'Vehicle' : t === 'property_owner' ? 'Property Owner' : 'Other';
  const color = t === 'vehicle' ? BLUE : t === 'property_owner' ? YELLOW : MUTED;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
      background: `${color}22`, color,
    }}>{label}</span>
  );
}

function printLabel(key: KeyEntry) {
  const url = `${window.location.origin}/keys/scan/${key.id}`;
  const qr  = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`;
  const w = window.open('', '_blank', 'width=400,height=500');
  w?.document.write(`<!DOCTYPE html><html><head><title>${key.name}</title>
    <style>body{font-family:sans-serif;text-align:center;padding:20px}
    img{width:250px;height:250px} h2{font-size:18px;margin:12px 0 4px}
    p{color:#666;font-size:13px;margin:0}</style></head><body>
    <img src="${qr}" />
    <h2>${key.name}</h2>
    <p>${key.key_type === 'vehicle' ? '🚗 Vehicle Spare' : key.key_type === 'property_owner' ? '🏠 Property Owner' : '📦 Other'}</p>
    <script>window.onload=()=>{window.print();window.close();}<\/script>
    </body></html>`);
}

// ── Add Key Form ──────────────────────────────────────────────────────────────

interface AddKeyFormProps {
  onCreated: () => void;
  onCancel: () => void;
}

function AddKeyForm({ onCreated, onCancel }: AddKeyFormProps) {
  const [name, setName]               = useState('');
  const [keyType, setKeyType]         = useState('vehicle');
  const [description, setDescription] = useState('');
  const [propertyName, setPropertyName] = useState('');
  const [propSearch, setPropSearch]   = useState('');
  const [propResults, setPropResults] = useState<{ property_id: number; property_name: string; address: string }[]>([]);
  const [searching, setSearching]     = useState(false);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');

  async function doSearch(q: string) {
    if (q.length < 2) { setPropResults([]); return; }
    setSearching(true);
    try {
      const res = await searchAspireProperties(q);
      setPropResults(res);
    } finally { setSearching(false); }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    try {
      await createKey({ name: name.trim(), keyType, description, propertyName });
      onCreated();
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to create key');
    } finally { setSaving(false); }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    background: BG, border: `1px solid ${BORDER}`, color: '#fff',
    fontSize: 14, boxSizing: 'border-box', marginBottom: 10,
  };

  return (
    <form onSubmit={handleSubmit} style={{ background: CARD, border: `1px solid ${BLUE}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16 }}>Add New Key</div>

      <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>Name *</label>
      <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Ford F-150 Spare" style={inputStyle} />

      <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>Type *</label>
      <select value={keyType} onChange={e => { setKeyType(e.target.value); setPropertyName(''); setPropResults([]); }} style={inputStyle}>
        <option value="vehicle">Vehicle Spare</option>
        <option value="property_owner">Property Owner</option>
        <option value="other">Other</option>
      </select>

      <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>Description</label>
      <input type="text" value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional details" style={inputStyle} />

      {keyType === 'property_owner' && (
        <>
          <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>Property (search Aspire)</label>
          <input
            type="text"
            value={propSearch}
            onChange={e => { setPropSearch(e.target.value); doSearch(e.target.value); }}
            placeholder="Start typing property name…"
            style={inputStyle}
          />
          {searching && <div style={{ color: MUTED, fontSize: 12, marginBottom: 8 }}>Searching…</div>}
          {propResults.length > 0 && (
            <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, marginBottom: 10 }}>
              {propResults.map(p => (
                <div
                  key={p.property_id}
                  onClick={() => { setPropertyName(p.property_name); setPropSearch(p.property_name); setPropResults([]); }}
                  style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${BORDER}`, fontSize: 13 }}
                  onMouseEnter={e => (e.currentTarget.style.background = CARD)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ fontWeight: 600 }}>{p.property_name}</div>
                  <div style={{ color: MUTED, fontSize: 11 }}>{p.address}</div>
                </div>
              ))}
            </div>
          )}
          {propertyName && (
            <div style={{ color: GREEN, fontSize: 12, marginBottom: 8 }}>Selected: {propertyName}</div>
          )}
        </>
      )}

      {error && <div style={{ color: RED, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 10 }}>
        <button type="submit" disabled={saving} style={{
          flex: 1, padding: '10px', borderRadius: 8, border: 'none',
          background: saving ? BORDER : GREEN, color: '#fff',
          fontWeight: 700, fontSize: 14, cursor: saving ? 'not-allowed' : 'pointer',
        }}>
          {saving ? 'Creating…' : 'Create Key'}
        </button>
        <button type="button" onClick={onCancel} style={{
          padding: '10px 16px', borderRadius: 8, border: `1px solid ${BORDER}`,
          background: 'transparent', color: MUTED, fontSize: 14, cursor: 'pointer',
        }}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Edit Key Form ──────────────────────────────────────────────────────────────

interface EditKeyFormProps {
  keyEntry: KeyEntry;
  onSaved: () => void;
  onCancel: () => void;
}

function EditKeyForm({ keyEntry, onSaved, onCancel }: EditKeyFormProps) {
  const [name, setName]               = useState(keyEntry.name);
  const [keyType, setKeyType]         = useState(keyEntry.key_type);
  const [description, setDescription] = useState(keyEntry.description || '');
  const [propertyName, setPropertyName] = useState(keyEntry.property_name || '');
  const [propSearch, setPropSearch]   = useState(keyEntry.property_name || '');
  const [propResults, setPropResults] = useState<{ property_id: number; property_name: string; address: string }[]>([]);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');

  async function doSearch(q: string) {
    if (q.length < 2) { setPropResults([]); return; }
    try {
      const res = await searchAspireProperties(q);
      setPropResults(res);
    } catch { /* ignore */ }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await updateKey(keyEntry.id, { name, keyType, description, propertyName });
      onSaved();
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to update');
    } finally { setSaving(false); }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 12px', borderRadius: 8,
    background: BG, border: `1px solid ${BORDER}`, color: '#fff',
    fontSize: 14, boxSizing: 'border-box', marginBottom: 8,
  };

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: 12, padding: '14px', background: BG, borderRadius: 10, border: `1px solid ${BLUE}` }}>
      <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Name" style={inputStyle} />
      <select value={keyType} onChange={e => setKeyType(e.target.value as 'vehicle' | 'property_owner' | 'other')} style={inputStyle}>
        <option value="vehicle">Vehicle Spare</option>
        <option value="property_owner">Property Owner</option>
        <option value="other">Other</option>
      </select>
      <input type="text" value={description} onChange={e => setDescription(e.target.value)} placeholder="Description" style={inputStyle} />
      {keyType === 'property_owner' && (
        <>
          <input
            type="text"
            value={propSearch}
            onChange={e => { setPropSearch(e.target.value); doSearch(e.target.value); }}
            placeholder="Search property…"
            style={inputStyle}
          />
          {propResults.length > 0 && (
            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, marginBottom: 8 }}>
              {propResults.map(p => (
                <div
                  key={p.property_id}
                  onClick={() => { setPropertyName(p.property_name); setPropSearch(p.property_name); setPropResults([]); }}
                  style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}
                >
                  <div style={{ fontWeight: 600 }}>{p.property_name}</div>
                  <div style={{ color: MUTED, fontSize: 11 }}>{p.address}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {error && <div style={{ color: RED, fontSize: 12, marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={saving} style={{
          flex: 1, padding: '8px', borderRadius: 8, border: 'none',
          background: saving ? BORDER : BLUE, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer',
        }}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={onCancel} style={{
          padding: '8px 14px', borderRadius: 8, border: `1px solid ${BORDER}`,
          background: 'transparent', color: MUTED, fontSize: 13, cursor: 'pointer',
        }}>Cancel</button>
      </div>
    </form>
  );
}

// ── Key Card ──────────────────────────────────────────────────────────────────

interface KeyCardProps {
  keyEntry: KeyEntry;
  onRefresh: () => void;
}

function KeyCard({ keyEntry: k, onRefresh }: KeyCardProps) {
  const [editing, setEditing]         = useState(false);
  const [confirming, setConfirming]   = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  const scanUrl = `${window.location.origin}/keys/scan/${k.id}`;
  const qrUrl   = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(scanUrl)}`;
  const isOut   = k.last_action === 'out';

  async function handleDeactivate() {
    setDeactivating(true);
    try {
      await deactivateKey(k.id);
      onRefresh();
    } catch { setDeactivating(false); }
  }

  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        {/* QR code */}
        <div style={{ flexShrink: 0 }}>
          <img src={qrUrl} alt={`QR for ${k.name}`} style={{ width: 80, height: 80, borderRadius: 6, background: '#fff' }} />
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{k.name}</div>
            {typeBadge(k.key_type)}
          </div>

          {k.description && (
            <div style={{ color: MUTED, fontSize: 12, marginBottom: 4 }}>{k.description}</div>
          )}
          {k.property_name && (
            <div style={{ color: MUTED, fontSize: 12, marginBottom: 4 }}>📍 {k.property_name}</div>
          )}

          {/* Status */}
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '3px 10px', borderRadius: 20, marginBottom: 10,
            background: isOut ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)',
            border: `1px solid ${isOut ? RED : GREEN}`,
          }}>
            <span style={{ fontSize: 8, color: isOut ? RED : GREEN }}>●</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: isOut ? RED : GREEN }}>
              {isOut ? `Out — ${k.current_holder}` : 'Available'}
            </span>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => printLabel(k)} style={{
              padding: '5px 12px', borderRadius: 6, border: `1px solid ${BORDER}`,
              background: 'transparent', color: MUTED, fontSize: 12, cursor: 'pointer',
            }}>🖨 Print Label</button>
            <button onClick={() => setEditing(!editing)} style={{
              padding: '5px 12px', borderRadius: 6, border: `1px solid ${BLUE}`,
              background: 'transparent', color: BLUE, fontSize: 12, cursor: 'pointer',
            }}>✏️ Edit</button>
            {!confirming ? (
              <button onClick={() => setConfirming(true)} style={{
                padding: '5px 12px', borderRadius: 6, border: `1px solid ${RED}`,
                background: 'transparent', color: RED, fontSize: 12, cursor: 'pointer',
              }}>🗑</button>
            ) : (
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: MUTED }}>Delete?</span>
                <button
                  onClick={handleDeactivate}
                  disabled={deactivating}
                  style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: RED, color: '#fff', fontSize: 12, cursor: 'pointer' }}
                >
                  {deactivating ? '…' : 'Yes'}
                </button>
                <button onClick={() => setConfirming(false)} style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${BORDER}`, background: 'transparent', color: MUTED, fontSize: 12, cursor: 'pointer' }}>
                  No
                </button>
              </span>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <EditKeyForm
          keyEntry={k}
          onSaved={() => { setEditing(false); onRefresh(); }}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

type Tab = 'keys' | 'log';

export default function KeysAdmin() {
  const navigate  = useNavigate();
  const [tab, setTab]             = useState<Tab>('keys');
  const [keys, setKeys]           = useState<KeyEntry[]>([]);
  const [logEntries, setLog]      = useState<KeyLogEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [logLoading, setLogLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [error, setError]         = useState('');

  // Auth guard
  useEffect(() => {
    if (!localStorage.getItem('ap_token')) navigate('/login');
  }, [navigate]);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listKeys();
      setKeys(data);
    } catch (e: unknown) {
      setError((e as Error).message || 'Failed to load keys');
    } finally { setLoading(false); }
  }, []);

  const loadLog = useCallback(async () => {
    setLogLoading(true);
    try {
      const data = await getKeyFullLog(200);
      setLog(data);
    } catch { /* ignore */ } finally { setLogLoading(false); }
  }, []);

  useEffect(() => { loadKeys(); }, [loadKeys]);
  useEffect(() => { if (tab === 'log') loadLog(); }, [tab, loadLog]);

  // Group keys by type
  const groups: { label: string; color: string; type: string }[] = [
    { label: 'Vehicle Spare', color: BLUE,   type: 'vehicle' },
    { label: 'Property Owner', color: YELLOW, type: 'property_owner' },
    { label: 'Other',          color: MUTED,  type: 'other' },
  ];

  const s: React.CSSProperties = {
    minHeight: '100vh',
    background: BG,
    color: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding: '24px',
  };

  return (
    <div style={s}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>🔑 Key Box Admin</h1>
          <p style={{ margin: '4px 0 0', color: MUTED, fontSize: 13 }}>Manage physical keys and view check-in/out history</p>
        </div>
        {tab === 'keys' && (
          <button onClick={() => setShowAddForm(!showAddForm)} style={{
            marginLeft: 'auto', padding: '8px 18px', borderRadius: 8, border: 'none',
            background: GREEN, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer',
          }}>
            + Add Key
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: `1px solid ${BORDER}`, paddingBottom: 0 }}>
        {(['keys', 'log'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 20px', borderRadius: '8px 8px 0 0', border: 'none',
              background: tab === t ? CARD : 'transparent',
              color: tab === t ? '#fff' : MUTED,
              fontWeight: tab === t ? 700 : 400,
              fontSize: 14, cursor: 'pointer',
              borderBottom: tab === t ? `2px solid ${BLUE}` : '2px solid transparent',
            }}
          >
            {t === 'keys' ? 'Keys' : 'Activity Log'}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && <div style={{ color: RED, marginBottom: 16, fontSize: 14 }}>{error}</div>}

      {/* ── Keys Tab ── */}
      {tab === 'keys' && (
        <>
          {showAddForm && (
            <AddKeyForm
              onCreated={() => { setShowAddForm(false); loadKeys(); }}
              onCancel={() => setShowAddForm(false)}
            />
          )}

          {loading ? (
            <div style={{ color: MUTED, textAlign: 'center', padding: 40 }}>Loading keys…</div>
          ) : keys.length === 0 ? (
            <div style={{ color: MUTED, textAlign: 'center', padding: 40 }}>
              No keys yet. Click "Add Key" to create the first one.
            </div>
          ) : (
            groups.map(group => {
              const groupKeys = keys.filter(k => k.key_type === group.type);
              if (groupKeys.length === 0) return null;
              return (
                <div key={group.type} style={{ marginBottom: 28 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: group.color, marginBottom: 10, padding: '4px 0',
                    borderBottom: `1px solid ${group.color}44`,
                  }}>
                    {group.label} ({groupKeys.length})
                  </div>
                  {groupKeys.map(k => (
                    <KeyCard key={k.id} keyEntry={k} onRefresh={loadKeys} />
                  ))}
                </div>
              );
            })
          )}
        </>
      )}

      {/* ── Activity Log Tab ── */}
      {tab === 'log' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <button onClick={loadLog} disabled={logLoading} style={{
              padding: '7px 16px', borderRadius: 8, border: `1px solid ${BORDER}`,
              background: 'transparent', color: MUTED, fontSize: 13, cursor: 'pointer',
            }}>
              {logLoading ? 'Refreshing…' : '↻ Refresh'}
            </button>
          </div>

          {logLoading ? (
            <div style={{ color: MUTED, textAlign: 'center', padding: 40 }}>Loading…</div>
          ) : logEntries.length === 0 ? (
            <div style={{ color: MUTED, textAlign: 'center', padding: 40 }}>No activity recorded yet.</div>
          ) : (
            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
              {/* Table header */}
              <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 120px 140px 80px 1fr', gap: 0, background: '#0f172a', padding: '10px 16px', fontSize: 11, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <div>Time</div>
                <div>Key</div>
                <div>Type</div>
                <div>Employee</div>
                <div>Action</div>
                <div>Notes</div>
              </div>
              {logEntries.map((entry, i) => (
                <div
                  key={entry.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '140px 1fr 120px 140px 80px 1fr',
                    gap: 0,
                    padding: '10px 16px',
                    borderTop: `1px solid ${BORDER}`,
                    background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                    fontSize: 13,
                    alignItems: 'center',
                  }}
                >
                  <div style={{ color: MUTED, fontSize: 12 }}>{fmtTs(entry.scanned_at)}</div>
                  <div style={{ fontWeight: 600 }}>{entry.key_name || `Key #${entry.key_id}`}</div>
                  <div>{entry.key_type ? typeBadge(entry.key_type) : '—'}</div>
                  <div>{entry.employee_name}</div>
                  <div>
                    <span style={{
                      fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                      background: entry.action === 'out' ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
                      color: entry.action === 'out' ? RED : GREEN,
                    }}>
                      {entry.action === 'out' ? '↗ Out' : '✓ In'}
                    </span>
                  </div>
                  <div style={{ color: MUTED, fontSize: 12 }}>{entry.notes || '—'}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
