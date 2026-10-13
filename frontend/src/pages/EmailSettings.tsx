/**
 * EmailSettings — adjust timing + distribution of the automated emails. Login required.
 * Route: /settings/email
 */
import { useState, useEffect } from 'react';
import { getEmailSettings, saveEmailSettings, type EmailSettings as ES } from '../lib/api';

const HOURS = Array.from({ length: 24 }, (_, h) => {
  const ampm = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
  return { value: h, label: `${String(h).padStart(2, '0')}:00  (${ampm})` };
});

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '18px 20px', marginBottom: 16 };
const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#111827', fontFamily: 'inherit' };
const sel:   React.CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#111827', background: '#fff' };

function Toggle({ on, onChange, label: lbl }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14, color: '#374151' }}>
      <input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)} />
      {lbl}
    </label>
  );
}

export default function EmailSettings() {
  const [s, setS] = useState<ES | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => { getEmailSettings().then(setS).catch(() => setMsg('Could not load settings.')).finally(() => setLoading(false)); }, []);

  function upd<K extends keyof ES>(key: K, patch: Partial<ES[K]>) {
    setS(prev => prev ? { ...prev, [key]: { ...prev[key], ...patch } } : prev);
  }

  async function save() {
    if (!s) return;
    setSaving(true); setMsg('');
    try { const saved = await saveEmailSettings(s); setS(saved); setMsg('✅ Saved. Changes take effect within a minute.'); }
    catch { setMsg('❌ Could not save — please try again.'); }
    finally { setSaving(false); setTimeout(() => setMsg(''), 4000); }
  }

  const scheduleRow = (cfg: { enabled: boolean; hour: number; skip_weekend: boolean }, key: 'issues_digest' | 'project_checkin') => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', marginTop: 12 }}>
      <Toggle on={cfg.enabled} onChange={v => upd(key, { enabled: v } as never)} label="Enabled" />
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#374151' }}>
        Send at
        <select style={sel} value={cfg.hour} onChange={e => upd(key, { hour: Number(e.target.value) } as never)}>
          {HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
        </select>
        <span style={{ color: '#9ca3af', fontSize: 12 }}>Pacific</span>
      </label>
      <Toggle on={cfg.skip_weekend} onChange={v => upd(key, { skip_weekend: v } as never)} label="Skip weekends" />
    </div>
  );

  if (loading) return <div style={{ padding: 40, color: '#9ca3af' }}>Loading…</div>;
  if (!s) return <div style={{ padding: 40, color: '#b91c1c' }}>{msg || 'Could not load settings.'}</div>;

  return (
    <div style={{ padding: '24px 20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: '#0f172a' }}>✉️ Email Settings</h1>
        <p style={{ margin: '0 0 20px', color: '#6b7280', fontSize: 13 }}>
          Control who receives each automated email and when the scheduled ones go out. Separate multiple
          addresses with commas.
        </p>

        {/* Safety Incident */}
        <div style={card}>
          <div style={{ fontWeight: 800, fontSize: 15, color: '#111827', marginBottom: 2 }}>🚨 Safety Incident Reports</div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>Sent immediately when a field incident is submitted.</div>
          <label style={label}>Recipients</label>
          <input style={input} value={s.safety_incident.recipients} onChange={e => upd('safety_incident', { recipients: e.target.value })} placeholder="name@darios.ca, name2@darios.ca" />
        </div>

        {/* Vehicle Inspection */}
        <div style={card}>
          <div style={{ fontWeight: 800, fontSize: 15, color: '#111827', marginBottom: 2 }}>🚛 Vehicle Inspections (defects)</div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>Sent only when an inspection has one or more defects.</div>
          <label style={label}>Recipients</label>
          <input style={input} value={s.vehicle_inspection.recipients} onChange={e => upd('vehicle_inspection', { recipients: e.target.value })} placeholder="name@darios.ca" />
        </div>

        {/* Issues Digest */}
        <div style={card}>
          <div style={{ fontWeight: 800, fontSize: 15, color: '#111827', marginBottom: 2 }}>💬 Issues Digest</div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>Nightly summary of field issues to management.</div>
          <label style={label}>Recipients</label>
          <input style={input} value={s.issues_digest.recipients} onChange={e => upd('issues_digest', { recipients: e.target.value })} placeholder="name@darios.ca" />
          {scheduleRow(s.issues_digest, 'issues_digest')}
        </div>

        {/* Project Check-ins */}
        <div style={card}>
          <div style={{ fontWeight: 800, fontSize: 15, color: '#111827', marginBottom: 2 }}>🏗️ Project Check-ins</div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>Daily check-in requests to crew leads; the CC list is copied on each check-in / project update.</div>
          <label style={label}>CC recipients</label>
          <input style={input} value={s.project_checkin.cc} onChange={e => upd('project_checkin', { cc: e.target.value })} placeholder="name@darios.ca" />
          {scheduleRow(s.project_checkin, 'project_checkin')}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8 }}>
          <button onClick={save} disabled={saving}
            style={{ padding: '11px 22px', borderRadius: 10, border: 'none', background: saving ? '#94a3b8' : '#16a34a', color: '#fff', fontWeight: 800, fontSize: 15, cursor: saving ? 'default' : 'pointer' }}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {msg && <span style={{ fontSize: 14, color: msg.startsWith('✅') ? '#15803d' : '#b91c1c' }}>{msg}</span>}
        </div>

        <div style={{ marginTop: 20, fontSize: 12, color: '#9ca3af', lineHeight: 1.6 }}>
          Times are in the company timezone (America/Vancouver). Scheduled emails poll every 5 minutes, so a
          changed send-time applies from the next window. Customer reports and the AP receipt confirmations are
          sent on-demand and aren't listed here.
        </div>
      </div>
    </div>
  );
}
