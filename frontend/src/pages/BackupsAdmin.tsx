/**
 * BackupsAdmin — database backup status, schedule, and download. Login required.
 * Route: /ops/backups
 */
import { useEffect, useState } from 'react';
import {
  runBackup, listBackups, getBackupDownloadUrl, getBackupSettings, saveBackupSettings,
  type BackupFile, type BackupSettings,
} from '../lib/api';

const HOURS = Array.from({ length: 24 }, (_, h) => {
  const ampm = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
  return { value: h, label: `${String(h).padStart(2, '0')}:00 (${ampm})` };
});
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtTime(s: string | null): string {
  if (!s) return '—';
  try { return new Date(s).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return s; }
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '18px 20px', marginBottom: 16 };
const input: React.CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#111827', background: '#fff' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 };

export default function BackupsAdmin() {
  const [s, setS] = useState<BackupSettings | null>(null);
  const [files, setFiles] = useState<BackupFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [cfg, list] = await Promise.all([getBackupSettings(), listBackups()]);
      setS(cfg); setFiles(list);
    } catch (e) { setMsg(`❌ ${(e as Error).message}`); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  function upd(patch: Partial<BackupSettings>) { setS(prev => prev ? { ...prev, ...patch } : prev); }

  async function save() {
    if (!s) return;
    setSaving(true); setMsg('');
    try {
      const saved = await saveBackupSettings({
        enabled: s.enabled, hour: s.hour, retention: s.retention,
        weekly_email_to: s.weekly_email_to, weekly_email_day: s.weekly_email_day,
      });
      setS(prev => ({ ...saved, _latest: prev?._latest, _count: prev?._count }));
      setMsg('✅ Saved'); setTimeout(() => setMsg(''), 2500);
    } catch (e) { setMsg(`❌ ${(e as Error).message}`); }
    finally { setSaving(false); }
  }

  async function backupNow() {
    setRunning(true); setMsg('');
    try {
      const r = await runBackup();
      setMsg(`✅ Backup complete — ${r.table_count} tables, ${r.row_count.toLocaleString()} rows (${fmtBytes(r.bytes)})`);
      await load();
    } catch (e) { setMsg(`❌ ${(e as Error).message}`); }
    finally { setRunning(false); }
  }

  async function download(key: string) {
    try { const url = await getBackupDownloadUrl(key); window.open(url, '_blank'); }
    catch (e) { setMsg(`❌ ${(e as Error).message}`); }
  }

  if (loading) return <div style={{ padding: 40, color: '#9ca3af' }}>Loading…</div>;

  return (
    <div style={{ padding: '24px 20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: '#0f172a' }}>💾 Database Backups</h1>
        <p style={{ margin: '0 0 20px', color: '#6b7280', fontSize: 13 }}>
          Nightly snapshots of the entire database to secure storage (R2). Each snapshot is a compressed
          JSON dump of every table. Use these to restore after an accidental change or data loss.
        </p>

        {/* Status + run now */}
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 12, color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Latest backup</div>
              {s?._latest
                ? <div style={{ marginTop: 4 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{fmtTime(s._latest.last_modified)}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>{fmtBytes(s._latest.bytes)} · {s._count} snapshot{(s._count || 0) === 1 ? '' : 's'} retained</div>
                  </div>
                : <div style={{ marginTop: 4, fontSize: 14, color: '#b45309' }}>No backups yet — run one now.</div>}
            </div>
            <button onClick={backupNow} disabled={running}
              style={{ padding: '11px 20px', borderRadius: 10, border: 'none', background: running ? '#94a3b8' : '#0f172a', color: '#fff', fontWeight: 800, fontSize: 14, cursor: running ? 'default' : 'pointer' }}>
              {running ? 'Backing up…' : '⚡ Back up now'}
            </button>
          </div>
          {msg && <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600, color: msg.startsWith('✅') ? '#15803d' : '#b91c1c' }}>{msg}</div>}
        </div>

        {/* Schedule */}
        {s && (
          <div style={card}>
            <div style={{ fontWeight: 800, fontSize: 15, color: '#111827', marginBottom: 14 }}>Schedule</div>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#374151' }}>
                <input type="checkbox" checked={s.enabled} onChange={e => upd({ enabled: e.target.checked })} />
                Nightly backup enabled
              </label>
              <div>
                <label style={lbl}>Run at</label>
                <select style={input} value={s.hour} onChange={e => upd({ hour: Number(e.target.value) })}>
                  {HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
                </select>
                <span style={{ color: '#9ca3af', fontSize: 12, marginLeft: 6 }}>Pacific</span>
              </div>
              <div>
                <label style={lbl}>Keep last</label>
                <input type="number" min={1} max={365} style={{ ...input, width: 80 }} value={s.retention} onChange={e => upd({ retention: Number(e.target.value) })} />
                <span style={{ color: '#9ca3af', fontSize: 12, marginLeft: 6 }}>snapshots</span>
              </div>
            </div>

            <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 16, paddingTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>Weekly emailed copy (optional)</div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <label style={lbl}>Email to</label>
                  <input style={{ ...input, width: '100%', boxSizing: 'border-box' }} value={s.weekly_email_to}
                    onChange={e => upd({ weekly_email_to: e.target.value })} placeholder="name@darios.ca (blank = off)" />
                </div>
                <div>
                  <label style={lbl}>On</label>
                  <select style={input} value={s.weekly_email_day} onChange={e => upd({ weekly_email_day: Number(e.target.value) })}>
                    {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>Snapshots up to 15 MB attach to the email; larger ones link to this page instead.</div>
            </div>

            <div style={{ marginTop: 16 }}>
              <button onClick={save} disabled={saving}
                style={{ padding: '10px 20px', borderRadius: 10, border: 'none', background: saving ? '#94a3b8' : '#16a34a', color: '#fff', fontWeight: 800, fontSize: 14, cursor: saving ? 'default' : 'pointer' }}>
                {saving ? 'Saving…' : 'Save schedule'}
              </button>
            </div>
          </div>
        )}

        {/* Snapshot list */}
        <div style={card}>
          <div style={{ fontWeight: 800, fontSize: 15, color: '#111827', marginBottom: 12 }}>Snapshots</div>
          {files.length === 0
            ? <div style={{ color: '#9ca3af', fontSize: 14 }}>No snapshots stored yet.</div>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {files.map((f, i) => (
                    <tr key={f.key} style={{ borderTop: i ? '1px solid #f1f5f9' : 'none' }}>
                      <td style={{ padding: '9px 0', fontSize: 13, color: '#111827' }}>
                        {fmtTime(f.last_modified)}
                        <span style={{ color: '#9ca3af', fontSize: 12, marginLeft: 10 }}>{f.key.split('/').pop()}</span>
                      </td>
                      <td style={{ padding: '9px 0', fontSize: 12, color: '#6b7280', textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtBytes(f.bytes)}</td>
                      <td style={{ padding: '9px 0', textAlign: 'right', width: 100 }}>
                        <button onClick={() => download(f.key)} style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid #d1d5db', background: '#f9fafb', color: '#374151', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>Download</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      </div>
    </div>
  );
}
