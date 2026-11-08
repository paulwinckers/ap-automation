/**
 * RequireAuth — wraps office routes. Redirects to /login if no valid token.
 * Saves the requested path so login can redirect back after success.
 * With `area`, people without that access area see a "no access" note instead of the page
 * (the backend enforces the same areas — this just avoids a page full of errors).
 */

import { Link, Navigate, useLocation } from 'react-router-dom';
import { AREAS, Area, hasArea } from '../lib/api';

function tokenValid(): boolean {
  const token = localStorage.getItem('ap_token');
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

export default function RequireAuth({ children, area }: { children: React.ReactNode; area?: Area }) {
  const location = useLocation();
  if (!tokenValid()) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  if (area && !hasArea(area)) {
    const label = AREAS.find(a => a.key === area)?.label ?? area;
    return (
      <div style={{ padding: 48, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: '#334155' }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>You don't have access to {label}</div>
        <div style={{ fontSize: 14, marginBottom: 16 }}>Ask an admin to add {label} to your account on the Users page.</div>
        <Link to="/my-work" style={{ color: '#2563eb', fontSize: 14 }}>Go to My Action Items</Link>
      </div>
    );
  }
  return <>{children}</>;
}
