import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import FieldSubmit from './pages/FieldSubmit';
import VendorAdmin from './pages/VendorAdmin';
import APDashboard from './pages/APDashboard';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/field"   element={<FieldSubmit />} />
        <Route path="/vendors" element={<VendorAdmin />} />
        <Route path="/ap"      element={<APDashboard />} />
        <Route path="*" element={<Navigate to="/field" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
