/**
 * AppShell — persistent sidebar nav for all office/AP pages.
 * Sidebar is collapsible: full (220px) or icon-only (56px).
 */

import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { logout, currentUser, listMyWorklist, hasArea, refreshMe } from '../lib/api';
import { visibleSections, activePath } from '../lib/nav';

const SIDEBAR_FULL  = 220;
const SIDEBAR_MINI  = 56;

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  // Re-read role + access areas once per visit so an admin's changes show up in the menu.
  const [, setAreasLoaded] = useState(0);
  useEffect(() => { refreshMe().then(() => setAreasLoaded(n => n + 1)); }, []);
  const nav = visibleSections(hasArea);
  const current = activePath(pathname, nav.flatMap(sec => sec.items.map(it => it.path)));
  const [actionCount, setActionCount] = useState(0);

  useEffect(() => {
    let alive = true;
    async function refresh() {
      try {
        const r = await listMyWorklist();
        if (alive) setActionCount((r.counts?.overdue || 0) + (r.counts?.today || 0));
      } catch { /* not logged in or unavailable — no badge */ }
    }
    refresh();
    const t = setInterval(refresh, 120000);   // refresh the badge every 2 min
    return () => { alive = false; clearInterval(t); };
  }, [pathname]);

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
          {nav.map(group => (
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
                const active = item.path === current;
                const badge = item.path === '/my-work' ? actionCount : 0;
                const badgeEl = badge > 0 ? (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9,
                    background: '#ef4444', color: '#fff', fontSize: 11, fontWeight: 800,
                    lineHeight: 1,
                  }}>{badge > 99 ? '99+' : badge}</span>
                ) : null;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    title={collapsed ? `${item.label}${badge > 0 ? ` (${badge})` : ''}` : undefined}
                    style={{ ...linkStyle(active), position: 'relative' }}
                  >
                    <span style={{ fontSize: 18, flexShrink: 0, position: 'relative' }}>
                      {item.icon}
                      {collapsed && badgeEl && (
                        <span style={{ position: 'absolute', top: -6, right: -10 }}>{badgeEl}</span>
                      )}
                    </span>
                    {!collapsed && <span>{item.label}</span>}
                    {!collapsed && badgeEl && <span style={{ marginLeft: 'auto' }}>{badgeEl}</span>}
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
