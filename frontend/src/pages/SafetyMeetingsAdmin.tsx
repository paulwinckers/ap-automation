/**
 * SafetyMeetingsAdmin — JHSC safety meeting log. Login required (operations).
 * Route: /ops/safety-meetings
 *
 * Create a meeting, pull in unresolved incidents for review, record discussion /
 * corrective actions / action items, then post the minutes to the field app.
 * Resolving an incident-review item flips the linked incident's own status.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  listSafetyMeetings, getSafetyMeeting, createSafetyMeeting, updateSafetyMeeting,
  deleteSafetyMeeting, addSafetyMeetingItem, updateSafetyMeetingItem, deleteSafetyMeetingItem,
  postSafetyMeeting, unpostSafetyMeeting, listOpenIncidentsForReview,
  loadAllOpenIncidents, recommendMeetingItem,
  type SafetyMeetingSummary, type SafetyMeetingDetail, type SafetyMeetingItem,
  type MeetingInput, type MeetingType, type OpenIncidentRow,
} from '../lib/api';

const TYPE_LABEL: Record<MeetingType, string> = {
  monthly: 'Monthly', quarterly: 'Quarterly', special: 'Special',
};
const SEV_COLOR: Record<string, string> = {
  minor: '#16a34a', moderate: '#d97706', serious: '#dc2626', critical: '#991b1b',
};
const ITEM_STATUS: Record<string, { label: string; bg: string; c: string }> = {
  open:        { label: 'Open',        bg: '#fef3c7', c: '#92400e' },
  in_progress: { label: 'In progress', bg: '#dbeafe', c: '#1e40af' },
  done:        { label: 'Done',        bg: '#dcfce7', c: '#15803d' },
};

function fmtDate(d?: string | null) {
  if (!d) return '';
  return new Date(d + (d.length <= 10 ? 'T00:00:00' : '')).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}
function today() { return new Date().toISOString().slice(0, 10); }
function currentUserName(): string {
  try { return JSON.parse(localStorage.getItem('ap_user') || '{}').name || ''; } catch { return ''; }
}

function Pill({ text, bg, c }: { text: string; bg: string; c: string }) {
  return <span style={{ padding: '2px 9px', borderRadius: 20, background: bg, color: c, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{text}</span>;
}

const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 14, color: '#111827' };
const lbl: React.CSSProperties = { fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, marginBottom: 4, display: 'block' };
const btn = (bg: string, c = '#fff'): React.CSSProperties => ({ padding: '9px 16px', borderRadius: 8, border: 'none', background: bg, color: c, fontWeight: 700, fontSize: 13, cursor: 'pointer' });

const MEETINGS_CACHE_KEY = 'ap_safety_meetings_cache';
function readMeetingsCache(): SafetyMeetingSummary[] {
  try { const c = localStorage.getItem(MEETINGS_CACHE_KEY); return c ? JSON.parse(c) : []; } catch { return []; }
}

export default function SafetyMeetingsAdmin() {
  // Stale-while-revalidate: paint the last-known list instantly, refresh in the background.
  // Keeps the page from blocking on Railway's cold start (~8s) on repeat visits.
  const [rows, setRows] = useState<SafetyMeetingSummary[]>(readMeetingsCache);
  const [loading, setLoading] = useState(rows.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(() => {
    setRefreshing(true);
    listSafetyMeetings()
      .then(r => { setRows(r); try { localStorage.setItem(MEETINGS_CACHE_KEY, JSON.stringify(r)); } catch { /* ignore */ } })
      .catch(() => { /* keep showing cached rows on failure */ })
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function newMeeting() {
    const r = await createSafetyMeeting({ meeting_date: today(), meeting_type: 'monthly', updated_by: currentUserName() || undefined });
    load();
    setOpenId(r.id);
  }

  if (openId !== null) {
    return <MeetingEditor id={openId} onBack={() => { setOpenId(null); load(); }} />;
  }

  return (
    <div style={{ padding: '24px 20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0f172a' }}>🪧 JHSC Safety Meetings</h1>
          <button onClick={newMeeting} style={btn('#111827')}>+ New meeting</button>
          {refreshing && rows.length > 0 && <span style={{ color: '#9ca3af', fontSize: 12 }}>refreshing…</span>}
        </div>
        <p style={{ margin: '0 0 18px', color: '#6b7280', fontSize: 13 }}>Record agenda & minutes, review open incidents, assign corrective actions, then post minutes to the field app.</p>

        {loading ? (
          <div style={{ color: '#9ca3af', padding: '40px 0', textAlign: 'center' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: '40px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>
            No meetings yet. Start one with <strong>+ New meeting</strong>.
          </div>
        ) : (
          <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            {rows.map((m, i) => (
              <div key={m.id} onClick={() => setOpenId(m.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', cursor: 'pointer', borderTop: i ? '1px solid #f3f4f6' : 'none' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
                onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>
                    {fmtDate(m.meeting_date)} <span style={{ color: '#9ca3af', fontWeight: 400 }}>· {TYPE_LABEL[m.meeting_type]}</span>
                  </div>
                  <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
                    {[m.location, m.chair && `Chair: ${m.chair}`, `${m.item_count || 0} item${m.item_count === 1 ? '' : 's'}`]
                      .filter(Boolean).join(' · ')}
                  </div>
                </div>
                {!!m.open_actions && m.open_actions > 0 && <Pill text={`${m.open_actions} open action${m.open_actions === 1 ? '' : 's'}`} bg="#fef3c7" c="#92400e" />}
                <Pill text={m.status === 'posted' ? 'POSTED' : 'DRAFT'} bg={m.status === 'posted' ? '#dcfce7' : '#f1f5f9'} c={m.status === 'posted' ? '#15803d' : '#475569'} />
                <span style={{ color: '#d1d5db', fontSize: 16 }}>›</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────────

function MeetingEditor({ id, onBack }: { id: number; onBack: () => void }) {
  const [m, setM] = useState<SafetyMeetingDetail | null>(null);
  const [openInc, setOpenInc] = useState<OpenIncidentRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [loadMsg, setLoadMsg] = useState<string | null>(null);

  // Refresh the meeting WITHOUT clobbering header fields the user may be mid-edit.
  // Item actions (status, recommend, add) call this; only the items + posted/status meta
  // are taken from the server, so unsaved Agenda/Minutes/Attendees text is preserved.
  const reload = useCallback(() => getSafetyMeeting(id).then(fresh => {
    setM(prev => prev
      ? { ...prev, items: fresh.items, status: fresh.status, posted_at: fresh.posted_at, posted_by: fresh.posted_by }
      : fresh);
  }), [id]);
  useEffect(() => { reload(); listOpenIncidentsForReview().then(setOpenInc).catch(() => setOpenInc([])); }, [id, reload]);

  function set<K extends keyof SafetyMeetingDetail>(k: K, v: SafetyMeetingDetail[K]) {
    setM(p => p ? { ...p, [k]: v } : p);
  }

  async function saveHeader() {
    if (!m) return;
    setSaving(true);
    try {
      const body: MeetingInput = {
        meeting_date: m.meeting_date, meeting_time: m.meeting_time || undefined, location: m.location || undefined,
        meeting_type: m.meeting_type, chair: m.chair || undefined, attendees: m.attendees || undefined,
        quorum_met: !!m.quorum_met, agenda: m.agenda || undefined, minutes: m.minutes || undefined,
        next_meeting: m.next_meeting || undefined, updated_by: currentUserName() || undefined,
      };
      const updated = await updateSafetyMeeting(id, body);
      setM(updated);
      setSavedAt(new Date().toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }));
    } finally { setSaving(false); }
  }

  async function addIncident(inc: OpenIncidentRow) {
    await addSafetyMeetingItem(id, {
      item_type: 'incident', incident_id: inc.id,
      title: `${inc.incident_type} — ${inc.location || 'Field'}`,
      status: 'open',
    });
    setPicker(false);
    reload();
  }
  async function addBlank(item_type: 'action' | 'topic') {
    await addSafetyMeetingItem(id, { item_type, status: 'open', title: item_type === 'action' ? '' : '' });
    reload();
  }
  async function loadAll() {
    setLoadingAll(true);
    setLoadMsg('Loading open incidents and drafting policy recommendations…');
    try {
      const r = await loadAllOpenIncidents(id, true);
      await reload();
      setLoadMsg(
        r.added === 0
          ? 'No new unresolved incidents to load.'
          : `Loaded ${r.added} incident${r.added === 1 ? '' : 's'} · ${r.recommendations} recommendation${r.recommendations === 1 ? '' : 's'} drafted${r.recommendation_errors ? ` · ${r.recommendation_errors} failed` : ''}.`
      );
    } catch {
      setLoadMsg('Could not load incidents. Please try again.');
    } finally {
      setLoadingAll(false);
    }
  }

  async function post() {
    if (!m) return;
    if (!(m.minutes || '').trim()) { alert('Add minutes before posting to the field app.'); return; }
    await saveHeader();
    await postSafetyMeeting(id, currentUserName() || undefined);
    reload();
  }
  async function unpost() { await unpostSafetyMeeting(id); reload(); }
  async function removeMeeting() {
    if (!confirm('Delete this meeting and all its items? This cannot be undone.')) return;
    await deleteSafetyMeeting(id);
    onBack();
  }

  if (!m) return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>;

  const posted = m.status === 'posted';
  const incidentItems = m.items.filter(i => i.item_type === 'incident');
  const actionItems = m.items.filter(i => i.item_type === 'action');
  const topicItems = m.items.filter(i => i.item_type === 'topic');
  const alreadyLinked = new Set(incidentItems.map(i => i.incident_id));
  const pickable = openInc.filter(i => !alreadyLinked.has(i.id));

  return (
    <div style={{ padding: '24px 20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: 14, cursor: 'pointer', padding: 0 }}>← All meetings</button>
          <div style={{ flex: 1 }} />
          <Pill text={posted ? 'POSTED' : 'DRAFT'} bg={posted ? '#dcfce7' : '#f1f5f9'} c={posted ? '#15803d' : '#475569'} />
        </div>

        {/* Header card */}
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: 18, marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <div><label style={lbl}>Date</label><input type="date" style={inp} value={m.meeting_date} onChange={e => set('meeting_date', e.target.value)} /></div>
            <div><label style={lbl}>Time</label><input style={inp} value={m.meeting_time || ''} placeholder="e.g. 8:00 AM" onChange={e => set('meeting_time', e.target.value)} /></div>
            <div><label style={lbl}>Type</label>
              <select style={inp} value={m.meeting_type} onChange={e => set('meeting_type', e.target.value as MeetingType)}>
                <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="special">Special</option>
              </select>
            </div>
            <div><label style={lbl}>Location</label><input style={inp} value={m.location || ''} placeholder="Shop / site" onChange={e => set('location', e.target.value)} /></div>
            <div><label style={lbl}>Chair</label><input style={inp} value={m.chair || ''} onChange={e => set('chair', e.target.value)} /></div>
            <div><label style={lbl}>Next meeting</label><input type="date" style={inp} value={m.next_meeting || ''} onChange={e => set('next_meeting', e.target.value)} /></div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={lbl}>Attendees</label>
            <textarea style={{ ...inp, minHeight: 56, resize: 'vertical' }} value={m.attendees || ''} placeholder="Names of everyone present — worker & employer reps" onChange={e => set('attendees', e.target.value)} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 14, color: '#374151', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!m.quorum_met} onChange={e => set('quorum_met', (e.target.checked ? 1 : 0) as any)} />
            Quorum met (worker + employer reps present)
          </label>
        </div>

        {/* Agenda + minutes */}
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: 18, marginBottom: 16 }}>
          <label style={lbl}>Agenda</label>
          <textarea style={{ ...inp, minHeight: 70, resize: 'vertical', marginBottom: 14 }} value={m.agenda || ''} placeholder="Standing items: review of previous minutes, incidents/near-misses, inspections, new business…" onChange={e => set('agenda', e.target.value)} />
          <label style={lbl}>Minutes</label>
          <textarea style={{ ...inp, minHeight: 140, resize: 'vertical' }} value={m.minutes || ''} placeholder="What was discussed and decided. This is what crews read on the field app." onChange={e => set('minutes', e.target.value)} />
        </div>

        {/* Incident reviews */}
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: 18, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a', flex: 1 }}>🚨 Incident review</div>
            <button onClick={loadAll} disabled={loadingAll || pickable.length === 0} title="Pull in every unresolved incident and draft a policy recommendation for each"
              style={{ ...btn(pickable.length === 0 ? '#e5e7eb' : '#1d4ed8', pickable.length === 0 ? '#9ca3af' : '#fff'), cursor: loadingAll || pickable.length === 0 ? 'default' : 'pointer' }}>
              {loadingAll ? '⏳ Working…' : `⚡ Load all open${pickable.length > 0 ? ` (${pickable.length})` : ''}`}
            </button>
            <button onClick={() => setPicker(true)} style={btn('#7f1d1d')}>+ Pull in one</button>
          </div>
          {loadMsg && <div style={{ fontSize: 13, color: loadingAll ? '#1d4ed8' : '#15803d', marginBottom: 12, background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '8px 12px' }}>{loadMsg}</div>}
          {incidentItems.length === 0 ? (
            <div style={{ color: '#9ca3af', fontSize: 13 }}>No incidents pulled in yet. {pickable.length > 0 ? `${pickable.length} unresolved incident${pickable.length === 1 ? '' : 's'} available — use ⚡ Load all to review them with recommendations.` : 'No unresolved incidents.'}</div>
          ) : incidentItems.map(it => <ItemRow key={it.id} it={it} onChanged={reload} />)}
        </div>

        {/* Action items */}
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: 18, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a', flex: 1 }}>✅ Action items</div>
            <button onClick={() => addBlank('action')} style={btn('#111827')}>+ Action item</button>
          </div>
          {actionItems.length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No action items yet.</div>
            : actionItems.map(it => <ItemRow key={it.id} it={it} onChanged={reload} />)}
        </div>

        {/* Other topics */}
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: 18, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a', flex: 1 }}>🗒️ Other topics</div>
            <button onClick={() => addBlank('topic')} style={btn('#111827')}>+ Topic</button>
          </div>
          {topicItems.length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No extra topics.</div>
            : topicItems.map(it => <ItemRow key={it.id} it={it} onChanged={reload} />)}
        </div>

        {/* Save / post bar */}
        <div style={{ position: 'sticky', bottom: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', boxShadow: '0 -4px 12px rgba(0,0,0,0.04)' }}>
          <button onClick={saveHeader} disabled={saving} style={btn('#e5e7eb', '#111827')}>{saving ? 'Saving…' : 'Save'}</button>
          {savedAt && <span style={{ color: '#9ca3af', fontSize: 12 }}>Saved {savedAt}</span>}
          <div style={{ flex: 1 }} />
          <button onClick={removeMeeting} style={{ ...btn('none', '#ef4444'), border: '1px solid #fecaca' }}>Delete</button>
          {posted
            ? <button onClick={unpost} style={{ ...btn('none', '#b45309'), border: '1px solid #fde68a' }}>Unpost</button>
            : <button onClick={post} style={btn('#15803d')}>Post to field app →</button>}
        </div>
        {posted && m.posted_at && <div style={{ textAlign: 'right', color: '#9ca3af', fontSize: 12, marginTop: 8 }}>Posted {fmtDate(m.posted_at.slice(0, 10))}{m.posted_by ? ` by ${m.posted_by}` : ''}</div>}
      </div>

      {picker && (
        <div onClick={() => setPicker(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', zIndex: 1000, overflowY: 'auto' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, maxWidth: 560, width: '100%', overflow: 'hidden' }}>
            <div style={{ background: '#7f1d1d', color: '#fff', padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 800 }}>Pull in an incident to review</div>
              <button onClick={() => setPicker(false)} style={{ background: 'none', border: 'none', color: '#fecaca', fontSize: 20, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ padding: 16, maxHeight: '60vh', overflowY: 'auto' }}>
              {pickable.length === 0 ? <div style={{ color: '#9ca3af', textAlign: 'center', padding: 24 }}>No unresolved incidents to review.</div>
                : pickable.map(inc => (
                  <div key={inc.id} onClick={() => addIncident(inc)}
                    style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '11px 13px', marginBottom: 8, cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center' }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                    <div style={{ width: 6, alignSelf: 'stretch', borderRadius: 3, background: SEV_COLOR[inc.severity] || '#9ca3af' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>{inc.location || 'Field'} · {inc.incident_type}</div>
                      <div style={{ fontSize: 13, color: '#4b5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inc.description}</div>
                      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{fmtDate(inc.incident_date)} · {inc.reporter_name} · {inc.status}</div>
                    </div>
                    <span style={{ color: '#2563eb', fontSize: 13, fontWeight: 700 }}>Add →</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Editable item row ────────────────────────────────────────────────────────────

function ItemRow({ it, onChanged }: { it: SafetyMeetingItem; onChanged: () => void }) {
  const [d, setD] = useState<SafetyMeetingItem>(it);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reccing, setReccing] = useState(false);
  const dRef = useRef(d);
  const dirtyRef = useRef(dirty);
  useEffect(() => { dRef.current = d; dirtyRef.current = dirty; });

  // Sync from the server copy WITHOUT discarding unsaved edits:
  //  - a different item now occupies this slot (id changed) → full reset
  //  - no unsaved edits → adopt the server copy (status, recommendation, corrective action…)
  //  - unsaved edits in progress → keep the user's text, but still pick up a recommendation
  //    generated out-of-band by "Suggest policy action" / "Load all".
  useEffect(() => {
    const cur = dRef.current;
    if (it.id !== cur.id) { setD(it); setDirty(false); return; }
    if (!dirtyRef.current) { setD(it); return; }
    if (it.recommendation !== cur.recommendation) setD(prev => ({ ...prev, recommendation: it.recommendation }));
  }, [it]);

  function upd<K extends keyof SafetyMeetingItem>(k: K, v: SafetyMeetingItem[K]) { setD(p => ({ ...p, [k]: v })); setDirty(true); }

  async function save(nextStatus?: SafetyMeetingItem['status']) {
    setSaving(true);
    try {
      const status = nextStatus || d.status;
      await updateSafetyMeetingItem(it.id, {
        item_type: d.item_type, incident_id: d.incident_id, title: d.title || undefined,
        discussion: d.discussion || undefined, corrective_action: d.corrective_action || undefined,
        recommendation: d.recommendation || undefined,
        assignee: d.assignee || undefined, due_date: d.due_date || undefined, status,
      });
      setDirty(false);
      onChanged();
    } finally { setSaving(false); }
  }
  async function recommend() {
    setReccing(true);
    try { const r = await recommendMeetingItem(it.id); setD(p => ({ ...p, recommendation: r.recommendation })); onChanged(); }
    catch { alert('Could not generate a recommendation right now.'); }
    finally { setReccing(false); }
  }
  async function remove() { if (confirm('Remove this item?')) { await deleteSafetyMeetingItem(it.id); onChanged(); } }

  const st = ITEM_STATUS[d.status] || ITEM_STATUS.open;
  const isIncident = d.item_type === 'incident';

  return (
    <div style={{ border: '1px solid #f3f4f6', borderRadius: 10, padding: 13, marginBottom: 10, background: '#fcfcfd' }}>
      {isIncident && (d.inc_date || d.inc_description) && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8, paddingBottom: 8, borderBottom: '1px dashed #e5e7eb' }}>
          <Pill text={(d.inc_severity || 'minor').toUpperCase()} bg={SEV_COLOR[d.inc_severity || 'minor'] || '#6b7280'} c="#fff" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>Incident #{d.incident_id} · {fmtDate(d.inc_date)} · {d.inc_location || 'Field'}</div>
            <div style={{ fontSize: 13, color: '#374151', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{d.inc_description}</div>
            {d.incident_id != null && (
              <a href={`/ops/safety-incidents?incident=${d.incident_id}`} target="_blank" rel="noopener noreferrer"
                 style={{ fontSize: 12, color: '#2563eb', fontWeight: 700, textDecoration: 'none', display: 'inline-block', marginTop: 4 }}>
                View full report ↗
              </a>
            )}
          </div>
        </div>
      )}
      {!isIncident && (
        <input style={{ ...inp, fontWeight: 700, marginBottom: 8 }} value={d.title || ''} placeholder={d.item_type === 'action' ? 'What needs doing' : 'Topic'} onChange={e => upd('title', e.target.value)} />
      )}
      <textarea style={{ ...inp, minHeight: 44, resize: 'vertical', marginBottom: 8 }} value={d.discussion || ''} placeholder="Discussion / notes" onChange={e => upd('discussion', e.target.value)} />
      {(isIncident || d.item_type === 'action') && (
        <textarea style={{ ...inp, minHeight: 40, resize: 'vertical', marginBottom: 8 }} value={d.corrective_action || ''} placeholder="Corrective action / resolution" onChange={e => upd('corrective_action', e.target.value)} />
      )}
      {isIncident && (
        <div style={{ marginBottom: 10, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: d.recommendation ? 6 : 0, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em', flex: 1 }}>💡 Policy recommendation</span>
            <button onClick={recommend} disabled={reccing} style={{ ...btn('#b45309'), padding: '6px 11px', fontSize: 12 }}>
              {reccing ? 'Thinking…' : d.recommendation ? 'Regenerate' : 'Suggest policy action'}
            </button>
          </div>
          {d.recommendation ? (
            <>
              <div style={{ fontSize: 13, color: '#78350f', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{d.recommendation}</div>
              <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                <button onClick={() => { upd('corrective_action', ((d.corrective_action ? d.corrective_action + '\n' : '') + d.recommendation)); }}
                  style={{ background: 'none', border: 'none', color: '#b45309', fontSize: 12, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                  Use as corrective action
                </button>
                <span style={{ fontSize: 11, color: '#a16207' }}>AI draft grounded in the safety library — review before adopting</span>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: '#a16207', marginTop: 4 }}>Cross-references this incident against the safety program and suggests a specific SWP/policy update for the committee.</div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <input style={{ ...inp, flex: 1, minWidth: 120 }} value={d.assignee || ''} placeholder="Assignee" onChange={e => upd('assignee', e.target.value)} />
        <input type="date" style={{ ...inp, flex: 1, minWidth: 120 }} value={d.due_date || ''} onChange={e => upd('due_date', e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {(['open', 'in_progress', 'done'] as const).map(s => (
          <button key={s} onClick={() => { upd('status', s); save(s); }} disabled={saving}
            style={{ padding: '6px 11px', borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                     border: '1px solid ' + (d.status === s ? ITEM_STATUS[s].c : '#e5e7eb'),
                     background: d.status === s ? ITEM_STATUS[s].bg : '#fff',
                     color: d.status === s ? ITEM_STATUS[s].c : '#6b7280' }}>
            {ITEM_STATUS[s].label}
          </button>
        ))}
        {isIncident && d.status === 'done' && <span style={{ fontSize: 11, color: '#15803d' }}>→ closes incident #{d.incident_id}</span>}
        {isIncident && d.status === 'in_progress' && <span style={{ fontSize: 11, color: '#1e40af' }}>→ marks incident reviewed</span>}
        <div style={{ flex: 1 }} />
        {dirty && <button onClick={() => save()} disabled={saving} style={btn('#2563eb')}>{saving ? 'Saving…' : 'Save'}</button>}
        <button onClick={remove} style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>Remove</button>
      </div>
      <div style={{ marginTop: 6 }}><Pill text={st.label} bg={st.bg} c={st.c} /></div>
    </div>
  );
}
