/**
 * Landing — the front door of the Darios Operations Portal. Two choices only:
 *   • I'm in the field → /crew  (public tile page, no login)
 *   • Office           → /home  (sign in first if needed)
 * Every individual page is reached from those two places (see src/lib/nav.ts).
 */

import { Link } from 'react-router-dom';

function signedIn(): boolean {
  const token = localStorage.getItem('ap_token');
  if (!token) return false;
  try {
    return JSON.parse(atob(token.split('.')[1])).exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

const DOOR: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 16,
  padding: '22px 22px', borderRadius: 16, textDecoration: 'none',
};

export default function Landing() {
  const office = signedIn();
  return (
    <div style={{
      minHeight: '100vh', background: '#0f172a',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '24px 16px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <img src="/darios-logo.png" alt="Darios Landscaping" style={{ height: 80, objectFit: 'contain' }} />
        <p style={{ color: '#64748b', fontSize: 13, margin: '8px 0 0' }}>Operations Portal</p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: '100%', maxWidth: 380 }}>
        <Link to="/crew" style={{ ...DOOR, background: '#14532d', border: '1px solid #16a34a' }}>
          <span style={{ fontSize: 34 }}>🌿</span>
          <div style={{ flex: 1 }}>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 18 }}>I'm in the field</div>
            <div style={{ color: '#86efac', fontSize: 13, marginTop: 2 }}>Receipts, schedule, POs, safety — no login</div>
          </div>
          <span style={{ color: '#4ade80', fontSize: 22 }}>›</span>
        </Link>

        <Link
          to={office ? '/home' : '/login'}
          state={office ? undefined : { from: '/home' }}
          style={{ ...DOOR, background: '#1e293b', border: '1px solid #334155' }}
        >
          <span style={{ fontSize: 30 }}>🏢</span>
          <div style={{ flex: 1 }}>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 18 }}>{office ? 'Office' : 'Office sign in'}</div>
            <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 2 }}>
              {office ? 'Go to your home page' : 'Staff login'}
            </div>
          </div>
          <span style={{ color: '#64748b', fontSize: 22 }}>›</span>
        </Link>
      </div>

      <p style={{ color: '#334155', fontSize: 11, marginTop: 40 }}>
        Darios Landscaping &copy; {new Date().getFullYear()}
      </p>
    </div>
  );
}
