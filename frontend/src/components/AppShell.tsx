/**
 * AppShell — persistent sidebar nav for all office/AP pages.
 * Sidebar is collapsible: full (220px) or icon-only (56px).
 */

import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

const SIDEBAR_FULL  = 220;
const SIDEBAR_MINI  = 56;

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
      { label: 'Sales',        path: '/dashboards/sales',        icon: '📊' },
      { label: 'Operations',   path: '/dashboards/ops',          icon: '⚙️' },
      { label: 'Construction', path: '/dashboards/construction', icon: '🏗️' },
      { label: 'Estimating',  path: '/dashboards/estimating',  icon: '📋' },
    ],
  },
];

const FIELD_LINKS = [
  { to: '/field',             icon: '🧾', label: 'Submit Receipt' },
  { to: '/field/work-ticket', icon: '✅', label: 'Complete Ticket' },
  { to: '/field/opportunity', icon: '➕', label: 'New Opportunity' },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const w = collapsed ? SIDEBAR_MINI : SIDEBAR_FULL;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8fafc' }}>

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <nav style={{
        width: w, minWidth: w,
        background: '#0f172a',
        display: 'flex', flexDirection: 'column',
        position: 'fixed', top: 0, left: 0, bottom: 0,
        zIndex: 100,
        transition: 'width 0.2s ease, min-width 0.2s ease',
        overflow: 'hidden',
      }}>

        {/* Brand + toggle */}
        <div style={{
          padding: collapsed ? '18px 0' : '20px 16px 16px',
          borderBottom: '1px solid #1e293b',
          display: 'flex', alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between',
          gap: 8,
        }}>
          {!collapsed && (
            <div>
              <div style={{ color: '#fff', fontWeight: 700, fontSize: 16, letterSpacing: '-0.3px' }}>
                🌿 Darios
              </div>
              <div style={{ color: '#475569', fontSize: 11, marginTop: 2 }}>Landscaping</div>
            </div>
          )}
          <button
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#475569', fontSize: 16, padding: 4, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 4, flexShrink: 0,
            }}
          >
            {collapsed ? '▶' : '◀'}
          </button>
        </div>

        {/* Nav items */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '8px 0' }}>
          {NAV.map(group => (
            <div key={group.section} style={{ marginBottom: 8 }}>
              {/* Section label — hidden when collapsed */}
              {!collapsed && (
                <div style={{
                  color: '#475569', fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.1em', textTransform: 'uppercase',
                  padding: '12px 16px 4px', whiteSpace: 'nowrap',
                }}>
                  {group.section}
                </div>
              )}
              {collapsed && <div style={{ height: 8 }} />}

              {group.items.map(item => {
                const active = item.path === '/ap'
                  ? pathname === '/ap'
                  : pathname.startsWith(item.path);
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    title={collapsed ? item.label : undefined}
                    style={{
                      display: 'flex', alignItems: 'center',
                      gap: collapsed ? 0 : 10,
                      padding: collapsed ? '10px 0' : '9px 16px',
                      justifyContent: collapsed ? 'center' : 'flex-start',
                      fontSize: 14, textDecoration: 'none',
                      color: active ? '#fff' : '#94a3b8',
                      background: active ? '#1e293b' : 'transparent',
                      borderLeft: `3px solid ${active ? '#22c55e' : 'transparent'}`,
                      transition: 'color 0.15s, background 0.15s',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ fontSize: 18, flexShrink: 0 }}>{item.icon}</span>
                    {!collapsed && <span>{item.label}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer — field app links */}
        <div style={{
          padding: collapsed ? '10px 0 14px' : '10px 16px 14px',
          borderTop: '1px solid #1e293b',
        }}>
          {!collapsed && (
            <div style={{ color: '#334155', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>
              Field Staff
            </div>
          )}
          {FIELD_LINKS.map(item => (
            <Link
              key={item.to}
              to={item.to}
              title={collapsed ? item.label : undefined}
              style={{
                color: '#475569', fontSize: 12, textDecoration: 'none',
                display: 'flex', alignItems: 'center',
                justifyContent: collapsed ? 'center' : 'flex-start',
                gap: collapsed ? 0 : 6,
                padding: collapsed ? '6px 0' : '4px 0',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ fontSize: collapsed ? 18 : 13 }}>{item.icon}</span>
              {!collapsed && item.label}
            </Link>
          ))}
        </div>
      </nav>

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <main style={{
        marginLeft: w, flex: 1, minHeight: '100vh', overflowX: 'hidden',
        transition: 'margin-left 0.2s ease',
      }}>
        {children}
      </main>

    </div>
  );
}
