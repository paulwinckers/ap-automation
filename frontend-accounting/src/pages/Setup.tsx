/**
 * Setup — one-time first-admin creation.
 * Only works when the users table is empty. Redirects to /ap after success.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const BASE = import.meta.env.VITE_API_URL || 'https://ap-automation-production.up.railway.app';

export default function Setup() {
  const navigate = useNavigate();
  const [name,     setName]     = useState('');
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const [done,     setDone]     = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (password.length < 8)  { setError('Password must be at least 8 characters.'); return; }

    setError(''); setLoading(true);
    try {
      const res = await fetch(`${BASE}/auth/setup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email.trim(), name: name.trim(), password, role: 'admin' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Setup failed');
      localStorage.setItem('ap_token', data.access_token);
      localStorage.setItem('ap_user', JSON.stringify({ name: data.name, email: email.trim(), role: 'admin' }));
      setDone(true);
      setTimeout(() => navigate('/ap'), 1500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#0f172a',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>

        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🌿</div>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: 20 }}>Darios Landscaping</div>
          <div style={{ color: '#475569', fontSize: 13, marginTop: 4 }}>First-time setup</div>
        </div>

        {done ? (
          <div style={{ textAlign: 'center', color: '#4ade80', fontSize: 16, fontWeight: 600 }}>
            ✅ Admin account created — redirecting…
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{
            background: '#1e293b', border: '1px solid #334155',
            borderRadius: 16, padding: 28,
          }}>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 17, marginBottom: 6 }}>
              Create admin account
            </div>
            <div style={{ color: '#64748b', fontSize: 12, marginBottom: 20 }}>
              This page only works once — when no users exist yet.
            </div>

            {error && (
              <div style={{
                background: '#450a0a', border: '1px solid #991b1b',
                borderRadius: 8, padding: '10px 14px',
                color: '#fca5a5', fontSize: 13, marginBottom: 16,
              }}>{error}</div>
            )}

            {[
              { label: 'YOUR NAME',        val: name,     set: setName,     type: 'text',     ph: 'Paul Winckers' },
              { label: 'EMAIL',            val: email,    set: setEmail,    type: 'email',    ph: 'paul@darios.ca' },
              { label: 'PASSWORD',         val: password, set: setPassword, type: 'password', ph: '••••••••' },
              { label: 'CONFIRM PASSWORD', val: confirm,  set: setConfirm,  type: 'password', ph: '••••••••' },
            ].map(f => (
              <label key={f.label} style={{ display: 'block', marginBottom: 14 }}>
                <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, marginBottom: 6 }}>{f.label}</div>
                <input
                  type={f.type}
                  value={f.val}
                  onChange={e => f.set(e.target.value)}
                  required
                  placeholder={f.ph}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: '#0f172a', border: '1px solid #334155',
                    borderRadius: 8, padding: '10px 12px',
                    color: '#fff', fontSize: 14, outline: 'none',
                  }}
                />
              </label>
            ))}

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%', marginTop: 8,
                background: loading ? '#1e40af' : '#2563eb',
                color: '#fff', border: 'none', borderRadius: 10,
                padding: '12px 0', fontSize: 15, fontWeight: 700,
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
            >
              {loading ? 'Creating…' : 'Create admin account'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
