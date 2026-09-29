/**
 * SafetyIncidentsAdmin — accumulated field safety incident reports. Login required.
 * Route: /ops/safety-incidents
 */
import { useState, useEffect, useCallback } from 'react';
import {
  listIncidents, getIncident, setIncidentStatus,
  type IncidentSummary, type IncidentDetail,
} from '../lib/api';

const TYPE_LABEL: Record<string, string> = {
  injury: 'Injury', near_miss: 'Near miss', property_damage: 'Property damage',
  environmental: 'Environmental', other: 'Other',
};
const SEV_COLOR: Record<string, string> = {
  minor: '#16a34a', moderate: '#d97706', serious: '#dc2626', critical: '#991b1b',
};
const STATUS_COLOR: Record<string, { bg: string; c: string }> = {
  open:     { bg: '#fef3c7', c: '#92400e' },
  reviewed: { bg: '#dbeafe', c: '#1e40af' },
  closed:   { bg: '#dcfce7', c: '#15803d' },
};

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}
function currentUserName(): string {
  try { return JSON.parse(localStorage.getItem('ap_user') || '{}').name || ''; } catch { return ''; }
}

function Pill({ text, bg, c }: { text: string; bg: string; c: string }) {
  return <span style={{ padding: '2px 9px', borderRadius: 20, background: bg, color: c, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{text}</span>;
}

// ── Detail modal ───────────────────────────────────────────────────────────────
function IncidentModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<IncidentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => { getIncident(id).then(setD).finally(() => setLoading(false)); }, [id]);

  async function changeStatus(status: string) {
    setSaving(true);
    try { await setIncidentStatus(id, status, currentUserName() || undefined); setD(p => p ? { ...p, status } : p); onChanged(); }
    finally { setSaving(false); }
  }

  const row = (lbl: string, val?: string | null) => val ? (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, marginBottom: 2 }}>{lbl}</div>
      <div style={{ fontSize: 14, color: '#111827', whiteSpace: 'pre-wrap' }}>{val}</div>
    </div>
  ) : null;

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '32px 16px', zIndex: 1000, overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, maxWidth: 560, width: '100%', overflow: 'hidden' }}>
        <div style={{ background: '#7f1d1d', color: '#fff', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>🚨 Incident #{id}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fecaca', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ padding: '18px 20px' }}>
          {loading || !d ? <div style={{ color: '#9ca3af', padding: '20px 0' }}>Loading…</div> : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                <Pill text={(d.severity || 'minor').toUpperCase()} bg={SEV_COLOR[d.severity] || '#6b7280'} c="#fff" />
                <Pill text={TYPE_LABEL[d.incident_type] || 'Other'} bg="#f1f5f9" c="#475569" />
                <Pill text={(d.status || 'open').toUpperCase()} bg={(STATUS_COLOR[d.status] || STATUS_COLOR.open).bg} c={(STATUS_COLOR[d.status] || STATUS_COLOR.open).c} />
              </div>
              {row('When', fmtDate(d.incident_date) + (d.incident_time ? ` · ${d.incident_time}` : ''))}
              {row('Location', d.location)}
              {row('Reported by', d.reporter_name)}
              {row('What happened', d.description)}
              {row('Injury details', d.injury_description)}
              {row('People involved', d.people_involved)}
              {row('Immediate action', d.immediate_action)}
              {row('Witnesses', d.witnesses)}
              {d.photo_urls.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, marginBottom: 6 }}>Photos</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {d.photo_urls.map((u, i) => (
                      <a key={i} href={u} target="_blank" rel="noopener noreferrer">
                        <img src={u} alt={`photo ${i + 1}`} style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 8, border: '1px solid #e5e7eb' }} />
                      </a>
                    ))}
                  </div>
                </div>
              )}
              {d.reviewed_by && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>Last updated by {d.reviewed_by}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 18, borderTop: '1px solid #f3f4f6', paddingTop: 16 }}>
                {['open', 'reviewed', 'closed'].map(s => (
                  <button key={s} disabled={saving || d.status === s} onClick={() => changeStatus(s)}
                    style={{ flex: 1, padding: '9px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: d.status === s ? 'default' : 'pointer',
                             border: '1px solid ' + (d.status === s ? (STATUS_COLOR[s].c) : '#e5e7eb'),
                             background: d.status === s ? (STATUS_COLOR[s].bg) : '#fff',
                             color: d.status === s ? (STATUS_COLOR[s].c) : '#6b7280' }}>
                    {s === 'open' ? 'Open' : s === 'reviewed' ? 'Mark reviewed' : 'Close'}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SafetyIncidentsAdmin() {
  const [rows, setRows] = useState<IncidentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    listIncidents({ status: status || undefined, severity: severity || undefined })
      .then(setRows).catch(() => setRows([])).finally(() => setLoading(false));
  }, [status, severity]);
  useEffect(() => { load(); }, [load]);

  const openCount = rows.filter(r => r.status === 'open').length;

  const sel: React.CSSProperties = { padding: '7px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, color: '#374151' };

  return (
    <div style={{ padding: '24px 20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>🚨 Safety Incident Reports</h1>
          {openCount > 0 && <Pill text={`${openCount} open`} bg="#fef3c7" c="#92400e" />}
        </div>
        <p style={{ margin: '0 0 18px', color: '#6b7280', fontSize: 13 }}>Field-submitted incident reports. Click one to review, add photos and set status.</p>

        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <select style={sel} value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="reviewed">Reviewed</option>
            <option value="closed">Closed</option>
          </select>
          <select style={sel} value={severity} onChange={e => setSeverity(e.target.value)}>
            <option value="">All severities</option>
            <option value="minor">Minor</option>
            <option value="moderate">Moderate</option>
            <option value="serious">Serious</option>
            <option value="critical">Critical</option>
          </select>
        </div>

        {loading ? (
          <div style={{ color: '#9ca3af', padding: '40px 0', textAlign: 'center' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: '40px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>
            No incident reports{status || severity ? ' match the filters' : ' yet'}.
          </div>
        ) : (
          <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            {rows.map((r, i) => (
              <div key={r.id} onClick={() => setOpenId(r.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', cursor: 'pointer', borderTop: i ? '1px solid #f3f4f6' : 'none' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
                onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                <div style={{ width: 6, alignSelf: 'stretch', borderRadius: 3, background: SEV_COLOR[r.severity] || '#9ca3af' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>
                    {r.location || 'Field'} <span style={{ color: '#9ca3af', fontWeight: 400 }}>· {TYPE_LABEL[r.incident_type] || 'Other'}</span>
                  </div>
                  <div style={{ fontSize: 13, color: '#4b5563', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 3 }}>
                    {fmtDate(r.incident_date)}{r.incident_time ? ` ${r.incident_time}` : ''} · {r.reporter_name}
                    {r.photo_count > 0 ? ` · 📷 ${r.photo_count}` : ''}
                  </div>
                </div>
                <Pill text={(r.status || 'open').toUpperCase()} bg={(STATUS_COLOR[r.status] || STATUS_COLOR.open).bg} c={(STATUS_COLOR[r.status] || STATUS_COLOR.open).c} />
                <span style={{ color: '#d1d5db', fontSize: 16 }}>›</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {openId !== null && <IncidentModal id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}
