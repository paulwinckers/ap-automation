/**
 * AppShell — persistent sidebar nav for all office/AP pages.
 * Sidebar is collapsible: full (220px) or icon-only (56px).
 */

import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { logout, currentUser } from '../lib/api';

const SIDEBAR_FULL  = 220;
const SIDEBAR_MINI  = 56;

const ACCOUNTING_URL = 'https://darios-accounting.pages.dev';

const NAV = [
  {
    section: 'Field Ops',
    items: [
      { label: 'Crew Schedule', path: '/ops/crew-schedule', icon: '👥' },
      { label: 'Time Tracking', path: '/ops/time-tracking', icon: '⏱️' },
      { label: 'Contacts',      path: '/ops/contacts',      icon: '📞' },
      { label: 'Key Box Admin', path: '/keys/admin',        icon: '🔑' },
      { label: 'Safety Talks',  path: '/ops/safety-talks',       icon: '🦺' },
      { label: 'Inspections',   path: '/ops/safety-inspections', icon: '🔍' },
      { label: 'Documents',     path: '/ops/documents',           icon: '📋' },
    ],
  },
  {
    section: 'Field Staff',
    items: [
      { label: 'Submit Receipt',  path: '/field',                icon: '🧾' },
      { label: 'Purchase Order',  path: '/field/purchase-order', icon: '🛒', color: '#f59e0b' },
      { label: 'New Opportunity', path: '/field/opportunity',    icon: '+',  color: '#22c55e' },
      { label: 'New Issue',       path: '/field/issue',          icon: '⚠️' },
      { label: 'Safety Talk',     path: '/field/safety',         icon: '🦺' },
      { label: 'Key Box',         path: '/field/keys',           icon: '🗝️', color: '#fbbf24' },
    ],
  },
  {
    section: 'Accounting',
    items: [
      { label: 'AP & Dashboards', href: ACCOUNTING_URL, icon: '💳' },
    ],
  },
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
            <img
              src="/darios-logo.png"
              alt="Darios Landscaping"
              style={{ height: 36, objectFit: 'contain' }}
            />
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
                const linkStyle = (active: boolean) => ({
                  display: 'flex', alignItems: 'center',
                  gap: collapsed ? 0 : 10,
                  padding: collapsed ? '10px 0' : '9px 16px',
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  fontSize: 14, textDecoration: 'none',
                  color: active ? '#fff' : '#94a3b8',
                  background: active ? '#1e293b' : 'transparent',
                  borderLeft: `3px solid ${active ? '#22c55e' : 'transparent'}`,
                  transition: 'color 0.15s, background 0.15s',
                  whiteSpace: 'nowrap' as const,
                });
                if ('href' in item && item.href) {
                  return (
                    <a
                      key={item.label}
                      href={item.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={collapsed ? item.label : undefined}
                      style={linkStyle(false)}
                    >
                      <span style={{ fontSize: 18, flexShrink: 0 }}>{item.icon}</span>
                      {!collapsed && <span>{item.label}</span>}
                    </a>
                  );
                }
                const active = 'path' in item
                  ? pathname.startsWith(item.path as string)
                  : false;
                const ic = 'color' in item ? (item as { color?: string }).color : undefined;
                return (
                  <Link
                    key={'path' in item ? item.path : item.label}
                    to={('path' in item ? item.path : '/') as string}
                    title={collapsed ? item.label : undefined}
                    style={linkStyle(active)}
                  >
                    <span style={{ fontSize: 18, flexShrink: 0, color: active ? undefined : ic, fontWeight: ic ? 700 : undefined }}>{item.icon}</span>
                    {!collapsed && <span style={{ color: active ? undefined : ic }}>{item.label}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer — user + logout */}
        <div style={{
          padding: collapsed ? '10px 0 14px' : '10px 16px 14px',
          borderTop: '1px solid #1e293b',
        }}>
          {!collapsed && (() => {
            const user = currentUser();
            return user ? (
              <div style={{ marginBottom: 8 }}>
                <div style={{ color: '#64748b', fontSize: 11, marginBottom: 2 }}>{user.name}</div>
                <div style={{ color: '#334155', fontSize: 10 }}>{user.email}</div>
              </div>
            ) : null;
          })()}
          <button
            onClick={logout}
            title="Sign out"
            style={{
              display: 'flex', alignItems: 'center',
              justifyContent: collapsed ? 'center' : 'flex-start',
              gap: collapsed ? 0 : 6,
              width: '100%', background: 'none', border: 'none',
              cursor: 'pointer', color: '#475569', fontSize: 12,
              padding: collapsed ? '6px 0' : '4px 0',
            }}
          >
            <span style={{ fontSize: collapsed ? 18 : 14 }}>🚪</span>
            {!collapsed && 'Sign out'}
          </button>
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
