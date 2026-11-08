/**
 * FieldShell — wraps every field (crew) page with a "Main Menu" button that always goes back
 * to the crew tile page (/crew), never the front door. It floats at the bottom-left so it's
 * reachable with a thumb, and a spacer keeps it from covering the page's last button.
 * `lift` raises it above pages that keep an action bar pinned to the bottom of the screen.
 */

import { Link } from 'react-router-dom';

export default function FieldShell({ children, lift = 0 }: { children: React.ReactNode; lift?: number }) {
  return (
    <>
      {children}
      {!lift && <div aria-hidden="true" style={{ height: 76 }} />}
      <Link
        to="/crew"
        aria-label="Main Menu"
        style={{
          position: 'fixed', zIndex: 50,
          left: 'calc(14px + env(safe-area-inset-left, 0px))',
          bottom: `calc(${14 + lift}px + env(safe-area-inset-bottom, 0px))`,
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '11px 16px', borderRadius: 999,
          background: '#14532d', border: '1px solid #16a34a', color: '#fff',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontSize: 14, fontWeight: 700, textDecoration: 'none',
          boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
        }}
      >
        <span style={{ fontSize: 16 }}>🏠</span> Main Menu
      </Link>
    </>
  );
}
