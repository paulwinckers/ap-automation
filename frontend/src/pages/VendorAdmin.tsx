/**
 * VendorAdmin.tsx — Vendor rule management page.
 * Accessible at /vendors on the frontend.
 * Create, edit, and deactivate vendor routing rules.
 */

import { useState, useEffect } from 'react';

const ADMIN_PIN = import.meta.env.VITE_ADMIN_PIN || '1946';
const SESSION_KEY = 'ap_admin_auth';

function PinGate({ onUnlock }: { onUnlock: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);

  const attempt = () => {
    if (pin === ADMIN_PIN) {
      sessionStorage.setItem(SESSION_KEY, '1');
      onUnlock();
    } else {
      setError(true);
      setPin('');
      setTimeout(() => setError(false), 2000);
    }
  };

  return (
    <div style={P.wrap}>
      <div style={P.box}>
        <div style={P.logo}>🔒</div>
        <div style={P.title}>Vendor Admin</div>
        <div style={P.sub}>Enter your PIN to continue</div>
        <input
          style={{ ...P.input, borderColor: error ? '#dc2626' : '#e2e6ed' }}
          type="password"
          inputMode="numeric"
          maxLength={8}
          placeholder="PIN"
          value={pin}
          onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
          onKeyDown={e => e.key === 'Enter' && attempt()}
          autoFocus
        />
        {error && <div style={P.err}>Incorrect PIN</div>}
        <button style={P.btn} onClick={attempt}>Unlock</button>
      </div>
    </div>
  );
}

const P: Record<string, React.CSSProperties> = {
  wrap:  { minHeight: '100vh', background: '#f4f6f9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans',sans-serif" },
  box:   { background: '#fff', border: '1px solid #e2e6ed', borderRadius: 16, padding: '40px 32px', width: '100%', maxWidth: 320, textAlign: 'center' },
  logo:  { fontSize: 40, marginBottom: 12 },
  title: { fontSize: 20, fontWeight: 600, color: '#1a1d23', marginBottom: 4 },
  sub:   { fontSize: 13, color: '#6b7280', marginBottom: 24 },
  input: { width: '100%', padding: '12px 14px', border: '1.5px solid', borderRadius: 8, fontSize: 18, textAlign: 'center' as const, outline: 'none', fontFamily: 'inherit', letterSpacing: '0.2em', boxSizing: 'border-box' as const, marginBottom: 8 },
  err:   { fontSize: 13, color: '#dc2626', marginBottom: 8 },
  btn:   { width: '100%', padding: 14, background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};
import {
  listVendors,
  createVendor,
  updateVendor,
  deactivateVendor,
  type VendorRule,
} from '../lib/api';

type VendorType = 'job_cost' | 'overhead' | 'mixed';

const EMPTY_FORM = {
  vendor_name: '',
  type: 'overhead' as VendorType,
  default_gl_account: '',
  default_gl_name: '',
  vendor_id_aspire: '',
  vendor_id_qbo: '',
  notes: '',
  is_employee: false,
};

export default function VendorAdmin() {
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem(SESSION_KEY) === '1');

  if (!unlocked) return <PinGate onUnlock={() => setUnlocked(true)} />;

  return <VendorAdminInner />;
}

function VendorAdminInner() {
  const [vendors, setVendors] = useState<VendorRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = () => {
    setLoading(true);
    listVendors()
      .then(res => { setVendors(res.vendors); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
    setShowForm(true);
  };

  const openEdit = (v: VendorRule) => {
    setEditingId(v.id);
    setForm({
      vendor_name:       v.vendor_name,
      type:              v.type,
      default_gl_account: v.default_gl_account || '',
      default_gl_name:   v.default_gl_name || '',
      vendor_id_aspire:  v.vendor_id_aspire || '',
      vendor_id_qbo:     v.vendor_id_qbo || '',
      notes:             v.notes || '',
      is_employee:       v.is_employee ?? false,
    });
    setSaveError(null);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.vendor_name.trim()) { setSaveError('Vendor name is required'); return; }
    setSaving(true); setSaveError(null);
    try {
      const payload = {
        vendor_name:        form.vendor_name.trim(),
        type:               form.type,
        default_gl_account: form.default_gl_account.trim() || undefined,
        default_gl_name:    form.default_gl_name.trim() || undefined,
        vendor_id_aspire:   form.vendor_id_aspire.trim() || undefined,
        vendor_id_qbo:      form.vendor_id_qbo.trim() || undefined,
        notes:              form.notes.trim() || undefined,
        is_employee:        form.is_employee,
      };
      if (editingId !== null) {
        await updateVendor(editingId, payload);
      } else {
        await createVendor(payload);
      }
      setShowForm(false);
      load();
    } catch (e: unknown) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async (id: number, name: string) => {
    if (!confirm(`Deactivate "${name}"? It will no longer be used for routing.`)) return;
    try {
      await deactivateVendor(id);
      load();
    } catch (e: unknown) {
      alert((e as Error).message);
    }
  };

  const displayed = vendors.filter(v => showInactive ? true : v.active);

  const typeLabel: Record<VendorType, string> = {
    job_cost: 'Job cost',
    overhead: 'Overhead',
    mixed:    'Mixed',
  };
  const typeBadge: Record<VendorType, React.CSSProperties> = {
    job_cost: { background: '#dbeafe', color: '#1e40af' },
    overhead: { background: '#fef9c3', color: '#92400e' },
    mixed:    { background: '#f3e8ff', color: '#6b21a8' },
  };

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerRow}>
          <div>
            <div style={S.h1}>Vendor Rules</div>
            <div style={S.hsub}>Routing configuration — Aspire &amp; QBO</div>
          </div>
          <button style={S.addBtn} onClick={openCreate}>+ Add vendor</button>
        </div>
      </div>

      <div style={S.content}>
        {/* Toolbar */}
        <div style={S.toolbar}>
          <label style={S.toggle}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={e => setShowInactive(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Show inactive
          </label>
          <span style={S.count}>{displayed.length} vendor{displayed.length !== 1 ? 's' : ''}</span>
        </div>

        {/* Error / loading */}
        {loading && <div style={S.info}>Loading…</div>}
        {error && <div style={S.errBox}>{error}</div>}

        {/* Vendor list */}
        {!loading && !error && (
          <div style={S.list}>
            {displayed.length === 0 && (
              <div style={S.empty}>No vendors yet — add one to get started.</div>
            )}
            {displayed.map(v => (
              <div key={v.id} style={{ ...S.card, opacity: v.active ? 1 : 0.5 }}>
                <div style={S.cardTop}>
                  <div style={S.cardLeft}>
                    <span style={S.vendorName}>{v.vendor_name}</span>
                    <span style={{ ...S.badge, ...typeBadge[v.type] }}>{typeLabel[v.type]}</span>
                    {v.is_employee && <span style={S.empBadge}>Employee</span>}
                    {!v.active && <span style={S.inactiveBadge}>Inactive</span>}
                  </div>
                  <div style={S.cardActions}>
                    <button style={S.editBtn} onClick={() => openEdit(v)}>Edit</button>
                    {v.active && (
                      <button style={S.deactivateBtn} onClick={() => handleDeactivate(v.id, v.vendor_name)}>
                        Deactivate
                      </button>
                    )}
                  </div>
                </div>
                {(v.default_gl_account || v.notes) && (
                  <div style={S.cardDetail}>
                    {v.default_gl_account && (
                      <span>GL: {v.default_gl_account}{v.default_gl_name ? ` — ${v.default_gl_name}` : ''}</span>
                    )}
                    {v.notes && <span style={{ color: '#6b7280' }}>{v.notes}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Slide-in form */}
      {showForm && (
        <div style={S.overlay} onClick={() => setShowForm(false)}>
          <div style={S.drawer} onClick={e => e.stopPropagation()}>
            <div style={S.drawerHeader}>
              <span style={S.drawerTitle}>{editingId ? 'Edit vendor' : 'New vendor'}</span>
              <button style={S.closeBtn} onClick={() => setShowForm(false)}>✕</button>
            </div>

            <div style={S.drawerBody}>
              {/* Vendor name */}
              <div style={S.field}>
                <label style={S.label}>Vendor name <span style={S.req}>*</span></label>
                <input
                  style={S.input}
                  value={form.vendor_name}
                  onChange={e => setForm(f => ({ ...f, vendor_name: e.target.value }))}
                  placeholder="e.g. Telus Business"
                  disabled={editingId !== null}
                />
                {editingId !== null && (
                  <div style={S.hint}>Name cannot be changed after creation.</div>
                )}
              </div>

              {/* Type */}
              <div style={S.field}>
                <label style={S.label}>Routing type <span style={S.req}>*</span></label>
                <div style={S.segmented}>
                  {(['job_cost', 'overhead', 'mixed'] as VendorType[]).map(t => (
                    <button
                      key={t}
                      style={{ ...S.seg, ...(form.type === t ? S.segActive : {}) }}
                      onClick={() => setForm(f => ({ ...f, type: t }))}
                    >
                      {typeLabel[t]}
                    </button>
                  ))}
                </div>
                <div style={S.hint}>
                  {form.type === 'job_cost' && 'Always routed to Aspire. Requires a PO number.'}
                  {form.type === 'overhead' && 'Always routed to QBO. Uses the GL account below.'}
                  {form.type === 'mixed' && 'Aspire if a PO is found, otherwise QBO.'}
                </div>
              </div>

              {/* Employee toggle */}
              <div style={S.field}>
                <label style={S.label}>Employee expense</label>
                <label style={S.checkRow}>
                  <div
                    style={{ ...S.toggleTrack, background: form.is_employee ? '#2563eb' : '#e2e6ed' }}
                    onClick={() => setForm(f => ({ ...f, is_employee: !f.is_employee }))}
                  >
                    <div style={{ ...S.toggleThumb, transform: form.is_employee ? 'translateX(20px)' : 'translateX(0)' }} />
                  </div>
                  <span style={S.checkLabel}>
                    {form.is_employee
                      ? 'Appears in the employee expense dropdown'
                      : 'Not an employee'}
                  </span>
                </label>
              </div>

              {/* GL account (overhead / mixed) */}
              {(form.type === 'overhead' || form.type === 'mixed') && (
                <div style={S.fieldRow}>
                  <div style={{ ...S.field, flex: 1 }}>
                    <label style={S.label}>GL account</label>
                    <input
                      style={S.input}
                      value={form.default_gl_account}
                      onChange={e => setForm(f => ({ ...f, default_gl_account: e.target.value }))}
                      placeholder="e.g. 6400"
                    />
                  </div>
                  <div style={{ ...S.field, flex: 2 }}>
                    <label style={S.label}>GL name</label>
                    <input
                      style={S.input}
                      value={form.default_gl_name}
                      onChange={e => setForm(f => ({ ...f, default_gl_name: e.target.value }))}
                      placeholder="e.g. Telephone &amp; Internet"
                    />
                  </div>
                </div>
              )}

              {/* Aspire / QBO IDs */}
              <div style={S.fieldRow}>
                <div style={{ ...S.field, flex: 1 }}>
                  <label style={S.label}>Aspire vendor ID</label>
                  <input
                    style={S.input}
                    value={form.vendor_id_aspire}
                    onChange={e => setForm(f => ({ ...f, vendor_id_aspire: e.target.value }))}
                    placeholder="optional"
                  />
                </div>
                <div style={{ ...S.field, flex: 1 }}>
                  <label style={S.label}>QBO vendor ID</label>
                  <input
                    style={S.input}
                    value={form.vendor_id_qbo}
                    onChange={e => setForm(f => ({ ...f, vendor_id_qbo: e.target.value }))}
                    placeholder="optional"
                  />
                </div>
              </div>

              {/* Notes */}
              <div style={S.field}>
                <label style={S.label}>Notes</label>
                <input
                  style={S.input}
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="optional"
                />
              </div>

              {saveError && <div style={S.errBox}>{saveError}</div>}
            </div>

            <div style={S.drawerFooter}>
              <button style={S.cancelBtn} onClick={() => setShowForm(false)}>Cancel</button>
              <button style={{ ...S.saveBtn, opacity: saving ? 0.5 : 1 }} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create vendor'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
} // end VendorAdminInner

const S: Record<string, React.CSSProperties> = {
  page:        { minHeight: '100vh', background: '#f4f6f9', fontFamily: "'DM Sans',sans-serif" },
  header:      { background: '#2563eb', color: '#fff', padding: '20px 24px 24px' },
  headerRow:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', maxWidth: 800, margin: '0 auto' },
  h1:          { fontSize: 20, fontWeight: 600 },
  hsub:        { fontSize: 13, opacity: 0.8, marginTop: 2 },
  addBtn:      { background: '#fff', color: '#2563eb', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  content:     { maxWidth: 800, margin: '0 auto', padding: '20px 24px' },
  toolbar:     { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  toggle:      { display: 'flex', alignItems: 'center', fontSize: 13, color: '#6b7280', cursor: 'pointer' },
  count:       { fontSize: 13, color: '#6b7280' },
  info:        { textAlign: 'center' as const, padding: 40, color: '#6b7280', fontSize: 14 },
  errBox:      { background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#dc2626', marginBottom: 12 },
  list:        { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  empty:       { textAlign: 'center' as const, padding: 40, color: '#6b7280', fontSize: 14, background: '#fff', borderRadius: 12, border: '1px solid #e2e6ed' },
  card:        { background: '#fff', border: '1px solid #e2e6ed', borderRadius: 12, padding: '14px 16px' },
  cardTop:     { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  cardLeft:    { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const },
  vendorName:  { fontSize: 15, fontWeight: 600, color: '#1a1d23' },
  badge:       { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 20 },
  empBadge:    { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 20, background: '#dcfce7', color: '#166534' },
  inactiveBadge: { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 20, background: '#f1f5f9', color: '#94a3b8' },
  cardActions: { display: 'flex', gap: 8, flexShrink: 0 },
  cardDetail:  { marginTop: 8, display: 'flex', gap: 16, fontSize: 12, color: '#6b7280' },
  editBtn:     { fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 6, border: '1.5px solid #e2e6ed', background: '#fff', color: '#2563eb', cursor: 'pointer', fontFamily: 'inherit' },
  deactivateBtn: { fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 6, border: '1.5px solid #fca5a5', background: '#fff', color: '#dc2626', cursor: 'pointer', fontFamily: 'inherit' },
  // Overlay & drawer
  overlay:     { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100, display: 'flex', justifyContent: 'flex-end' },
  drawer:      { width: '100%', maxWidth: 460, background: '#fff', display: 'flex', flexDirection: 'column' as const, boxShadow: '-4px 0 24px rgba(0,0,0,.12)' },
  drawerHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #e2e6ed' },
  drawerTitle: { fontSize: 16, fontWeight: 600, color: '#1a1d23' },
  closeBtn:    { background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: 'pointer', padding: 4 },
  drawerBody:  { flex: 1, overflowY: 'auto' as const, padding: '20px 24px', display: 'flex', flexDirection: 'column' as const, gap: 0 },
  drawerFooter: { padding: '16px 24px', borderTop: '1px solid #e2e6ed', display: 'flex', gap: 10, justifyContent: 'flex-end' },
  // Form fields
  field:       { marginBottom: 16 },
  fieldRow:    { display: 'flex', gap: 12, marginBottom: 16 },
  label:       { display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '.04em', marginBottom: 6 },
  req:         { color: '#dc2626' },
  input:       { width: '100%', padding: '10px 12px', border: '1.5px solid #e2e6ed', borderRadius: 8, fontSize: 14, color: '#1a1d23', outline: 'none', fontFamily: 'inherit', background: '#fff', boxSizing: 'border-box' as const },
  hint:        { fontSize: 12, color: '#6b7280', marginTop: 5, lineHeight: 1.5 },
  segmented:   { display: 'flex', background: '#f4f6f9', border: '1.5px solid #e2e6ed', borderRadius: 8, padding: 3 },
  seg:         { flex: 1, padding: '8px 4px', textAlign: 'center' as const, borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#6b7280', background: 'transparent', border: 'none', fontFamily: 'inherit' },
  segActive:   { background: '#2563eb', color: '#fff' },
  // Employee toggle
  checkRow:    { display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' },
  toggleTrack: { width: 44, height: 24, borderRadius: 12, position: 'relative' as const, cursor: 'pointer', transition: 'background .2s', flexShrink: 0 },
  toggleThumb: { position: 'absolute' as const, top: 2, left: 2, width: 20, height: 20, borderRadius: 10, background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,.2)', transition: 'transform .2s' },
  checkLabel:  { fontSize: 13, color: '#1a1d23' },
  // Footer buttons
  cancelBtn:   { padding: '10px 20px', borderRadius: 8, border: '1.5px solid #e2e6ed', background: '#fff', color: '#6b7280', fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  saveBtn:     { padding: '10px 24px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};
