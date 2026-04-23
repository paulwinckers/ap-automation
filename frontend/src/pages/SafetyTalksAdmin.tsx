/**
 * SafetyTalksAdmin.tsx — Office view of all safety talk records.
 * Route: /ops/safety-talks (login required)
 * Design mirrors the Activity Summary table style.
 */

import React, { useState, useEffect } from 'react';
import { listSafetyTalks, getSafetyTalk, type SafetyTalkSummary, type SafetyTalkDetail } from '../lib/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr() { return new Date().toISOString().slice(0, 10); }
function monthAgoStr() {
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
}
function fmtDate(s: string) {
  if (!s) return '—';
  try { return new Date(s + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return s; }
}

// ── Table primitives ──────────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc';

const TH: React.CSSProperties = {
  padding: '7px 10px', fontSize: 11, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: 0.4, color: '#6b7280',
  borderBottom: '2px solid #e5e7eb', background: '#f8fafc',
  whiteSpace: 'nowrap', userSelect: 'none', cursor: 'pointer', textAlign: 'left',
};

function SortTh({ children, field, sortField, sortDir, onSort, align = 'left' }: {
  children: React.ReactNode; field: string; sortField: string;
  sortDir: SortDir; onSort: (f: string) => void; align?: 'left' | 'right' | 'center';
}) {
  const active = sortField === field;
  return (
    <th onClick={() => onSort(field)} style={{ ...TH, textAlign: align, color: active ? '#2563eb' : '#6b7280' }}>
      {children}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

function Td({ children, align = 'left', style }: {
  children: React.ReactNode; align?: 'left' | 'right' | 'center'; style?: React.CSSProperties;
}) {
  return (
    <td style={{ padding: '6px 10px', fontSize: 12, verticalAlign: 'middle', textAlign: align, ...style }}>
      {children}
    </td>
  );
}

// ── Expanded detail row ───────────────────────────────────────────────────────

function DetailRow({ talkId, colSpan }: { talkId: number; colSpan: number }) {
  const [detail, setDetail] = useState<SafetyTalkDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSafetyTalk(talkId)
      .then(setDetail)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [talkId]);

  return (
    <tr style={{ background: '#eff6ff' }}>
      <td colSpan={colSpan} style={{ padding: '12px 20px' }}>
        {loading && <span style={{ color: '#94a3b8', fontSize: 12 }}>Loading…</span>}
        {detail && (
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            {/* Attendees */}
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                Attendees ({detail.attendees.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {detail.attendees.map((name, i) => (
                  <span key={i} style={{
                    background: '#dbeafe', color: '#1e40af', fontSize: 11, fontWeight: 600,
                    padding: '3px 9px', borderRadius: 20,
                  }}>
                    {name}
                  </span>
                ))}
              </div>
            </div>

            {/* Notes */}
            {detail.notes && (
              <div style={{ flex: 2, minWidth: 200 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                  Key Points
                </div>
                <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{detail.notes}</div>
              </div>
            )}

            {/* Photo */}
            {detail.photo_url && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                  Group Photo
                </div>
                <a href={detail.photo_url} target="_blank" rel="noopener noreferrer">
                  <img
                    src={detail.photo_url}
                    alt="Group photo"
                    style={{ height: 120, borderRadius: 8, objectFit: 'cover', display: 'block', cursor: 'pointer' }}
                  />
                </a>
              </div>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const SEL = (active: boolean): React.CSSProperties => ({
  fontSize: 12, padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
  border: `1px solid ${active ? '#2563eb' : '#e5e7eb'}`,
  background: active ? '#2563eb' : '#fff',
  color:      active ? '#fff'    : '#1f2937',
  fontWeight: active ? 700       : 400,
});

export default function SafetyTalksAdmin() {
  const [talks,     setTalks]     = useState<SafetyTalkSummary[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [startDate, setStartDate] = useState(monthAgoStr());
  const [endDate,   setEndDate]   = useState(todayStr());
  const [search,    setSearch]    = useState('');
  const [expanded,  setExpanded]  = useState<number | null>(null);

  // Sorting
  const [sortField, setSortField] = useState('talk_date');
  const [sortDir,   setSortDir]   = useState<SortDir>('desc');

  function onSort(field: string) {
    if (field === sortField) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  }

  async function load() {
    setLoading(true); setError(null);
    try { setTalks(await listSafetyTalks(startDate, endDate)); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  function toggleExpand(id: number) {
    setExpanded(e => e === id ? null : id);
  }

  // Filter + sort
  const searchLower = search.trim().toLowerCase();
  const visible = talks
    .filter(t =>
      !searchLower ||
      t.topic.toLowerCase().includes(searchLower) ||
      t.presenter_name.toLowerCase().includes(searchLower) ||
      (t.job_site ?? '').toLowerCase().includes(searchLower)
    )
    .sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sortField];
      const bv = (b as unknown as Record<string, unknown>)[sortField];
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''));
      return sortDir === 'asc' ? cmp : -cmp;
    });

  const totalAttendees = talks.reduce((s, t) => s + t.attendee_count, 0);
  const sp = { sortField, sortDir, onSort };
  const COL_COUNT = 7;

  return (
    <div style={{ background: '#f8fafc', minHeight: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>

      {/* Header */}
      <div style={{ padding: '20px 28px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827', letterSpacing: '-0.3px' }}>
            🦺 Safety Talks
          </h1>
          <a
            href="/field/safety"
            style={{
              fontSize: 13, fontWeight: 700, padding: '7px 16px', borderRadius: 8,
              background: '#16a34a', color: '#fff', textDecoration: 'none',
            }}
          >+ New Talk</a>
        </div>

        {/* Summary cards */}
        {!loading && talks.length > 0 && (
          <div style={{ display: 'flex', gap: 12, margin: '16px 0 0', flexWrap: 'wrap' }}>
            {[
              { label: 'Talks',          value: talks.length,                                             icon: '📋' },
              { label: 'Total attendees',value: totalAttendees,                                            icon: '👥' },
              { label: 'Avg attendance', value: talks.length ? Math.round(totalAttendees / talks.length) : 0, icon: '📊' },
            ].map(c => (
              <div key={c.label} style={{
                background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
                padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <span style={{ fontSize: 18 }}>{c.icon}</span>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: '#111827', lineHeight: 1 }}>{c.value}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{c.label}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sticky filter bar */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: '#f8fafc', borderBottom: '1px solid #e5e7eb',
        padding: '10px 28px',
        display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        marginTop: 16,
      }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>From</label>
        <input
          type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
          style={{ ...SEL(false), padding: '5px 8px' }}
        />
        <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>To</label>
        <input
          type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
          style={{ ...SEL(false), padding: '5px 8px' }}
        />
        <button onClick={load} style={{ ...SEL(true), padding: '5px 14px' }}>Search</button>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 14, color: '#9ca3af' }}>🔍</span>
          <input
            type="text" placeholder="Search…"
            value={search} onChange={e => setSearch(e.target.value)}
            style={{
              fontSize: 12, padding: '5px 10px', borderRadius: 6, outline: 'none', width: 160,
              border: `1px solid ${search ? '#2563eb' : '#e5e7eb'}`,
              background: search ? '#eff6ff' : '#fff', color: '#1f2937',
            }}
          />
          {search && (
            <button onClick={() => setSearch('')} style={{ fontSize: 11, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
          )}
          <span style={{ fontSize: 11, color: '#9ca3af' }}>{visible.length} showing</span>
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: '16px 28px 40px' }}>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60, flexDirection: 'column', gap: 12 }}>
            <div style={{ width: 28, height: 28, border: '3px solid #e2e8f0', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <span style={{ color: '#64748b', fontSize: 13 }}>Loading safety talks…</span>
          </div>
        )}

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '14px 18px', color: '#dc2626', fontWeight: 600 }}>
            {error}
          </div>
        )}

        {!loading && !error && talks.length === 0 && (
          <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>🦺</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#64748b' }}>No safety talks found</div>
            <div style={{ fontSize: 13, marginTop: 6 }}>Try a wider date range or record your first talk.</div>
          </div>
        )}

        {!loading && visible.length > 0 && (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <SortTh field="talk_date"      {...sp}>Date</SortTh>
                    <SortTh field="topic"          {...sp}>Topic</SortTh>
                    <SortTh field="presenter_name" {...sp}>Presenter</SortTh>
                    <SortTh field="job_site"       {...sp}>Property / Site</SortTh>
                    <SortTh field="attendee_count" align="center" {...sp}>Attendees</SortTh>
                    <th style={{ ...TH, cursor: 'default' }}>Notes</th>
                    <th style={{ ...TH, cursor: 'default' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((talk, i) => (
                    <React.Fragment key={talk.id}>
                      <tr
                        style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb', cursor: 'pointer' }}
                        onClick={() => toggleExpand(talk.id)}
                        onMouseEnter={e => (e.currentTarget.style.background = '#eff6ff')}
                        onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#f9fafb')}
                      >
                        <Td>
                          <span style={{ fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>
                            {fmtDate(talk.talk_date)}
                          </span>
                        </Td>
                        <Td>
                          <span style={{ fontWeight: 600, color: '#111827' }}>{talk.topic}</span>
                        </Td>
                        <Td>
                          <span style={{ color: '#374151' }}>{talk.presenter_name}</span>
                        </Td>
                        <Td>
                          {talk.job_site
                            ? <span style={{ color: '#374151' }}>{talk.job_site}</span>
                            : <span style={{ color: '#d1d5db' }}>—</span>}
                        </Td>
                        <Td align="center">
                          <span style={{
                            background: '#f0fdf4', color: '#16a34a', fontWeight: 700,
                            fontSize: 11, padding: '2px 9px', borderRadius: 20,
                            border: '1px solid #bbf7d0',
                          }}>
                            👥 {talk.attendee_count}
                          </span>
                        </Td>
                        <Td style={{ maxWidth: 240 }}>
                          {talk.notes
                            ? <span style={{ color: '#6b7280', fontSize: 11 }}>
                                {talk.notes.length > 60 ? talk.notes.slice(0, 60) + '…' : talk.notes}
                              </span>
                            : <span style={{ color: '#d1d5db' }}>—</span>}
                        </Td>
                        <Td align="center">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {talk.photo_url && <span title="Has photo" style={{ fontSize: 13 }}>📷</span>}
                            <span style={{ color: '#9ca3af', fontSize: 12 }}>
                              {expanded === talk.id ? '▲' : '▼'}
                            </span>
                          </div>
                        </Td>
                      </tr>

                      {expanded === talk.id && (
                        <DetailRow talkId={talk.id} colSpan={COL_COUNT} />
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ background: '#f8fafc', borderTop: '2px solid #e5e7eb' }}>
                    <td colSpan={COL_COUNT} style={{ padding: '6px 10px', fontSize: 11, color: '#6b7280', fontWeight: 600 }}>
                      {visible.length} talk{visible.length !== 1 ? 's' : ''} · {visible.reduce((s, t) => s + t.attendee_count, 0)} total attendees
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
