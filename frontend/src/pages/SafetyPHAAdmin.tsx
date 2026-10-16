/**
 * SafetyPHAAdmin — office log of Project Hazard Assessments. Login required.
 * Route: /ops/safety-pha
 *
 * Lists all PHAs, opens one for review/edit, and can create a new one.
 */
import { useEffect, useState } from 'react';
import { listPHA, type PHASummary } from '../lib/api';
import ProjectHazardAssessment from '../components/ProjectHazardAssessment';

function fmt(s: string | null): string {
  if (!s) return '—';
  try { return new Date(s.includes('T') ? s : s + 'Z').toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return s; }
}

export default function SafetyPHAAdmin() {
  const [rows, setRows] = useState<PHASummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | 'draft' | 'submitted'>('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true); setErr('');
    try { setRows(await listPHA(statusFilter ? { status: statusFilter } : undefined)); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [statusFilter]);

  // Detail / editor view
  if (openId != null || creating) {
    return (
      <div style={{ padding: '20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', maxWidth: 1000, margin: '0 auto' }}>
        <button onClick={() => { setOpenId(null); setCreating(false); load(); }}
          style={{ marginBottom: 16, padding: '8px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
          ← Back to PHA log
        </button>
        <ProjectHazardAssessment phaId={openId ?? undefined} onSaved={load} />
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>🦺 Project Hazard Assessments</h1>
          <button onClick={() => setCreating(true)}
            style={{ marginLeft: 'auto', padding: '9px 18px', borderRadius: 10, border: 'none', background: '#1A5376', color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
            + New PHA
          </button>
        </div>
        <p style={{ margin: '0 0 18px', color: '#6b7280', fontSize: 13 }}>
          Pre-mobilization hazard assessments. Completed from the field project "Safety" tab or here. Retain submitted PHAs for a minimum of 2 years.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {([['', 'All'], ['draft', 'Drafts'], ['submitted', 'Submitted']] as const).map(([v, lbl]) => (
            <button key={v} onClick={() => setStatusFilter(v)}
              style={{ padding: '7px 14px', borderRadius: 999, border: `1.5px solid ${statusFilter === v ? '#1A5376' : '#d1d5db'}`, background: statusFilter === v ? '#1A5376' : '#fff', color: statusFilter === v ? '#fff' : '#374151', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
              {lbl}
            </button>
          ))}
        </div>

        {loading && <div style={{ padding: 40, color: '#9ca3af' }}>Loading…</div>}
        {err && <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, color: '#991b1b' }}>{err}</div>}

        {!loading && !err && (
          rows.length === 0
            ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No assessments yet.</div>
            : (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      {['PHA #', 'Project', 'Site', 'Status', 'Hazards', 'Photos', 'Updated', ''].map((h, i) => (
                        <th key={i} style={{ padding: '9px 12px', textAlign: i >= 4 && i <= 5 ? 'center' : 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '2px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.id} style={{ background: i % 2 ? '#f9fafb' : '#fff', cursor: 'pointer' }} onClick={() => setOpenId(r.id)}>
                        <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 700, color: '#1A5376', whiteSpace: 'nowrap' }}>{r.pha_number || `#${r.id}`}</td>
                        <td style={{ padding: '10px 12px', fontSize: 13, color: '#111827' }}>{r.project_name || '—'}</td>
                        <td style={{ padding: '10px 12px', fontSize: 12, color: '#6b7280' }}>{r.site_address || '—'}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{ background: r.status === 'submitted' ? '#dcfce7' : '#fef3c7', color: r.status === 'submitted' ? '#15803d' : '#92400e', padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 800 }}>
                            {r.status === 'submitted' ? 'SUBMITTED' : 'DRAFT'}
                          </span>
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'center', fontSize: 13, color: r.hazard_count ? '#b91c1c' : '#9ca3af', fontWeight: r.hazard_count ? 700 : 400 }}>{r.hazard_count || '—'}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'center', fontSize: 13, color: '#6b7280' }}>{r.photo_count || '—'}</td>
                        <td style={{ padding: '10px 12px', fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmt(r.updated_at || r.created_at)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#9ca3af', fontSize: 16 }}>›</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>
    </div>
  );
}
