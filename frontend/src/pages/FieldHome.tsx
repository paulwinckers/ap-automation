/**
 * FieldHome — the crew's start page. Route: /crew (public, no login, built for phones).
 * The four everyday tasks are big tiles; everything else sits under "More".
 * Crews can add this page to their home screen.
 */

import { Link } from 'react-router-dom';
import { FIELD_LINKS } from '../lib/nav';

export default function FieldHome() {
  const top  = FIELD_LINKS.filter(l => l.top);
  const more = FIELD_LINKS.filter(l => !l.top);
  return (
    <div style={{
      minHeight: '100vh', background: '#0f172a',
      padding: '20px 16px 32px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{ maxWidth: 440, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <Link to="/"><img src="/darios-logo.png" alt="Darios Landscaping" style={{ height: 40, objectFit: 'contain' }} /></Link>
          <span style={{ color: '#86efac', fontSize: 12, fontWeight: 600 }}>Field</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 26 }}>
          {top.map(l => (
            <Link key={l.path} to={l.path} style={{
              textDecoration: 'none', borderRadius: 16, padding: '22px 12px', textAlign: 'center',
              background: l.urgent ? '#450a0a' : '#14532d',
              border: `1px solid ${l.urgent ? '#dc2626' : '#16a34a'}`,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, minHeight: 112,
              justifyContent: 'center',
            }}>
              <span style={{ fontSize: 34, lineHeight: 1 }}>{l.icon}</span>
              <span style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>{l.label}</span>
            </Link>
          ))}
        </div>

        <div style={{ color: '#64748b', fontSize: 12, fontWeight: 600, marginBottom: 10 }}>More</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {more.map(l => (
            <Link key={l.path} to={l.path} title={l.sub} style={{
              textDecoration: 'none', borderRadius: 12, padding: '12px 4px', textAlign: 'center',
              background: '#1e293b', border: '1px solid #334155',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            }}>
              <span style={{ fontSize: 24, lineHeight: 1 }}>{l.icon}</span>
              <span style={{ color: '#cbd5e1', fontSize: 11, fontWeight: 600, lineHeight: 1.2 }}>{l.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
