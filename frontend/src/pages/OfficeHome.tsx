/**
 * OfficeHome — where office staff land after signing in. Route: /home
 * Your numbers for the day, a "jump to" box (pages + customers), and your areas.
 * Everything shown is filtered by the person's access areas (src/lib/nav.ts).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { currentUser, hasArea, listMyWorklist, searchCustomerEntities, CustomerEntity } from '../lib/api';
import { visibleSections } from '../lib/nav';

interface Hit { to: string; icon: string; label: string; sub: string }

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export default function OfficeHome() {
  const navigate = useNavigate();
  const user = currentUser();
  const first = (user?.name || '').split(' ')[0];
  const sections = visibleSections(hasArea);
  const areaSections = sections.filter(s => s.area);

  const [counts, setCounts] = useState<{ overdue: number; today: number; waiting: number; feed: number } | null>(null);
  useEffect(() => {
    listMyWorklist()
      .then(r => setCounts({
        overdue: r.counts?.overdue || 0,
        today:   r.counts?.today || 0,
        waiting: (r.waiting || []).length,
        feed:    r.feed_unread || 0,
      }))
      .catch(() => setCounts(null));
  }, []);

  // Jump to: pages match instantly; customers search after a short pause.
  const [q, setQ] = useState('');
  const [customers, setCustomers] = useState<CustomerEntity[]>([]);
  const timer = useRef<number>();
  const canCustomers = hasArea('customers');
  useEffect(() => {
    window.clearTimeout(timer.current);
    setCustomers([]);
    if (!canCustomers || q.trim().length < 3) return;
    timer.current = window.setTimeout(() => {
      searchCustomerEntities(q.trim()).then(r => setCustomers(r.slice(0, 5))).catch(() => {});
    }, 300);
  }, [q, canCustomers]);

  const hits: Hit[] = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    const pages = sections.flatMap(s => s.items)
      .filter(it => it.label.toLowerCase().includes(t) || it.sub.toLowerCase().includes(t))
      .slice(0, 6)
      .map(it => ({ to: it.path, icon: it.icon, label: it.label, sub: it.sub }));
    const people = customers.map(c => ({
      to: `/dashboards/customer/360?key=${c.kind}:${c.id}`, icon: c.kind === 'company' ? '🏢' : '👤',
      label: c.name, sub: `Customer · ${c.sub}`,
    }));
    return [...pages, ...people];
  }, [q, customers, sections]);

  const tile = (label: string, n: number | undefined, tone?: string, to = '/my-work') => (
    <Link to={to} style={{
      textDecoration: 'none', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12,
      padding: '14px 16px', display: 'block',
    }}>
      <div style={{ color: '#6b7280', fontSize: 12 }}>{label}</div>
      <div style={{ color: tone || '#111827', fontSize: 26, fontWeight: 700, marginTop: 2 }}>{n ?? '—'}</div>
    </Link>
  );

  return (
    <div style={{
      background: '#f8fafc', minHeight: '100vh', padding: '32px 28px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      <div style={{ maxWidth: 860 }}>
        <h1 style={{ margin: '0 0 20px', fontSize: 24, fontWeight: 800, color: '#111827' }}>
          {greeting()}{first ? `, ${first}` : ''}
        </h1>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
          {tile('Overdue', counts?.overdue, counts?.overdue ? '#dc2626' : undefined)}
          {tile('Due today', counts?.today)}
          {tile('Waiting on others', counts?.waiting)}
          {tile('New in Feed', counts?.feed, counts?.feed ? '#2563eb' : undefined, '/my-work?tab=feed')}
        </div>

        <div style={{ position: 'relative', marginBottom: 28 }}>
          <input
            id="jump-to"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && hits[0]) navigate(hits[0].to); if (e.key === 'Escape') setQ(''); }}
            placeholder={canCustomers ? 'Jump to a page or customer…' : 'Jump to a page…'}
            aria-label="Jump to a page or customer"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 15,
              border: '1px solid #d1d5db', borderRadius: 10, outline: 'none', background: '#fff', color: '#111827',
            }}
          />
          {q.trim() && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 6, zIndex: 10,
              background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden',
              boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
            }}>
              {hits.length === 0 ? (
                <div style={{ padding: '12px 14px', color: '#6b7280', fontSize: 13 }}>
                  {canCustomers && q.trim().length < 3 ? 'Keep typing to search customers…' : 'Nothing matches that.'}
                </div>
              ) : hits.map(h => (
                <Link key={h.to} to={h.to} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                  textDecoration: 'none', borderTop: '1px solid #f3f4f6',
                }}>
                  <span style={{ fontSize: 18 }}>{h.icon}</span>
                  <span style={{ color: '#111827', fontSize: 14, fontWeight: 600 }}>{h.label}</span>
                  <span style={{ color: '#6b7280', fontSize: 12, marginLeft: 'auto', textAlign: 'right' }}>{h.sub}</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div style={{ color: '#6b7280', fontSize: 12, fontWeight: 700, marginBottom: 10 }}>Your areas</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          {areaSections.map(sec => (
            <div key={sec.section} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px' }}>
              <div style={{ color: '#111827', fontWeight: 700, fontSize: 15, marginBottom: 8 }}>{sec.section}</div>
              {sec.items.slice(0, 4).map(it => (
                <Link key={it.path} to={it.path} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
                  color: '#1f2937', fontSize: 14, textDecoration: 'none',
                }}>
                  <span>{it.icon}</span>{it.label}
                </Link>
              ))}
              {sec.items.length > 4 && (
                <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 4 }}>
                  +{sec.items.length - 4} more in the menu
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
