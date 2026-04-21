/**
 * FieldAmendPO.tsx — Let field crew change the vendor on an existing New-status PO.
 *
 * Flow:
 *   1. List of all "New" receipts — tap to select
 *   2. Search and pick a new vendor
 *   3. Confirm change
 *   4. Success
 */

import { useState, useEffect } from 'react';
import {
  getNewReceipts, getPOVendors, amendPOVendor,
  type NewReceipt, type POVendor,
} from '../lib/api';

type Step = 'loading' | 'select-po' | 'select-vendor' | 'confirm' | 'submitting' | 'success' | 'error';

const S: Record<string, React.CSSProperties> = {
  page:    { minHeight: '100vh', background: '#0f172a', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', padding: '0 0 40px' },
  header:  { background: '#1e293b', borderBottom: '1px solid #334155', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, position: 'sticky', top: 0, zIndex: 10 },
  logo:    { height: 32, objectFit: 'contain' as const },
  title:   { color: '#fff', fontWeight: 700, fontSize: 16, flex: 1 },
  homeBtn: { color: '#94a3b8', fontSize: 13, textDecoration: 'none', padding: '6px 10px', borderRadius: 6, border: '1px solid #334155' },
  body:    { padding: '20px 16px', maxWidth: 480, margin: '0 auto' },
  card:    { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: '16px', marginBottom: 12, cursor: 'pointer' },
  cardSel: { background: '#1e3a5f', border: '1px solid #3b82f6', borderRadius: 12, padding: '16px', marginBottom: 12, cursor: 'pointer' },
  poNum:   { color: '#60a5fa', fontWeight: 700, fontSize: 15 },
  vendor:  { color: '#fff', fontWeight: 600, fontSize: 14, marginTop: 2 },
  meta:    { color: '#64748b', fontSize: 12, marginTop: 4 },
  note:    { color: '#94a3b8', fontSize: 12, marginTop: 4, fontStyle: 'italic' },
  input:   { width: '100%', background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: '10px 12px', color: '#fff', fontSize: 15, boxSizing: 'border-box' as const },
  label:   { color: '#94a3b8', fontSize: 12, marginBottom: 6, display: 'block' },
  btn:     { width: '100%', padding: '14px', borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 16, cursor: 'pointer', marginTop: 12 },
  btnPri:  { background: '#2563eb', color: '#fff' },
  btnGray: { background: '#334155', color: '#94a3b8' },
  sect:    { color: '#475569', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, marginBottom: 10, marginTop: 20 },
  empty:   { color: '#475569', textAlign: 'center' as const, padding: '40px 0', fontSize: 14 },
  err:     { background: '#7f1d1d', border: '1px solid #dc2626', borderRadius: 8, padding: '12px', color: '#fca5a5', fontSize: 13, marginBottom: 12 },
  success: { textAlign: 'center' as const, padding: '40px 0' },
};

export default function FieldAmendPO() {
  const [step,        setStep]        = useState<Step>('loading');
  const [receipts,    setReceipts]    = useState<NewReceipt[]>([]);
  const [selected,    setSelected]    = useState<NewReceipt | null>(null);
  const [vendors,     setVendors]     = useState<POVendor[]>([]);
  const [vendorQ,     setVendorQ]     = useState('');
  const [newVendor,   setNewVendor]   = useState<POVendor | null>(null);
  const [error,       setError]       = useState<string | null>(null);
  const [result,      setResult]      = useState<{ display_number: number | null; old_vendor: string; vendor_name: string } | null>(null);

  // Load New receipts on mount
  useEffect(() => {
    getNewReceipts()
      .then(r => { setReceipts(r); setStep('select-po'); })
      .catch(e => { setError(String(e)); setStep('error'); });
  }, []);

  // Load preferred vendors on mount (for step 2)
  useEffect(() => {
    getPOVendors('').then(r => setVendors(r.vendors)).catch(() => {});
  }, []);

  // Live vendor search
  useEffect(() => {
    if (!vendorQ) {
      getPOVendors('').then(r => setVendors(r.vendors)).catch(() => {});
      return;
    }
    const t = setTimeout(() => {
      getPOVendors(vendorQ).then(r => setVendors(r.vendors)).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [vendorQ]);

  async function handleSubmit() {
    if (!selected || !newVendor) return;
    setStep('submitting');
    try {
      const res = await amendPOVendor({
        receiptId:  selected.receipt_id,
        vendorId:   newVendor.vendor_id!,
        vendorName: newVendor.vendor_name,
      });
      setResult(res);
      setStep('success');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  }

  function header(subtitle: string) {
    return (
      <div style={S.header}>
        <a href="/" title="Home"><img src="/darios-logo.png" alt="Darios" style={S.logo} /></a>
        <span style={S.title}>{subtitle}</span>
        <a href="/" style={S.homeBtn}>🏠 Home</a>
      </div>
    );
  }

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (step === 'loading') {
    return (
      <div style={S.page}>
        {header('Amend PO Vendor')}
        <div style={{ ...S.empty, marginTop: 60 }}>Loading open POs…</div>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────────
  if (step === 'error') {
    return (
      <div style={S.page}>
        {header('Amend PO Vendor')}
        <div style={S.body}>
          <div style={S.err}>{error}</div>
          <button style={{ ...S.btn, ...S.btnGray }} onClick={() => window.location.reload()}>
            Try Again
          </button>
          <a href="/" style={{ display: 'block', textAlign: 'center', color: '#94a3b8', marginTop: 12, fontSize: 13 }}>
            ← Back to Home
          </a>
        </div>
      </div>
    );
  }

  // ── Success ──────────────────────────────────────────────────────────────────
  if (step === 'success' && result) {
    return (
      <div style={S.page}>
        {header('PO Updated')}
        <div style={S.body}>
          <div style={S.success}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
            <div style={{ color: '#4ade80', fontWeight: 700, fontSize: 22, marginBottom: 8 }}>
              PO #{result.display_number} Updated
            </div>
            <div style={{ color: '#94a3b8', fontSize: 14, marginBottom: 4 }}>
              Vendor changed from
            </div>
            <div style={{ color: '#f87171', fontWeight: 600, fontSize: 16, marginBottom: 4 }}>
              {result.old_vendor}
            </div>
            <div style={{ color: '#64748b', fontSize: 14, marginBottom: 4 }}>to</div>
            <div style={{ color: '#4ade80', fontWeight: 700, fontSize: 18, marginBottom: 32 }}>
              {result.vendor_name}
            </div>
            <a href="/" style={{ display: 'inline-block', background: '#1e293b', color: '#94a3b8', padding: '12px 28px', borderRadius: 10, textDecoration: 'none', fontWeight: 600, fontSize: 14 }}>
              🏠 Back to Home
            </a>
          </div>
        </div>
      </div>
    );
  }

  // ── Submitting ───────────────────────────────────────────────────────────────
  if (step === 'submitting') {
    return (
      <div style={S.page}>
        {header('Updating PO…')}
        <div style={{ ...S.empty, marginTop: 60 }}>Saving vendor change…</div>
      </div>
    );
  }

  // ── Step 1: Select PO ────────────────────────────────────────────────────────
  if (step === 'select-po') {
    return (
      <div style={S.page}>
        {header('Amend PO Vendor')}
        <div style={S.body}>
          <div style={S.sect}>Open POs — tap to select</div>

          {receipts.length === 0 && (
            <div style={S.empty}>No open POs found with "New" status.</div>
          )}

          {receipts.map(r => (
            <div
              key={r.receipt_id}
              style={selected?.receipt_id === r.receipt_id ? S.cardSel : S.card}
              onClick={() => setSelected(r)}
            >
              <div style={S.poNum}>PO #{r.display_number}</div>
              <div style={S.vendor}>{r.vendor_name}</div>
              {r.note_snippet && <div style={S.note}>"{r.note_snippet}"</div>}
              <div style={S.meta}>
                {r.received_date ? `Date: ${r.received_date}` : ''}
                {r.total > 0 ? `  ·  Est. $${r.total.toFixed(2)}` : ''}
              </div>
            </div>
          ))}

          <button
            style={{ ...S.btn, ...(selected ? S.btnPri : S.btnGray) }}
            disabled={!selected}
            onClick={() => selected && setStep('select-vendor')}
          >
            {selected ? `Change Vendor on PO #${selected.display_number}` : 'Select a PO above'}
          </button>
        </div>
      </div>
    );
  }

  // ── Step 2: Select new vendor ─────────────────────────────────────────────────
  if (step === 'select-vendor') {
    return (
      <div style={S.page}>
        {header('Select New Vendor')}
        <div style={S.body}>
          <div style={{ background: '#172554', border: '1px solid #1d4ed8', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
            <div style={{ color: '#93c5fd', fontSize: 12 }}>Changing vendor on</div>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>
              PO #{selected?.display_number} — {selected?.vendor_name}
            </div>
          </div>

          <div style={S.sect}>New Vendor</div>
          <input
            style={{ ...S.input, marginBottom: 12 }}
            placeholder="Search vendors…"
            value={vendorQ}
            onChange={e => { setVendorQ(e.target.value); setNewVendor(null); }}
            autoFocus
          />

          {vendors.map(v => (
            <div
              key={v.vendor_id}
              style={newVendor?.vendor_id === v.vendor_id ? S.cardSel : S.card}
              onClick={() => setNewVendor(v)}
            >
              <div style={{ color: '#fff', fontWeight: 600, fontSize: 14 }}>{v.vendor_name}</div>
            </div>
          ))}

          <button
            style={{ ...S.btn, ...(newVendor ? S.btnPri : S.btnGray) }}
            disabled={!newVendor}
            onClick={() => newVendor && setStep('confirm')}
          >
            {newVendor ? `Use ${newVendor.vendor_name}` : 'Select a vendor above'}
          </button>

          <button
            style={{ ...S.btn, ...S.btnGray, marginTop: 8 }}
            onClick={() => { setNewVendor(null); setStep('select-po'); }}
          >
            ← Back
          </button>
        </div>
      </div>
    );
  }

  // ── Step 3: Confirm ────────────────────────────────────────────────────────
  if (step === 'confirm') {
    return (
      <div style={S.page}>
        {header('Confirm Change')}
        <div style={S.body}>
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: '20px', marginBottom: 20 }}>
            <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 16 }}>VENDOR CHANGE SUMMARY</div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ color: '#475569', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>PO</div>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: 18 }}>#{selected?.display_number}</div>
              </div>
              <div>
                <div style={{ color: '#475569', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>From</div>
                <div style={{ color: '#f87171', fontWeight: 600, fontSize: 16 }}>{selected?.vendor_name}</div>
              </div>
              <div style={{ color: '#475569', fontSize: 20, textAlign: 'center' }}>↓</div>
              <div>
                <div style={{ color: '#475569', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>To</div>
                <div style={{ color: '#4ade80', fontWeight: 700, fontSize: 16 }}>{newVendor?.vendor_name}</div>
              </div>
            </div>
          </div>

          <button
            style={{ ...S.btn, ...S.btnPri }}
            onClick={handleSubmit}
          >
            Confirm Vendor Change
          </button>
          <button
            style={{ ...S.btn, ...S.btnGray, marginTop: 8 }}
            onClick={() => setStep('select-vendor')}
          >
            ← Back
          </button>
        </div>
      </div>
    );
  }

  return null;
}
