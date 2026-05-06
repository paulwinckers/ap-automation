/**
 * DashboardsIndex — lists all available dashboards.
 * Route: /dashboards
 */

import { Link } from 'react-router-dom';

const DASHBOARDS = [
  {
    to:    '/dashboards/sales',
    icon:  '📈',
    label: 'Sales Dashboard',
    sub:   'Revenue pipeline, targets & pace',
  },
  {
    to:    '/dashboards/ops',
    icon:  '🗓️',
    label: 'Ops Dashboard',
    sub:   'Daily hours log vs budget, MTD/YTD',
  },
  {
    to:    '/dashboards/construction',
    icon:  '🏗️',
    label: 'Construction Dashboard',
    sub:   'Job progress, hours & site updates',
  },
  {
    to:    '/dashboards/estimating',
    icon:  '💼',
    label: 'Estimating Dashboard',
    sub:   'Open opportunities & pipeline value',
  },
  {
    to:    '/dashboards/activities',
    icon:  '📋',
    label: 'Activity Summary',
    sub:   'Open issues & activities from Aspire',
  },
];

export default function DashboardsIndex() {
  return (
    <div style={{
      background: '#f8fafc', minHeight: '100vh',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      padding: '32px 28px',
    }}>
      <h1 style={{ margin: '0 0 6px', fontSize: 24, fontWeight: 800, color: '#111827' }}>
        Dashboards
      </h1>
      <p style={{ margin: '0 0 28px', fontSize: 13, color: '#6b7280' }}>
        Select a dashboard to view
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16, maxWidth: 900 }}>
        {DASHBOARDS.map(d => (
          <Link
            key={d.to}
            to={d.to}
            style={{ textDecoration: 'none' }}
          >
            <div style={{
              background: '#fff', borderRadius: 12,
              border: '1px solid #e5e7eb',
              padding: '20px 22px',
              display: 'flex', alignItems: 'flex-start', gap: 14,
              transition: 'box-shadow 0.15s, border-color 0.15s',
              cursor: 'pointer',
            }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)';
                (e.currentTarget as HTMLDivElement).style.borderColor = '#2563eb';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
                (e.currentTarget as HTMLDivElement).style.borderColor = '#e5e7eb';
              }}
            >
              <span style={{ fontSize: 28, lineHeight: 1 }}>{d.icon}</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#111827', marginBottom: 3 }}>{d.label}</div>
                <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.4 }}>{d.sub}</div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
