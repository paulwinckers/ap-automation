import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import AppShell          from './components/AppShell';
import RequireAuth        from './components/RequireAuth';
import Landing            from './pages/Landing';
import Login              from './pages/Login';
import Setup              from './pages/Setup';
import FieldSubmit        from './pages/FieldSubmit';
import FieldWorkTicket    from './pages/FieldWorkTicket';
import FieldOpportunity   from './pages/FieldOpportunity';
import FieldIssue         from './pages/FieldIssue';
import FieldPurchaseOrder from './pages/FieldPurchaseOrder';
import FieldAmendPO       from './pages/FieldAmendPO';
import FieldKeys          from './pages/FieldKeys';
import FieldSafetyTalk    from './pages/FieldSafetyTalk';
import FieldDocuments     from './pages/FieldDocuments';
import DocumentsAdmin     from './pages/DocumentsAdmin';
import KeyScan            from './pages/KeyScan';
import CrewSchedule       from './pages/CrewSchedule';
import TimeTracking       from './pages/TimeTracking';
import PropertyLookup     from './pages/PropertyLookup';
import KeysAdmin          from './pages/KeysAdmin';
import SafetyTalksAdmin       from './pages/SafetyTalksAdmin';
import FieldInspection        from './pages/FieldInspection';
import SafetyInspectionsAdmin from './pages/SafetyInspectionsAdmin';

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
        <Route path="/field/amend-po"       element={<FieldAmendPO />} />
        <Route path="/keys/scan/:id"        element={<KeyScan />} />
        <Route path="/field/keys"           element={<FieldKeys />} />
        <Route path="/field/safety"           element={<FieldSafetyTalk />} />
        <Route path="/field/documents"          element={<FieldDocuments />} />
        <Route path="/field/inspection"         element={<FieldInspection />} />

        {/* Field Ops — login required */}
        <Route path="/ops/crew-schedule" element={<RequireAuth><Office><CrewSchedule /></Office></RequireAuth>} />
        <Route path="/ops/safety-talks"  element={<RequireAuth><Office><SafetyTalksAdmin /></Office></RequireAuth>} />
        <Route path="/ops/time-tracking" element={<TimeTracking />} />
        <Route path="/ops/contacts"      element={<RequireAuth><Office><PropertyLookup /></Office></RequireAuth>} />
        <Route path="/keys/admin"        element={<RequireAuth><Office><KeysAdmin /></Office></RequireAuth>} />
        <Route path="/ops/documents"          element={<RequireAuth><Office><DocumentsAdmin /></Office></RequireAuth>} />
        <Route path="/ops/safety-inspections" element={<RequireAuth><Office><SafetyInspectionsAdmin /></Office></RequireAuth>} />

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />

      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
