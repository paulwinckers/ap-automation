/**
 * FieldSafetyMeetings — posted JHSC safety-meeting minutes, readable by crew.
 * Public, no login required. /field/safety-meetings
 */
import { useEffect, useState } from 'react';
import {
  listFieldSafetyMeetings, getFieldSafetyMeeting,
  type SafetyMeetingSummary, type SafetyMeetingDetail, type SafetyMeetingItem,
} from '../lib/api';

const BG = '#0f172a';
const CARD = '#1e293b';

const TYPE_LABEL: Record<string, string> = {
  monthly: 'Monthly meeting', quarterly: 'Quarterly meeting', special: 'Special meeting',
};
const ITEM_STATUS: Record<string, { label: string; bg: string; c: string }> = {
  open:        { label: 'Open',        bg: '#422006', c: '#fbbf24' },
  in_progress: { label: 'In progress', bg: '#1e3a5f', c: '#60a5fa' },
  done:        { label: 'Done',        bg: '#14321f', c: '#4ade80' },
};

function fmtDate(d?: string | null) {
  if (!d) return '';
  return new Date(d + (d.length <= 10 ? 'T00:00:00' : '')).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function FieldSafetyMeetings() {
  const [rows, setRows] = useState<SafetyMeetingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<SafetyMeetingDetail | null>(null);
  const [openLoading, setOpenLoading] = useState(false);

  useEffect(() => {
    listFieldSafetyMeetings()
      .then(setRows)
      .catch(() => setError('Could not load safety meetings. Please try again.'))
      .finally(() => setLoading(false));
  }, []);

  function openMeeting(id: number) {
    setOpenLoading(true);
    getFieldSafetyMeeting(id).then(setOpen).finally(() => setOpenLoading(false));
  }

  const wrap: React.CSSProperties = {
    minHeight: '100vh', background: BG,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', paddingBottom: 40,
  };

  // ── Reading view ──
  if (open) {
    const actions = open.items.filter(i => i.item_type === 'action');
    const reviewed = open.items.filter(i => i.item_type !== 'action');
    return (
      <div style={wrap}>
        <div style={{ background: CARD, padding: '16px 18px', position: 'sticky', top: 0, zIndex: 5, borderBottom: '1px solid #334155' }}>
          <button onClick={() => setOpen(null)}
            style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: 15, cursor: 'pointer', padding: 0, marginBottom: 6 }}>
            ← All meetings
          </button>
          <h1 style={{ margin: 0, color: '#fff', fontSize: 20, fontWeight: 800 }}>
            {TYPE_LABEL[open.meeting_type] || 'Safety meeting'} · {fmtDate(open.meeting_date)}
          </h1>
          <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>
            {[open.location, open.chair && `Chair: ${open.chair}`, open.posted_at && `Posted ${fmtDate(open.posted_at.slice(0, 10))}`]
              .filter(Boolean).join(' · ')}
          </div>
        </div>

        <div style={{ padding: '18px 16px 60px', maxWidth: 760, margin: '0 auto' }}>
          {open.attendees && (
            <Section title="Present">
              <div style={{ color: '#cbd5e1', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{open.attendees}</div>
            </Section>
          )}

          <Section title="Minutes">
            <div style={{ color: '#e2e8f0', fontSize: 15, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{open.minutes || '—'}</div>
          </Section>

          {reviewed.length > 0 && (
            <Section title="Incidents & topics reviewed">
              {reviewed.map(it => <ItemCard key={it.id} it={it} />)}
            </Section>
          )}

          {actions.length > 0 && (
            <Section title="Action items">
              {actions.map(it => <ItemCard key={it.id} it={it} />)}
            </Section>
          )}

          {open.next_meeting && (
            <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 20, textAlign: 'center' }}>
              Next meeting: <strong style={{ color: '#cbd5e1' }}>{fmtDate(open.next_meeting)}</strong>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Index ──
  return (
    <div style={wrap}>
      <div style={{ background: CARD, padding: '20px 18px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <a href="/crew" style={{ color: '#64748b', fontSize: 20, textDecoration: 'none' }}>←</a>
          <h1 style={{ margin: 0, color: '#fff', fontSize: 20, fontWeight: 800, flex: 1 }}>🪧 Safety Meetings</h1>
        </div>
        <p style={{ color: '#64748b', fontSize: 13, margin: '8px 0 0' }}>
          Joint Health &amp; Safety Committee minutes & action items.
        </p>
      </div>

      <div style={{ padding: '16px 16px 0', maxWidth: 760, margin: '0 auto' }}>
        {loading && <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>Loading…</div>}
        {error && <div style={{ color: '#ef4444', textAlign: 'center', padding: 40 }}>{error}</div>}
        {openLoading && <div style={{ color: '#64748b', textAlign: 'center', padding: 20 }}>Opening…</div>}
        {!loading && !error && rows.length === 0 && (
          <div style={{ color: '#64748b', textAlign: 'center', padding: 60 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🪧</div>No safety meetings posted yet.
          </div>
        )}
        {rows.map(m => (
          <div key={m.id} onClick={() => openMeeting(m.id)}
            style={{ background: CARD, borderRadius: 12, padding: '14px 16px', marginBottom: 10, border: '1px solid #334155', cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: '#f1f5f9', fontSize: 16, fontWeight: 800, flex: 1 }}>{fmtDate(m.meeting_date)}</span>
              <span style={{ background: '#0f172a', color: '#60a5fa', fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 5 }}>
                {(TYPE_LABEL[m.meeting_type] || 'Meeting').toUpperCase()}
              </span>
            </div>
            <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 4 }}>
              {[m.location, m.chair && `Chair: ${m.chair}`].filter(Boolean).join(' · ') || 'Tap to read minutes'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ color: '#64748b', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function ItemCard({ it }: { it: SafetyMeetingItem }) {
  const st = ITEM_STATUS[it.status] || ITEM_STATUS.open;
  return (
    <div style={{ background: CARD, borderRadius: 10, padding: '12px 14px', marginBottom: 8, border: '1px solid #334155' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, color: '#f1f5f9', fontSize: 14, fontWeight: 700 }}>
          {it.item_type === 'incident' && '🚨 '}
          {it.title || (it.item_type === 'incident' ? (it.inc_description || 'Incident review') : 'Item')}
        </div>
        <span style={{ background: st.bg, color: st.c, fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 20, whiteSpace: 'nowrap' }}>{st.label}</span>
      </div>
      {it.item_type === 'incident' && (it.inc_date || it.inc_location) && (
        <div style={{ color: '#64748b', fontSize: 12, marginTop: 3 }}>
          {[fmtDate(it.inc_date), it.inc_location, it.inc_severity].filter(Boolean).join(' · ')}
        </div>
      )}
      {it.discussion && <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.6, marginTop: 6, whiteSpace: 'pre-wrap' }}>{it.discussion}</div>}
      {it.corrective_action && (
        <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.6, marginTop: 6 }}>
          <span style={{ color: '#4ade80', fontWeight: 700 }}>Corrective action: </span>{it.corrective_action}
        </div>
      )}
      {(it.assignee || it.due_date) && (
        <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 6 }}>
          {it.assignee && <>👤 {it.assignee}</>}{it.assignee && it.due_date && '  ·  '}{it.due_date && <>📅 due {fmtDate(it.due_date)}</>}
        </div>
      )}
    </div>
  );
}
