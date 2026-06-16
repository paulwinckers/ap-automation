/**
 * JobPrepChecklist.tsx — preparedness checklist for a construction job.
 * Shared by the planning board (ConstructionPlan) and the Construction Project page
 * (FieldProject). Each item is a dropdown: N/A · Complete · Upload Doc.
 * "Upload Doc" stores the file in the job's shared Documents (job_attachments) and
 * links it to the item. N/A items are excluded from the readiness total.
 */

import { useEffect, useRef, useState } from 'react';
import {
  getJobChecklist, setChecklistStatus, uploadJobAttachment, API_BASE,
  type PrepItem, type PrepStatus,
} from '../lib/api';

function currentUserName(): string {
  try {
    const u = JSON.parse(localStorage.getItem('ap_user') || '{}');
    return u.name || '';
  } catch { return ''; }
}

interface Props {
  oppId:       number;
  onProgress?: (done: number, total: number) => void;  // notify parent on load/change
}

export default function JobPrepChecklist({ oppId, onProgress }: Props) {
  const [items,   setItems]   = useState<PrepItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy,    setBusy]    = useState<string | null>(null);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const pendingUploadKey = useRef<string | null>(null);

  function report(next: PrepItem[]) {
    const done  = next.filter(i => i.status === 'complete' || i.status === 'uploaded').length;
    const total = next.filter(i => i.status !== 'na').length;
    onProgress?.(done, total);
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    getJobChecklist(oppId)
      .then(d => { if (!active) return; setItems(d.items); onProgress?.(d.done, d.total); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oppId]);

  function applyLocal(key: string, patch: Partial<PrepItem>) {
    setItems(prev => {
      const next = prev.map(i => i.key === key ? { ...i, ...patch } : i);
      report(next);
      return next;
    });
  }

  async function chooseStatus(item: PrepItem, value: PrepStatus | 'upload') {
    if (value === 'upload') {
      // Open the file picker; the actual status change happens after upload succeeds.
      pendingUploadKey.current = item.key;
      fileRefs.current[item.key]?.click();
      return;
    }
    const prev = items;
    applyLocal(item.key, { status: value, attachment_id: value === 'uploaded' ? item.attachment_id : null });
    setBusy(item.key);
    try {
      await setChecklistStatus(oppId, item.key, value, null, currentUserName() || undefined);
    } catch {
      setItems(prev); report(prev);
      alert('Could not update — please try again.');
    } finally { setBusy(null); }
  }

  async function handleFile(item: PrepItem, file: File | null) {
    pendingUploadKey.current = null;
    if (!file) return;
    setBusy(item.key);
    try {
      const att = await uploadJobAttachment(oppId, file, `Prep: ${item.label}`);
      await setChecklistStatus(oppId, item.key, 'uploaded', att.id, currentUserName() || undefined);
      applyLocal(item.key, {
        status: 'uploaded', attachment_id: att.id, attachment_name: att.file_name,
        attachment_url: `/checkin/job-attachment/${att.id}/file`,
      });
    } catch {
      alert('Upload failed — please try again.');
    } finally { setBusy(null); }
  }

  const done  = items.filter(i => i.status === 'complete' || i.status === 'uploaded').length;
  const total = items.filter(i => i.status !== 'na').length;
  const ready = total > 0 && done === total;

  const selectVal = (s: PrepStatus) => (s === 'uploaded' ? 'upload' : s);

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {items.map(it => {
            const satisfied = it.status === 'complete' || it.status === 'uploaded';
            const na = it.status === 'na';
            return (
              <div key={it.key} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 8,
                background: satisfied ? '#f0fdf4' : na ? '#f8fafc' : '#fff',
                border: '1px solid ' + (satisfied ? '#bbf7d0' : '#e2e8f0'),
                opacity: na ? 0.7 : 1,
              }}>
                <span style={{ flex: 1, fontSize: 13, color: satisfied ? '#166534' : '#334155', fontWeight: satisfied ? 600 : 400 }}>
                  {it.label}
                </span>

                {/* Uploaded doc — view link */}
                {it.status === 'uploaded' && it.attachment_url && (
                  <a href={`${API_BASE}${it.attachment_url}`} target="_blank" rel="noopener noreferrer"
                    title={it.attachment_name || 'View document'}
                    style={{ fontSize: 11, color: '#2563eb', textDecoration: 'none', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    📄 {it.attachment_name || 'View'}
                  </a>
                )}

                <select
                  value={selectVal(it.status)}
                  disabled={busy === it.key}
                  onChange={e => chooseStatus(it, e.target.value as PrepStatus | 'upload')}
                  style={{
                    fontSize: 12, padding: '4px 6px', borderRadius: 6, fontFamily: 'inherit', cursor: 'pointer',
                    border: '1px solid ' + (satisfied ? '#86efac' : '#d1d5db'),
                    background: '#fff', color: '#374151', minWidth: 110,
                  }}
                >
                  <option value="">— set —</option>
                  <option value="na">N/A</option>
                  <option value="complete">Complete</option>
                  <option value="upload">{it.status === 'uploaded' ? 'Replace doc' : 'Upload Doc'}</option>
                </select>

                <input
                  ref={el => { fileRefs.current[it.key] = el; }}
                  type="file"
                  style={{ display: 'none' }}
                  onChange={e => handleFile(it, e.target.files?.[0] ?? null)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
