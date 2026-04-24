import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import AppShell              from './components/AppShell';
import RequireAuth           from './components/RequireAuth';
import Login                 from './pages/Login';
import Setup                 from './pages/Setup';
import APDashboard           from './pages/APDashboard';
import VendorAdmin           from './pages/VendorAdmin';
import UserAdmin             from './pages/UserAdmin';
import Reconcile             from './pages/Reconcile';
import SalesDashboard        from './pages/SalesDashboard';
import OpsDashboard          from './pages/OpsDashboard';
import ConstructionDashboard from './pages/ConstructionDashboard';
import EstimatingDashboard   from './pages/EstimatingDashboard';
import ActivitiesDashboard   from './pages/ActivitiesDashboard';

function Office({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>

        {/* Default → invoices (login gate handles redirect) */}
        <Route path="/" element={<Navigate to="/ap" replace />} />

        {/* Auth */}
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />

        {/* AP & Finance */}
        <Route path="/ap"           element={<RequireAuth><Office><APDashboard /></Office></RequireAuth>} />
        <Route path="/ap/vendors"   element={<RequireAuth><Office><VendorAdmin /></Office></RequireAuth>} />
        <Route path="/ap/users"     element={<RequireAuth><Office><UserAdmin /></Office></RequireAuth>} />
        <Route path="/ap/reconcile" element={<RequireAuth><Office><Reconcile /></Office></RequireAuth>} />

        {/* Dashboards */}
        <Route path="/dashboards/sales"        element={<RequireAuth><Office><SalesDashboard /></Office></RequireAuth>} />
        <Route path="/dashboards/ops"          element={<RequireAuth><Office><OpsDashboard /></Office></RequireAuth>} />
        <Route path="/dashboards/construction" element={<RequireAuth><Office><ConstructionDashboard /></Office></RequireAuth>} />
        <Route path="/dashboards/estimating"   element={<RequireAuth><Office><EstimatingDashboard /></Office></RequireAuth>} />
        <Route path="/dashboards/activities"   element={<RequireAuth><Office><ActivitiesDashboard /></Office></RequireAuth>} />

        {/* Legacy redirects */}
        <Route path="/vendors"      element={<Navigate to="/ap/vendors"   replace />} />
        <Route path="/reconcile"    element={<Navigate to="/ap/reconcile" replace />} />
        <Route path="/construction" element={<Navigate to="/dashboards/construction" replace />} />

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/ap" replace />} />

      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
