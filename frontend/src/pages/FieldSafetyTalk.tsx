/**
 * FieldSafetyTalk.tsx — Mobile safety / toolbox talk submission for field crew.
 * Route: /field/safety (public, no login required)
 *
 * Steps:
 *   1. Talk details (date, topic, presenter, job site)
 *   2. Add attendees
 *   3. Notes (optional key points)
 *   4. Review & submit
 *   5. Success
 */

import { useState, useRef, useEffect } from 'react';
import { createSafetyTalk, getCrewAssignments, type CrewAssignment } from '../lib/api';

type Step = 1 | 2 | 3 | 4 | 5;

// ── Shared UI ─────────────────────────────────────────────────────────────────

const DARK   = '#0f172a';
const GREEN  = '#16a34a';
const BORDER = '#1e293b';

function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtDate(s: string) {
  if (!s) return '';
  try { return new Date(s + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
  catch { return s; }
}

function StepHeader({ step, label, total = 4 }: { step: number; label: string; total?: number }) {
  return (
    <div style={{ padding: '20px 20px 0' }}>
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
        Step {step} of {total}
      </div>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#fff' }}>{label}</h2>
    </div>
  );
}

function FieldInput({ label, value, onChange, placeholder, required }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; required?: boolean;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: 3 }}>*</span>}
      </label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '12px 14px',
          borderRadius: 10, border: `1.5px solid ${BORDER}`,
          background: '#1e293b', color: '#f8fafc', fontSize: 16, outline: 'none',
        }}
        onFocus={e => (e.currentTarget.style.borderColor = GREEN)}
        onBlur={e  => (e.currentTarget.style.borderColor = BORDER)}
      />
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

// ── Step 1: Talk Details ──────────────────────────────────────────────────────

function StepDetails({
  talkDate, setTalkDate,
  topic, setTopic,
  presenterName, setPresenterName,
  jobSite, setJobSite,
  onNext,
}: {
  talkDate: string; setTalkDate: (v: string) => void;
  topic: string; setTopic: (v: string) => void;
  presenterName: string; setPresenterName: (v: string) => void;
  jobSite: string; setJobSite: (v: string) => void;
  onNext: () => void;
}) {
  const [customTopic, setCustomTopic] = useState(!PRESET_TOPICS.includes(topic) && topic !== '');

  function pickTopic(t: string) {
    setTopic(t);
    setCustomTopic(false);
  }

  function switchToCustom() {
    setTopic('');
    setCustomTopic(true);
  }

  const canProceed = talkDate && topic.trim() && presenterName.trim();

  return (
    <div>
      <StepHeader step={1} label="Talk Details" />
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

        <FieldInput
          label="Presenter Name" required
          value={presenterName} onChange={setPresenterName}
          placeholder="Who is leading this talk?"
        />

        <FieldInput
          label="Crew / Route"
          value={jobSite} onChange={setJobSite}
          placeholder="e.g. Route 3, North Crew…"
        />

        <NextBtn onClick={onNext} disabled={!canProceed} />
      </div>
    </div>
  );
}

// ── Step 2: Attendees ─────────────────────────────────────────────────────────

function StepAttendees({
  attendees, setAttendees,
  presenterName, talkDate,
  onBack, onNext,
}: {
  attendees: string[]; setAttendees: (a: string[]) => void;
  presenterName: string; talkDate: string;
  onBack: () => void; onNext: () => void;
}) {
  const [current,    setCurrent]    = useState('');
  const [routes,     setRoutes]     = useState<Record<string, CrewAssignment[]>>({});
  const [routeLoad,  setRouteLoad]  = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load crew assignments for the talk date
  useEffect(() => {
    setRouteLoad(true);
    getCrewAssignments(talkDate)
      .then(setRoutes)
      .catch(() => setRoutes({}))
      .finally(() => setRouteLoad(false));
  }, [talkDate]);

  const attendeeSet = new Set(attendees.map(n => n.toLowerCase()));

  function toggle(name: string) {
    const lower = name.toLowerCase();
    if (attendeeSet.has(lower)) {
      setAttendees(attendees.filter(n => n.toLowerCase() !== lower));
    } else {
      setAttendees([...attendees, name]);
    }
  }

  function addAllFromRoute(members: CrewAssignment[]) {
    const toAdd = members
      .map(m => m.employee_name)
      .filter(n => !attendeeSet.has(n.toLowerCase()));
    if (toAdd.length) setAttendees([...attendees, ...toAdd]);
  }

  function addManual() {
    const name = current.trim();
    if (!name) return;
    if (!attendeeSet.has(name.toLowerCase())) setAttendees([...attendees, name]);
    setCurrent('');
    inputRef.current?.focus();
  }

  function removeAttendee(i: number) {
    setAttendees(attendees.filter((_, idx) => idx !== i));
  }

  const routeNames = Object.keys(routes).sort();
  const hasRoutes  = routeNames.length > 0;

  return (
    <div>
      <StepHeader step={2} label="Attendees" />
      <div style={{ padding: '16px 20px' }}>

        {/* Route crew selector */}
        {routeLoad && (
          <div style={{ color: '#64748b', fontSize: 13, marginBottom: 16 }}>Loading crew assignments…</div>
        )}

        {!routeLoad && hasRoutes && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
              Today's Routes — tap to add crew
            </div>
            {routeNames.map(route => {
              const members = routes[route] || [];
              const allAdded = members.every(m => attendeeSet.has(m.employee_name.toLowerCase()));
              return (
                <div key={route} style={{ marginBottom: 12, background: '#1e293b', borderRadius: 12, overflow: 'hidden' }}>
                  {/* Route header */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid #0f172a' }}>
                    <span style={{ color: '#f8fafc', fontWeight: 700, fontSize: 14 }}>🚛 {route}</span>
                    <button
                      onClick={() => addAllFromRoute(members)}
                      disabled={allAdded}
                      style={{
                        padding: '5px 12px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 700,
                        background: allAdded ? '#374151' : GREEN,
                        color: allAdded ? '#6b7280' : '#fff',
                        cursor: allAdded ? 'default' : 'pointer',
                      }}
                    >{allAdded ? '✓ All added' : `+ Add all (${members.length})`}</button>
                  </div>
                  {/* Member chips */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 14px' }}>
                    {members.map(m => {
                      const added = attendeeSet.has(m.employee_name.toLowerCase());
                      return (
                        <button
                          key={m.employee_id}
                          onClick={() => toggle(m.employee_name)}
                          style={{
                            padding: '7px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                            cursor: 'pointer', border: `1.5px solid ${added ? GREEN : '#334155'}`,
                            background: added ? '#14532d' : '#0f172a',
                            color: added ? '#fff' : '#94a3b8',
                          }}
                        >{added ? '✓ ' : ''}{m.employee_name}</button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Manual entry */}
        <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
          {hasRoutes ? 'Add someone not on a route' : 'Add attendees'}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <input
            ref={inputRef}
            type="text"
            value={current}
            onChange={e => setCurrent(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}
            placeholder="Type a name…"
            style={{
              flex: 1, padding: '12px 14px', borderRadius: 10,
              border: `1.5px solid ${BORDER}`, background: '#1e293b',
              color: '#f8fafc', fontSize: 16, outline: 'none',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = GREEN)}
            onBlur={e  => (e.currentTarget.style.borderColor = BORDER)}
          />
          <button
            onClick={addManual}
            disabled={!current.trim()}
            style={{
              padding: '12px 20px', borderRadius: 10, border: 'none',
              background: current.trim() ? GREEN : '#374151',
              color: current.trim() ? '#fff' : '#6b7280',
              fontWeight: 700, fontSize: 15, cursor: current.trim() ? 'pointer' : 'not-allowed',
              flexShrink: 0,
            }}
          >Add</button>
        </div>

        {/* Selected attendees summary */}
        {attendees.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8 }}>
              {attendees.length} attendee{attendees.length !== 1 ? 's' : ''} selected
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
                    {name.toLowerCase() === presenterName.toLowerCase() && (
                      <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 700, background: '#14532d', padding: '2px 7px', borderRadius: 10 }}>
                        Presenter
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

        <BackBtn onClick={onBack} />
        <NextBtn
          onClick={onNext}
          disabled={attendees.length === 0}
          label={`Next → (${attendees.length} attendee${attendees.length !== 1 ? 's' : ''})`}
        />
      </div>
    </div>
  );
}

// ── Step 3: Notes ─────────────────────────────────────────────────────────────

function StepNotes({
  notes, setNotes,
  onBack, onNext,
}: {
  notes: string; setNotes: (v: string) => void;
  onBack: () => void; onNext: () => void;
}) {
  return (
    <div>
      <StepHeader step={3} label="Key Points" />
      <div style={{ padding: '16px 20px' }}>

        <div style={{ marginBottom: 4, fontSize: 13, color: '#64748b' }}>
          Optional — record any key points covered, hazards discussed, or follow-up actions.
        </div>

        <div style={{ marginBottom: 20, marginTop: 16 }}>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Reviewed proper hydration schedule, PPE checklist completed, discussed new chemical SDS for product X…"
            rows={7}
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

        <BackBtn onClick={onBack} />
        <NextBtn onClick={onNext} label="Review →" />
      </div>
    </div>
  );
}

// ── Step 4: Review ────────────────────────────────────────────────────────────

function StepReview({
  talkDate, topic, presenterName, jobSite, notes, attendees,
  onBack, onSubmit, submitting,
}: {
  talkDate: string; topic: string; presenterName: string;
  jobSite: string; notes: string; attendees: string[];
  onBack: () => void; onSubmit: () => void; submitting: boolean;
}) {
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
      <StepHeader step={4} label="Review & Submit" />
      <div style={{ padding: '16px 20px' }}>

        <div style={{ background: '#1e293b', borderRadius: 12, padding: '4px 16px', marginBottom: 20 }}>
          <Row label="Date"      value={fmtDate(talkDate)} />
          <Row label="Topic"     value={topic} />
          <Row label="Presenter" value={presenterName} />
          <Row label="Crew"      value={jobSite} />
          <Row label="Notes"     value={notes} />
          <div style={{ padding: '12px 0', borderBottom: '1px solid #1e293b' }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
              Attendees ({attendees.length})
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {attendees.map((name, i) => (
                <span
                  key={i}
                  style={{
                    background: '#0f172a', color: '#94a3b8', fontSize: 13,
                    padding: '4px 10px', borderRadius: 20,
                    border: '1px solid #334155',
                  }}
                >👤 {name}</span>
              ))}
            </div>
          </div>
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

// ── Step 5: Success ───────────────────────────────────────────────────────────

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
          background: GREEN, color: '#fff',
          fontSize: 15, fontWeight: 700, cursor: 'pointer',
        }}
      >+ New Safety Talk</button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FieldSafetyTalk() {
  const [step, setStep] = useState<Step>(1);

  const [talkDate,      setTalkDate]      = useState(todayStr());
  const [topic,         setTopic]         = useState('');
  const [presenterName, setPresenterName] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ap_user') || '{}').name || ''; } catch { return ''; }
  });
  const [jobSite,  setJobSite]  = useState('');
  const [attendees, setAttendees] = useState<string[]>([]);
  const [notes,    setNotes]    = useState('');

  const [submitting,   setSubmitting]   = useState(false);
  const [submitError,  setSubmitError]  = useState<string | null>(null);
  const [lastTalkInfo, setLastTalkInfo] = useState<{ topic: string; count: number } | null>(null);

  function reset() {
    setStep(1); setTalkDate(todayStr()); setTopic(''); setJobSite('');
    setAttendees([]); setNotes(''); setSubmitError(null); setLastTalkInfo(null);
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
      });
      setLastTalkInfo({ topic: topic.trim(), count: attendees.length });
      setStep(5);
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
      <div style={{ background: '#0a0f1c', padding: '16px 20px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', gap: 12 }}>
        <a href="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none', flexShrink: 0 }} title="Home">
          <img src="/darios-logo.png" alt="Darios" style={{ height: 28, objectFit: 'contain', filter: 'brightness(0) invert(1)' }} />
        </a>
        <div>
          <div style={{ color: '#fff', fontWeight: 800, fontSize: 16 }}>Safety Talk</div>
          <div style={{ color: '#64748b', fontSize: 11 }}>Darios Landscaping</div>
        </div>
        {step < 5 && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            {[1, 2, 3, 4].map(s => (
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
        <StepDetails
          talkDate={talkDate}       setTalkDate={setTalkDate}
          topic={topic}             setTopic={setTopic}
          presenterName={presenterName} setPresenterName={setPresenterName}
          jobSite={jobSite}         setJobSite={setJobSite}
          onNext={() => setStep(2)}
        />
      )}

      {step === 2 && (
        <StepAttendees
          attendees={attendees} setAttendees={setAttendees}
          presenterName={presenterName} talkDate={talkDate}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <StepNotes
          notes={notes} setNotes={setNotes}
          onBack={() => setStep(2)}
          onNext={() => setStep(4)}
        />
      )}

      {step === 4 && (
        <StepReview
          talkDate={talkDate} topic={topic}
          presenterName={presenterName} jobSite={jobSite}
          notes={notes} attendees={attendees}
          onBack={() => setStep(3)}
          onSubmit={handleSubmit}
          submitting={submitting}
        />
      )}

      {step === 5 && lastTalkInfo && (
        <StepSuccess
          topic={lastTalkInfo.topic}
          attendeeCount={lastTalkInfo.count}
          onAnother={reset}
        />
      )}
    </div>
  );
}
