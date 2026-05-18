/**
 * EmergencyReset.tsx — PIN-protected admin password reset.
 * Route: /emergency-reset  (public, no login required)
 *
 * Use this when locked out of the admin account.
 * Requires ADMIN_RESET_PIN env var set in Railway.
 */

import { useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? '';

export default function EmergencyReset() {
  const [pin,      setPin]      = useState('');
  const [email,    setEmail]    = useState('');
  const [name,     setName]     = useState('');
  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [loading,  setLoading]  = useState(false);
  const [done,     setDone]     = useState(false);
  const [error,    setError]    = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (password.length < 8)  { setError('Password must be at least 8 characters.'); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API}/auth/emergency-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, email, name, password }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.detail || `HTTP ${res.status}`);
      // Save token so they're logged in immediately
      localStorage.setItem('auth_token', d.access_token);
      localStorage.setItem('user_name',  d.name);
      localStorage.setItem('user_role',  d.role);
      setDone(true);
    } catch (e: any) {
      setError(e.message || 'Reset failed. Check your PIN and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#0f172a',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <img src="/darios-logo.png" alt="Darios" style={{ height: 60, marginBottom: 12, objectFit: 'contain' }} />
          <h1 style={{ color: '#fff', fontSize: 20, fontWeight: 700, margin: 0 }}>Emergency Admin Reset</h1>
          <p style={{ color: '#64748b', fontSize: 13, marginTop: 6 }}>
            Use this to regain access when locked out.
          </p>
        </div>

        {done ? (
          <div style={{ background: '#14532d', border: '1px solid #16a34a', borderRadius: 12, padding: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Password reset successfully</div>
            <div style={{ color: '#86efac', fontSize: 13, marginBottom: 20 }}>You are now logged in as admin.</div>
            <a href="/" style={{
              display: 'inline-block', padding: '10px 24px',
              background: '#16a34a', color: '#fff', borderRadius: 8,
              textDecoration: 'none', fontWeight: 700, fontSize: 14,
            }}>Go to Home →</a>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 24 }}>
            {[
              { label: 'Reset PIN', value: pin,      set: setPin,      type: 'password', placeholder: 'Enter the ADMIN_RESET_PIN from Railway' },
              { label: 'Your email', value: email,   set: setEmail,    type: 'email',    placeholder: 'admin@darios.ca' },
              { label: 'Your name',  value: name,    set: setName,     type: 'text',     placeholder: 'Paul' },
              { label: 'New password', value: password, set: setPassword, type: 'password', placeholder: 'Min 8 characters' },
              { label: 'Confirm password', value: confirm, set: setConfirm, type: 'password', placeholder: 'Repeat password' },
            ].map(f => (
              <div key={f.label} style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', color: '#94a3b8', fontSize: 12, fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {f.label}
                </label>
                <input
                  type={f.type}
                  value={f.value}
                  onChange={e => f.set(e.target.value)}
                  placeholder={f.placeholder}
                  required
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: '#0f172a', border: '1px solid #334155',
                    borderRadius: 8, padding: '9px 12px',
                    color: '#fff', fontSize: 14, outline: 'none', fontFamily: 'inherit',
                  }}
                />
              </div>
            ))}

            {error && (
              <div style={{ background: '#7f1d1d', border: '1px solid #ef4444', borderRadius: 8, padding: '10px 14px', color: '#fca5a5', fontSize: 13, marginBottom: 16 }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%', padding: '12px 0',
                background: loading ? '#334155' : '#dc2626',
                color: loading ? '#64748b' : '#fff',
                border: 'none', borderRadius: 8,
                fontSize: 14, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {loading ? 'Resetting…' : 'Reset Password'}
            </button>

            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <a href="/login" style={{ color: '#64748b', fontSize: 12, textDecoration: 'none' }}>← Back to login</a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
