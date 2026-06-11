/**
 * JobPrepChecklist.tsx — preparedness checklist for a construction job.
 * Shared by the planning board (ConstructionPlan) and the Construction Project page
 * (FieldProject). Items are a fixed set defined on the backend; this stores checked state
 * keyed by opportunity_id.
 */

import { useEffect, useState } from 'react';
import { getJobChecklist, toggleJobChecklist, type PrepItem } from '../lib/api';

function currentUserName(): string {
  try {
    const u = JSON.parse(localStorage.getItem('ap_user') || '{}');
    return u.name || '';
  } catch { return ''; }
}

interface Props {
  oppId:       number;
  onProgress?: (done: number, total: number) => void;  // notify parent on load/toggle
}

export default function JobPrepChecklist({ oppId, onProgress }: Props) {
  const [items,   setItems]   = useState<PrepItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy,    setBusy]    = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getJobChecklist(oppId)
      .then(d => {
        if (!active) return;
        setItems(d.items);
        onProgress?.(d.done, d.total);
      })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oppId]);

  async function toggle(item: PrepItem) {
    const next = !item.checked;
    setBusy(item.key);
    // optimistic update
    const optimistic = items.map(i => i.key === item.key ? { ...i, checked: next } : i);
    setItems(optimistic);
    onProgress?.(optimistic.filter(i => i.checked).length, optimistic.length);
    try {
      await toggleJobChecklist(oppId, item.key, next, currentUserName() || undefined);
    } catch {
      // revert on failure
      setItems(items);
      onProgress?.(items.filter(i => i.checked).length, items.length);
      alert('Could not update — please try again.');
    } finally {
      setBusy(null);
    }
  }

  const done  = items.filter(i => i.checked).length;
  const total = items.length;
  const ready = total > 0 && done === total;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 11, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          ✅ Preparedness
        </div>
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
          background: ready ? '#dcfce7' : '#fef3c7',
          color:      ready ? '#15803d' : '#92400e',
        }}>
          {ready ? 'Ready' : `${done}/${total}`}
        </span>
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: '#94a3b8', padding: '6px 0' }}>Loading checklist…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {items.map(it => (
            <label key={it.key} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 8,
              cursor: busy === it.key ? 'wait' : 'pointer',
              background: it.checked ? '#f0fdf4' : '#fff',
              border: '1px solid ' + (it.checked ? '#bbf7d0' : '#e2e8f0'),
            }}>
              <input
                type="checkbox"
                checked={it.checked}
                disabled={busy === it.key}
                onChange={() => toggle(it)}
                style={{ width: 16, height: 16, accentColor: '#16a34a', cursor: 'inherit' }}
              />
              <span style={{ fontSize: 13, color: it.checked ? '#166534' : '#334155', fontWeight: it.checked ? 600 : 400, flex: 1 }}>
                {it.label}
              </span>
              {it.checked && it.checked_by && (
                <span style={{ fontSize: 10, color: '#9ca3af' }}>{it.checked_by}</span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
