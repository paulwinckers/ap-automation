import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import AppShell       from './components/AppShell';
import Landing        from './pages/Landing';
import FieldSubmit    from './pages/FieldSubmit';
import FieldWorkTicket  from './pages/FieldWorkTicket';
import FieldOpportunity from './pages/FieldOpportunity';
import FieldIssue           from './pages/FieldIssue';
import FieldPurchaseOrder  from './pages/FieldPurchaseOrder';
import APDashboard    from './pages/APDashboard';
import VendorAdmin    from './pages/VendorAdmin';
import Reconcile      from './pages/Reconcile';
import SalesDashboard        from './pages/SalesDashboard';
import OpsDashboard          from './pages/OpsDashboard';
import ConstructionDashboard from './pages/ConstructionDashboard';
import EstimatingDashboard  from './pages/EstimatingDashboard';
import ActivitiesDashboard  from './pages/ActivitiesDashboard';
import CrewSchedule         from './pages/CrewSchedule';
import TimeTracking         from './pages/TimeTracking';
import PropertyLookup       from './pages/PropertyLookup';
import Login                from './pages/Login';
import Setup                from './pages/Setup';
import UserAdmin            from './pages/UserAdmin';
import RequireAuth          from './components/RequireAuth';

/** Wrap a page in the office sidebar shell */
function Office({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>

        {/* Landing */}
        <Route path="/"    element={<Landing />} />

        {/* Auth */}
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />

        {/* Field crew — no shell, phone-optimised, no login required */}
        <Route path="/field"             element={<FieldSubmit />} />
        <Route path="/field/work-ticket" element={<FieldWorkTicket />} />
        <Route path="/field/opportunity" element={<FieldOpportunity />} />
        <Route path="/field/issue"          element={<FieldIssue />} />
        <Route path="/field/purchase-order" element={<FieldPurchaseOrder />} />

        {/* Office / AP — login required */}
        <Route path="/ap"           element={<RequireAuth><Office><APDashboard /></Office></RequireAuth>} />
        <Route path="/ap/vendors"   element={<RequireAuth><Office><VendorAdmin /></Office></RequireAuth>} />
        <Route path="/ap/users"     element={<RequireAuth><Office><UserAdmin /></Office></RequireAuth>} />
        <Route path="/ap/reconcile" element={<RequireAuth><Office><Reconcile /></Office></RequireAuth>} />

        {/* Dashboards — login required */}
        <Route path="/dashboards/sales"        element={<RequireAuth><Office><SalesDashboard /></Office></RequireAuth>} />
        <Route path="/dashboards/ops"          element={<RequireAuth><Office><OpsDashboard /></Office></RequireAuth>} />
        <Route path="/dashboards/construction" element={<RequireAuth><Office><ConstructionDashboard /></Office></RequireAuth>} />
        <Route path="/dashboards/estimating"   element={<RequireAuth><Office><EstimatingDashboard /></Office></RequireAuth>} />
        <Route path="/dashboards/activities"   element={<RequireAuth><Office><ActivitiesDashboard /></Office></RequireAuth>} />
        <Route path="/ops/crew-schedule"       element={<RequireAuth><Office><CrewSchedule /></Office></RequireAuth>} />
        <Route path="/ops/time-tracking"       element={<TimeTracking />} />
        <Route path="/ops/contacts"            element={<RequireAuth><Office><PropertyLookup /></Office></RequireAuth>} />

        {/* Legacy URL redirects */}
        <Route path="/vendors"      element={<Navigate to="/ap/vendors"   replace />} />
        <Route path="/reconcile"    element={<Navigate to="/ap/reconcile" replace />} />
        <Route path="/construction" element={<Navigate to="/dashboards/construction" replace />} />

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />

      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
