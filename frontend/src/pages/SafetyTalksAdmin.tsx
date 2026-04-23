/**
 * SafetyTalksAdmin.tsx — Office view of all safety talk records.
 * Route: /ops/safety-talks (login required)
 */

import { useState, useEffect } from 'react';
import { listSafetyTalks, getSafetyTalk, type SafetyTalkSummary, type SafetyTalkDetail } from '../lib/api';

function todayStr() { return new Date().toISOString().slice(0, 10); }
function monthAgoStr() {
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
}
function fmtDate(s: string) {
  if (!s) return '';
  try { return new Date(s + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return s; }
}

export default function SafetyTalksAdmin() {
  const [talks,      setTalks]      = useState<SafetyTalkSummary[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [startDate,  setStartDate]  = useState(monthAgoStr());
  const [endDate,    setEndDate]    = useState(todayStr());
  const [expanded,   setExpanded]   = useState<number | null>(null);
  const [detail,     setDetail]     = useState<SafetyTalkDetail | null>(null);
  const [detailLoad, setDetailLoad] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const data = await listSafetyTalks(startDate, endDate);
      setTalks(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function toggleExpand(id: number) {
    if (expanded === id) { setExpanded(null); setDetail(null); return; }
    setExpanded(id); setDetail(null); setDetailLoad(true);
    try {
      const d = await getSafetyTalk(id);
      setDetail(d);
    } catch { /* ignore */ }
    finally { setDetailLoad(false); }
  }

  // Totals
  const totalAttendees = talks.reduce((s, t) => s + t.attendee_count, 0);

  return (
    <div style={{ padding: '28px 32px', maxWidth: 900, fontFamily: 'system-ui, sans-serif' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: '#0f172a' }}>🦺 Safety Talks</h1>
          <div style={{ color: '#64748b', fontSize: 14, marginTop: 4 }}>Toolbox talk attendance records</div>
        </div>
        <a
          href="/field/safety"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '10px 18px', borderRadius: 10, textDecoration: 'none',
            background: '#16a34a', color: '#fff', fontWeight: 700, fontSize: 14,
          }}
        >
          + New Talk
        </a>
      </div>

      {/* Filters */}
      <div style={{
        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
        padding: '16px 20px', marginBottom: 24,
        display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap',
      }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>From</label>
          <input
            type="date" value={startDate}
            onChange={e => setStartDate(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>To</label>
          <input
            type="date" value={endDate}
            onChange={e => setEndDate(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
          />
        </div>
        <button
          onClick={load}
          style={{
            padding: '8px 20px', borderRadius: 8, border: 'none',
            background: '#0f172a', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer',
          }}
        >Search</button>
      </div>

      {/* Summary cards */}
      {!loading && talks.length > 0 && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          {[
            { label: 'Talks recorded', value: talks.length, icon: '📋' },
            { label: 'Total attendees', value: totalAttendees, icon: '👥' },
            { label: 'Avg attendance', value: talks.length ? Math.round(totalAttendees / talks.length) : 0, icon: '📊' },
          ].map(c => (
            <div key={c.label} style={{
              flex: 1, minWidth: 140,
              background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
              padding: '16px 20px',
            }}>
              <div style={{ fontSize: 22, marginBottom: 4 }}>{c.icon}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#0f172a' }}>{c.value}</div>
              <div style={{ fontSize: 12, color: '#64748b' }}>{c.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      {loading && (
        <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8', fontSize: 16 }}>Loading…</div>
      )}
      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', color: '#b91c1c', fontSize: 14 }}>
          ⚠️ {error}
        </div>
      )}
      {!loading && !error && talks.length === 0 && (
        <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🦺</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#64748b' }}>No safety talks found</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>Try a wider date range or record your first talk.</div>
        </div>
      )}

      {!loading && talks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {talks.map(talk => (
            <div key={talk.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>

              {/* Row */}
              <button
                onClick={() => toggleExpand(talk.id)}
                style={{
                  width: '100%', textAlign: 'left', background: 'none', border: 'none',
                  padding: '16px 20px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 16,
                }}
              >
                <div style={{
                  width: 44, height: 44, borderRadius: 10, background: '#f0fdf4',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 22, flexShrink: 0,
                }}>🦺</div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#0f172a', marginBottom: 2 }}>{talk.topic}</div>
                  <div style={{ fontSize: 13, color: '#64748b' }}>
                    {fmtDate(talk.talk_date)}
                    {talk.job_site && <span style={{ marginLeft: 8, color: '#94a3b8' }}>· {talk.job_site}</span>}
                  </div>
                </div>

                <div style={{ flexShrink: 0, textAlign: 'right' }}>
                  <div style={{
                    background: '#f0fdf4', color: '#16a34a', fontWeight: 700, fontSize: 13,
                    padding: '4px 10px', borderRadius: 20, display: 'inline-block', marginBottom: 4,
                  }}>
                    👥 {talk.attendee_count}
                  </div>
                  <div style={{ fontSize: 12, color: '#94a3b8' }}>{talk.presenter_name}</div>
                </div>

                <div style={{ color: '#94a3b8', fontSize: 16, flexShrink: 0 }}>
                  {expanded === talk.id ? '▲' : '▼'}
                </div>
              </button>

              {/* Expanded detail */}
              {expanded === talk.id && (
                <div style={{ borderTop: '1px solid #f1f5f9', padding: '16px 20px', background: '#f8fafc' }}>
                  {detailLoad && <div style={{ color: '#94a3b8', fontSize: 14 }}>Loading attendees…</div>}

                  {detail && detail.id === talk.id && (
                    <>
                      {detail.notes && (
                        <div style={{ marginBottom: 16 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 6 }}>KEY POINTS</div>
                          <div style={{ fontSize: 14, color: '#334155', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{detail.notes}</div>
                        </div>
                      )}

                      <div style={{ marginBottom: detail.photo_url ? 16 : 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8 }}>
                          ATTENDEES ({detail.attendees.length})
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {detail.attendees.map((name, i) => (
                            <span
                              key={i}
                              style={{
                                background: '#e0f2fe', color: '#075985', fontSize: 13, fontWeight: 600,
                                padding: '5px 12px', borderRadius: 20,
                              }}
                            >👤 {name}</span>
                          ))}
                        </div>
                      </div>

                      {detail.photo_url && (
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8 }}>GROUP PHOTO</div>
                          <a href={detail.photo_url} target="_blank" rel="noopener noreferrer">
                            <img
                              src={detail.photo_url}
                              alt="Group photo"
                              style={{
                                maxWidth: '100%', maxHeight: 320, borderRadius: 10,
                                objectFit: 'cover', display: 'block', cursor: 'pointer',
                              }}
                            />
                          </a>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
