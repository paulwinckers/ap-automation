import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

// Eager: the shell wrappers used on every route, plus the public Landing (the first
// paint for new users — no spinner flash on "/"). Everything else is route-split.
import AppShell       from './components/AppShell';
import RequireAuth    from './components/RequireAuth';
import FieldShell     from './components/FieldShell';
import PageViewTracker from './components/PageViewTracker';
import Landing        from './pages/Landing';

// Lazy: every page gets its own chunk, loaded on first navigation to it. Heavy
// shared libs (Chart.js, XLSX, PapaParse) are hoisted into shared chunks and so
// leave the initial bundle entirely — they load only when a dashboard is opened.
const Login                  = lazy(() => import('./pages/Login'));
const Setup                  = lazy(() => import('./pages/Setup'));
const APDashboard            = lazy(() => import('./pages/APDashboard'));
const VendorAdmin            = lazy(() => import('./pages/VendorAdmin'));
const Reconcile              = lazy(() => import('./pages/Reconcile'));
const UserAdmin              = lazy(() => import('./pages/UserAdmin'));
const EmailCapture           = lazy(() => import('./pages/EmailCapture'));
const SalesDashboard         = lazy(() => import('./pages/SalesDashboard'));
const ConstructionDashboard  = lazy(() => import('./pages/ConstructionDashboard'));
const ConstructionPlan       = lazy(() => import('./pages/ConstructionPlan'));
const ConstructionBoard      = lazy(() => import('./pages/ConstructionBoard'));
const DailySchedule          = lazy(() => import('./pages/DailySchedule'));
const CustomerDashboard      = lazy(() => import('./pages/CustomerDashboard'));
const Customer360            = lazy(() => import('./pages/Customer360'));
const SalesVisit             = lazy(() => import('./pages/SalesVisit'));
const WeeklySchedule         = lazy(() => import('./pages/WeeklySchedule'));
const EstimatingDashboard    = lazy(() => import('./pages/EstimatingDashboard'));
const ActivitiesDashboard    = lazy(() => import('./pages/ActivitiesDashboard'));
const DashboardsIndex        = lazy(() => import('./pages/DashboardsIndex'));
const FieldSubmit            = lazy(() => import('./pages/FieldSubmit'));
const FieldWorkTicket        = lazy(() => import('./pages/FieldWorkTicket'));
const FieldIssue             = lazy(() => import('./pages/FieldIssue'));
const FieldPurchaseOrder     = lazy(() => import('./pages/FieldPurchaseOrder'));
const FieldAmendPO           = lazy(() => import('./pages/FieldAmendPO'));
const FieldKeys              = lazy(() => import('./pages/FieldKeys'));
const FieldSafetyTalk        = lazy(() => import('./pages/FieldSafetyTalk'));
const FieldDocuments         = lazy(() => import('./pages/FieldDocuments'));
const FieldSafetyProgram     = lazy(() => import('./pages/FieldSafetyProgram'));
const SafetyProgramAdmin     = lazy(() => import('./pages/SafetyProgramAdmin'));
const FieldSafetyMeetings    = lazy(() => import('./pages/FieldSafetyMeetings'));
const SafetyMeetingsAdmin    = lazy(() => import('./pages/SafetyMeetingsAdmin'));
const DocumentsAdmin         = lazy(() => import('./pages/DocumentsAdmin'));
const KeyScan                = lazy(() => import('./pages/KeyScan'));
const TimeTracking           = lazy(() => import('./pages/TimeTracking'));
const PropertyLookup         = lazy(() => import('./pages/PropertyLookup'));
const KeysAdmin              = lazy(() => import('./pages/KeysAdmin'));
const SafetyTalksAdmin       = lazy(() => import('./pages/SafetyTalksAdmin'));
const FieldInspection        = lazy(() => import('./pages/FieldInspection'));
const SafetyInspectionsAdmin = lazy(() => import('./pages/SafetyInspectionsAdmin'));
const FieldIncident          = lazy(() => import('./pages/FieldIncident'));
const SafetyIncidentsAdmin   = lazy(() => import('./pages/SafetyIncidentsAdmin'));
const FieldVehicleInspection = lazy(() => import('./pages/FieldVehicleInspection'));
const VehicleInspectionsAdmin = lazy(() => import('./pages/VehicleInspectionsAdmin'));
const SafetyPHAAdmin         = lazy(() => import('./pages/SafetyPHAAdmin'));
const BackupsAdmin           = lazy(() => import('./pages/BackupsAdmin'));
const EmailSettings          = lazy(() => import('./pages/EmailSettings'));
const FieldCheckin           = lazy(() => import('./pages/FieldCheckin'));
const FieldProject           = lazy(() => import('./pages/FieldProject'));
const FieldProjectLookup     = lazy(() => import('./pages/FieldProjectLookup'));
const FieldMaintenance       = lazy(() => import('./pages/FieldMaintenance'));
const FieldMaintenanceLookup = lazy(() => import('./pages/FieldMaintenanceLookup'));
const IssuesDashboard        = lazy(() => import('./pages/IssuesDashboard'));
const EmergencyReset         = lazy(() => import('./pages/EmergencyReset'));
const InvoiceSummaryReport   = lazy(() => import('./pages/InvoiceSummaryReport'));
const MyWork                 = lazy(() => import('./pages/MyWork'));
const FieldHome              = lazy(() => import('./pages/FieldHome'));
const OfficeHome             = lazy(() => import('./pages/OfficeHome'));
const Account                = lazy(() => import('./pages/Account'));
const FieldFeed              = lazy(() => import('./pages/FieldFeed'));
const UsageAdmin             = lazy(() => import('./pages/UsageAdmin'));
const Training               = lazy(() => import('./pages/Training'));
const TrainingReport         = lazy(() => import('./pages/TrainingReport'));

/** Wrap a page in the office sidebar shell */
function Office({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

/** Lightweight fallback shown while a route's chunk downloads. */
function PageLoading() {
  return (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 22, height: 22, border: '3px solid #e5e7eb', borderTopColor: '#1A5376', borderRadius: '50%', animation: 'ap-spin 0.7s linear infinite' }} />
      <style>{'@keyframes ap-spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );
}

/** A stale, cached index.html can point at a chunk hash a newer deploy replaced, so a
 *  lazy import() 404s. Reload once (rate-limited to avoid a loop) to fetch the fresh
 *  index + chunks; a genuine, repeated failure shows a manual Reload instead. */
class ChunkErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) {
    const msg = String((error as { message?: string })?.message || error || '');
    const isChunk = /dynamically imported module|module script failed|ChunkLoadError|Failed to fetch/i.test(msg);
    let last = 0;
    try { last = Number(sessionStorage.getItem('ap_chunk_reload_at') || 0); } catch { /* ignore */ }
    if (isChunk && Date.now() - last > 10000) {
      try { sessionStorage.setItem('ap_chunk_reload_at', String(Date.now())); } catch { /* ignore */ }
      window.location.reload();
    }
  }
  render() {
    if (this.state.failed) {
      return (
        <div style={{ minHeight: '60vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: '#374151' }}>
          <div>This page didn’t finish loading.</div>
          <button onClick={() => window.location.reload()} style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#1A5376', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <PageViewTracker />
      <ChunkErrorBoundary>
      <Suspense fallback={<PageLoading />}>
      <Routes>

        {/* Landing */}
        <Route path="/"    element={<Landing />} />
        <Route path="/crew" element={<FieldHome />} />
        <Route path="/home" element={<RequireAuth><Office><OfficeHome /></Office></RequireAuth>} />
        <Route path="/account" element={<RequireAuth><Office><Account /></Office></RequireAuth>} />

        {/* Auth */}
        <Route path="/login"           element={<Login />} />
        <Route path="/setup"           element={<Setup />} />
        <Route path="/emergency-reset" element={<EmergencyReset />} />

        {/* Field crew — no shell, phone-optimised, no login required */}
        <Route path="/field"             element={<FieldShell lift={110}><FieldSubmit /></FieldShell>} />
        <Route path="/field/feed" element={<FieldShell><FieldFeed /></FieldShell>} />
        <Route path="/field/work-ticket" element={<FieldShell lift={110}><FieldWorkTicket /></FieldShell>} />
        {/* New Opportunity — access removed for now (kept for easy re-enable)
        <Route path="/field/opportunity" element={<FieldOpportunity />} /> */}
        {/* Contacts — public (no login), moved up into Field Staff */}
        <Route path="/field/contacts"    element={<FieldShell><PropertyLookup /></FieldShell>} />
        <Route path="/field/issue"          element={<FieldShell><FieldIssue /></FieldShell>} />
        <Route path="/field/purchase-order" element={<FieldShell><FieldPurchaseOrder /></FieldShell>} />
        <Route path="/field/amend-po"       element={<FieldShell><FieldAmendPO /></FieldShell>} />
        <Route path="/keys/scan/:id"        element={<FieldShell><KeyScan /></FieldShell>} />
        <Route path="/field/keys"           element={<FieldShell><FieldKeys /></FieldShell>} />
        <Route path="/field/safety"           element={<FieldShell><FieldSafetyTalk /></FieldShell>} />
        <Route path="/field/documents"          element={<FieldShell><FieldDocuments /></FieldShell>} />
        <Route path="/field/safety-program"      element={<FieldShell><FieldSafetyProgram /></FieldShell>} />
        <Route path="/field/safety-meetings"     element={<FieldShell><FieldSafetyMeetings /></FieldShell>} />
        <Route path="/field/inspection"         element={<FieldShell><FieldInspection /></FieldShell>} />
        <Route path="/field/incident"           element={<FieldShell><FieldIncident /></FieldShell>} />
        <Route path="/field/vehicle-inspection"  element={<FieldShell><FieldVehicleInspection /></FieldShell>} />
        <Route path="/field/checkin/:token"     element={<FieldShell><FieldCheckin /></FieldShell>} />
        <Route path="/field/project"            element={<FieldShell><FieldProjectLookup /></FieldShell>} />
        <Route path="/field/project/:oppId"     element={<FieldShell><FieldProject /></FieldShell>} />
        <Route path="/field/maintenance"        element={<FieldShell><FieldMaintenanceLookup /></FieldShell>} />
        <Route path="/field/maintenance/:oppId" element={<FieldShell><FieldMaintenance /></FieldShell>} />

        {/* Field Ops — login required */}
        <Route path="/ops/issues"        element={<RequireAuth area="operations"><Office><IssuesDashboard /></Office></RequireAuth>} />
        <Route path="/ops/safety-talks"  element={<RequireAuth area="operations"><Office><SafetyTalksAdmin /></Office></RequireAuth>} />
        <Route path="/ops/time-tracking" element={<FieldShell><TimeTracking /></FieldShell>} />
        <Route path="/ops/contacts"      element={<RequireAuth area="customers"><Office><PropertyLookup /></Office></RequireAuth>} />
        <Route path="/keys/admin"        element={<RequireAuth area="operations"><Office><KeysAdmin /></Office></RequireAuth>} />
        <Route path="/ops/documents"          element={<RequireAuth area="operations"><Office><DocumentsAdmin /></Office></RequireAuth>} />
        <Route path="/ops/safety-program"     element={<RequireAuth area="operations"><Office><SafetyProgramAdmin /></Office></RequireAuth>} />
        <Route path="/ops/safety-inspections" element={<RequireAuth area="operations"><Office><SafetyInspectionsAdmin /></Office></RequireAuth>} />
        <Route path="/ops/safety-incidents"   element={<RequireAuth area="hr"><Office><SafetyIncidentsAdmin /></Office></RequireAuth>} />
        <Route path="/ops/vehicle-inspections" element={<RequireAuth area="operations"><Office><VehicleInspectionsAdmin /></Office></RequireAuth>} />
        <Route path="/ops/safety-pha"          element={<RequireAuth area="operations"><Office><SafetyPHAAdmin /></Office></RequireAuth>} />
        <Route path="/ops/safety-meetings"     element={<RequireAuth area="operations"><Office><SafetyMeetingsAdmin /></Office></RequireAuth>} />

        {/* AP & Finance */}
        <Route path="/ap/invoice-summary" element={<RequireAuth area="finance"><Office><InvoiceSummaryReport /></Office></RequireAuth>} />
        <Route path="/ap"        element={<RequireAuth area="finance"><Office><APDashboard /></Office></RequireAuth>} />
        <Route path="/vendors"   element={<RequireAuth area="finance"><Office><VendorAdmin /></Office></RequireAuth>} />
        <Route path="/reconcile" element={<RequireAuth area="finance"><Office><Reconcile /></Office></RequireAuth>} />
        <Route path="/users"     element={<RequireAuth area="admin"><Office><UserAdmin /></Office></RequireAuth>} />
        <Route path="/sales/email-capture" element={<RequireAuth area="admin"><Office><EmailCapture /></Office></RequireAuth>} />
        <Route path="/settings/email" element={<RequireAuth area="admin"><Office><EmailSettings /></Office></RequireAuth>} />
        <Route path="/ops/backups"     element={<RequireAuth area="admin"><Office><BackupsAdmin /></Office></RequireAuth>} />
        <Route path="/ops/usage"       element={<RequireAuth area="admin"><Office><UsageAdmin /></Office></RequireAuth>} />

        {/* Training — any signed-in person (crew leads get a Training-only account); no sidebar, phone-first */}
        <Route path="/training"                     element={<RequireAuth><Training /></RequireAuth>} />
        <Route path="/training/:courseId"           element={<RequireAuth><Training /></RequireAuth>} />
        <Route path="/training/:courseId/:moduleId" element={<RequireAuth><Training /></RequireAuth>} />
        <Route path="/ops/training"                 element={<RequireAuth area="hr"><Office><TrainingReport /></Office></RequireAuth>} />

        {/* Personal worklist */}
        <Route path="/my-work" element={<RequireAuth><Office><MyWork /></Office></RequireAuth>} />

        {/* Dashboards */}
        <Route path="/dashboards"              element={<RequireAuth><Office><DashboardsIndex /></Office></RequireAuth>} />
        <Route path="/dashboards/sales"        element={<RequireAuth area="customers"><Office><SalesDashboard /></Office></RequireAuth>} />
        <Route path="/dashboards/schedule"      element={<RequireAuth area="operations"><Office><DailySchedule /></Office></RequireAuth>} />
        <Route path="/dashboards/customer"      element={<RequireAuth area="customers"><Office><CustomerDashboard /></Office></RequireAuth>} />
        <Route path="/dashboards/customer/360"  element={<RequireAuth area="customers"><Office><Customer360 /></Office></RequireAuth>} />
        <Route path="/sales/log"                 element={<RequireAuth area="customers"><SalesVisit /></RequireAuth>} />
        <Route path="/dashboards/schedule/week" element={<RequireAuth area="operations"><Office><WeeklySchedule /></Office></RequireAuth>} />
        <Route path="/dashboards/construction" element={<RequireAuth area="operations"><Office><ConstructionDashboard /></Office></RequireAuth>} />
        <Route path="/dashboards/construction/plan" element={<RequireAuth area="operations"><Office><ConstructionPlan /></Office></RequireAuth>} />
        <Route path="/dashboards/construction/board" element={<RequireAuth area="operations"><Office><ConstructionBoard /></Office></RequireAuth>} />
        <Route path="/dashboards/estimating"   element={<RequireAuth area="customers"><Office><EstimatingDashboard /></Office></RequireAuth>} />
        <Route path="/dashboards/activities"   element={<RequireAuth area="customers"><Office><ActivitiesDashboard /></Office></RequireAuth>} />

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />

      </Routes>
      </Suspense>
      </ChunkErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>
);

// Register the service worker so the app is installable and can receive push on every device.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ });
  });
}
