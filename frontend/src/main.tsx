import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import AppShell       from './components/AppShell';
import Landing        from './pages/Landing';
import FieldSubmit    from './pages/FieldSubmit';
import FieldWorkTicket  from './pages/FieldWorkTicket';
import FieldOpportunity from './pages/FieldOpportunity';
import APDashboard    from './pages/APDashboard';
import VendorAdmin    from './pages/VendorAdmin';
import Reconcile      from './pages/Reconcile';
import SalesDashboard        from './pages/SalesDashboard';
import OpsDashboard          from './pages/OpsDashboard';
import ConstructionDashboard from './pages/ConstructionDashboard';
import EstimatingDashboard  from './pages/EstimatingDashboard';
import ActivitiesDashboard  from './pages/ActivitiesDashboard';
import CrewSchedule         from './pages/CrewSchedule';

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

        {/* Field crew — no shell, phone-optimised */}
        <Route path="/field"             element={<FieldSubmit />} />
        <Route path="/field/work-ticket" element={<FieldWorkTicket />} />
        <Route path="/field/opportunity" element={<FieldOpportunity />} />

        {/* Office / AP — wrapped in sidebar shell */}
        <Route path="/ap"           element={<Office><APDashboard /></Office>} />
        <Route path="/ap/vendors"   element={<Office><VendorAdmin /></Office>} />
        <Route path="/ap/reconcile" element={<Office><Reconcile /></Office>} />

        {/* Dashboards — iframe embeds + native React */}
        <Route path="/dashboards/sales"         element={<Office><SalesDashboard /></Office>} />
        <Route path="/dashboards/ops"           element={<Office><OpsDashboard /></Office>} />
        <Route path="/dashboards/construction"  element={<Office><ConstructionDashboard /></Office>} />
        <Route path="/dashboards/estimating"    element={<Office><EstimatingDashboard /></Office>} />
        <Route path="/dashboards/activities"   element={<Office><ActivitiesDashboard /></Office>} />
        <Route path="/ops/crew-schedule"       element={<Office><CrewSchedule /></Office>} />

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
