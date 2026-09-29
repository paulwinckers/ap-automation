/**
 * VehicleInspectionsAdmin — weekly vehicle inspection log. Login required.
 * Route: /ops/vehicle-inspections
 */
import { useState, useEffect, useCallback } from 'react';
import {
  listVehicleInspections, getVehicleInspection,
  type VehicleInspectionSummary, type VehicleInspectionDetail,
} from '../lib/api';

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

function DefectPill({ n }: { n: number }) {
  return n > 0
    ? <span style={{ padding: '2px 9px', borderRadius: 20, background: '#fef3c7', color: '#92400e', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>⚠️ {n} not OK</span>
    : <span style={{ padding: '2px 9px', borderRadius: 20, background: '#dcfce7', color: '#15803d', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>✓ All good</span>;
}

function InspectionModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [d, setD] = useState<VehicleInspectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { getVehicleInspection(id).then(setD).finally(() => setLoading(false)); }, [id]);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '32px 16px', zIndex: 1000, overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, maxWidth: 600, width: '100%', overflow: 'hidden' }}>
        <div style={{ background: '#1d4ed8', color: '#fff', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>🚛 Inspection #{id}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#bfdbfe', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ padding: '18px 20px' }}>
          {loading || !d ? <div style={{ color: '#9ca3af', padding: '20px 0' }}>Loading…</div> : (
            <>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 14 }}>
                {[['Vehicle', d.vehicle_number ? `#${d.vehicle_number}` : '—'], ['Odometer', d.odometer || '—'],
                  ['Completed by', d.completed_by], ['Date', fmtDate(d.inspection_date)]].map(([l, v]) => (
                  <div key={l as string}>
                    <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>{l}</div>
                    <div style={{ fontSize: 14, color: '#111827', fontWeight: 600 }}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginBottom: 12 }}><DefectPill n={d.defect_count} /></div>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                {d.items.map((it, i) => {
                  const notOk = it.result === 'not_ok';
                  const blank = !it.result;
                  return (
                    <div key={it.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 12px', borderTop: i ? '1px solid #f3f4f6' : 'none', background: notOk ? '#fef2f2' : '#fff' }}>
                      <span style={{ fontSize: 15, width: 20, textAlign: 'center' }}>{notOk ? '👎' : blank ? '▫️' : '👍'}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, color: notOk ? '#991b1b' : '#374151', fontWeight: notOk ? 700 : 500 }}>{it.label}</div>
                        {it.notes && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2, whiteSpace: 'pre-wrap' }}>{it.notes}</div>}
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: notOk ? '#dc2626' : blank ? '#9ca3af' : '#16a34a' }}>
                        {notOk ? 'NOT OK' : blank ? '—' : 'OK'}
                      </span>
                    </div>
                  );
                })}
              </div>
              {d.notes && <div style={{ marginTop: 12, fontSize: 13, color: '#374151' }}><b>Notes:</b> {d.notes}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function VehicleInspectionsAdmin() {
  const [rows, setRows] = useState<VehicleInspectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [onlyDefects, setOnlyDefects] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    listVehicleInspections({ only_defects: onlyDefects || undefined })
      .then(setRows).catch(() => setRows([])).finally(() => setLoading(false));
  }, [onlyDefects]);
  useEffect(() => { load(); }, [load]);

  const defectCount = rows.filter(r => r.defect_count > 0).length;

  return (
    <div style={{ padding: '24px 20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>🚛 Vehicle Inspections</h1>
          {defectCount > 0 && <span style={{ padding: '2px 9px', borderRadius: 20, background: '#fef3c7', color: '#92400e', fontSize: 12, fontWeight: 700 }}>{defectCount} with defects</span>}
        </div>
        <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: 13 }}>Weekly pre-use vehicle inspections. Click one to see the full checklist.</p>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyDefects} onChange={e => setOnlyDefects(e.target.checked)} />
          Only show inspections with defects
        </label>

        {loading ? (
          <div style={{ color: '#9ca3af', padding: '40px 0', textAlign: 'center' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: '40px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>
            No vehicle inspections{onlyDefects ? ' with defects' : ' yet'}.
          </div>
        ) : (
          <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            {rows.map((r, i) => (
              <div key={r.id} onClick={() => setOpenId(r.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', cursor: 'pointer', borderTop: i ? '1px solid #f3f4f6' : 'none' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
                onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                <span style={{ fontSize: 22 }}>{r.defect_count > 0 ? '🔧' : '🚛'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>
                    Vehicle {r.vehicle_number ? `#${r.vehicle_number}` : '(unspecified)'}
                    {r.odometer ? <span style={{ color: '#9ca3af', fontWeight: 400 }}> · {r.odometer} km</span> : null}
                  </div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{fmtDate(r.inspection_date)} · {r.completed_by}</div>
                </div>
                <DefectPill n={r.defect_count} />
                <span style={{ color: '#d1d5db', fontSize: 16 }}>›</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {openId !== null && <InspectionModal id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
