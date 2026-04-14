/**
 * Login.tsx — Simple email/password login for office staff.
 * Redirects to the originally requested page after login.
 */

import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { login, getMe } from '../lib/api';

export default function Login() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const from      = (location.state as any)?.from || '/ap';

  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  // If already logged in, redirect immediately
  useEffect(() => {
    getMe().then(() => navigate(from, { replace: true })).catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await login(email.trim(), password);
      navigate(from, { replace: true });
    } catch {
      setError('Invalid email or password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f172a',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{ width: '100%', maxWidth: 380 }}>

        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🌿</div>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: 20 }}>Darios Landscaping</div>
          <div style={{ color: '#475569', fontSize: 13, marginTop: 4 }}>Office &amp; Management</div>
        </div>

        {/* Card */}
        <form onSubmit={handleSubmit} style={{
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 16,
          padding: 28,
        }}>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: 17, marginBottom: 20 }}>
            Sign in
          </div>

          {error && (
            <div style={{
              background: '#450a0a', border: '1px solid #991b1b',
              borderRadius: 8, padding: '10px 14px',
              color: '#fca5a5', fontSize: 13, marginBottom: 16,
            }}>
              {error}
            </div>
          )}

          <label style={{ display: 'block', marginBottom: 14 }}>
            <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              EMAIL
            </div>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
              placeholder="you@darios.ca"
              style={{
                width: '100%', boxSizing: 'border-box',
                background: '#0f172a', border: '1px solid #334155',
                borderRadius: 8, padding: '10px 12px',
                color: '#fff', fontSize: 14, outline: 'none',
              }}
            />
          </label>

          <label style={{ display: 'block', marginBottom: 24 }}>
            <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              PASSWORD
            </div>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              placeholder="••••••••"
              style={{
                width: '100%', boxSizing: 'border-box',
                background: '#0f172a', border: '1px solid #334155',
                borderRadius: 8, padding: '10px 12px',
                color: '#fff', fontSize: 14, outline: 'none',
              }}
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              background: loading ? '#1e40af' : '#2563eb',
              color: '#fff', border: 'none', borderRadius: 10,
              padding: '12px 0', fontSize: 15, fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s',
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {/* Back to field app */}
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <a href="/" style={{ color: '#475569', fontSize: 12, textDecoration: 'none' }}>
            ← Back to home
          </a>
        </div>
      </div>
    </div>
  );
}
