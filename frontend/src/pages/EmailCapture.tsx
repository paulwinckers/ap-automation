/**
 * EmailCapture — admin control for sales email auto-capture.
 * Workflow: set rep mailboxes → Sync contacts (build the matcher) → Dry run (review matches) → Enable.
 * Backed by /sales/email-capture/* (admin-only). Captured emails appear in Customer 360 + the worklist.
 */
import { useEffect, useState } from 'react';
import {
  getEmailCaptureSettings, updateEmailCaptureSettings, syncEmailCaptureContacts, runEmailCapture,
  EmailCaptureSettings, EmailCaptureReport,
} from '../lib/api';

const CARD: React.CSSProperties = { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 24, marginBottom: 20 };
const INPUT: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: '9px 12px', color: '#fff', fontSize: 14, outline: 'none' };
const BTN = (color: string, disabled = false): React.CSSProperties => ({ background: disabled ? '#1e293b' : color, color: disabled ? '#475569' : '#fff', border: 'none', borderRadius: 8, padding: '8px 15px', fontSize: 13, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' });
const LABEL: React.CSSProperties = { color: '#94a3b8', fontSize: 11, fontWeight: 700, marginBottom: 5 };

function Totals({ r }: { r: EmailCaptureReport }) {
  const t = r.totals;
  const cell = (n: number, label: string, color: string) => (
    <div style={{ textAlign: 'center', minWidth: 72 }}>
      <div style={{ color, fontSize: 22, fontWeight: 800 }}>{n}</div>
      <div style={{ color: '#64748b', fontSize: 11 }}>{label}</div>
    </div>
  );
  return (
    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', padding: '6px 0 12px' }}>
      {cell(t.scanned, 'scanned', '#cbd5e1')}
      {cell(t.matched, 'matched', '#93c5fd')}
      {cell(t.written, r.dry_run ? 'would write' : 'written', '#86efac')}
      {cell(t.skipped_dup, 'already had', '#fbbf24')}
      {cell(t.out_of_scope, 'out of scope', '#64748b')}
    </div>
  );
}

export default function EmailCapture() {
  const [data, setData] = useState<EmailCaptureSettings | null>(null);
  const [mailboxes, setMailboxes] = useState('');
  const [pollMin, setPollMin] = useState(10);
  const [backfill, setBackfill] = useState(30);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'' | 'save' | 'sync' | 'dry' | 'live'>('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [report, setReport] = useState<EmailCaptureReport | null>(null);

  async function load() {
    setLoading(true); setErr('');
    try {
      const d = await getEmailCaptureSettings();
      setData(d);
      setMailboxes((d.config.mailboxes || []).join('\n'));
      setPollMin(d.config.poll_minutes); setBackfill(d.config.backfill_days);
      setEnabled(d.config.enabled);
      setReport(d.last_report || null);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const parsedMailboxes = () => mailboxes.split(/[\n,]/).map(s => s.trim().toLowerCase()).filter(Boolean);

  async function save(nextEnabled?: boolean) {
    setBusy('save'); setErr(''); setNote('');
    try {
      const en = nextEnabled != null ? nextEnabled : enabled;
      const r = await updateEmailCaptureSettings({ mailboxes: parsedMailboxes(), poll_minutes: pollMin, backfill_days: backfill, enabled: en });
      setEnabled(r.config.enabled);
      setNote(en ? 'Saved — capture is ON. The poller will log matching emails automatically.' : 'Saved.');
      await load();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(''); }
  }
  async function sync() {
    setBusy('sync'); setErr(''); setNote('');
    try { const r = await syncEmailCaptureContacts(); setNote(`Matcher refreshed — ${r.emails} contact emails indexed.`); await load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(''); }
  }
  async function run(dry: boolean) {
    setBusy(dry ? 'dry' : 'live'); setErr(''); setNote('');
    try {
      const r = await runEmailCapture(dry, backfill);
      setReport(r);
      if (!r.ok) setErr(r.error || 'Nothing ran.');
      else setNote(dry ? 'Dry run complete — nothing was written.' : `Captured ${r.totals.written} email(s).`);
      if (!dry) await load();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(''); }
  }

  const mbxCount = parsedMailboxes().length;

  return (
    <div style={{ padding: 32, maxWidth: 860, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ color: '#fff', fontWeight: 700, fontSize: 22 }}>Sales Email Capture</div>
        <div style={{ color: '#64748b', fontSize: 13, marginTop: 4, maxWidth: 640 }}>
          Reads each rep's Inbox &amp; Sent Items (read-only), and logs any email to or from a known customer
          contact — tied to an open opportunity or recent lead — as a sales activity on that customer.
          It never marks, moves, or sends mail. Captured emails show up in Customer 360 and the worklist.
        </div>
      </div>

      {err && <div style={{ background: '#450a0a', border: '1px solid #991b1b', borderRadius: 8, padding: '10px 14px', color: '#fca5a5', fontSize: 13, marginBottom: 16 }}>{err}</div>}
      {note && <div style={{ background: '#052e16', border: '1px solid #166534', borderRadius: 8, padding: '10px 14px', color: '#86efac', fontSize: 13, marginBottom: 16 }}>{note}</div>}

      {loading ? <div style={{ color: '#64748b', padding: 40, textAlign: 'center' }}>Loading…</div> : (
        <>
          {/* Status strip */}
          <div style={{ ...CARD, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <div style={LABEL}>STATUS</div>
              <span style={{ background: enabled ? '#14532d' : '#334155', color: enabled ? '#86efac' : '#94a3b8', fontSize: 13, fontWeight: 700, padding: '3px 12px', borderRadius: 99 }}>
                {enabled ? '● Capturing' : '○ Off'}
              </span>
            </div>
            <div><div style={LABEL}>CONTACTS INDEXED</div><div style={{ color: '#e2e8f0', fontSize: 15, fontWeight: 600 }}>{data?.index_emails ?? 0}</div></div>
            <div><div style={LABEL}>MAILBOXES</div><div style={{ color: '#e2e8f0', fontSize: 15, fontWeight: 600 }}>{data?.config.mailboxes.length ?? 0}</div></div>
            <div><div style={LABEL}>LAST POLL</div><div style={{ color: '#e2e8f0', fontSize: 15, fontWeight: 600 }}>{data?.last_run ? new Date(data.last_run).toLocaleString() : '—'}</div></div>
          </div>

          {/* Config */}
          <div style={CARD}>
            <div style={{ color: '#fff', fontWeight: 600, fontSize: 15, marginBottom: 14 }}>Configuration</div>
            <div style={{ marginBottom: 14 }}>
              <div style={LABEL}>REP MAILBOXES (one per line)</div>
              <textarea value={mailboxes} onChange={e => setMailboxes(e.target.value)} rows={4}
                placeholder={'jane@darios.ca\nrob@darios.ca'} style={{ ...INPUT, resize: 'vertical', fontFamily: 'monospace' }} />
              <div style={{ color: '#64748b', fontSize: 11, marginTop: 4 }}>{mbxCount} mailbox{mbxCount === 1 ? '' : 'es'} · their Inbox + Sent Items are polled read-only.</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <label><div style={LABEL}>POLL EVERY (MINUTES)</div><input type="number" min={5} value={pollMin} onChange={e => setPollMin(+e.target.value)} style={INPUT} /></label>
              <label><div style={LABEL}>FIRST-RUN BACKFILL (DAYS)</div><input type="number" min={0} value={backfill} onChange={e => setBackfill(+e.target.value)} style={INPUT} /></label>
            </div>
            <button onClick={() => save()} disabled={busy === 'save'} style={BTN('#2563eb', busy === 'save')}>{busy === 'save' ? 'Saving…' : 'Save settings'}</button>
          </div>

          {/* Workflow */}
          <div style={CARD}>
            <div style={{ color: '#fff', fontWeight: 600, fontSize: 15, marginBottom: 6 }}>Set up &amp; test</div>
            <div style={{ color: '#64748b', fontSize: 12, marginBottom: 14 }}>1 · Sync the matcher from Aspire → 2 · Dry-run to review what would be logged → 3 · Enable.</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
              <button onClick={sync} disabled={busy === 'sync'} style={BTN('#334155', busy === 'sync')}>{busy === 'sync' ? 'Syncing…' : '1 · Sync contacts'}</button>
              <button onClick={() => run(true)} disabled={busy === 'dry' || mbxCount === 0} style={BTN('#4f46e5', busy === 'dry' || mbxCount === 0)}>{busy === 'dry' ? 'Running…' : '2 · Dry run'}</button>
              {enabled
                ? <button onClick={() => save(false)} disabled={busy === 'save'} style={BTN('#7f1d1d', busy === 'save')}>Turn capture OFF</button>
                : <button onClick={() => save(true)} disabled={busy === 'save' || mbxCount === 0} style={BTN('#16a34a', busy === 'save' || mbxCount === 0)}>3 · Enable capture</button>}
              <button onClick={() => run(false)} disabled={busy === 'live' || mbxCount === 0} style={BTN('#334155', busy === 'live' || mbxCount === 0)} title="Run one live pass now (e.g. to backfill)">{busy === 'live' ? 'Running…' : 'Run live now'}</button>
            </div>
          </div>

          {/* Report */}
          {report && (
            <div style={CARD}>
              <div style={{ color: '#fff', fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
                {report.dry_run ? 'Dry-run result' : 'Last run result'}
              </div>
              <Totals r={report} />
              {(report.mailboxes || []).map(m => (
                <div key={m.mailbox} style={{ borderTop: '1px solid #334155', paddingTop: 12, marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 14 }}>{m.mailbox}</span>
                    <span style={{ color: '#64748b', fontSize: 12 }}>
                      {m.scanned} scanned · {m.matched} matched · {m.written} {report.dry_run ? 'would log' : 'logged'}
                      {m.out_of_scope ? ` · ${m.out_of_scope} out of scope` : ''}{m.skipped_dup ? ` · ${m.skipped_dup} dup` : ''}
                    </span>
                  </div>
                  {m.error && <div style={{ color: '#fca5a5', fontSize: 12, marginTop: 4 }}>⚠ {m.error}</div>}
                  {m.samples?.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {m.samples.map((s, i) => (
                        <div key={i} style={{ fontSize: 12, color: '#94a3b8', display: 'flex', gap: 8 }}>
                          <span style={{ color: s.direction === 'out' ? '#60a5fa' : '#34d399', fontWeight: 700, minWidth: 30 }}>{s.direction === 'out' ? '→ out' : '← in'}</span>
                          <span style={{ color: '#cbd5e1' }}>{s.with}</span>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.subject}</span>
                          <span style={{ marginLeft: 'auto', color: '#475569' }}>{s.at}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
