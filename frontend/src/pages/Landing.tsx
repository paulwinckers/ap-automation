/**
 * Landing — branded entry point for the Darios Operations Portal.
 * Dispatches users to the field app or the office/AP shell.
 */

import { Link } from 'react-router-dom';

export default function Landing() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f172a',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>

      {/* Brand */}
      <div style={{ textAlign: 'center', marginBottom: 48 }}>
        <div style={{ fontSize: 56, marginBottom: 12 }}>🌿</div>
        <h1 style={{
          color: '#fff', fontSize: 26, fontWeight: 700,
          margin: 0, letterSpacing: '-0.5px',
        }}>
          Darios Landscaping
        </h1>
        <p style={{ color: '#475569', marginTop: 8, fontSize: 14 }}>
          Operations Portal
        </p>
      </div>

      {/* Entry points */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: '100%', maxWidth: 360 }}>

        {/* Field crew */}
        <Link to="/field" style={{ textDecoration: 'none' }}>
          <div style={{
            background: '#14532d',
            border: '1px solid #16a34a',
            borderRadius: 14,
            padding: '22px 24px',
            cursor: 'pointer',
            transition: 'opacity 0.15s',
          }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 28 }}>📱</span>
              <div>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: 17 }}>Field Staff</div>
                <div style={{ color: '#86efac', fontSize: 13, marginTop: 2 }}>
                  Submit receipts &amp; expenses
                </div>
              </div>
            </div>
          </div>
        </Link>

        {/* Office / AP */}
        <Link to="/ap" style={{ textDecoration: 'none' }}>
          <div style={{
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: 14,
            padding: '22px 24px',
            cursor: 'pointer',
            transition: 'opacity 0.15s',
          }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 28 }}>🏢</span>
              <div>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: 17 }}>Office &amp; AP</div>
                <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 2 }}>
                  Invoices, vendors &amp; dashboards
                </div>
              </div>
            </div>
          </div>
        </Link>

      </div>

      <p style={{ color: '#1e293b', fontSize: 12, marginTop: 48 }}>
        Darios Landscaping &copy; {new Date().getFullYear()}
      </p>
    </div>
  );
}
