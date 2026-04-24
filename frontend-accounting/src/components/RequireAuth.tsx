/**
 * RequireAuth — wraps office routes. Redirects to /login if no valid token.
 * Saves the requested path so login can redirect back after success.
 */

import { Navigate, useLocation } from 'react-router-dom';

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

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!tokenValid()) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}
