/**
 * FieldSafetyTalk.tsx — Mobile safety / toolbox talk submission for field crew.
 * Route: /field/safety (public, no login required)
 *
 * Flow:
 *   1. Pick attendees (Aspire employee chips + search + manual entry)
 *   2. Topic, date, notes & optional group photo
 *   3. Review & submit
 *   4. Success
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { createSafetyTalk, getAspireEmployees, searchAspireProperties, type AspireEmployee } from '../lib/api';

type Step = 1 | 2 | 3 | 4;

// ── Shared styles ─────────────────────────────────────────────────────────────

const DARK   = '#0f172a';
const GREEN  = '#16a34a';
const BORDER = '#1e293b';

function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtDate(s: string) {
  if (!s) return '';
  try { return new Date(s + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
  catch { return s; }
}

function StepHeader({ step, label, total = 3 }: { step: number; label: string; total?: number }) {
  return (
    <div style={{ padding: '20px 20px 0' }}>
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
        Step {step} of {total}
      </div>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#fff' }}>{label}</h2>
    </div>
  );
}

function NextBtn({ onClick, disabled, label = 'Next →' }: { onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%', padding: '15px', borderRadius: 12, border: 'none',
        background: disabled ? '#374151' : GREEN,
        color: disabled ? '#6b7280' : '#fff',
        fontSize: 16, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
        marginTop: 8,
      }}
    >{label}</button>
  );
}

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      background: 'none', border: 'none', color: '#64748b',
      fontSize: 13, cursor: 'pointer', padding: '12px 0', display: 'block',
    }}>← Back</button>
  );
}

// ── Preset topics ─────────────────────────────────────────────────────────────

const PRESET_TOPICS = [
  'Heat illness prevention',
  'WHMIS / Hazard communication',
  'PPE requirements',
  'Slips, trips & falls',
  'Equipment & machinery safety',
  'Chemical safety (pesticides)',
  'Hand & power tool safety',
  'Back safety & lifting',
  'Traffic control & roadside safety',
  'Electrical safety',
  'Emergency procedures',
  'Wildlife & bee safety',
  'Distracted work prevention',
  'First aid & incident reporting',
];

// ── Step 1: Attendees ─────────────────────────────────────────────────────────

function StepAttendees({
  attendees, setAttendees,
  presenterName, setPresenterName,
  onNext,
}: {
  attendees: string[];
  setAttendees: (a: string[]) => void;
  presenterName: string;
  setPresenterName: (v: string) => void;
  onNext: () => void;
}) {
  const [employees,   setEmployees]   = useState<AspireEmployee[]>([]);
  const [empLoading,  setEmpLoading]  = useState(true);
  const [search,      setSearch]      = useState('');
  const [manualName,  setManualName]  = useState('');
  const manualRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getAspireEmployees()
      .then(setEmployees)
      .catch(() => setEmployees([]))
      .finally(() => setEmpLoading(false));
  }, []);

  const attendeeSet = new Set(attendees.map(n => n.toLowerCase()));

  function toggle(name: string) {
    const lower = name.toLowerCase();
    if (attendeeSet.has(lower)) {
      setAttendees(attendees.filter(n => n.toLowerCase() !== lower));
    } else {
      setAttendees([...attendees, name]);
    }
  }

  function addManual() {
    const name = manualName.trim();
    if (!name) return;
    if (!attendeeSet.has(name.toLowerCase())) setAttendees([...attendees, name]);
    setManualName('');
    manualRef.current?.focus();
  }

  function removeAttendee(idx: number) {
    setAttendees(attendees.filter((_, i) => i !== idx));
  }

  const filtered = search.trim()
    ? employees.filter(e => e.FullName.toLowerCase().includes(search.toLowerCase()))
    : employees;

  return (
    <div>
      <StepHeader step={1} label="Who attended?" />
      <div style={{ padding: '16px 20px' }}>

        {/* Presenter field */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>
            Your name (presenter)<span style={{ color: '#ef4444', marginLeft: 3 }}>*</span>
          </label>
          <input
            type="text"
            value={presenterName}
            onChange={e => setPresenterName(e.target.value)}
            placeholder="Who is leading this talk?"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '12px 14px',
              borderRadius: 10, border: `1.5px solid ${BORDER}`,
              background: '#1e293b', color: '#f8fafc', fontSize: 16, outline: 'none',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = GREEN)}
            onBlur={e  => (e.currentTarget.style.borderColor = BORDER)}
          />
        </div>

        {/* Search employees */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>
            Select crew members
          </label>
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="🔍 Search employees…"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '11px 14px',
              borderRadius: 10, border: `1.5px solid ${BORDER}`,
              background: '#1e293b', color: '#f8fafc', fontSize: 15, outline: 'none',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = GREEN)}
            onBlur={e  => (e.currentTarget.style.borderColor = BORDER)}
          />
        </div>

        {/* Employee chips */}
        {empLoading ? (
          <div style={{ color: '#64748b', fontSize: 13, marginBottom: 16, padding: '8px 0' }}>Loading employees…</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20, maxHeight: 260, overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <span style={{ color: '#475569', fontSize: 13 }}>No employees match "{search}"</span>
            )}
            {filtered.map(emp => {
              const added = attendeeSet.has(emp.FullName.toLowerCase());
              return (
                <button
                  key={emp.ContactID}
                  onClick={() => toggle(emp.FullName)}
                  style={{
                    padding: '8px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', border: `1.5px solid ${added ? GREEN : '#334155'}`,
                    background: added ? '#14532d' : '#1e293b',
                    color: added ? '#fff' : '#94a3b8',
                    transition: 'all 0.1s',
                  }}
                >{added ? '✓ ' : ''}{emp.FullName}</button>
              );
            })}
          </div>
        )}

        {/* Manual entry */}
        <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
          Add someone not in the list
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <input
            ref={manualRef}
            type="text"
            value={manualName}
            onChange={e => setManualName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}
            placeholder="Type a name…"
            style={{
              flex: 1, padding: '12px 14px', borderRadius: 10,
              border: `1.5px solid ${BORDER}`, background: '#1e293b',
              color: '#f8fafc', fontSize: 15, outline: 'none',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = GREEN)}
            onBlur={e  => (e.currentTarget.style.borderColor = BORDER)}
          />
          <button
            onClick={addManual}
            disabled={!manualName.trim()}
            style={{
              padding: '12px 20px', borderRadius: 10, border: 'none',
              background: manualName.trim() ? GREEN : '#374151',
              color: manualName.trim() ? '#fff' : '#6b7280',
              fontWeight: 700, fontSize: 15, cursor: manualName.trim() ? 'pointer' : 'not-allowed',
              flexShrink: 0,
            }}
          >Add</button>
        </div>

        {/* Selected attendees */}
        {attendees.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8 }}>
              ✅ {attendees.length} attendee{attendees.length !== 1 ? 's' : ''} selected
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {attendees.map((name, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: '#1e293b', borderRadius: 10, padding: '11px 16px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 16 }}>👤</span>
                    <span style={{ color: '#f8fafc', fontWeight: 600, fontSize: 14 }}>{name}</span>
                    {name.toLowerCase() === presenterName.trim().toLowerCase() && presenterName.trim() && (
                      <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 700, background: '#14532d', padding: '2px 7px', borderRadius: 10 }}>
                        You
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => removeAttendee(i)}
                    style={{ background: 'none', border: 'none', color: '#475569', fontSize: 18, cursor: 'pointer', padding: '0 4px' }}
                  >✕</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <NextBtn
          onClick={onNext}
          disabled={attendees.length === 0 || !presenterName.trim()}
          label={attendees.length > 0
            ? `Next → (${attendees.length} attendee${attendees.length !== 1 ? 's' : ''})`
            : 'Next →'}
        />
      </div>
    </div>
  );
}

// ── Property search (Aspire) ──────────────────────────────────────────────────

interface PropertyHit { property_id: number; property_name: string; address: string; }

function PropertySearch({
  value, onChange,
}: {
  value: string;
  onChange: (name: string, id: number | null) => void;
}) {
  const [query,   setQuery]   = useState(value);
  const [results, setResults] = useState<PropertyHit[]>([]);
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef  = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleInput(q: string) {
    setQuery(q);
    onChange(q, null);           // propagate raw text while typing
    setOpen(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (q.trim().length < 2) { setResults([]); return; }
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const hits = await searchAspireProperties(q.trim());
        setResults(hits.slice(0, 8));
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 320);
  }

  function pick(hit: PropertyHit) {
    setQuery(hit.property_name);
    onChange(hit.property_name, hit.property_id);
    setResults([]);
    setOpen(false);
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        type="search"
        value={query}
        onChange={e => handleInput(e.target.value)}
        onFocus={e => { if (results.length) setOpen(true); e.currentTarget.style.borderColor = GREEN; }}
        onBlur={e  => (e.currentTarget.style.borderColor = BORDER)}
        placeholder="Search Aspire properties…"
        style={{
          width: '100%', boxSizing: 'border-box', padding: '12px 14px',
          borderRadius: 10, border: `1.5px solid ${BORDER}`,
          background: '#1e293b', color: '#f8fafc', fontSize: 16, outline: 'none',
        }}
      />
      {loading && (
        <div style={{
          position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
          color: '#64748b', fontSize: 12, pointerEvents: 'none',
        }}>Searching…</div>
      )}
      {open && results.length > 0 && (
        <div style={{
          position: 'absolute', zIndex: 50, left: 0, right: 0, top: '100%', marginTop: 4,
          background: '#1e293b', borderRadius: 10, border: `1px solid ${BORDER}`,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)', overflow: 'hidden',
        }}>
          {results.map(hit => (
            <button
              key={hit.property_id}
              onMouseDown={() => pick(hit)}  // mousedown fires before blur
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '11px 14px', background: 'none', border: 'none',
                cursor: 'pointer', borderBottom: `1px solid ${BORDER}`,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#0f172a')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <div style={{ color: '#f8fafc', fontWeight: 600, fontSize: 14 }}>{hit.property_name}</div>
              {hit.address && (
                <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>{hit.address}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Step 2: Topic, Date, Notes & Photo ────────────────────────────────────────

function StepTalkInfo({
  talkDate, setTalkDate,
  topic, setTopic,
  jobSite, setJobSite, setPropertyId,
  notes, setNotes,
  photo, setPhoto,
  onBack, onNext,
}: {
  talkDate: string;   setTalkDate:  (v: string) => void;
  topic: string;      setTopic:     (v: string) => void;
  jobSite: string;    setJobSite:   (v: string) => void;
  setPropertyId:      (id: number | null) => void;
  notes: string;      setNotes:     (v: string) => void;
  photo: File | null; setPhoto:     (f: File | null) => void;
  onBack: () => void; onNext: () => void;
}) {
  const [customTopic,  setCustomTopic]  = useState(!PRESET_TOPICS.includes(topic) && topic !== '');
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function pickTopic(t: string) { setTopic(t); setCustomTopic(false); }
  function switchToCustom() { setTopic(''); setCustomTopic(true); }

  const handlePhotoChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setPhoto(f);
    if (f) {
      const url = URL.createObjectURL(f);
      setPhotoPreview(url);
    } else {
      setPhotoPreview(null);
    }
  }, [setPhoto]);

  function removePhoto() {
    setPhoto(null);
    setPhotoPreview(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  const canProceed = talkDate && topic.trim();

  return (
    <div>
      <StepHeader step={2} label="Talk Details" />
      <div style={{ padding: '16px 20px' }}>

        {/* Date */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>
            Date<span style={{ color: '#ef4444', marginLeft: 3 }}>*</span>
          </label>
          <input
            type="date"
            value={talkDate}
            max={todayStr()}
            onChange={e => setTalkDate(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '12px 14px',
              borderRadius: 10, border: `1.5px solid ${BORDER}`,
              background: '#1e293b', color: '#f8fafc', fontSize: 16, outline: 'none',
              colorScheme: 'dark',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = GREEN)}
            onBlur={e  => (e.currentTarget.style.borderColor = BORDER)}
          />
          {talkDate && (
            <div style={{ marginTop: 5, fontSize: 12, color: '#22c55e', fontWeight: 600 }}>
              📅 {fmtDate(talkDate)}
            </div>
          )}
        </div>

        {/* Topic chips */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>
            Topic<span style={{ color: '#ef4444', marginLeft: 3 }}>*</span>
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
            {PRESET_TOPICS.map(t => {
              const active = topic === t && !customTopic;
              return (
                <button
                  key={t}
                  onClick={() => pickTopic(t)}
                  style={{
                    padding: '8px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', border: `1.5px solid ${active ? GREEN : BORDER}`,
                    background: active ? '#14532d' : '#1e293b',
                    color: active ? '#fff' : '#94a3b8',
                  }}
                >{t}</button>
              );
            })}
            <button
              onClick={switchToCustom}
              style={{
                padding: '8px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                cursor: 'pointer', border: `1.5px solid ${customTopic ? '#f59e0b' : BORDER}`,
                background: customTopic ? '#78350f' : '#1e293b',
                color: customTopic ? '#fff' : '#94a3b8',
              }}
            >✏️ Other…</button>
          </div>
          {customTopic && (
            <input
              type="text"
              value={topic}
              onChange={e => setTopic(e.target.value)}
              placeholder="Describe the safety topic…"
              autoFocus
              style={{
                width: '100%', boxSizing: 'border-box', padding: '12px 14px',
                borderRadius: 10, border: `1.5px solid ${GREEN}`,
                background: '#1e293b', color: '#f8fafc', fontSize: 16, outline: 'none',
              }}
            />
          )}
        </div>

        {/* Job site — Aspire property search */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>
            Job site / property <span style={{ color: '#475569', fontWeight: 400 }}>(optional)</span>
          </label>
          <PropertySearch
            value={jobSite}
            onChange={(name, id) => { setJobSite(name); setPropertyId(id); }}
          />
        </div>

        {/* Notes */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>
            Key points / notes <span style={{ color: '#475569', fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Reviewed PPE checklist, discussed hydration schedule…"
            rows={4}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '12px 14px',
              borderRadius: 10, border: `1.5px solid ${BORDER}`,
              background: '#1e293b', color: '#f8fafc', fontSize: 15,
              outline: 'none', resize: 'vertical', fontFamily: 'inherit',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = GREEN)}
            onBlur={e  => (e.currentTarget.style.borderColor = BORDER)}
          />
        </div>

        {/* Group photo */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>
            Group photo <span style={{ color: '#475569', fontWeight: 400 }}>(optional)</span>
          </label>

          {photoPreview ? (
            <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', marginBottom: 8 }}>
              <img
                src={photoPreview}
                alt="Group photo preview"
                style={{ width: '100%', maxHeight: 260, objectFit: 'cover', display: 'block', borderRadius: 12 }}
              />
              <button
                onClick={removePhoto}
                style={{
                  position: 'absolute', top: 8, right: 8,
                  background: 'rgba(0,0,0,0.7)', border: 'none', color: '#fff',
                  borderRadius: '50%', width: 32, height: 32, fontSize: 16,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >✕</button>
            </div>
          ) : (
            <button
              onClick={() => fileRef.current?.click()}
              style={{
                width: '100%', padding: '20px', borderRadius: 12,
                border: `2px dashed ${BORDER}`, background: '#1e293b',
                color: '#64748b', fontSize: 15, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              }}
            >
              <span style={{ fontSize: 24 }}>📷</span>
              <span>Take or choose a photo</span>
            </button>
          )}

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handlePhotoChange}
            style={{ display: 'none' }}
          />
        </div>

        <BackBtn onClick={onBack} />
        <NextBtn onClick={onNext} disabled={!canProceed} label="Review →" />
      </div>
    </div>
  );
}

// ── Step 3: Review & Submit ───────────────────────────────────────────────────

function StepReview({
  talkDate, topic, presenterName, jobSite, notes, attendees, photo,
  onBack, onSubmit, submitting,
}: {
  talkDate: string; topic: string; presenterName: string;
  jobSite: string; notes: string; attendees: string[];
  photo: File | null;
  onBack: () => void; onSubmit: () => void; submitting: boolean;
}) {
  const photoPreview = photo ? URL.createObjectURL(photo) : null;

  function Row({ label, value }: { label: string; value: string }) {
    if (!value) return null;
    return (
      <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #1e293b' }}>
        <span style={{ width: 110, fontSize: 12, color: '#64748b', flexShrink: 0, paddingTop: 1 }}>{label}</span>
        <span style={{ fontSize: 14, color: '#f1f5f9', flex: 1 }}>{value}</span>
      </div>
    );
  }

  return (
    <div>
      <StepHeader step={3} label="Review & Submit" />
      <div style={{ padding: '16px 20px' }}>

        <div style={{ background: '#1e293b', borderRadius: 12, padding: '4px 16px', marginBottom: 20 }}>
          <Row label="Date"       value={fmtDate(talkDate)} />
          <Row label="Topic"      value={topic} />
          <Row label="Presenter"  value={presenterName} />
          <Row label="Crew/Site"  value={jobSite} />
          <Row label="Notes"      value={notes} />
          <div style={{ padding: '12px 0', borderBottom: '1px solid #1e293b' }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
              Attendees ({attendees.length})
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {attendees.map((name, i) => (
                <span key={i} style={{
                  background: '#0f172a', color: '#94a3b8', fontSize: 13,
                  padding: '4px 10px', borderRadius: 20, border: '1px solid #334155',
                }}>
                  👤 {name}
                </span>
              ))}
            </div>
          </div>
          {photo && (
            <div style={{ padding: '12px 0' }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>Group photo</div>
              <img
                src={photoPreview!}
                alt="Group photo"
                style={{ width: '100%', maxHeight: 200, objectFit: 'cover', borderRadius: 8, display: 'block' }}
              />
            </div>
          )}
        </div>

        <BackBtn onClick={onBack} />
        <NextBtn
          onClick={onSubmit}
          disabled={submitting}
          label={submitting ? 'Submitting…' : '✓ Submit Safety Talk'}
        />
      </div>
    </div>
  );
}

// ── Step 4: Success ───────────────────────────────────────────────────────────

function StepSuccess({ topic, attendeeCount, onAnother }: {
  topic: string; attendeeCount: number; onAnother: () => void;
}) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 28px 40px' }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>✅</div>
      <h2 style={{ color: '#fff', margin: '0 0 8px', fontSize: 22, fontWeight: 800 }}>Talk Recorded!</h2>
      <p style={{ color: '#94a3b8', margin: '0 0 6px', fontSize: 15 }}>{topic}</p>
      <p style={{ color: '#64748b', margin: '0 0 40px', fontSize: 13 }}>
        👥 {attendeeCount} attendee{attendeeCount !== 1 ? 's' : ''} logged
      </p>
      <button
        onClick={onAnother}
        style={{
          padding: '14px 32px', borderRadius: 12, border: 'none',
          background: GREEN, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer',
        }}
      >+ New Safety Talk</button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FieldSafetyTalk() {
  const [step, setStep] = useState<Step>(1);

  const [presenterName, setPresenterName] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ap_user') || '{}').name || ''; } catch { return ''; }
  });
  const [attendees,  setAttendees]  = useState<string[]>([]);
  const [talkDate,    setTalkDate]    = useState(todayStr());
  const [topic,       setTopic]       = useState('');
  const [jobSite,     setJobSite]     = useState('');
  const [propertyId,  setPropertyId]  = useState<number | null>(null);
  const [notes,       setNotes]       = useState('');
  const [photo,       setPhoto]       = useState<File | null>(null);

  const [submitting,   setSubmitting]   = useState(false);
  const [submitError,  setSubmitError]  = useState<string | null>(null);
  const [lastTalkInfo, setLastTalkInfo] = useState<{ topic: string; count: number } | null>(null);

  function reset() {
    setStep(1); setAttendees([]); setTalkDate(todayStr()); setTopic('');
    setJobSite(''); setPropertyId(null); setNotes(''); setPhoto(null);
    setSubmitError(null); setLastTalkInfo(null);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await createSafetyTalk({
        talk_date:      talkDate,
        topic:          topic.trim(),
        presenter_name: presenterName.trim(),
        job_site:       jobSite.trim() || undefined,
        notes:          notes.trim() || undefined,
        attendees,
        photo:          photo ?? undefined,
      });
      setLastTalkInfo({ topic: topic.trim(), count: attendees.length });
      setStep(4);
    } catch (e) {
      setSubmitError((e as Error).message || 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: DARK,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      maxWidth: 480, margin: '0 auto',
    }}>
      {/* Header */}
      <div style={{
        background: '#0a0f1c', padding: '16px 20px',
        borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <a href="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none', flexShrink: 0 }} title="Home">
          <img src="/darios-logo.png" alt="Darios" style={{ height: 28, objectFit: 'contain', filter: 'brightness(0) invert(1)' }} />
        </a>
        <div>
          <div style={{ color: '#fff', fontWeight: 800, fontSize: 16 }}>Safety Talk</div>
          <div style={{ color: '#64748b', fontSize: 11 }}>Darios Landscaping</div>
        </div>
        {step < 4 && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            {[1, 2, 3].map(s => (
              <div key={s} style={{
                width: s === step ? 20 : 6, height: 6, borderRadius: 3,
                background: s <= step ? GREEN : '#1e293b',
                transition: 'all 0.2s',
              }} />
            ))}
          </div>
        )}
      </div>

      {/* Error banner */}
      {submitError && (
        <div style={{ background: '#7f1d1d', padding: '12px 20px', fontSize: 13, color: '#fca5a5' }}>
          ⚠️ {submitError}
        </div>
      )}

      {step === 1 && (
        <StepAttendees
          attendees={attendees}       setAttendees={setAttendees}
          presenterName={presenterName} setPresenterName={setPresenterName}
          onNext={() => setStep(2)}
        />
      )}

      {step === 2 && (
        <StepTalkInfo
          talkDate={talkDate} setTalkDate={setTalkDate}
          topic={topic}       setTopic={setTopic}
          jobSite={jobSite}   setJobSite={setJobSite}
          setPropertyId={setPropertyId}
          notes={notes}       setNotes={setNotes}
          photo={photo}       setPhoto={setPhoto}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <StepReview
          talkDate={talkDate} topic={topic}
          presenterName={presenterName} jobSite={jobSite}
          notes={notes} attendees={attendees} photo={photo}
          onBack={() => setStep(2)}
          onSubmit={handleSubmit}
          submitting={submitting}
        />
      )}

      {step === 4 && lastTalkInfo && (
        <StepSuccess
          topic={lastTalkInfo.topic}
          attendeeCount={lastTalkInfo.count}
          onAnother={reset}
        />
      )}
    </div>
  );
}
