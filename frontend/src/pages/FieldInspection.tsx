/**
 * FieldInspection — Site Safety Inspection Form
 * Mobile-first, 4-step: Site Info → Checklist → Findings & Actions → Submit
 * Public, no login required. /field/inspection
 */
import React, { useState, useRef } from 'react';
import { submitInspection, type ChecklistItem, type ActionItem } from '../lib/api';

// ── Palette ───────────────────────────────────────────────────────────────────
const BG   = '#0f172a';
const CARD = '#1e293b';
const BORDER = '#334155';

// ── Standard checklist ────────────────────────────────────────────────────────
const CHECKLIST_TEMPLATE: { category: string; emoji: string; items: string[] }[] = [
  {
    category: 'PPE',
    emoji: '🦺',
    items: [
      'Hi-vis vests worn by all crew',
      'Gloves appropriate for task',
      'Eye protection available & used',
      'Hearing protection where required',
    ],
  },
  {
    category: 'Equipment',
    emoji: '🔧',
    items: [
      'Blade guards and shields in place',
      'No fluid leaks observed',
      'Tools in good working condition',
      'Pre-start equipment checks completed',
    ],
  },
  {
    category: 'Housekeeping',
    emoji: '🧹',
    items: [
      'No trip or slip hazards',
      'Walkways and exits clear',
      'Materials and tools properly stored',
      'Waste disposed of correctly',
    ],
  },
  {
    category: 'Chemicals',
    emoji: '⚗️',
    items: [
      'All products properly labelled',
      'WHMIS / SDS sheets on site',
      'Chemicals stored away from drains/water',
    ],
  },
  {
    category: 'First Aid',
    emoji: '🚑',
    items: [
      'First aid kit present and accessible',
      'Kit contents stocked and not expired',
      'Emergency contacts known by crew',
    ],
  },
  {
    category: 'Traffic Control',
    emoji: '🚧',
    items: [
      'Cones and signs in place near road',
      'Adequate pedestrian protection',
      'Crew visible to passing traffic',
    ],
  },
  {
    category: 'Heat & Hydration',
    emoji: '💧',
    items: [
      'Water available for all crew',
      'Crew aware of heat illness signs',
      'Shade or rest breaks available if hot',
    ],
  },
  {
    category: 'Vehicles',
    emoji: '🚗',
    items: [
      'Pre-trip inspection completed',
      'Seatbelts worn by all occupants',
      'No unreported damage',
    ],
  },
];

// Build initial checklist state
function buildChecklist(): ChecklistItem[] {
  return CHECKLIST_TEMPLATE.flatMap(group =>
    group.items.map(item => ({
      category: group.category,
      item,
      result: 'na' as const,
      notes: '',
    }))
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────
const inp: React.CSSProperties = {
  width: '100%', padding: '11px 14px', borderRadius: 10,
  border: `1px solid ${BORDER}`, background: '#0f172a',
  color: '#f1f5f9', fontSize: 15, boxSizing: 'border-box',
};
const label: React.CSSProperties = {
  color: '#94a3b8', fontSize: 11, fontWeight: 700,
  letterSpacing: '0.07em', textTransform: 'uppercase',
  display: 'block', marginBottom: 4,
};

// ── Result toggle ─────────────────────────────────────────────────────────────
function ResultToggle({
  value, onChange,
}: { value: 'pass' | 'fail' | 'na'; onChange: (v: 'pass' | 'fail' | 'na') => void }) {
  const opts: { v: 'pass' | 'fail' | 'na'; label: string; color: string }[] = [
    { v: 'pass', label: '✓', color: '#22c55e' },
    { v: 'fail', label: '✗', color: '#ef4444' },
    { v: 'na',   label: 'N/A', color: '#475569' },
  ];
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {opts.map(o => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          style={{
            padding: '6px 10px', borderRadius: 8, border: 'none',
            background: value === o.v ? o.color : '#0f172a',
            color: value === o.v ? '#fff' : '#64748b',
            fontWeight: 700, fontSize: 13, cursor: 'pointer',
            minWidth: 42, transition: 'background 0.15s',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function FieldInspection() {
  const [step, setStep] = useState(1);
  const TOTAL_STEPS = 4;

  // Step 1 — Site info
  const today = new Date().toISOString().split('T')[0];
  const [date, setDate]         = useState(today);
  const [site, setSite]         = useState('');
  const [inspector, setInspector] = useState('');
  const [crewInput, setCrewInput] = useState('');
  const [crew, setCrew]         = useState<string[]>([]);

  // Step 2 — Checklist
  const [checklist, setChecklist] = useState<ChecklistItem[]>(buildChecklist());

  // Step 3 — Findings & Actions
  const [notes, setNotes]       = useState('');
  const [overall, setOverall]   = useState<'pass' | 'conditional' | 'fail'>('pass');
  const [actions, setActions]   = useState<Omit<ActionItem, 'id' | 'status' | 'resolved_notes' | 'resolved_at' | 'created_at'>[]>([
    { description: '', assigned_to: '', due_date: '' },
  ]);

  // Step 4 — Photo & Submit
  const [photo, setPhoto]       = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]   = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  // Derived
  const failCount = checklist.filter(c => c.result === 'fail').length;

  // Auto-set overall result based on fails
  function updateChecklist(idx: number, update: Partial<ChecklistItem>) {
    const next = checklist.map((c, i) => i === idx ? { ...c, ...update } : c);
    setChecklist(next);
    const fails = next.filter(c => c.result === 'fail').length;
    setOverall(fails === 0 ? 'pass' : fails <= 2 ? 'conditional' : 'fail');
  }

  function addCrewMember() {
    const name = crewInput.trim();
    if (name && !crew.includes(name)) {
      setCrew(prev => [...prev, name]);
      setCrewInput('');
    }
  }

  function addAction() {
    setActions(prev => [...prev, { description: '', assigned_to: '', due_date: '' }]);
  }

  function updateAction(idx: number, update: Partial<typeof actions[0]>) {
    setActions(prev => prev.map((a, i) => i === idx ? { ...a, ...update } : a));
  }

  function removeAction(idx: number) {
    setActions(prev => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const validActions = actions.filter(a => a.description?.trim());
      await submitInspection({
        inspection_date: date,
        site_name:       site.trim(),
        inspector_name:  inspector.trim(),
        crew_present:    crew,
        overall_result:  overall,
        notes:           notes.trim() || undefined,
        checklist,
        actions:         validActions,
        photo:           photo ?? undefined,
      });
      setSubmitted(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const wrap: React.CSSProperties = {
    minHeight: '100vh', background: BG,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    paddingBottom: 40,
  };

  // ── Success screen ──────────────────────────────────────────────────────────
  if (submitted) {
    const resultColor = overall === 'pass' ? '#22c55e' : overall === 'conditional' ? '#f59e0b' : '#ef4444';
    const resultLabel = overall === 'pass' ? 'PASS ✓' : overall === 'conditional' ? 'CONDITIONAL ⚠' : 'FAIL ✗';
    return (
      <div style={{ ...wrap, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>📋</div>
        <h1 style={{ color: '#fff', fontSize: 24, fontWeight: 800, margin: '0 0 8px', textAlign: 'center' }}>
          Inspection Submitted
        </h1>
        <div style={{
          display: 'inline-block', padding: '6px 20px', borderRadius: 20,
          background: resultColor + '22', border: `1px solid ${resultColor}`,
          color: resultColor, fontWeight: 800, fontSize: 16, marginBottom: 12,
        }}>
          {resultLabel}
        </div>
        <p style={{ color: '#64748b', fontSize: 14, textAlign: 'center', margin: '0 0 32px' }}>
          {site} · {date}
          {failCount > 0 && ` · ${failCount} item${failCount !== 1 ? 's' : ''} flagged`}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 320 }}>
          <button
            onClick={() => { setSubmitted(false); setStep(1); setSite(''); setInspector(''); setCrew([]); setChecklist(buildChecklist()); setNotes(''); setOverall('pass'); setActions([{ description: '', assigned_to: '', due_date: '' }]); setPhoto(null); }}
            style={{ padding: '14px', borderRadius: 12, background: '#1e293b', border: `1px solid ${BORDER}`, color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}
          >
            New Inspection
          </button>
          <a href="/" style={{ textAlign: 'center', color: '#64748b', fontSize: 14, paddingTop: 4, textDecoration: 'none' }}>
            ← Back to menu
          </a>
        </div>
      </div>
    );
  }

  // ── Progress bar ────────────────────────────────────────────────────────────
  const stepLabels = ['Site Info', 'Checklist', 'Findings', 'Submit'];

  const header = (
    <div style={{ background: CARD, padding: '16px 16px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <a href="/" style={{ color: '#64748b', fontSize: 20, textDecoration: 'none' }}>←</a>
        <h1 style={{ margin: 0, color: '#fff', fontSize: 18, fontWeight: 800 }}>🔍 Site Inspection</h1>
      </div>
      {/* Step progress */}
      <div style={{ display: 'flex', marginBottom: 0 }}>
        {stepLabels.map((lbl, i) => {
          const n = i + 1;
          const active = n === step;
          const done   = n < step;
          return (
            <div key={lbl} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{
                height: 3,
                background: done ? '#22c55e' : active ? '#3b82f6' : '#334155',
                marginBottom: 6, borderRadius: 2,
                transition: 'background 0.2s',
              }} />
              <div style={{
                fontSize: 10, fontWeight: 700,
                color: done ? '#22c55e' : active ? '#3b82f6' : '#475569',
                paddingBottom: 10,
              }}>
                {done ? '✓ ' : ''}{lbl}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  // ── Step 1: Site info ───────────────────────────────────────────────────────
  if (step === 1) {
    const canNext = date && site.trim() && inspector.trim();
    return (
      <div style={wrap}>
        {header}
        <div style={{ padding: '20px 16px' }}>
          <div style={{ marginBottom: 16 }}>
            <label style={label}>Date</label>
            <input type="date" style={inp} value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={label}>Site / Property *</label>
            <input style={inp} placeholder="e.g. 123 Elm St — Smith Residence" value={site} onChange={e => setSite(e.target.value)} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={label}>Inspector Name *</label>
            <input style={inp} placeholder="Your full name" value={inspector} onChange={e => setInspector(e.target.value)} />
          </div>
          <div style={{ marginBottom: 24 }}>
            <label style={label}>Crew Present</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input
                style={{ ...inp, flex: 1 }}
                placeholder="Add crew member name"
                value={crewInput}
                onChange={e => setCrewInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addCrewMember()}
              />
              <button
                onClick={addCrewMember}
                style={{
                  padding: '11px 16px', borderRadius: 10, border: 'none',
                  background: '#3b82f6', color: '#fff', fontWeight: 700,
                  fontSize: 18, cursor: 'pointer', flexShrink: 0,
                }}
              >+</button>
            </div>
            {crew.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {crew.map(name => (
                  <div key={name} style={{
                    background: '#1e293b', border: `1px solid ${BORDER}`,
                    borderRadius: 20, padding: '4px 12px',
                    display: 'flex', alignItems: 'center', gap: 8,
                    color: '#f1f5f9', fontSize: 13,
                  }}>
                    {name}
                    <span
                      onClick={() => setCrew(prev => prev.filter(n => n !== name))}
                      style={{ color: '#64748b', cursor: 'pointer', fontSize: 16 }}
                    >×</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => setStep(2)}
            disabled={!canNext}
            style={{
              width: '100%', padding: '15px', borderRadius: 12, border: 'none',
              background: canNext ? '#3b82f6' : '#334155',
              color: '#fff', fontWeight: 800, fontSize: 16, cursor: canNext ? 'pointer' : 'not-allowed',
            }}
          >
            Next: Checklist →
          </button>
        </div>
      </div>
    );
  }

  // ── Step 2: Checklist ───────────────────────────────────────────────────────
  if (step === 2) {
    const groups = CHECKLIST_TEMPLATE;
    return (
      <div style={wrap}>
        {header}
        <div style={{ padding: '16px 16px 0' }}>
          {failCount > 0 && (
            <div style={{
              background: '#7f1d1d', border: '1px solid #ef4444',
              borderRadius: 10, padding: '10px 14px',
              color: '#fca5a5', fontSize: 13, fontWeight: 600, marginBottom: 16,
            }}>
              ⚠ {failCount} item{failCount !== 1 ? 's' : ''} flagged as FAIL
            </div>
          )}
        </div>
        <div style={{ padding: '0 16px' }}>
          {groups.map(group => {
            const groupItems = checklist.filter(c => c.category === group.category);
            const groupStart = checklist.findIndex(c => c.category === group.category);
            return (
              <div key={group.category} style={{ marginBottom: 20 }}>
                <div style={{
                  color: '#fff', fontWeight: 800, fontSize: 14,
                  marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <span>{group.emoji}</span> {group.category}
                </div>
                {groupItems.map((item, relIdx) => {
                  const absIdx = groupStart + relIdx;
                  return (
                    <div key={item.item} style={{
                      background: item.result === 'fail' ? '#1c0a0a' : CARD,
                      border: `1px solid ${item.result === 'fail' ? '#7f1d1d' : BORDER}`,
                      borderRadius: 10, padding: '12px 14px', marginBottom: 8,
                    }}>
                      <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        alignItems: 'flex-start', gap: 10, marginBottom: 8,
                      }}>
                        <div style={{ color: '#e2e8f0', fontSize: 14, flex: 1 }}>{item.item}</div>
                        <ResultToggle
                          value={item.result}
                          onChange={v => updateChecklist(absIdx, { result: v })}
                        />
                      </div>
                      {item.result === 'fail' && (
                        <input
                          style={{ ...inp, fontSize: 13, padding: '8px 12px' }}
                          placeholder="Describe the issue…"
                          value={item.notes || ''}
                          onChange={e => updateChecklist(absIdx, { notes: e.target.value })}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div style={{ padding: '8px 16px 0', display: 'flex', gap: 10 }}>
          <button
            onClick={() => setStep(1)}
            style={{ flex: 1, padding: '14px', borderRadius: 12, border: `1px solid ${BORDER}`, background: 'none', color: '#94a3b8', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}
          >
            ← Back
          </button>
          <button
            onClick={() => setStep(3)}
            style={{ flex: 2, padding: '14px', borderRadius: 12, border: 'none', background: '#3b82f6', color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}
          >
            Next: Findings →
          </button>
        </div>
      </div>
    );
  }

  // ── Step 3: Findings & Actions ──────────────────────────────────────────────
  if (step === 3) {
    const resultOpts: { v: 'pass' | 'conditional' | 'fail'; label: string; color: string; bg: string }[] = [
      { v: 'pass',        label: '✓ Pass',             color: '#22c55e', bg: '#14532d' },
      { v: 'conditional', label: '⚠ Conditional Pass', color: '#f59e0b', bg: '#451a03' },
      { v: 'fail',        label: '✗ Fail',             color: '#ef4444', bg: '#7f1d1d' },
    ];
    return (
      <div style={wrap}>
        {header}
        <div style={{ padding: '20px 16px' }}>

          {/* Overall result */}
          <div style={{ marginBottom: 20 }}>
            <label style={label}>Overall Result</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {resultOpts.map(opt => (
                <button
                  key={opt.v}
                  onClick={() => setOverall(opt.v)}
                  style={{
                    padding: '12px 16px', borderRadius: 10, border: `2px solid`,
                    borderColor: overall === opt.v ? opt.color : BORDER,
                    background: overall === opt.v ? opt.bg : 'transparent',
                    color: overall === opt.v ? opt.color : '#64748b',
                    fontWeight: 700, fontSize: 14, cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* General notes */}
          <div style={{ marginBottom: 20 }}>
            <label style={label}>General Findings / Notes</label>
            <textarea
              style={{ ...inp, minHeight: 100, resize: 'vertical' } as React.CSSProperties}
              placeholder="Describe key observations, hazards found, site conditions…"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>

          {/* Action items */}
          <div style={{ marginBottom: 8 }}>
            <label style={label}>Action Items</label>
            {actions.map((action, idx) => (
              <div key={idx} style={{
                background: CARD, border: `1px solid ${BORDER}`,
                borderRadius: 12, padding: 14, marginBottom: 10,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 700 }}>ACTION {idx + 1}</div>
                  {actions.length > 1 && (
                    <button
                      onClick={() => removeAction(idx)}
                      style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 18, cursor: 'pointer', padding: 0 }}
                    >×</button>
                  )}
                </div>
                <div style={{ marginBottom: 8 }}>
                  <input
                    style={{ ...inp, fontSize: 14 }}
                    placeholder="What needs to be fixed or addressed?"
                    value={action.description}
                    onChange={e => updateAction(idx, { description: e.target.value })}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    style={{ ...inp, flex: 1, fontSize: 13 }}
                    placeholder="Assigned to"
                    value={action.assigned_to || ''}
                    onChange={e => updateAction(idx, { assigned_to: e.target.value })}
                  />
                  <input
                    type="date"
                    style={{ ...inp, flex: 1, fontSize: 13 }}
                    value={action.due_date || ''}
                    onChange={e => updateAction(idx, { due_date: e.target.value })}
                  />
                </div>
              </div>
            ))}
            <button
              onClick={addAction}
              style={{
                width: '100%', padding: '10px', borderRadius: 10,
                border: `1px dashed ${BORDER}`, background: 'none',
                color: '#64748b', fontWeight: 600, fontSize: 14, cursor: 'pointer',
              }}
            >
              + Add Action Item
            </button>
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
            <button
              onClick={() => setStep(2)}
              style={{ flex: 1, padding: '14px', borderRadius: 12, border: `1px solid ${BORDER}`, background: 'none', color: '#94a3b8', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}
            >
              ← Back
            </button>
            <button
              onClick={() => setStep(4)}
              style={{ flex: 2, padding: '14px', borderRadius: 12, border: 'none', background: '#3b82f6', color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}
            >
              Next: Submit →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Step 4: Photo & Submit ──────────────────────────────────────────────────
  const resultColor = overall === 'pass' ? '#22c55e' : overall === 'conditional' ? '#f59e0b' : '#ef4444';
  const resultLabel = overall === 'pass' ? 'Pass ✓' : overall === 'conditional' ? 'Conditional ⚠' : 'Fail ✗';
  const actionsFilled = actions.filter(a => a.description?.trim()).length;

  return (
    <div style={wrap}>
      {header}
      <div style={{ padding: '20px 16px' }}>

        {/* Summary */}
        <div style={{
          background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14,
          padding: 16, marginBottom: 20,
        }}>
          <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, marginBottom: 10, letterSpacing: '0.07em', textTransform: 'uppercase' }}>
            Inspection Summary
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
            {[
              ['Date', date],
              ['Site', site],
              ['Inspector', inspector],
              ['Crew', crew.length ? crew.join(', ') : '—'],
            ].map(([k, v]) => (
              <div key={k}>
                <div style={{ color: '#475569', fontSize: 11 }}>{k}</div>
                <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600 }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${BORDER}`, display: 'flex', gap: 16 }}>
            <div>
              <div style={{ color: '#475569', fontSize: 11 }}>Result</div>
              <div style={{ color: resultColor, fontWeight: 800, fontSize: 14 }}>{resultLabel}</div>
            </div>
            <div>
              <div style={{ color: '#475569', fontSize: 11 }}>Items Checked</div>
              <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 14 }}>{checklist.length}</div>
            </div>
            {failCount > 0 && (
              <div>
                <div style={{ color: '#475569', fontSize: 11 }}>Flagged</div>
                <div style={{ color: '#ef4444', fontWeight: 700, fontSize: 14 }}>{failCount}</div>
              </div>
            )}
            {actionsFilled > 0 && (
              <div>
                <div style={{ color: '#475569', fontSize: 11 }}>Actions</div>
                <div style={{ color: '#f59e0b', fontWeight: 700, fontSize: 14 }}>{actionsFilled}</div>
              </div>
            )}
          </div>
        </div>

        {/* Photo upload */}
        <div style={{ marginBottom: 20 }}>
          <label style={label}>Site Photo (optional)</label>
          <input
            ref={photoRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ color: '#94a3b8', fontSize: 13 }}
            onChange={e => setPhoto(e.target.files?.[0] ?? null)}
          />
          {photo && (
            <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>
              {photo.name} · {(photo.size / 1024).toFixed(0)} KB
            </div>
          )}
        </div>

        {error && (
          <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>⚠ {error}</div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={() => setStep(3)}
            style={{ flex: 1, padding: '14px', borderRadius: 12, border: `1px solid ${BORDER}`, background: 'none', color: '#94a3b8', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}
          >
            ← Back
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{
              flex: 2, padding: '14px', borderRadius: 12, border: 'none',
              background: submitting ? '#334155' : '#22c55e',
              color: '#fff', fontWeight: 800, fontSize: 16,
              cursor: submitting ? 'wait' : 'pointer',
            }}
          >
            {submitting ? 'Submitting…' : '✓ Submit Inspection'}
          </button>
        </div>
      </div>
    </div>
  );
}
