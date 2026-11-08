/**
 * PageViewTracker — records each page someone opens (see backend app/api/usage.py).
 * Signed-in people are known from their login; crew phones send the name they already remember
 * (from the receipt / chat / key forms) and a random id kept on the phone. Admins read the
 * results on /ops/usage.
 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { trackPageView } from '../lib/api';

function deviceId(): string {
  try {
    let d = localStorage.getItem('dv_id');
    if (!d) {
      d = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      localStorage.setItem('dv_id', d);
    }
    return d;
  } catch { return ''; }
}

function crewName(): string {
  try {
    const f = JSON.parse(localStorage.getItem('fieldUser') || '{}');
    if (f && f.name) return String(f.name);
  } catch { /* ignore */ }
  try {
    return localStorage.getItem('fieldCrewName') || localStorage.getItem('field_employee')
      || localStorage.getItem('key_employee') || '';
  } catch { return ''; }
}

export default function PageViewTracker() {
  const { pathname, search } = useLocation();
  const tab = new URLSearchParams(search).get('tab');
  useEffect(() => {
    // Short delay so a redirect (e.g. / → /login) only counts where the person lands.
    const t = setTimeout(() => trackPageView({ path: pathname, tab, device: deviceId(), name: crewName() }), 400);
    return () => clearTimeout(t);
  }, [pathname, tab]);
  return null;
}
