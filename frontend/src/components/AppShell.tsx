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
      { label: 'Estimating',   path: '/dashboards/estimating',   icon: '📋' },
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

        {/* Footer — field app links */}
        <div style={{ padding: '10px 16px 14px', borderTop: '1px solid #1e293b' }}>
          <div style={{ color: '#334155', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>
            Field Staff
          </div>
          {([
            { to: '/field',             icon: '🧾', label: 'Submit Receipt' },
            { to: '/field/work-ticket', icon: '✅', label: 'Complete Ticket' },
            { to: '/field/opportunity', icon: '➕', label: 'New Opportunity' },
          ] as { to: string; icon: string; label: string }[]).map(item => (
            <Link
              key={item.to}
              to={item.to}
              style={{
                color: '#475569', fontSize: 12, textDecoration: 'none',
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0',
              }}
            >
              <span style={{ fontSize: 13 }}>{item.icon}</span> {item.label}
            </Link>
          ))}
        </div>
      </nav>

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <main style={{ marginLeft: SIDEBAR_W, flex: 1, minHeight: '100vh', overflowX: 'hidden' }}>
        {children}
      </main>

    </div>
  );
}
