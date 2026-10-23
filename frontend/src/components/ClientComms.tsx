/**
 * ClientComms — the construction client-experience comms UI (Phase C).
 *   ClientCommsModal : per-job journey (which emails sent / next) + preview & send.
 *   CxSetupModal     : edit staff roles, survey/review links, and the templates.
 * Manual preview-and-send; emails go "as" the role's mailbox via the backend.
 */
import { useEffect, useState } from 'react';
import {
  getProjectCx, renderCxEmail, sendCxEmail, getCxSettings, saveCxSettings,
  listCxTemplates, updateCxTemplate, currentUser,
  type CxProject, type CxTemplate, type CxRender, type CxSettings,
} from '../lib/api';

const NAVY = '#1A5376';
function fmt(s: string | null | undefined): string {
  if (!s) return '';
  try { return new Date(s.includes('T') ? s : s + 'Z').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return s; }
}
const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, fontFamily: 'inherit' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 1250, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '24px 12px', overflowY: 'auto' };

// ── Per-job comms ─────────────────────────────────────────────────────────────
export function ClientCommsModal({ oppId, jobName, initialTemplateKey, onClose }: { oppId: number; jobName: string; initialTemplateKey?: string; onClose: () => void }) {
  const [data, setData] = useState<CxProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [compose, setCompose] = useState<CxRender | null>(null);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    setLoading(true);
    try {
      const d = await getProjectCx(oppId); setData(d);
      if (initialTemplateKey && !compose) {
        try { setCompose(await renderCxEmail(oppId, initialTemplateKey)); } catch { /* ignore */ }
      }
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [oppId]);

  async function openCompose(t: CxTemplate) {
    setErr(''); setMsg('');
    try { setCompose(await renderCxEmail(oppId, t.key)); } catch (e) { setErr((e as Error).message); }
  }

  async function doSend() {
    if (!compose) return;
    if (!compose.to.trim()) { setErr('Enter a recipient email.'); return; }
    setSending(true); setErr('');
    try {
      await sendCxEmail(oppId, {
        template_key: compose.template_key, subject: compose.subject, body: compose.body,
        to: compose.to, cc: compose.cc, from_email: compose.from_email, from_name: compose.from_name,
        from_role: compose.from_role, sent_by: currentUser()?.name,
      });
      setCompose(null); setMsg('✅ Sent'); await load();
      setTimeout(() => setMsg(''), 3000);
    } catch (e) { setErr((e as Error).message); } finally { setSending(false); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 640, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: '#0f172a' }}>✉️ Client comms <span style={{ color: '#9ca3af', fontWeight: 500 }}>· {jobName}</span></div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, color: '#6b7280', cursor: 'pointer' }}>×</button>
        </div>

        {loading ? <div style={{ padding: 30, color: '#9ca3af' }}>Loading…</div> : !data ? <div style={{ padding: 30, color: '#b91c1c' }}>{err || 'Could not load.'}</div> : (
          <div style={{ padding: 20 }}>
            {!compose ? (
              <>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
                  To: <b>{data.context.client_name || '—'}</b>{data.context.client_email ? ` · ${data.context.client_email}` : ' · (no client email found)'}
                  {data.context.window ? ` · scheduled ${data.context.window}` : ''}
                </div>
                {msg && <div style={{ fontSize: 13, color: '#15803d', fontWeight: 600, marginBottom: 10 }}>{msg}</div>}
                {err && <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 10 }}>{err}</div>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {data.templates.map(t => (
                    <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111827' }}>{t.title}{t.optional ? <span style={{ color: '#9ca3af', fontWeight: 500 }}> · optional</span> : ''}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>
                          from {t.from_role}{t.sent_count ? ` · sent ${t.sent_count}× · last ${fmt(t.last_sent_at)}` : ' · not sent'}
                        </div>
                      </div>
                      {t.sent_count ? <span style={{ fontSize: 11, fontWeight: 800, color: '#15803d', background: '#dcfce7', padding: '2px 8px', borderRadius: 10 }}>✓ Sent</span> : null}
                      <button onClick={() => openCompose(t)} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>
                        {t.sent_count ? 'Resend' : 'Compose'}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 12, color: '#6b7280' }}>From <b>{compose.from_name}</b> &lt;{compose.from_email}&gt;</div>
                <div><label style={lbl}>To</label><input style={inp} value={compose.to} onChange={e => setCompose({ ...compose, to: e.target.value })} /></div>
                <div><label style={lbl}>CC (optional)</label><input style={inp} value={compose.cc} onChange={e => setCompose({ ...compose, cc: e.target.value })} placeholder="name@darios.ca" /></div>
                <div><label style={lbl}>Subject</label><input style={inp} value={compose.subject} onChange={e => setCompose({ ...compose, subject: e.target.value })} /></div>
                <div><label style={lbl}>Message — review & fill any [bracketed] bits</label>
                  <textarea style={{ ...inp, minHeight: 240, resize: 'vertical', lineHeight: 1.5 }} value={compose.body} onChange={e => setCompose({ ...compose, body: e.target.value })} />
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>✍️ {compose.from_name}'s signature card is added automatically on send.</div></div>
                {err && <div style={{ fontSize: 13, color: '#b91c1c' }}>{err}</div>}
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => setCompose(null)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>← Back</button>
                  <button onClick={doSend} disabled={sending} style={{ padding: '9px 22px', borderRadius: 8, border: 'none', background: sending ? '#94a3b8' : '#16a34a', color: '#fff', fontWeight: 800, fontSize: 14, cursor: sending ? 'default' : 'pointer' }}>
                    {sending ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Setup: staff roles, links, and template editor ────────────────────────────
export function CxSetupModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<CxSettings | null>(null);
  const [tmpls, setTmpls] = useState<CxTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [openT, setOpenT] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try { const [cfg, ts] = await Promise.all([getCxSettings(), listCxTemplates()]); setS(cfg); setTmpls(ts); }
    catch { /* ignore */ } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function saveSettings() {
    if (!s) return; setSaving(true); setMsg('');
    try { await saveCxSettings(s); setMsg('✅ Saved'); setTimeout(() => setMsg(''), 2500); } catch { setMsg('❌ Could not save'); } finally { setSaving(false); }
  }
  async function saveTemplate(t: CxTemplate) {
    setSaving(true); setMsg('');
    try { await updateCxTemplate(t.id, { subject: t.subject, body: t.body, from_role: t.from_role, cc: t.cc }); setMsg('✅ Template saved'); setTimeout(() => setMsg(''), 2500); }
    catch { setMsg('❌ Could not save template'); } finally { setSaving(false); }
  }

  const ROLES: [string, string][] = [
    ['scheduler', 'Scheduler'], ['supervisor', 'Supervisor'], ['designer', 'Designer'], ['sales', 'Sales (default)'],
  ];
  const gv = (k: string) => (s ? ((s as unknown as Record<string, string>)[k] || '') : '');
  const sv = (k: string, v: string) => setS(prev => prev ? ({ ...prev, [k]: v } as CxSettings) : prev);

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 720, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: '#0f172a' }}>✉️ Client comms setup</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, color: '#6b7280', cursor: 'pointer' }}>×</button>
        </div>
        {loading || !s ? <div style={{ padding: 30, color: '#9ca3af' }}>Loading…</div> : (
          <div style={{ padding: 20 }}>
            <div style={{ fontWeight: 800, fontSize: 14, color: '#111827', marginBottom: 10 }}>Who sends each email (name, title, email, phones — used in the signature)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              {ROLES.map(([role, label]) => (
                <div key={role} style={{ border: '1px solid #f1f5f9', borderRadius: 8, padding: 10 }}>
                  <label style={lbl}>{label}</label>
                  <input style={{ ...inp, marginBottom: 5 }} value={gv(`${role}_name`)} placeholder="Name" onChange={e => sv(`${role}_name`, e.target.value)} />
                  <input style={{ ...inp, marginBottom: 5 }} value={gv(`${role}_title`)} placeholder="Title" onChange={e => sv(`${role}_title`, e.target.value)} />
                  <input style={{ ...inp, marginBottom: 5 }} value={gv(`${role}_email`)} placeholder="email@darios.ca" onChange={e => sv(`${role}_email`, e.target.value)} />
                  <div style={{ display: 'flex', gap: 5 }}>
                    <input style={inp} value={gv(`${role}_phone`)} placeholder="Direct phone" onChange={e => sv(`${role}_phone`, e.target.value)} />
                    <input style={inp} value={gv(`${role}_mobile`)} placeholder="Mobile" onChange={e => sv(`${role}_mobile`, e.target.value)} />
                  </div>
                </div>
              ))}
            </div>

            <div style={{ fontWeight: 800, fontSize: 14, color: '#111827', margin: '4px 0 10px', borderTop: '1px solid #f1f5f9', paddingTop: 14 }}>Signature card</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
              <div><label style={lbl}>Company name</label><input style={inp} value={s.company_name} onChange={e => setS({ ...s, company_name: e.target.value })} /></div>
              <div><label style={lbl}>Website</label><input style={inp} value={s.company_website} onChange={e => setS({ ...s, company_website: e.target.value })} /></div>
              <div><label style={lbl}>Logo URL (hosted, https)</label><input style={inp} value={s.company_logo_url} onChange={e => setS({ ...s, company_logo_url: e.target.value })} /></div>
              <div><label style={lbl}>Brand colour</label><input style={inp} value={s.brand_color} onChange={e => setS({ ...s, brand_color: e.target.value })} placeholder="#2f6b3f" /></div>
            </div>
            <div style={{ marginBottom: 8 }}><label style={lbl}>Confidentiality disclaimer (one line each)</label>
              <textarea style={{ ...inp, minHeight: 72, resize: 'vertical' }} value={s.email_disclaimer} onChange={e => setS({ ...s, email_disclaimer: e.target.value })} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
              <div><label style={lbl}>Fallback phone</label><input style={inp} value={s.company_phone} onChange={e => setS({ ...s, company_phone: e.target.value })} /></div>
              <div><label style={lbl}>Survey link</label><input style={inp} value={s.survey_link} onChange={e => setS({ ...s, survey_link: e.target.value })} /></div>
              <div><label style={lbl}>Google review link</label><input style={inp} value={s.review_link} onChange={e => setS({ ...s, review_link: e.target.value })} /></div>
            </div>
            <button onClick={saveSettings} disabled={saving} style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>Save setup</button>
            {msg && <span style={{ marginLeft: 12, fontSize: 13, fontWeight: 600, color: msg.startsWith('✅') ? '#15803d' : '#b91c1c' }}>{msg}</span>}

            <div style={{ fontWeight: 800, fontSize: 14, color: '#111827', margin: '20px 0 10px', borderTop: '1px solid #f1f5f9', paddingTop: 16 }}>Templates</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10 }}>Tokens like {'{{client_name}}'}, {'{{window}}'}, {'{{start_date}}'}, {'{{duration}}'}, {'{{survey_link}}'} auto-fill when you compose.</div>
            {tmpls.map((t, i) => (
              <div key={t.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 8, overflow: 'hidden' }}>
                <div onClick={() => setOpenT(openT === t.id ? null : t.id)} style={{ padding: '10px 12px', background: '#fafafa', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 13.5, color: '#111827', flex: 1 }}>{i + 1}. {t.title}</span>
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>from {t.from_role}</span>
                  <span style={{ color: '#6b7280' }}>{openT === t.id ? '▾' : '▸'}</span>
                </div>
                {openT === t.id && (
                  <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div><label style={lbl}>Subject</label><input style={inp} value={t.subject} onChange={e => setTmpls(tmpls.map(x => x.id === t.id ? { ...x, subject: e.target.value } : x))} /></div>
                    <div><label style={lbl}>Body</label><textarea style={{ ...inp, minHeight: 200, resize: 'vertical', lineHeight: 1.5 }} value={t.body || ''} onChange={e => setTmpls(tmpls.map(x => x.id === t.id ? { ...x, body: e.target.value } : x))} /></div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <label style={{ fontSize: 12, color: '#374151' }}>From&nbsp;
                        <select value={t.from_role} onChange={e => setTmpls(tmpls.map(x => x.id === t.id ? { ...x, from_role: e.target.value } : x))} style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db' }}>
                          {['sales', 'scheduler', 'designer', 'supervisor'].map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </label>
                      <button onClick={() => saveTemplate(t)} disabled={saving} style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Save template</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
