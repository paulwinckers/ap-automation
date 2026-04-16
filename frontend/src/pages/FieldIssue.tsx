/**
 * FieldIssue.tsx — Mobile Issue creation for field staff.
 * Route: /field/issue (public, no login required)
 *
 * Steps:
 *   1. Search & select property
 *   2. Issue details (subject, assigned to, priority, due date)
 *   3. Comment + photos
 *   4. Review & submit
 *   5. Success
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  searchFieldProperties,
  getAspireEmployees,
  createFieldIssue,
  type FieldPropertyResult,
  type AspireEmployee,
} from '../lib/api';

type Step = 1 | 2 | 3 | 4 | 5;

const MAX_PHOTOS = 5;
const MAX_PX     = 1600;

const PRIORITIES = ['High', 'Normal', 'Low'] as const;

// ── Image compression ─────────────────────────────────────────────────────────

function compressImage(f: File): Promise<File> {
  return new Promise(resolve => {
    if (f.size < 1.5 * 1024 * 1024) { resolve(f); return; }
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let { width, height } = img;
      if (width > MAX_PX || height > MAX_PX) {
        if (width > height) { height = Math.round(height * MAX_PX / width); width = MAX_PX; }
        else { width = Math.round(width * MAX_PX / height); height = MAX_PX; }
      }
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => {
        if (blob) resolve(new File([blob], f.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
        else resolve(f);
      }, 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(f); };
    img.src = url;
  });
}

// ── Shared UI primitives ──────────────────────────────────────────────────────

const DARK   = '#0f172a';
const GREEN  = '#16a34a';
const BORDER = '#1e293b';

function StepHeader({ step, label }: { step: number; label: string }) {
  return (
    <div style={{ padding: '20px 20px 0' }}>
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
        Step {step} of 4
      </div>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#fff' }}>{label}</h2>
    </div>
  );
}

function FieldInput({ label, value, onChange, placeholder, type = 'text', required }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; required?: boolean;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: 3 }}>*</span>}
      </label>
      <input
        type={type}
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

function FieldSelect({ label, value, onChange, options, placeholder, required }: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; placeholder?: string; required?: boolean;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: 3 }}>*</span>}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '12px 14px',
          borderRadius: 10, border: `1.5px solid ${BORDER}`,
          background: '#1e293b', color: value ? '#f8fafc' : '#64748b',
          fontSize: 16, outline: 'none', appearance: 'none',
        }}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
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

// ── Step 1: Property Search ───────────────────────────────────────────────────

function StepProperty({ onSelect }: {
  onSelect: (id: number, name: string) => void;
}) {
  const [query,    setQuery]    = useState('');
  const [results,  setResults]  = useState<FieldPropertyResult[]>([]);
  const [loading,  setLoading]  = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function handleSearch(val: string) {
    setQuery(val);
    if (debounce.current) clearTimeout(debounce.current);
    if (val.trim().length < 2) { setResults([]); return; }
    debounce.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await searchFieldProperties(val.trim());
        setResults(res.properties);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 350);
  }

  // Deduplicate by PropertyID
  const unique = results.filter((p, i, a) =>
    p.PropertyID && a.findIndex(x => x.PropertyID === p.PropertyID) === i
  );

  return (
    <div>
      <StepHeader step={1} label="Select Property" />
      <div style={{ padding: '16px 20px 8px' }}>
        <div style={{ position: 'relative', marginBottom: 8 }}>
          <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', fontSize: 16, color: '#64748b' }}>🔍</span>
          <input
            ref={inputRef}
            type="search"
            placeholder="Search property or client name…"
            value={query}
            onChange={e => handleSearch(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '13px 14px 13px 42px',
              borderRadius: 10, border: `1.5px solid ${BORDER}`,
              background: '#1e293b', color: '#f8fafc', fontSize: 16, outline: 'none',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = GREEN)}
            onBlur={e  => (e.currentTarget.style.borderColor = BORDER)}
          />
          {query && (
            <button onClick={() => { setQuery(''); setResults([]); inputRef.current?.focus(); }}
              style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#64748b', fontSize: 18, cursor: 'pointer' }}>✕</button>
          )}
        </div>
        {loading && <div style={{ textAlign: 'center', padding: 20, color: '#64748b', fontSize: 13 }}>Searching…</div>}
        {!loading && unique.length === 0 && query.length >= 2 && (
          <div style={{ textAlign: 'center', padding: 20, color: '#64748b', fontSize: 13 }}>No properties found for "{query}"</div>
        )}
        {unique.length === 0 && query.length < 2 && (
          <div style={{ textAlign: 'center', padding: 40, color: '#475569' }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>🏠</div>
            <div style={{ fontSize: 14 }}>Type a property or client name</div>
          </div>
        )}
        {unique.map(p => (
          <button
            key={p.PropertyID}
            onClick={() => onSelect(p.PropertyID!, p.PropertyName || `Property ${p.PropertyID}`)}
            style={{
              width: '100%', display: 'block', textAlign: 'left', padding: '14px 16px',
              margin: '6px 0', borderRadius: 10, border: `1px solid ${BORDER}`,
              background: '#1e293b', color: '#f8fafc', cursor: 'pointer',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14 }}>🏠 {p.PropertyName}</div>
            {p.DivisionName && (
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>{p.DivisionName}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Step 2: Issue Details ─────────────────────────────────────────────────────

function StepDetails({
  propertyName, subject, setSubject,
  assignedToId, setAssignedToId, assignedToName, setAssignedToName,
  priority, setPriority, dueDate, setDueDate,
  onBack, onNext,
}: {
  propertyName: string;
  subject: string; setSubject: (v: string) => void;
  assignedToId: number | null; setAssignedToId: (v: number | null) => void;
  assignedToName: string; setAssignedToName: (v: string) => void;
  priority: string; setPriority: (v: string) => void;
  dueDate: string; setDueDate: (v: string) => void;
  onBack: () => void; onNext: () => void;
}) {
  const [employees, setEmployees] = useState<AspireEmployee[]>([]);

  useEffect(() => {
    getAspireEmployees().then(setEmployees).catch(() => {});
  }, []);

  function handleAssignee(val: string) {
    if (!val) { setAssignedToId(null); setAssignedToName(''); return; }
    const emp = employees.find(e => String(e.UserID || e.ContactID) === val);
    if (emp) {
      setAssignedToId(emp.UserID || emp.ContactID);
      setAssignedToName(emp.FullName);
    }
  }

  const currentAssigneeVal = assignedToId ? String(assignedToId) : '';

  return (
    <div>
      <StepHeader step={2} label="Issue Details" />
      <div style={{ padding: '16px 20px' }}>
        <div style={{ background: '#1e293b', borderRadius: 10, padding: '10px 14px', marginBottom: 20, fontSize: 13, color: '#94a3b8' }}>
          🏠 <span style={{ color: '#f8fafc', fontWeight: 600 }}>{propertyName}</span>
        </div>

        <FieldInput
          label="Subject / Title" required
          value={subject} onChange={setSubject}
          placeholder="e.g. Gate latch broken, irrigation leak…"
        />

        <FieldSelect
          label="Assigned To" required={false}
          value={currentAssigneeVal}
          onChange={handleAssignee}
          placeholder="Select employee…"
          options={employees.map(e => ({
            value: String(e.UserID || e.ContactID),
            label: e.FullName,
          }))}
        />

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Priority</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {PRIORITIES.map(p => (
              <button key={p} onClick={() => setPriority(p)} style={{
                flex: 1, padding: '10px 0', borderRadius: 8,
                border: `1.5px solid ${priority === p ? (p === 'High' ? '#ef4444' : p === 'Low' ? '#22c55e' : GREEN) : BORDER}`,
                background: priority === p ? (p === 'High' ? '#7f1d1d' : p === 'Low' ? '#14532d' : '#14532d') : '#1e293b',
                color: priority === p ? '#fff' : '#94a3b8',
                fontWeight: 600, fontSize: 13, cursor: 'pointer',
              }}>{p}</button>
            ))}
          </div>
        </div>

        <FieldInput
          label="Due Date" type="date"
          value={dueDate} onChange={setDueDate}
          placeholder=""
        />

        <BackBtn onClick={onBack} />
        <NextBtn onClick={onNext} disabled={!subject.trim()} />
      </div>
    </div>
  );
}

// ── Step 3: Comment + Photos ──────────────────────────────────────────────────

function StepComment({
  notes, setNotes, photos, setPhotos,
  submitterName, setSubmitterName,
  onBack, onNext,
}: {
  notes: string; setNotes: (v: string) => void;
  photos: File[]; setPhotos: (f: File[]) => void;
  submitterName: string; setSubmitterName: (v: string) => void;
  onBack: () => void; onNext: () => void;
}) {
  const [compressing, setCompressing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const previews = photos.map(f => URL.createObjectURL(f));

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    const arr = Array.from(files);
    const remaining = MAX_PHOTOS - photos.length;
    if (remaining <= 0) return;
    setCompressing(true);
    const compressed = await Promise.all(arr.slice(0, remaining).map(compressImage));
    setPhotos([...photos, ...compressed]);
    setCompressing(false);
  }

  const removePhoto = useCallback((i: number) => {
    setPhotos(photos.filter((_, idx) => idx !== i));
  }, [photos, setPhotos]);

  return (
    <div>
      <StepHeader step={3} label="Comment & Photos" />
      <div style={{ padding: '16px 20px' }}>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 6 }}>Comment</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Describe the issue in detail…"
            rows={5}
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

        {/* Photo upload */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>
            Photos ({photos.length}/{MAX_PHOTOS})
          </label>
          {photos.length < MAX_PHOTOS && (
            <>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={compressing}
                style={{
                  width: '100%', padding: '14px', borderRadius: 10,
                  border: `1.5px dashed ${BORDER}`,
                  background: '#1e293b', color: '#64748b',
                  fontSize: 14, cursor: 'pointer', marginBottom: 10,
                }}
              >
                {compressing ? 'Compressing…' : '📷 Add Photos'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                capture="environment"
                onChange={e => handleFiles(e.target.files)}
                style={{ display: 'none' }}
              />
            </>
          )}
          {previews.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
              {previews.map((src, i) => (
                <div key={i} style={{ position: 'relative' }}>
                  <img src={src} alt={`Photo ${i+1}`} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8 }} />
                  <button
                    onClick={() => removePhoto(i)}
                    style={{
                      position: 'absolute', top: 4, right: 4, width: 22, height: 22,
                      borderRadius: '50%', background: 'rgba(0,0,0,0.7)',
                      border: 'none', color: '#fff', fontSize: 11, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <FieldInput
          label="Your Name" required
          value={submitterName} onChange={setSubmitterName}
          placeholder="Your name"
        />

        <BackBtn onClick={onBack} />
        <NextBtn onClick={onNext} disabled={!submitterName.trim()} />
      </div>
    </div>
  );
}

// ── Step 4: Review ────────────────────────────────────────────────────────────

function StepReview({
  propertyName, subject, assignedToName, priority, dueDate, notes, photos,
  submitterName, onBack, onSubmit, submitting,
}: {
  propertyName: string; subject: string; assignedToName: string;
  priority: string; dueDate: string; notes: string; photos: File[];
  submitterName: string;
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
          <Row label="Property"    value={propertyName} />
          <Row label="Subject"     value={subject} />
          <Row label="Assigned To" value={assignedToName} />
          <Row label="Priority"    value={priority} />
          <Row label="Due Date"    value={dueDate} />
          <Row label="Comment"     value={notes} />
          <Row label="Submitted By" value={submitterName} />
          {photos.length > 0 && (
            <div style={{ display: 'flex', gap: 12, padding: '10px 0' }}>
              <span style={{ width: 110, fontSize: 12, color: '#64748b', flexShrink: 0 }}>Photos</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {photos.map((f, i) => (
                  <img key={i} src={URL.createObjectURL(f)} alt={`Photo ${i+1}`}
                    style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6 }} />
                ))}
              </div>
            </div>
          )}
        </div>

        <BackBtn onClick={onBack} />
        <NextBtn
          onClick={onSubmit}
          disabled={submitting}
          label={submitting ? 'Submitting…' : '✓ Submit Issue'}
        />
      </div>
    </div>
  );
}

// ── Step 5: Success ───────────────────────────────────────────────────────────

function StepSuccess({ propertyName, subject, onAnother }: {
  propertyName: string; subject: string; onAnother: () => void;
}) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 28px 40px' }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>✅</div>
      <h2 style={{ color: '#fff', margin: '0 0 8px', fontSize: 22, fontWeight: 800 }}>Issue Created!</h2>
      <p style={{ color: '#94a3b8', margin: '0 0 8px', fontSize: 14 }}>{subject}</p>
      <p style={{ color: '#64748b', margin: '0 0 40px', fontSize: 13 }}>📍 {propertyName}</p>
      <button
        onClick={onAnother}
        style={{
          padding: '14px 32px', borderRadius: 12, border: 'none',
          background: GREEN, color: '#fff',
          fontSize: 15, fontWeight: 700, cursor: 'pointer',
        }}
      >+ New Issue</button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FieldIssue() {
  const [step, setStep] = useState<Step>(1);

  // Step 1
  const [propertyId,   setPropertyId]   = useState<number | null>(null);
  const [propertyName, setPropertyName] = useState('');

  // Step 2
  const [subject,         setSubject]         = useState('');
  const [assignedToId,    setAssignedToId]    = useState<number | null>(null);
  const [assignedToName,  setAssignedToName]  = useState('');
  const [priority,        setPriority]        = useState('Normal');
  const [dueDate,         setDueDate]         = useState('');

  // Step 3
  const [notes,         setNotes]         = useState('');
  const [photos,        setPhotos]        = useState<File[]>([]);
  const [submitterName, setSubmitterName] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ap_user') || '{}').name || ''; } catch { return ''; }
  });

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function reset() {
    setStep(1); setPropertyId(null); setPropertyName('');
    setSubject(''); setAssignedToId(null); setAssignedToName('');
    setPriority('Normal'); setDueDate(''); setNotes('');
    setPhotos([]); setSubmitError(null);
  }

  async function handleSubmit() {
    if (!propertyId || !subject.trim() || !submitterName.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await createFieldIssue({
        submitterName,
        propertyId,
        propertyName,
        subject: subject.trim(),
        assignedToId:   assignedToId  ?? undefined,
        assignedToName: assignedToName || undefined,
        priority:       priority || undefined,
        dueDate:        dueDate  || undefined,
        notes:          notes.trim(),
        photos,
      });
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
      {/* Header bar */}
      <div style={{ background: '#0a0f1c', padding: '16px 20px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 22 }}>⚠️</span>
        <div>
          <div style={{ color: '#fff', fontWeight: 800, fontSize: 16 }}>New Issue</div>
          <div style={{ color: '#64748b', fontSize: 11 }}>Darios Landscaping</div>
        </div>
        {step < 5 && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            {[1,2,3,4].map(s => (
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

      {/* Steps */}
      {step === 1 && (
        <StepProperty
          onSelect={(id, name) => { setPropertyId(id); setPropertyName(name); setStep(2); }}
        />
      )}

      {step === 2 && (
        <StepDetails
          propertyName={propertyName}
          subject={subject}           setSubject={setSubject}
          assignedToId={assignedToId} setAssignedToId={setAssignedToId}
          assignedToName={assignedToName} setAssignedToName={setAssignedToName}
          priority={priority}         setPriority={setPriority}
          dueDate={dueDate}           setDueDate={setDueDate}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <StepComment
          notes={notes}               setNotes={setNotes}
          photos={photos}             setPhotos={setPhotos}
          submitterName={submitterName} setSubmitterName={setSubmitterName}
          onBack={() => setStep(2)}
          onNext={() => setStep(4)}
        />
      )}

      {step === 4 && (
        <StepReview
          propertyName={propertyName} subject={subject}
          assignedToName={assignedToName} priority={priority}
          dueDate={dueDate} notes={notes} photos={photos}
          submitterName={submitterName}
          onBack={() => setStep(3)}
          onSubmit={handleSubmit}
          submitting={submitting}
        />
      )}

      {step === 5 && (
        <StepSuccess
          propertyName={propertyName}
          subject={subject}
          onAnother={reset}
        />
      )}
    </div>
  );
}
