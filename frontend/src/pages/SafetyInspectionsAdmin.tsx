/**
 * SafetyInspectionsAdmin — view all site inspections and manage action items.
 * Login required. /ops/safety-inspections
 */
import { useState, useEffect } from 'react';
import {
  listInspections, listOpenActionItems, resolveActionItem, reopenActionItem,
  getInspection,
  type InspectionSummary, type InspectionDetail, type ActionItem,
} from '../lib/api';

const BASE_API = import.meta.env.VITE_API_URL || 'https://ap-automation-production.up.railway.app';

function resultBadge(r: 'pass' | 'conditional' | 'fail') {
  const map = {
    pass:        { color: '#22c55e', bg: '#14532d22', label: 'Pass' },
    conditional: { color: '#f59e0b', bg: '#451a0322', label: 'Conditional' },
    fail:        { color: '#ef4444', bg: '#7f1d1d22', label: 'Fail' },
  };
  const { color, bg, label } = map[r] ?? map.pass;
  return (
    <span style={{
      padding: '3px 10px', borderRadius: 20, border: `1px solid ${color}`,
      background: bg, color, fontWeight: 700, fontSize: 12,
    }}>
      {label}
    </span>
  );
}

function fmt(dt: string) {
  return new Date(dt).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDue(dt?: string | null) {
  if (!dt) return '—';
  const d   = new Date(dt + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - now.getTime()) / 86400000);
  const label = new Date(dt + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  if (diff < 0)   return <span style={{ color: '#ef4444', fontWeight: 700 }}>{label} (overdue)</span>;
  if (diff === 0) return <span style={{ color: '#f59e0b', fontWeight: 700 }}>Today</span>;
  if (diff <= 3)  return <span style={{ color: '#f59e0b' }}>{label}</span>;
  return <span>{label}</span>;
}

// ── Inspection detail modal ────────────────────────────────────────────────────
function InspectionModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [detail, setDetail] = useState<InspectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const [resolveNote, setResolveNote] = useState('');

  useEffect(() => {
    getInspection(id).then(setDetail).finally(() => setLoading(false));
  }, [id]);

  async function handleResolve(itemId: number) {
    setResolvingId(itemId);
    await resolveActionItem(itemId, resolveNote || undefined);
    setDetail(prev => prev ? {
      ...prev,
      action_items: prev.action_items.map(a =>
        a.id === itemId ? { ...a, status: 'resolved', resolved_notes: resolveNote || undefined } : a
      ),
    } : null);
    setResolvingId(null);
    setResolveNote('');
  }

  async function handleReopen(itemId: number) {
    await reopenActionItem(itemId);
    setDetail(prev => prev ? {
      ...prev,
      action_items: prev.action_items.map(a =>
        a.id === itemId ? { ...a, status: 'open', resolved_notes: undefined } : a
      ),
    } : null);
  }

  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
    zIndex: 1000, overflowY: 'auto', padding: '24px 16px',
  };
  const modal: React.CSSProperties = {
    background: '#1e293b', borderRadius: 16, maxWidth: 720,
    margin: '0 auto', padding: 24, border: '1px solid #334155',
  };

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={modal}>
        {loading && <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>Loading…</div>}
        {detail && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <div style={{ color: '#fff', fontSize: 20, fontWeight: 800, marginBottom: 4 }}>
                  {detail.site_name}
                </div>
                <div style={{ color: '#64748b', fontSize: 13 }}>
                  {fmt(detail.inspection_date)} · {detail.inspector_name}
                  {detail.crew_present?.length > 0 && ` · ${detail.crew_present.join(', ')}`}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {resultBadge(detail.overall_result)}
                <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 22, cursor: 'pointer', padding: 0 }}>×</button>
              </div>
            </div>

            {/* Notes */}
            {detail.notes && (
              <div style={{ background: '#0f172a', borderRadius: 10, padding: '12px 14px', marginBottom: 20 }}>
                <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' }}>Notes</div>
                <div style={{ color: '#e2e8f0', fontSize: 14 }}>{detail.notes}</div>
              </div>
            )}

            {/* Photo */}
            {detail.photo_r2_key && (
              <div style={{ marginBottom: 20 }}>
                <a href={`${BASE_API}/documents/proxy?key=${encodeURIComponent(detail.photo_r2_key)}`}
                  target="_blank" rel="noopener noreferrer"
                  style={{ color: '#3b82f6', fontSize: 13 }}>
                  📷 View site photo
                </a>
              </div>
            )}

            {/* Checklist */}
            {detail.checklist.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Checklist</div>
                {['PPE','Equipment','Housekeeping','Chemicals','First Aid','Traffic Control','Heat & Hydration','Vehicles'].map(cat => {
                  const items = detail.checklist.filter(c => c.category === cat);
                  if (!items.length) return null;
                  return (
                    <div key={cat} style={{ marginBottom: 12 }}>
                      <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>{cat}</div>
                      {items.map((c, i) => (
                        <div key={i} style={{
                          display: 'flex', gap: 10, alignItems: 'flex-start',
                          padding: '6px 0', borderBottom: '1px solid #1e293b',
                        }}>
                          <span style={{
                            color: c.result === 'pass' ? '#22c55e' : c.result === 'fail' ? '#ef4444' : '#475569',
                            fontWeight: 800, fontSize: 14, minWidth: 24, flexShrink: 0,
                          }}>
                            {c.result === 'pass' ? '✓' : c.result === 'fail' ? '✗' : '—'}
                          </span>
                          <div>
                            <div style={{ color: '#e2e8f0', fontSize: 13 }}>{c.item}</div>
                            {c.notes && <div style={{ color: '#f87171', fontSize: 12, marginTop: 2 }}>{c.notes}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Action items */}
            {detail.action_items.length > 0 && (
              <div>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Action Items</div>
                {detail.action_items.map(a => (
                  <div key={a.id} style={{
                    background: '#0f172a', borderRadius: 10, padding: '12px 14px', marginBottom: 10,
                    border: `1px solid ${a.status === 'resolved' ? '#1e3a2f' : '#334155'}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{
                          color: a.status === 'resolved' ? '#64748b' : '#f1f5f9',
                          fontSize: 14, fontWeight: 600,
                          textDecoration: a.status === 'resolved' ? 'line-through' : 'none',
                          marginBottom: 4,
                        }}>
                          {a.description}
                        </div>
                        <div style={{ color: '#475569', fontSize: 12 }}>
                          {a.assigned_to && <span>👤 {a.assigned_to} · </span>}
                          {a.due_date && <span>📅 {fmtDue(a.due_date)}</span>}
                        </div>
                        {a.status === 'resolved' && a.resolved_notes && (
                          <div style={{ color: '#22c55e', fontSize: 12, marginTop: 4 }}>
                            ✓ {a.resolved_notes}
                          </div>
                        )}
                      </div>
                      <div>
                        {a.status === 'open' ? (
                          <button
                            onClick={() => handleResolve(a.id!)}
                            style={{
                              padding: '6px 14px', borderRadius: 8, border: 'none',
                              background: '#14532d', color: '#22c55e', fontWeight: 700,
                              fontSize: 12, cursor: 'pointer',
                            }}
                          >
                            {resolvingId === a.id ? '…' : 'Resolve'}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleReopen(a.id!)}
                            style={{
                              padding: '6px 14px', borderRadius: 8, border: '1px solid #334155',
                              background: 'none', color: '#64748b', fontSize: 12, cursor: 'pointer',
                            }}
                          >
                            Reopen
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function SafetyInspectionsAdmin() {
  const [inspections, setInspections]   = useState<InspectionSummary[]>([]);
  const [openActions, setOpenActions]   = useState<ActionItem[]>([]);
  const [loading, setLoading]           = useState(true);
  const [tab, setTab]                   = useState<'inspections' | 'actions'>('inspections');
  const [selectedId, setSelectedId]     = useState<number | null>(null);
  const [resolvingId, setResolvingId]   = useState<number | null>(null);

  function load() {
    setLoading(true);
    Promise.all([listInspections(), listOpenActionItems()])
      .then(([ins, acts]) => { setInspections(ins); setOpenActions(acts); })
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleResolve(itemId: number) {
    setResolvingId(itemId);
    await resolveActionItem(itemId);
    setOpenActions(prev => prev.filter(a => a.id !== itemId));
    setResolvingId(null);
  }

  const h1: React.CSSProperties = { margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: '#0f172a' };
  const tabBtn = (key: typeof tab, label: string, count?: number) => (
    <button
      onClick={() => setTab(key)}
      style={{
        padding: '8px 18px', borderRadius: 8, border: 'none',
        background: tab === key ? '#1e293b' : 'transparent',
        color: tab === key ? '#fff' : '#64748b',
        fontWeight: 700, fontSize: 14, cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 6,
      }}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span style={{ background: '#ef4444', color: '#fff', fontSize: 11, fontWeight: 800, borderRadius: 20, padding: '1px 7px' }}>
          {count}
        </span>
      )}
    </button>
  );

  return (
    <div style={{ padding: '28px 32px', maxWidth: 900 }}>
      <h1 style={h1}>🔍 Site Inspections</h1>
      <p style={{ margin: '0 0 20px', color: '#64748b', fontSize: 14 }}>
        Review inspections and track open action items.
      </p>

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: 4, background: '#f1f5f9', borderRadius: 10,
        padding: 4, marginBottom: 24, width: 'fit-content',
      }}>
        {tabBtn('inspections', '📋 All Inspections')}
        {tabBtn('actions', '⚠️ Open Actions', openActions.length)}
      </div>

      {loading && <div style={{ color: '#94a3b8' }}>Loading…</div>}

      {/* ── Inspections tab ── */}
      {!loading && tab === 'inspections' && (
        <>
          <div style={{ marginBottom: 12, color: '#64748b', fontSize: 13 }}>
            {inspections.length} inspection{inspections.length !== 1 ? 's' : ''}
          </div>
          {inspections.length === 0 && (
            <div style={{ color: '#94a3b8', padding: 40, textAlign: 'center' }}>
              No inspections submitted yet.
            </div>
          )}
          {inspections.map(ins => (
            <div
              key={ins.id}
              onClick={() => setSelectedId(ins.id)}
              style={{
                background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
                padding: '14px 18px', marginBottom: 10, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 16,
                transition: 'box-shadow 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)')}
              onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 15 }}>{ins.site_name}</div>
                  {resultBadge(ins.overall_result)}
                </div>
                <div style={{ color: '#64748b', fontSize: 12 }}>
                  {fmt(ins.inspection_date)} · {ins.inspector_name}
                  {ins.fail_count > 0 && (
                    <span style={{ color: '#ef4444', fontWeight: 600 }}> · {ins.fail_count} flagged</span>
                  )}
                  {ins.open_actions > 0 && (
                    <span style={{ color: '#f59e0b', fontWeight: 600 }}> · {ins.open_actions} open action{ins.open_actions !== 1 ? 's' : ''}</span>
                  )}
                </div>
              </div>
              <span style={{ color: '#94a3b8', fontSize: 18 }}>›</span>
            </div>
          ))}
        </>
      )}

      {/* ── Open actions tab ── */}
      {!loading && tab === 'actions' && (
        <>
          <div style={{ marginBottom: 12, color: '#64748b', fontSize: 13 }}>
            {openActions.length} open action item{openActions.length !== 1 ? 's' : ''}
          </div>
          {openActions.length === 0 && (
            <div style={{ color: '#94a3b8', padding: 40, textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 10 }}>✅</div>
              All action items resolved!
            </div>
          )}
          {openActions.map(a => (
            <div key={a.id} style={{
              background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
              padding: '14px 18px', marginBottom: 10,
              display: 'flex', alignItems: 'center', gap: 14,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 14, marginBottom: 4 }}>
                  {a.description}
                </div>
                <div style={{ color: '#64748b', fontSize: 12 }}>
                  <span style={{ color: '#3b82f6', fontWeight: 600 }}>{a.site_name}</span>
                  {' · '}{a.inspection_date && fmt(a.inspection_date)}
                  {a.assigned_to && <span> · 👤 {a.assigned_to}</span>}
                  {a.due_date    && <span> · 📅 {fmtDue(a.due_date)}</span>}
                </div>
              </div>
              <button
                onClick={() => handleResolve(a.id!)}
                disabled={resolvingId === a.id}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: 'none',
                  background: '#14532d', color: '#22c55e', fontWeight: 700,
                  fontSize: 13, cursor: 'pointer', flexShrink: 0,
                }}
              >
                {resolvingId === a.id ? '…' : '✓ Resolve'}
              </button>
            </div>
          ))}
        </>
      )}

      {/* Detail modal */}
      {selectedId !== null && (
        <InspectionModal id={selectedId} onClose={() => { setSelectedId(null); load(); }} />
      )}
    </div>
  );
}
