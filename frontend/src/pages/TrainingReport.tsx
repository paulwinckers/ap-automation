/**
 * TrainingReport — who has finished which course. HR area. Route: /ops/training
 * Lists everyone whose account has the Training area, plus anyone else who has started a course.
 * Data: GET /training/report (backend app/api/training.py).
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { getTrainingReport, type TrainingReport as Report } from '../lib/api';

const card: CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '16px 18px', marginBottom: 16 };
const th: CSSProperties = { textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
  letterSpacing: '0.04em', padding: '6px 8px', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '9px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 14, color: '#111827', verticalAlign: 'middle' };
const pill = (bg: string, fg: string): CSSProperties => ({ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: bg, color: fg, whiteSpace: 'nowrap' });

function day(ts: string | null) {
  if (!ts) return '';
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function TrainingReport() {
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => { getTrainingReport().then(setR).catch(e => setErr(String(e.message || e))); }, []);

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0, color: '#111827' }}>Training</h1>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>
            Who has finished each course. Everyone with the Training area is listed, plus anyone else who has started a course.
          </p>
        </div>
        <Link to="/training" style={{ fontSize: 14, fontWeight: 600, color: '#1f4d2b' }}>Open the courses →</Link>
      </div>

      {err && <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }}>Couldn't load the report: {err}</div>}
      {!r && !err && <div style={card}>Loading…</div>}

      {r && r.courses.map(c => {
        const rows = r.people.map(p => ({ p, s: p.courses[c.id] })).filter(x => x.s);
        const finished = rows.filter(x => x.s.finished_at).length;
        const started = rows.filter(x => !x.s.finished_at && x.s.done > 0).length;
        const notStarted = rows.length - finished - started;
        return (
          <div key={c.id} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 10 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{c.title} <span style={{ color: '#6b7280', fontWeight: 500, fontSize: 14 }}>· {c.modules} modules</span></h2>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span style={pill('#dcfce7', '#166534')}>{finished} finished</span>
                <span style={pill('#fef3c7', '#92400e')}>{started} in progress</span>
                <span style={pill('#f3f4f6', '#374151')}>{notStarted} not started</span>
              </div>
            </div>
            {rows.length === 0 ? (
              <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>
                No one yet. Give crew leads an account on the Users page with only the Training area ticked, and they'll appear here.
              </p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr><th style={th}>Person</th><th style={th}>Progress</th><th style={th}>Finished</th><th style={th}>Last activity</th></tr></thead>
                  <tbody>
                    {rows.sort((a, b) => (b.s.finished_at ? 1 : 0) - (a.s.finished_at ? 1 : 0) || b.s.done - a.s.done).map(({ p, s }) => (
                      <tr key={p.user_id}>
                        <td style={td}>
                          <div style={{ fontWeight: 600 }}>{p.name}</div>
                          <div style={{ fontSize: 12, color: '#6b7280' }}>{p.email}{p.training_only ? ' · Training-only account' : ''}</div>
                        </td>
                        <td style={{ ...td, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                          <span style={{ display: 'inline-block', width: 90, height: 6, borderRadius: 9, background: '#e5e7eb', verticalAlign: 'middle', marginRight: 8, overflow: 'hidden' }}>
                            <span style={{ display: 'block', height: '100%', width: `${(s.done / s.total) * 100}%`, background: '#1f4d2b' }} />
                          </span>
                          {s.done} of {s.total}
                        </td>
                        <td style={td}>{s.finished_at ? <span style={pill('#dcfce7', '#166534')}>✓ {day(s.finished_at)}</span> : <span style={{ color: '#9ca3af' }}>Not yet</span>}</td>
                        <td style={{ ...td, color: '#6b7280' }}>{day(s.last_at) || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
