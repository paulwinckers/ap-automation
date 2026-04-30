/**
 * HandoffGenerator — admin UI to generate a Project Handoff Package .docx
 * from Aspire Opportunity data.
 *
 * Route: /ops/handoff  (login required, wrapped in AppShell)
 */

import React, { useState } from 'react';
import { downloadHandoffPack } from '../lib/api';

type Step = 'idle' | 'loading' | 'done' | 'error';

export default function HandoffGenerator() {
  const [oppNumber, setOppNumber] = useState('');
  const [step,      setStep]      = useState<Step>('idle');
  const [error,     setError]     = useState('');
  const [lastOpp,   setLastOpp]   = useState('');

  const handleGenerate = async () => {
    const num = parseInt(oppNumber.trim(), 10);
    if (!num || num <= 0) {
      setError('Please enter a valid opportunity number.');
      return;
    }
    setStep('loading');
    setError('');
    try {
      await downloadHandoffPack(num);
      setLastOpp(oppNumber.trim());
      setStep('done');
    } catch (e: unknown) {
      setError((e as Error).message || 'Generation failed');
      setStep('error');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleGenerate();
  };

  return (
    <div style={{
      padding: '32px 24px',
      maxWidth: 620,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>
          📄 Project Handoff Pack
        </h1>
        <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 14 }}>
          Enter an Aspire opportunity number to generate a fully populated
          handoff package as a Word document.
        </p>
      </div>

      {/* Card */}
      <div style={{
        background: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: 12,
        padding: '28px 24px',
        boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}>

        <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 14, color: '#334155' }}>
          Aspire Opportunity Number
        </label>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            type="number"
            min="1"
            value={oppNumber}
            onChange={e => { setOppNumber(e.target.value); setStep('idle'); setError(''); }}
            onKeyDown={handleKeyDown}
            placeholder="e.g. 1970"
            disabled={step === 'loading'}
            style={{
              flex: 1,
              padding: '10px 14px',
              border: '1px solid #cbd5e1',
              borderRadius: 8,
              fontSize: 15,
              outline: 'none',
              background: step === 'loading' ? '#f1f5f9' : '#fff',
            }}
          />
          <button
            onClick={handleGenerate}
            disabled={step === 'loading' || !oppNumber.trim()}
            style={{
              padding: '10px 22px',
              background: step === 'loading' ? '#94a3b8' : '#1B3A5C',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontWeight: 700,
              fontSize: 14,
              cursor: step === 'loading' ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              whiteSpace: 'nowrap',
            }}
          >
            {step === 'loading' ? (
              <>
                <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>
                Generating…
              </>
            ) : (
              <>⬇ Generate &amp; Download</>
            )}
          </button>
        </div>

        {/* Progress indicator */}
        {step === 'loading' && (
          <div style={{
            marginTop: 16,
            padding: '12px 16px',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: 8,
            fontSize: 13,
            color: '#1d4ed8',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            <span style={{ fontSize: 18 }}>🔄</span>
            <div>
              <strong>Fetching Aspire data…</strong>
              <div style={{ color: '#3b82f6', marginTop: 2 }}>
                Pulling opportunity, services, work tickets, and receipts.
                This usually takes 5–15 seconds.
              </div>
            </div>
          </div>
        )}

        {/* Success */}
        {step === 'done' && (
          <div style={{
            marginTop: 16,
            padding: '12px 16px',
            background: '#f0fdf4',
            border: '1px solid #bbf7d0',
            borderRadius: 8,
            fontSize: 13,
            color: '#166534',
          }}>
            <strong>✅ Handoff pack downloaded</strong> for Opportunity #{lastOpp}.
            <div style={{ marginTop: 4, color: '#15803d' }}>
              Check your Downloads folder — the file is ready to review and share.
            </div>
          </div>
        )}

        {/* Error */}
        {step === 'error' && (
          <div style={{
            marginTop: 16,
            padding: '12px 16px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 8,
            fontSize: 13,
            color: '#991b1b',
          }}>
            <strong>⚠️ Error:</strong> {error}
          </div>
        )}
      </div>

      {/* What's included */}
      <div style={{
        marginTop: 24,
        background: '#f8fafc',
        border: '1px solid #e2e8f0',
        borderRadius: 12,
        padding: '20px 24px',
      }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: '#475569', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          What's included in the pack
        </div>
        {[
          ['1. Project Overview',          'Contract value, dates, sales rep, ops manager'],
          ['2. Scope of Work',             'Proposal description + all service lines from Aspire'],
          ['3. Project Schedule',          'Work tickets table — colour-coded green/amber by status'],
          ['4. Materials & Procurement',   'All Aspire receipts with line items and totals'],
          ['5. Design & Plans',            'Checklist for drawings, permits, HOA approval (fill in)'],
          ['6. Equipment Requirements',    'Rental and owned equipment tables (fill in)'],
          ['7. Subcontractors',            'Sub list with scope, contact, dates (fill in)'],
          ['8. Notes',                     'Space for handwritten notes and special instructions'],
        ].map(([label, desc]) => (
          <div key={label} style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 13 }}>
            <span style={{ fontWeight: 600, color: '#1B3A5C', minWidth: 220 }}>{label}</span>
            <span style={{ color: '#64748b' }}>{desc}</span>
          </div>
        ))}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
