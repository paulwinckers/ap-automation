/**
 * FieldVehicleInspection.tsx — Weekly vehicle inspection (public, phone-first).
 * A little fun: truck graphics + a synthesized car horn (Web Audio, no asset needed).
 */
import { useState } from 'react';
import { submitVehicleInspection, VEHICLE_CHECKLIST } from '../lib/api';

// ── Synthesized car horn (dual-tone, via Web Audio) ─────────────────────────────
let _actx: AudioContext | null = null;
function honk(times = 1) {
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    _actx = _actx || new Ctor();
    const ctx = _actx;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const dur = 0.34, gap = 0.16;
    for (let n = 0; n < times; n++) {
      const t0 = now + n * (dur + gap);
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.03);
      gain.gain.setValueAtTime(0.22, t0 + dur - 0.06);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      [349, 440].forEach(f => {            // F + A — classic dual-tone horn
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.connect(gain);
        o.start(t0);
        o.stop(t0 + dur);
      });
    }
  } catch { /* audio unavailable — no-op */ }
}

function today(): string { return new Date().toISOString().slice(0, 10); }
function userName(): string {
  try { return JSON.parse(localStorage.getItem('ap_user') || '{}').name || ''; } catch { return ''; }
}

const S: Record<string, React.CSSProperties> = {
  page:   { minHeight: '100vh', background: '#0f172a', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', padding: '0 0 48px' },
  header: { background: 'linear-gradient(135deg,#1e3a8a,#1d4ed8)', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, position: 'sticky', top: 0, zIndex: 10 },
  logo:   { height: 30, objectFit: 'contain' as const },
  title:  { color: '#fff', fontWeight: 800, fontSize: 17, flex: 1 },
  home:   { color: '#bfdbfe', fontSize: 13, textDecoration: 'none', padding: '6px 10px', borderRadius: 6, border: '1px solid #3b82f6' },
  body:   { padding: '16px', maxWidth: 560, margin: '0 auto' },
  card:   { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 14, marginBottom: 10 },
  label:  { color: '#94a3b8', fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'block' },
  input:  { width: '100%', background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: '11px 12px', color: '#fff', fontSize: 15, boxSizing: 'border-box' as const, fontFamily: 'inherit' },
  btn:    { width: '100%', padding: '15px', borderRadius: 10, border: 'none', fontWeight: 800, fontSize: 16, cursor: 'pointer', marginTop: 4 },
  req:    { color: '#f87171' },
  err:    { background: '#7f1d1d', border: '1px solid #dc2626', borderRadius: 8, padding: '12px', color: '#fca5a5', fontSize: 13, marginBottom: 12 },
};

type Item = { result: 'ok' | 'not_ok' | ''; notes: string };

export default function FieldVehicleInspection() {
  const [vehicle, setVehicle]   = useState('');
  const [odo, setOdo]           = useState('');
  const [by, setBy]             = useState(userName());
  const [date, setDate]         = useState(today());
  const [items, setItems]       = useState<Record<string, Item>>(
    () => Object.fromEntries(VEHICLE_CHECKLIST.map(i => [i.key, { result: '', notes: '' }])),
  );
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');
  const [done, setDone]         = useState<{ id: number; defects: number } | null>(null);

  const answered = Object.values(items).filter(i => i.result !== '').length;
  const defects  = Object.values(items).filter(i => i.result === 'not_ok').length;
  const total    = VEHICLE_CHECKLIST.length;
  const pct       = Math.round((answered / total) * 100);

  function setResult(key: string, result: 'ok' | 'not_ok') {
    setItems(prev => ({ ...prev, [key]: { ...prev[key], result } }));
    if (key === 'horn' && result === 'ok') honk(1);   // 🎉 test the horn!
  }
  function setNote(key: string, notes: string) {
    setItems(prev => ({ ...prev, [key]: { ...prev[key], notes } }));
  }

  async function submit() {
    setError('');
    if (!by.trim())      { setError('Please enter who completed the inspection.'); return; }
    if (answered === 0)  { setError('Please check at least one item.'); return; }
    setBusy(true);
    try {
      const payloadItems = VEHICLE_CHECKLIST.map(c => ({
        key: c.key, label: c.label, result: items[c.key].result,
        notes: items[c.key].notes.trim() || null,
      }));
      const r = await submitVehicleInspection({
        vehicle_number: vehicle.trim() || undefined, odometer: odo.trim() || undefined,
        completed_by: by.trim(), inspection_date: date, items: payloadItems,
      });
      honk(2);
      setDone({ id: r.id, defects: r.defect_count });
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
        <span style={S.title}>🚛 Vehicle Inspection</span>
        <button onClick={() => honk(1)} title="Honk!" style={{ background: '#fbbf24', border: 'none', borderRadius: 8, fontSize: 18, padding: '4px 10px', cursor: 'pointer' }}>📣</button>
        <a href="/" style={S.home}>🏠</a>
      </div>
    );
  }

  if (done) {
    const clean = done.defects === 0;
    return (
      <div style={S.page}>
        {header()}
        <div style={{ ...S.body, textAlign: 'center', paddingTop: 44 }}>
          <div style={{ fontSize: 60, marginBottom: 8 }}>{clean ? '🚛💨' : '🚛🔧'}</div>
          <div style={{ color: clean ? '#4ade80' : '#fbbf24', fontWeight: 800, fontSize: 24, marginBottom: 8 }}>
            {clean ? 'All good — good to go!' : `${done.defects} item(s) flagged`}
          </div>
          <div style={{ color: '#94a3b8', fontSize: 14, marginBottom: 6 }}>Inspection #{done.id} submitted.</div>
          <div style={{ color: '#64748b', fontSize: 13, marginBottom: 26 }}>
            {clean ? 'Drive safe out there. 🦺' : 'The shop has been notified of the defects.'}
          </div>
          <button onClick={() => honk(2)} style={{ ...S.btn, background: '#fbbf24', color: '#1f2937', maxWidth: 220, margin: '0 auto 12px', display: 'block' }}>📣 Honk!</button>
          <a href="/" style={{ display: 'inline-block', color: '#94a3b8', fontSize: 13 }}>← Back to Home</a>
        </div>
      </div>
    );
  }

  return (
    <div style={S.page}>
      {header()}
      <div style={S.body}>
        <div style={{ color: '#93c5fd', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>
          🦺 Complete before operating the vehicle for the week. Ask for help or leave a note if unsure.
        </div>
        {error && <div style={S.err}>{error}</div>}

        <div style={S.card}>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={S.label}>Vehicle #</label>
              <input style={S.input} value={vehicle} onChange={e => setVehicle(e.target.value)} placeholder="e.g. 12" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={S.label}>Odometer</label>
              <input style={S.input} value={odo} onChange={e => setOdo(e.target.value)} inputMode="numeric" placeholder="km" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={S.label}>Completed by <span style={S.req}>*</span></label>
              <input style={S.input} value={by} onChange={e => setBy(e.target.value)} placeholder="Your name" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={S.label}>Date <span style={S.req}>*</span></label>
              <input style={S.input} type="date" value={date} onChange={e => setDate(e.target.value)} />
            </div>
          </div>
        </div>

        {/* Progress "road" */}
        <div style={{ margin: '4px 2px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>
            <span>{answered}/{total} checked</span>
            {defects > 0 && <span style={{ color: '#f87171', fontWeight: 700 }}>⚠️ {defects} not OK</span>}
          </div>
          <div style={{ position: 'relative', height: 12, background: '#334155', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: defects ? 'linear-gradient(90deg,#f59e0b,#f97316)' : 'linear-gradient(90deg,#22c55e,#16a34a)', transition: 'width 0.2s' }} />
          </div>
        </div>

        {VEHICLE_CHECKLIST.map(c => {
          const it = items[c.key];
          const notOk = it.result === 'not_ok';
          const ok = it.result === 'ok';
          return (
            <div key={c.key} style={{ ...S.card, border: '1px solid ' + (notOk ? '#dc2626' : ok ? '#16a34a' : '#334155') }}>
              <div style={{ color: '#e2e8f0', fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
                {c.key === 'horn' ? '📣 ' : ''}{c.label}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setResult(c.key, 'ok')}
                  style={{ flex: 1, padding: '11px', borderRadius: 8, fontSize: 14, fontWeight: 800, cursor: 'pointer',
                           border: '1px solid ' + (ok ? '#16a34a' : '#334155'),
                           background: ok ? '#14532d' : '#0f172a', color: ok ? '#86efac' : '#94a3b8' }}>
                  👍 OK / N-A
                </button>
                <button onClick={() => setResult(c.key, 'not_ok')}
                  style={{ flex: 1, padding: '11px', borderRadius: 8, fontSize: 14, fontWeight: 800, cursor: 'pointer',
                           border: '1px solid ' + (notOk ? '#dc2626' : '#334155'),
                           background: notOk ? '#7f1d1d' : '#0f172a', color: notOk ? '#fca5a5' : '#94a3b8' }}>
                  👎 Not OK
                </button>
              </div>
              {notOk && (
                <input style={{ ...S.input, marginTop: 10, borderColor: '#dc2626' }} value={it.notes}
                  onChange={e => setNote(c.key, e.target.value)} placeholder="What's wrong? (required-ish)" />
              )}
            </div>
          );
        })}

        <button style={{ ...S.btn, background: busy ? '#475569' : '#1d4ed8', color: '#fff' }} disabled={busy} onClick={submit}>
          {busy ? 'Submitting…' : '🚛 Submit inspection'}
        </button>
      </div>
    </div>
  );
}
