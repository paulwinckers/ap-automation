/**
 * Account — any signed-in user: see who you're signed in as and change your own password.
 * (Changing a login email is an admin action, on the Users page.)
 */

import { useState } from 'react';
import { changeMyPassword, currentUser } from '../lib/api';

const CARD: React.CSSProperties = {
  background: '#1e293b', border: '1px solid #334155',
  borderRadius: 12, padding: 24, marginBottom: 24,
};

const INPUT: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: '#0f172a', border: '1px solid #334155',
  borderRadius: 8, padding: '9px 12px',
  color: '#fff', fontSize: 16, outline: 'none',
};

const LABEL: React.CSSProperties = {
  display: 'block', color: '#94a3b8', fontSize: 11, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5,
};

export default function Account() {
  const user = currentUser();
  const [curPw,     setCurPw]     = useState('');
  const [newPw,     setNewPw]     = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [saving,    setSaving]    = useState(false);
  const [msg,       setMsg]       = useState('');
  const [err,       setErr]       = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setMsg('');
    if (newPw.length < 8)    { setErr('New password must be at least 8 characters.'); return; }
    if (newPw !== confirmPw) { setErr('New passwords do not match.'); return; }
    if (newPw === curPw)     { setErr('New password must be different from the current one.'); return; }
    setSaving(true);
    try {
      await changeMyPassword(curPw, newPw);
      setMsg('Password changed. Use the new one next time you sign in.');
      setCurPw(''); setNewPw(''); setConfirmPw('');
    } catch (e) {
      setErr((e as Error).message || 'Failed to change password.');
    } finally {
      setSaving(false);
    }
  }

  const fields = [
    { label: 'Current password', value: curPw,     set: setCurPw,     auto: 'current-password' },
    { label: 'New password',     value: newPw,     set: setNewPw,     auto: 'new-password', hint: 'At least 8 characters' },
    { label: 'Confirm new',      value: confirmPw, set: setConfirmPw, auto: 'new-password' },
  ];

  return (
    <div style={{
      padding: 'clamp(16px, 4vw, 32px)', maxWidth: 520,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{ color: '#fff', fontWeight: 700, fontSize: 22, marginBottom: 24 }}>My account</div>

      {user && (
        <div style={CARD}>
          <div style={LABEL}>Signed in as</div>
          <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 15 }}>{user.name}</div>
          <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 2 }}>{user.email}</div>
          <div style={{ color: '#64748b', fontSize: 12, marginTop: 10 }}>
            Need your login email changed? Ask an admin.
          </div>
        </div>
      )}

      <div style={CARD}>
        <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 15, marginBottom: 16 }}>Change password</div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* hidden username helps password managers update the right entry */}
          <input type="email" autoComplete="username" value={user?.email || ''} readOnly hidden />
          {fields.map(f => (
            <label key={f.label}>
              <span style={LABEL}>{f.label}</span>
              <input
                type="password" required value={f.value} autoComplete={f.auto}
                onChange={e => f.set(e.target.value)} placeholder={f.hint} style={INPUT}
              />
            </label>
          ))}
          {err && <div style={{ color: '#f87171', fontSize: 13 }}>{err}</div>}
          {msg && <div style={{ color: '#4ade80', fontSize: 13 }}>{msg}</div>}
          <button type="submit" disabled={saving} style={{
            alignSelf: 'flex-start', padding: '10px 20px', border: 'none', borderRadius: 8,
            background: saving ? '#1e293b' : '#1d4ed8', color: saving ? '#475569' : '#fff',
            fontSize: 14, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
          }}>
            {saving ? 'Saving…' : 'Save new password'}
          </button>
        </form>
      </div>
    </div>
  );
}
