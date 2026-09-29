/**
 * FieldIncident.tsx — Field Safety Incident Report (public, phone-first, no login).
 * Submits to POST /safety/incidents which stores the report + emails the safety team.
 */

import { useState } from 'react';
import { submitIncident } from '../lib/api';

const TYPES = [
  { v: 'injury',          l: 'Injury' },
  { v: 'near_miss',       l: 'Near miss' },
  { v: 'property_damage', l: 'Property damage' },
  { v: 'environmental',   l: 'Environmental' },
  { v: 'other',           l: 'Other' },
];
const SEVERITIES = [
  { v: 'minor',    l: 'Minor',    c: '#16a34a' },
  { v: 'moderate', l: 'Moderate', c: '#d97706' },
  { v: 'serious',  l: 'Serious',  c: '#dc2626' },
  { v: 'critical', l: 'Critical', c: '#991b1b' },
];
const FACTORS = [
  { v: 'unsafe_act',        l: 'Unsafe act' },
  { v: 'unsafe_conditions', l: 'Unsafe conditions' },
  { v: 'equipment_issue',   l: 'Equipment issue' },
  { v: 'lack_of_training',  l: 'Lack of training' },
];

const S: Record<string, React.CSSProperties> = {
  page:   { minHeight: '100vh', background: '#0f172a', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', padding: '0 0 48px' },
  header: { background: '#7f1d1d', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, position: 'sticky', top: 0, zIndex: 10 },
  logo:   { height: 30, objectFit: 'contain' as const },
  title:  { color: '#fff', fontWeight: 800, fontSize: 17, flex: 1 },
  home:   { color: '#fecaca', fontSize: 13, textDecoration: 'none', padding: '6px 10px', borderRadius: 6, border: '1px solid #b91c1c' },
  body:   { padding: '18px 16px', maxWidth: 520, margin: '0 auto' },
  card:   { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 16, marginBottom: 12 },
  label:  { color: '#94a3b8', fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'block' },
  input:  { width: '100%', background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: '11px 12px', color: '#fff', fontSize: 15, boxSizing: 'border-box' as const, fontFamily: 'inherit' },
  area:   { width: '100%', background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: '11px 12px', color: '#fff', fontSize: 15, boxSizing: 'border-box' as const, fontFamily: 'inherit', minHeight: 90, resize: 'vertical' as const },
  btn:    { width: '100%', padding: '15px', borderRadius: 10, border: 'none', fontWeight: 800, fontSize: 16, cursor: 'pointer', marginTop: 4 },
  req:    { color: '#f87171' },
  err:    { background: '#7f1d1d', border: '1px solid #dc2626', borderRadius: 8, padding: '12px', color: '#fca5a5', fontSize: 13, marginBottom: 12 },
};

function today(): string { return new Date().toISOString().slice(0, 10); }
function userName(): string {
  try { return JSON.parse(localStorage.getItem('ap_user') || '{}').name || ''; } catch { return ''; }
}

function YesNo({ value, onChange }: { value: boolean | null; onChange: (v: boolean) => void }) {
  const opt = (v: boolean, label: string) => (
    <button type="button" onClick={() => onChange(v)}
      style={{ flex: 1, padding: '10px', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer',
               border: '1px solid ' + (value === v ? '#3b82f6' : '#334155'),
               background: value === v ? '#1e3a5f' : '#0f172a', color: value === v ? '#93c5fd' : '#94a3b8' }}>
      {label}
    </button>
  );
  return <div style={{ display: 'flex', gap: 8 }}>{opt(true, 'Yes')}{opt(false, 'No')}</div>;
}

export default function FieldIncident() {
  const [reporter, setReporter] = useState(userName());
  const [date, setDate]         = useState(today());
  const [time, setTime]         = useState('');
  const [location, setLocation] = useState('');
  const [itype, setItype]       = useState('near_miss');
  const [severity, setSeverity] = useState('minor');
  const [people, setPeople]     = useState('');
  const [injury, setInjury]     = useState('');
  const [what, setWhat]         = useState('');
  const [action, setAction]     = useState('');
  const [sentMedical, setSentMedical] = useState<boolean | null>(null);
  const [factors, setFactors]   = useState<string[]>([]);
  const [worksafe, setWorksafe] = useState<boolean | null>(null);
  const [damage, setDamage]     = useState<boolean | null>(null);
  const [damageDesc, setDamageDesc] = useState('');
  const [witnesses, setWitnesses] = useState('');
  const [photos, setPhotos]     = useState<File[]>([]);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');
  const [doneId, setDoneId]     = useState<number | null>(null);

  async function submit() {
    setError('');
    if (!reporter.trim()) { setError('Please enter your name.'); return; }
    if (!what.trim())     { setError('Please describe what happened.'); return; }
    setBusy(true);
    try {
      const r = await submitIncident({
        incident_date: date, incident_time: time || undefined, reporter_name: reporter.trim(),
        location: location.trim() || undefined, incident_type: itype, severity,
        people_involved: people.trim() || undefined,
        injury_description: injury.trim() || undefined,
        description: what.trim(),
        immediate_action: action.trim() || undefined,
        sent_to_medical: sentMedical ?? undefined,
        contributing_factors: factors,
        reported_worksafe: worksafe ?? undefined,
        property_damage: damage ?? undefined,
        property_damage_desc: damage ? (damageDesc.trim() || undefined) : undefined,
        witnesses: witnesses.trim() || undefined,
        photos,
      });
      setDoneId(r.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not submit — please try again.');
    } finally {
      setBusy(false);
    }
  }

  function header() {
    return (
      <div style={S.header}>
        <a href="/" title="Home"><img src="/darios-logo.png" alt="Darios" style={S.logo} /></a>
        <span style={S.title}>🚨 Safety Incident Report</span>
        <a href="/" style={S.home}>🏠 Home</a>
      </div>
    );
  }

  if (doneId) {
    return (
      <div style={S.page}>
        {header()}
        <div style={{ ...S.body, textAlign: 'center', paddingTop: 48 }}>
          <div style={{ fontSize: 52, marginBottom: 12 }}>✅</div>
          <div style={{ color: '#4ade80', fontWeight: 800, fontSize: 22, marginBottom: 8 }}>Report submitted</div>
          <div style={{ color: '#94a3b8', fontSize: 14, marginBottom: 6 }}>Incident #{doneId} has been sent to the safety team.</div>
          <div style={{ color: '#64748b', fontSize: 13, marginBottom: 28 }}>Thank you for reporting. If anyone is hurt, make sure they’re receiving care.</div>
          <button style={{ ...S.btn, background: '#1e293b', color: '#94a3b8', maxWidth: 260, margin: '0 auto', display: 'block' }}
                  onClick={() => { setDoneId(null); setWhat(''); setInjury(''); setAction(''); setPeople(''); setWitnesses(''); setPhotos([]); setSentMedical(null); setFactors([]); setWorksafe(null); setDamage(null); setDamageDesc(''); }}>
            Report another
          </button>
          <a href="/" style={{ display: 'inline-block', marginTop: 14, color: '#94a3b8', fontSize: 13 }}>← Back to Home</a>
        </div>
      </div>
    );
  }

  return (
    <div style={S.page}>
      {header()}
      <div style={S.body}>
        {error && <div style={S.err}>{error}</div>}

        <div style={S.card}>
          <label style={S.label}>Your name <span style={S.req}>*</span></label>
          <input style={S.input} value={reporter} onChange={e => setReporter(e.target.value)} placeholder="Who is reporting" />
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={S.label}>Date <span style={S.req}>*</span></label>
              <input style={S.input} type="date" value={date} onChange={e => setDate(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={S.label}>Time</label>
              <input style={S.input} type="time" value={time} onChange={e => setTime(e.target.value)} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={S.label}>Location / property</label>
            <input style={S.input} value={location} onChange={e => setLocation(e.target.value)} placeholder="Where did it happen" />
          </div>
        </div>

        <div style={S.card}>
          <label style={S.label}>Type of incident</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {TYPES.map(t => (
              <button key={t.v} onClick={() => setItype(t.v)}
                style={{ padding: '8px 12px', borderRadius: 20, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                         border: '1px solid ' + (itype === t.v ? '#3b82f6' : '#334155'),
                         background: itype === t.v ? '#1e3a5f' : '#0f172a', color: itype === t.v ? '#93c5fd' : '#94a3b8' }}>
                {t.l}
              </button>
            ))}
          </div>
          <label style={{ ...S.label, marginTop: 14 }}>Severity</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {SEVERITIES.map(s => (
              <button key={s.v} onClick={() => setSeverity(s.v)}
                style={{ padding: '8px 12px', borderRadius: 20, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                         border: '1px solid ' + (severity === s.v ? s.c : '#334155'),
                         background: severity === s.v ? s.c : '#0f172a', color: severity === s.v ? '#fff' : '#94a3b8' }}>
                {s.l}
              </button>
            ))}
          </div>
        </div>

        <div style={S.card}>
          <label style={S.label}>What happened? <span style={S.req}>*</span></label>
          <textarea style={S.area} value={what} onChange={e => setWhat(e.target.value)} placeholder="Describe the incident — what, where, how" />
          {itype === 'injury' && (
            <div style={{ marginTop: 12 }}>
              <label style={S.label}>Injury details</label>
              <textarea style={{ ...S.area, minHeight: 70 }} value={injury} onChange={e => setInjury(e.target.value)} placeholder="Who was hurt and how; first aid / medical given" />
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <label style={S.label}>People involved</label>
            <input style={S.input} value={people} onChange={e => setPeople(e.target.value)} placeholder="Names of anyone involved" />
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={S.label}>Immediate action taken</label>
            <textarea style={{ ...S.area, minHeight: 70 }} value={action} onChange={e => setAction(e.target.value)} placeholder="What was done right away to make it safe" />
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={S.label}>Worker sent to hospital / clinic?</label>
            <YesNo value={sentMedical} onChange={setSentMedical} />
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={S.label}>Witnesses</label>
            <input style={S.input} value={witnesses} onChange={e => setWitnesses(e.target.value)} placeholder="Names of any witnesses" />
          </div>
        </div>

        <div style={S.card}>
          <label style={S.label}>Contributing factors</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {FACTORS.map(f => {
              const on = factors.includes(f.v);
              return (
                <button key={f.v} type="button"
                  onClick={() => setFactors(on ? factors.filter(x => x !== f.v) : [...factors, f.v])}
                  style={{ padding: '8px 12px', borderRadius: 20, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                           border: '1px solid ' + (on ? '#3b82f6' : '#334155'),
                           background: on ? '#1e3a5f' : '#0f172a', color: on ? '#93c5fd' : '#94a3b8' }}>
                  {on ? '✓ ' : ''}{f.l}
                </button>
              );
            })}
          </div>
          <div style={{ marginTop: 16 }}>
            <label style={S.label}>Reported to WorkSafeBC?</label>
            <YesNo value={worksafe} onChange={setWorksafe} />
          </div>
          <div style={{ marginTop: 16 }}>
            <label style={S.label}>Property / equipment damage?</label>
            <YesNo value={damage} onChange={setDamage} />
            {damage && (
              <textarea style={{ ...S.area, minHeight: 60, marginTop: 8 }} value={damageDesc}
                onChange={e => setDamageDesc(e.target.value)} placeholder="Describe the property or equipment damage" />
            )}
          </div>
        </div>

        <div style={S.card}>
          <label style={S.label}>Photos</label>
          <input type="file" accept="image/*" multiple capture="environment"
            onChange={e => setPhotos(Array.from(e.target.files || []))}
            style={{ color: '#94a3b8', fontSize: 13, width: '100%' }} />
          {photos.length > 0 && <div style={{ color: '#64748b', fontSize: 12, marginTop: 6 }}>{photos.length} photo(s) attached</div>}
        </div>

        <button style={{ ...S.btn, background: busy ? '#475569' : '#dc2626', color: '#fff' }} disabled={busy} onClick={submit}>
          {busy ? 'Submitting…' : 'Submit incident report'}
        </button>
      </div>
    </div>
  );
}
