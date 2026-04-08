/**
 * AppShell — persistent sidebar nav for all office/AP pages.
 * Wraps any page that requires the office layout.
 */

import React from 'react';
import { Link, useLocation } from 'react-router-dom';

const SIDEBAR_W = 220;

const NAV = [
  {
    section: 'AP & Finance',
    items: [
      { label: 'Invoices',  path: '/ap',           icon: '💳' },
      { label: 'Vendors',   path: '/ap/vendors',   icon: '🏪' },
      { label: 'Reconcile', path: '/ap/reconcile', icon: '🔄' },
    ],
  },
  {
    section: 'Dashboards',
    items: [
      { label: 'Sales',         path: '/dashboards/sales',         icon: '📊' },
      { label: 'Operations',    path: '/dashboards/ops',           icon: '⚙️' },
      { label: 'Construction',  path: '/dashboards/construction',  icon: '🏗️' },
    ],
  },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8fafc' }}>

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <nav style={{
        width: SIDEBAR_W, minWidth: SIDEBAR_W,
        background: '#0f172a',
        display: 'flex', flexDirection: 'column',
        position: 'fixed', top: 0, left: 0, bottom: 0,
        zIndex: 100,
      }}>

        {/* Brand */}
        <div style={{ padding: '20px 16px 16px', borderBottom: '1px solid #1e293b' }}>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: 16, letterSpacing: '-0.3px' }}>
            🌿 Darios
          </div>
          <div style={{ color: '#475569', fontSize: 11, marginTop: 2 }}>Landscaping</div>
        </div>

        {/* Nav items */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {NAV.map(group => (
            <div key={group.section} style={{ marginBottom: 8 }}>
              <div style={{
                color: '#475569', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.1em', textTransform: 'uppercase',
                padding: '12px 16px 4px',
              }}>
                {group.section}
              </div>
              {group.items.map(item => {
                // Active: exact match for /ap, prefix match for everything else
                const active = item.path === '/ap'
                  ? pathname === '/ap'
                  : pathname.startsWith(item.path);
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '9px 16px', fontSize: 14,
                      textDecoration: 'none',
                      color: active ? '#fff' : '#94a3b8',
                      background: active ? '#1e293b' : 'transparent',
                      borderLeft: `3px solid ${active ? '#22c55e' : 'transparent'}`,
                      transition: 'color 0.15s, background 0.15s',
                    }}
                  >
                    <span style={{ fontSize: 16 }}>{item.icon}</span>
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer — link back to field app */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid #1e293b' }}>
          <Link
            to="/field"
            style={{
              color: '#475569', fontSize: 12, textDecoration: 'none',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <span>📱</span> Field App
          </Link>
        </div>
      </nav>

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <main style={{ marginLeft: SIDEBAR_W, flex: 1, minHeight: '100vh', overflowX: 'hidden' }}>
        {children}
      </main>

    </div>
  );
}
