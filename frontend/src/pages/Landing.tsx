/**
 * Landing — branded entry point for the Darios Operations Portal.
 *
 * /field/*  — public, no login required (field crew)
 * /ap/*     — protected by Cloudflare Access (office staff)
 * /dashboards/* and /ops/* — protected by Cloudflare Access
 */

import { Link } from 'react-router-dom';

const FIELD_LINKS = [
  { to: '/field',                  icon: '🧾', label: 'Submit Receipt',   sub: 'Invoices, MC & expenses' },
  { to: '/field/work-ticket',      icon: '✅', label: 'Schedule',         sub: 'View routes & complete tickets' },
  { to: '/ops/time-tracking',      icon: '⏱️', label: 'Time Tracking',    sub: 'Clock in / out' },
  { to: '/field/purchase-order',   icon: '🛒', label: 'Purchase Order',   sub: 'Create a PO for materials' },
  { to: '/field/amend-po',         icon: '✏️', label: 'Amend PO Vendor',  sub: 'Change vendor on an open PO' },
  { to: '/field/opportunity',      icon: '➕', label: 'New Opportunity',   sub: 'Create a job in Aspire' },
  { to: '/field/issue',            icon: '⚠️', label: 'New Issue',         sub: 'Log a site issue' },
];

const OFFICE_GROUPS = [
  {
    label: 'AP & Finance',
    items: [
      { to: '/ap',           icon: '💳', label: 'Invoices',   sub: 'Review & post invoices' },
      { to: '/ap/vendors',   icon: '🏪', label: 'Vendors',    sub: 'Routing & Aspire links' },
      { to: '/ap/reconcile', icon: '🔄', label: 'Reconcile',  sub: 'Vendor statement matching' },
    ],
  },
  {
    label: 'Field Ops',
    items: [
      { to: '/ops/crew-schedule', icon: '👥', label: 'Crew Schedule', sub: 'Assign staff to routes' },
      { to: '/ops/contacts',      icon: '📞', label: 'Contacts',      sub: 'Property & client lookup' },
    ],
  },
  {
    label: 'Dashboards',
    items: [
      { to: '/dashboards/sales',        icon: '📊', label: 'Sales',         sub: 'Pipeline & won jobs' },
      { to: '/dashboards/ops',          icon: '⚙️', label: 'Operations',    sub: 'Job progress' },
      { to: '/dashboards/construction', icon: '🏗️', label: 'Construction',  sub: 'Active builds' },
      { to: '/dashboards/estimating',   icon: '📋', label: 'Estimating',    sub: 'Quotes & bids' },
      { to: '/dashboards/activities',   icon: '📅', label: 'Activities',    sub: 'Team activity log' },
      { to: 'https://ap-automation-production.up.railway.app/dashboard/daily-report', icon: '📝', label: 'Daily Report', sub: 'Completion report by division', external: true },
    ],
  },
];

function CardLink({ to, icon, label, sub, external }: { to: string; icon: string; label: string; sub: string; external?: boolean }) {
  const inner = (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', cursor: 'pointer' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ fontSize: 20, flexShrink: 0, width: 28, textAlign: 'center' }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ color: '#fff', fontWeight: 600, fontSize: 14 }}>{label}</div>
        <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 1 }}>{sub}</div>
      </div>
      <span style={{ color: '#475569', fontSize: 14 }}>›</span>
    </div>
  );
  if (external) {
    return <a href={to} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>{inner}</a>;
  }
  return <Link to={to} style={{ textDecoration: 'none' }}>{inner}</Link>;
}

export default function Landing() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f172a',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px 16px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>

      {/* Brand */}
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <img src="/darios-logo.png" alt="Darios Landscaping" style={{ height: 80, marginBottom: 12, objectFit: 'contain' }} />
        <p style={{ color: '#475569', marginTop: 6, fontSize: 13, margin: '6px 0 0' }}>
          Operations Portal
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%', maxWidth: 400 }}>

        {/* ── Field Staff — public, no login ── */}
        <div style={{
          background: '#14532d',
          border: '1px solid #16a34a',
          borderRadius: 14,
          overflow: 'hidden',
        }}>
          <div style={{ padding: '14px 20px 10px', borderBottom: '1px solid #16a34a', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>📱</span>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>Field Staff</div>
            <span style={{ marginLeft: 'auto', background: '#166534', color: '#86efac', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, letterSpacing: '0.05em' }}>
              NO LOGIN NEEDED
            </span>
          </div>
          {FIELD_LINKS.map(item => (
            <Link key={item.to} to={item.to} style={{ textDecoration: 'none' }}>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ fontSize: 20, flexShrink: 0, width: 28, textAlign: 'center' }}>{item.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#fff', fontWeight: 600, fontSize: 14 }}>{item.label}</div>
                  <div style={{ color: '#86efac', fontSize: 12, marginTop: 1 }}>{item.sub}</div>
                </div>
                <span style={{ color: '#4ade80', fontSize: 14 }}>›</span>
              </div>
            </Link>
          ))}
        </div>

        {/* ── Office & Management — protected ── */}
        <div style={{
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 14,
          overflow: 'hidden',
        }}>
          <div style={{ padding: '14px 20px 10px', borderBottom: '1px solid #334155', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>🏢</span>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>Office &amp; Management</div>
            <span style={{ marginLeft: 'auto', background: '#1e3a5f', color: '#93c5fd', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, letterSpacing: '0.05em' }}>
              🔒 LOGIN REQUIRED
            </span>
          </div>

          {OFFICE_GROUPS.map((group, gi) => (
            <div key={group.label}>
              {gi > 0 && <div style={{ height: 1, background: '#334155', margin: '0 20px' }} />}
              <div style={{ padding: '8px 20px 2px', color: '#475569', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                {group.label}
              </div>
              {group.items.map(item => (
                <CardLink key={item.to} {...item} />
              ))}
            </div>
          ))}
        </div>

      </div>

      <p style={{ color: '#1e293b', fontSize: 11, marginTop: 40 }}>
        Darios Landscaping &copy; {new Date().getFullYear()}
      </p>
    </div>
  );
}
