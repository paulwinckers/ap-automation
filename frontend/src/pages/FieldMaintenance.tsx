/**
 * FieldMaintenance.tsx — Maintenance contract page for field crew.
 * Route: /field/maintenance/:oppId
 *
 * 4 tabs:
 *   Summary    — AI summary + service list
 *   History    — Completed tickets with visit notes + activities
 *   Upcoming   — Upcoming/active tickets
 *   Field Advisor — AI Q&A with optional photo
 */
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

const API = import.meta.env.VITE_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface VisitNote {
  note:           string;
  created_at:     string;
  created_by:     string;
  scheduled_date: string;
}

interface Ticket {
  WorkTicketID:         number;
  WorkTicketNumber:     string | number;
  ServiceName:          string;
  WorkTicketStatusName: string;
  ScheduledStartDate:   string;
  CompleteDate:         string;
  HoursEst:             number | null;
  HoursAct:             number | null;
  CrewLeaderName:       string | null;
  visit_notes:          VisitNote[];
}

interface ActivityComment {
  Comment:           string;
  CreatedDate:       string;
  CreatedByUserName: string;
}

interface Activity {
  ActivityID:           number;
  Subject:              string;
  ActivityType:         string;
  ActivityCategoryName: string;
  Status:               string;
  CreatedDate:          string;
  CompleteDate:         string;
  CreatedByUserName:    string;
  IsMileStone:          boolean;
  comments:             ActivityComment[];
}

interface Service {
  name:      string;
  frequency: string;
  price:     number | null;
  notes:     string;
}

interface AdvisorLogEntry {
  id:           number;
  question:     string;
  answer:       string;
  has_photo:    number;
  photo_r2_key: string | null;
  asked_at:     string;
}

interface ConstructionProject {
  opp_id: number;
  name:   string;
  status: string;
  start:  string;
  end:    string;
}

interface PageData {
  opportunity_id:        number;
  opportunity_name:      string;
  property_name:         string;
  division:              string;
  status:                string;
  hrs_est:               number | null;
  hrs_act:               number | null;
  ai_summary:            string;
  services:              Service[];
  completed_tickets:     Ticket[];
  upcoming_tickets:      Ticket[];
  activities:            Activity[];
  advisor_log:           AdvisorLogEntry[];
  construction_projects: ConstructionProject[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string | null | undefined) {
  if (!d) return '—';
  try {
    return new Date(d + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return d; }
}

function fmtDateTime(d: string | null | undefined) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return d; }
}

function compressImage(f: File, maxPx = 1920, quality = 0.82): Promise<File> {
  return new Promise(resolve => {
    if (f.type.startsWith('video/') || f.size < 1.5 * 1024 * 1024) { resolve(f); return; }
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxPx || height > maxPx) {
        if (width > height) { height = Math.round(height * maxPx / width); width = maxPx; }
        else { width = Math.round(width * maxPx / height); height = maxPx; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => {
        if (blob) resolve(new File([blob], f.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
        else resolve(f);
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(f); };
    img.src = url;
  });
}

/** Strip script/style tags and on* handlers, leave everything else intact. */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\s+on\w+="[^"]*"/gi, '')
    .replace(/\s+on\w+='[^']*'/gi, '');
}

/** Render a note field that may be plain text or Aspire HTML. */
function NoteBody({ text }: { text: string }) {
  const isHtml = /<[a-z][\s\S]*>/i.test(text);
  if (isHtml) {
    return (
      <div
        style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(text) }}
      />
    );
  }
  return <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>{text}</div>;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function HoursBar({ est, act, color = '#0369a1' }: { est: number | null; act: number | null; color?: string }) {
  const e = est ?? 0;
  const a = act ?? 0;
  const pct = e > 0 ? Math.min((a / e) * 100, 100) : 0;
  const over = e > 0 && a > e;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280', marginBottom: 3 }}>
        <span>{a.toFixed(1)}h actual</span>
        <span>{e.toFixed(1)}h est</span>
      </div>
      <div style={{ height: 4, background: '#e5e7eb', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: over ? '#ef4444' : color, borderRadius: 2, transition: 'width .3s' }} />
      </div>
    </div>
  );
}

function BulletText({ text }: { text: string }) {
  const lines = text.split('\n').filter(l => l.trim());
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {lines.map((line, i) => (
        <div key={i} style={{ fontSize: 14, color: '#1e293b', lineHeight: 1.5, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <span style={{ flexShrink: 0, marginTop: 1 }}>
            {line.startsWith('•') ? '' : '•'}
          </span>
          <span>{line.replace(/^[•\-\*]\s*/, '')}</span>
        </div>
      ))}
    </div>
  );
}

function TicketCard({ ticket, showNotes }: { ticket: Ticket; showNotes: boolean }) {
  const [open, setOpen] = useState(false);
  const est = ticket.HoursEst ?? 0;
  const act = ticket.HoursAct ?? 0;
  const over = est > 0 && act > est;
  const status = (ticket.WorkTicketStatusName || '').toLowerCase();
  const isComplete = status.includes('complete');
  const hasNotes = ticket.visit_notes && ticket.visit_notes.length > 0;

  const badgeBg   = isComplete ? '#f0fdf4' : '#eff6ff';
  const badgeText = isComplete ? '#15803d' : '#1d4ed8';

  return (
    <div style={S.ticketCard}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>
            {ticket.ServiceName || `#${ticket.WorkTicketNumber}`}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
            {isComplete && ticket.CompleteDate
              ? `Completed ${fmtDate(ticket.CompleteDate)}`
              : fmtDate(ticket.ScheduledStartDate)
            }
            {ticket.CrewLeaderName && ` · ${ticket.CrewLeaderName}`}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {over && <span style={{ fontSize: 12, color: '#ef4444', fontWeight: 700 }}>⚠ Over</span>}
          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: badgeBg, color: badgeText }}>
            {ticket.WorkTicketStatusName}
          </span>
        </div>
      </div>

      <HoursBar est={ticket.HoursEst} act={ticket.HoursAct} />

      {showNotes && hasNotes && (
        <>
          <button
            onClick={() => setOpen(v => !v)}
            style={{ marginTop: 8, background: 'none', border: 'none', padding: 0, fontSize: 12, color: '#0369a1', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}
          >
            {open ? '▲ Hide visit notes' : `▼ ${ticket.visit_notes.length} visit note${ticket.visit_notes.length !== 1 ? 's' : ''}`}
          </button>
          {open && (
            <div style={{ marginTop: 8, borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
              {ticket.visit_notes.map((vn, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 3 }}>
                    {vn.created_by} · {fmtDateTime(vn.created_at) || fmtDate(vn.scheduled_date)}
                  </div>
                  <div style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 10px' }}>
                    <NoteBody text={vn.note} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CollapsibleGroup({ label, count, icon, children }: { label: string; count: number; icon: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 10 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: '#fff', border: '1px solid #e2e6ed', borderRadius: open ? '10px 10px 0 0' : 10,
          padding: '11px 14px', cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>
          {icon} {label}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, background: '#f3f4f6', color: '#6b7280', borderRadius: 20, padding: '2px 8px' }}>{count}</span>
          <span style={{ fontSize: 13, color: '#9ca3af' }}>{open ? '▲' : '▼'}</span>
        </div>
      </button>
      {open && (
        <div style={{ border: '1px solid #e2e6ed', borderTop: 'none', borderRadius: '0 0 10px 10px', padding: '10px 10px 4px', background: '#fafafa' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function ActivityCard({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const hasComments = activity.comments && activity.comments.length > 0;
  const isMilestone = activity.IsMileStone;

  return (
    <div style={{ ...S.actCard, borderLeft: isMilestone ? '3px solid #0369a1' : '3px solid #e2e6ed' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>
            {isMilestone ? '🔵 ' : ''}{activity.Subject || activity.ActivityType || 'Activity'}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
            {activity.CreatedByUserName} · {fmtDate(activity.CreatedDate)}
            {activity.ActivityCategoryName ? ` · ${activity.ActivityCategoryName}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, marginLeft: 8, flexShrink: 0 }}>
          {activity.ActivityType && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#1d4ed8', background: '#eff6ff', borderRadius: 20, padding: '2px 7px', whiteSpace: 'nowrap' }}>
              {activity.ActivityType}
            </span>
          )}
          {activity.Status && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', background: '#f3f4f6', borderRadius: 20, padding: '2px 7px', whiteSpace: 'nowrap' }}>
              {activity.Status}
            </span>
          )}
        </div>
      </div>

      {hasComments && (
        <>
          <button
            onClick={() => setOpen(v => !v)}
            style={{ marginTop: 6, background: 'none', border: 'none', padding: 0, fontSize: 11, color: '#0369a1', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}
          >
            {open ? '▲ Hide comments' : `▼ ${activity.comments.length} comment${activity.comments.length !== 1 ? 's' : ''}`}
          </button>
          {open && (
            <div style={{ marginTop: 8, borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
              {activity.comments.map((c, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>
                    {c.CreatedByUserName} · {fmtDate(c.CreatedDate)}
                  </div>
                  <div style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 10px' }}>
                    <NoteBody text={c.Comment} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'summary' | 'history' | 'upcoming' | 'advisor';

export default function FieldMaintenance() {
  const { oppId } = useParams<{ oppId: string }>();
  const opp_id = Number(oppId);

  const [data, setData]     = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);
  const [tab, setTab]       = useState<Tab>('summary');

  // Field Advisor state
  const [question, setQuestion]         = useState('');
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const [answer, setAnswer]             = useState('');
  const [advisorError, setAdvisorError] = useState('');
  const [saveStatus, setSaveStatus]     = useState<'idle' | 'saving' | 'saved'>('idle');
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [pendingR2Key, setPendingR2Key] = useState<string | null>(null);
  const [pendingHasPhoto, setPendingHasPhoto] = useState(0);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [advisorLog, setAdvisorLog]     = useState<AdvisorLogEntry[]>([]);

  const cameraRef  = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`${API}/field/maintenance/${opp_id}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d: PageData) => { setData(d); setAdvisorLog(d.advisor_log || []); })
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [opp_id]);

  async function handlePhotoSelect(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    const compressed = await compressImage(file);
    setPendingPhoto(compressed);
    const url = URL.createObjectURL(compressed);
    setPhotoPreview(url);
  }

  async function askAdvisor() {
    if (!question.trim()) return;
    setAdvisorLoading(true);
    setAnswer('');
    setAdvisorError('');
    setSaveStatus('idle');
    setPendingR2Key(null);
    setPendingHasPhoto(0);

    try {
      const form = new FormData();
      form.append('question', question.trim());
      if (pendingPhoto) form.append('photo', pendingPhoto);

      const res = await fetch(`${API}/field/maintenance/${opp_id}/field-advisor`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setAnswer(d.answer || 'No answer received.');
      setPendingR2Key(d.photo_r2_key || null);
      setPendingHasPhoto(d.has_photo || 0);
    } catch (e) {
      setAdvisorError((e as Error).message || 'Could not reach the advisor. Try again.');
    } finally {
      setAdvisorLoading(false);
    }
  }

  async function saveAdvisorAnswer() {
    if (!answer) return;
    setSaveStatus('saving');
    try {
      const form = new FormData();
      form.append('question', question.trim());
      form.append('answer', answer);
      form.append('has_photo', String(pendingHasPhoto));
      if (pendingR2Key) form.append('photo_r2_key', pendingR2Key);

      const res = await fetch(`${API}/field/maintenance/${opp_id}/field-advisor/save`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = await res.json();
      if (saved.saved) {
        setSaveStatus('saved');
        setAdvisorLog(prev => [{
          id:           saved.log_id,
          question:     question.trim(),
          answer,
          has_photo:    pendingHasPhoto,
          photo_r2_key: pendingR2Key,
          asked_at:     new Date().toISOString(),
        }, ...prev]);
        // Reset after save
        setTimeout(() => {
          setQuestion('');
          setAnswer('');
          setPendingPhoto(null);
          setPendingR2Key(null);
          setPendingHasPhoto(0);
          setPhotoPreview(null);
          setSaveStatus('idle');
        }, 1500);
      }
    } catch (e) {
      setAdvisorError((e as Error).message || 'Save failed.');
      setSaveStatus('idle');
    }
  }

  if (loading) {
    return (
      <div style={S.phone}>
        <div style={{ ...S.header, background: '#0f4c75' }}>
          <div style={S.headerTop}>
            <a href="/field/maintenance" style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, textDecoration: 'none', background: 'rgba(255,255,255,0.15)', borderRadius: 20, padding: '5px 12px' }}>← Contracts</a>
          </div>
          <div style={S.hsub}>Loading…</div>
        </div>
        <div style={{ textAlign: 'center', padding: '40px 20px', color: '#6b7280' }}>Loading contract data…</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={S.phone}>
        <div style={{ ...S.header, background: '#0f4c75' }}>
          <div style={S.headerTop}>
            <a href="/field/maintenance" style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, textDecoration: 'none', background: 'rgba(255,255,255,0.15)', borderRadius: 20, padding: '5px 12px' }}>← Contracts</a>
          </div>
          <div style={S.hsub}>Error</div>
        </div>
        <div style={{ padding: 20, color: '#dc2626', fontSize: 14 }}>{error || 'Failed to load data.'}</div>
      </div>
    );
  }

  const displayTitle = data.property_name || data.opportunity_name;
  const totalEst = data.hrs_est ?? 0;
  const totalAct = data.hrs_act ?? 0;
  const pct = totalEst > 0 ? Math.round((totalAct / totalEst) * 100) : 0;

  return (
    <div style={S.phone}>
      {/* Header */}
      <div style={{ ...S.header, background: '#0f4c75' }}>
        <div style={S.headerTop}>
          <a href="/field/maintenance" style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, textDecoration: 'none', background: 'rgba(255,255,255,0.15)', borderRadius: 20, padding: '5px 12px' }}>
            ← Contracts
          </a>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', background: 'rgba(255,255,255,0.1)', borderRadius: 20, padding: '4px 10px' }}>
            {data.status || 'Active'}
          </span>
        </div>
        <div style={S.hsub}>{displayTitle}</div>
        {data.property_name && data.opportunity_name !== data.property_name && (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{data.opportunity_name}</div>
        )}
        {data.division && (
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>{data.division}</div>
        )}
        {/* Hours summary bar */}
        <div style={{ marginTop: 10, background: 'rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>
            <span>{totalAct.toFixed(1)}h used · {pct}% of budget</span>
            <span>{totalEst.toFixed(1)}h est</span>
          </div>
          <div style={{ height: 5, background: 'rgba(255,255,255,0.2)', borderRadius: 3 }}>
            <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: pct > 100 ? '#fca5a5' : '#7dd3fc', borderRadius: 3 }} />
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={S.tabBar}>
        {(['summary', 'history', 'upcoming', 'advisor'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              ...S.tabBtn,
              color:       tab === t ? '#0369a1' : '#6b7280',
              borderBottom: tab === t ? '2px solid #0369a1' : '2px solid transparent',
              fontWeight:  tab === t ? 700 : 400,
            }}
          >
            {t === 'summary' ? 'Summary' : t === 'history' ? 'History' : t === 'upcoming' ? 'Upcoming' : '🤖 Advisor'}
          </button>
        ))}
      </div>

      <div style={S.content}>

        {/* ── SUMMARY TAB ── */}
        {tab === 'summary' && (
          <div>
            {/* AI Summary */}
            {data.ai_summary && (
              <div style={S.section}>
                <div style={S.sectionTitle}>📋 Agreement Summary</div>
                <BulletText text={data.ai_summary} />
              </div>
            )}

            {/* Services */}
            {data.services.length > 0 && (() => {
              // Ticket counts per service (excluding disposal)
              const svcCounts = new Map<string, { done: number; total: number }>();
              for (const t of [...data.completed_tickets, ...data.upcoming_tickets]) {
                if ((t.ServiceName || '').toLowerCase().includes('disposal')) continue;
                const key = t.ServiceName || '';
                if (!svcCounts.has(key)) svcCounts.set(key, { done: 0, total: 0 });
                const e = svcCounts.get(key)!;
                e.total++;
                if ((t.WorkTicketStatusName || '').toLowerCase().includes('complete')) e.done++;
              }
              return (
                <div style={S.section}>
                  <div style={S.sectionTitle}>🌿 Services Included</div>
                  {data.services.map((svc, i) => {
                    const c = svcCounts.get(svc.name);
                    const allDone = c && c.total > 0 && c.done === c.total;
                    return (
                      <div key={i} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: i < data.services.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', flex: 1 }}>{svc.name}</div>
                          {c && c.total > 0 && (
                            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: allDone ? '#f0fdf4' : '#eff6ff', color: allDone ? '#15803d' : '#1d4ed8', flexShrink: 0 }}>
                              {c.done}/{c.total}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 12, marginTop: 3, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' }}>
                          {svc.frequency && <span>🔄 {svc.frequency}</span>}
                          {svc.price && <span>💰 ${Number(svc.price).toLocaleString('en-CA', { minimumFractionDigits: 2 })}</span>}
                        </div>
                        {svc.notes && (
                          <div style={{ marginTop: 4, fontSize: 12, color: '#374151', background: '#f8fafc', borderRadius: 6, padding: '6px 8px' }}>
                            {svc.notes}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* Quick stats */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
              <div style={{ background: '#eff6ff', borderRadius: 10, padding: '12px 14px', textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#1d4ed8' }}>{data.completed_tickets.length}</div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Tickets Completed</div>
              </div>
              <div style={{ background: '#f0fdf4', borderRadius: 10, padding: '12px 14px', textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#15803d' }}>{data.upcoming_tickets.length}</div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Tickets Upcoming</div>
              </div>
            </div>
          </div>
        )}

        {/* ── HISTORY TAB ── */}
        {tab === 'history' && (() => {
          const doneTickets = data.completed_tickets.filter(
            t => !(t.ServiceName || '').toLowerCase().includes('disposal')
          );
          // Group by service name
          const groups = new Map<string, Ticket[]>();
          for (const t of doneTickets) {
            const key = t.ServiceName || '(No Service)';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(t);
          }
          const hasTickets = groups.size > 0;
          const filteredActivities = data.activities.filter(a => {
            const type = (a.ActivityType || '').toLowerCase();
            const subj = (a.Subject || '').toLowerCase();
            return !type.includes('time adjustment') && !subj.includes('time adjustment');
          });
          const hasActivities = filteredActivities.length > 0;

          return (
            <div>
              {!hasTickets && !hasActivities && (
                <div style={S.empty}>No completed tickets or activities yet.</div>
              )}

              {hasTickets && Array.from(groups.entries()).map(([svcName, grpTickets]) => (
                <CollapsibleGroup key={svcName} label={svcName} count={grpTickets.length} icon="✅">
                  {grpTickets.map(t => (
                    <TicketCard key={t.WorkTicketID} ticket={t} showNotes={true} />
                  ))}
                </CollapsibleGroup>
              ))}

              {hasActivities && (
                <div style={{ marginTop: hasTickets ? 4 : 0 }}>
                  <CollapsibleGroup label="Activities & Notes" count={filteredActivities.length} icon="🗓">
                    {filteredActivities.map(a => (
                      <ActivityCard key={a.ActivityID} activity={a} />
                    ))}
                  </CollapsibleGroup>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── UPCOMING TAB ── */}
        {tab === 'upcoming' && (() => {
          const upcomingTickets = data.upcoming_tickets.filter(
            t => !(t.ServiceName || '').toLowerCase().includes('disposal')
          );
          // Group by service name
          const groups = new Map<string, Ticket[]>();
          for (const t of upcomingTickets) {
            const key = t.ServiceName || '(No Service)';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(t);
          }

          const projects = data.construction_projects || [];

          return (
            <div>
              {groups.size === 0 && projects.length === 0 && (
                <div style={S.empty}>No upcoming tickets — all work is complete.</div>
              )}

              {groups.size > 0 && Array.from(groups.entries()).map(([svcName, grpTickets]) => (
                <CollapsibleGroup key={svcName} label={svcName} count={grpTickets.length} icon="📅">
                  {grpTickets.map(t => (
                    <TicketCard key={t.WorkTicketID} ticket={t} showNotes={false} />
                  ))}
                </CollapsibleGroup>
              ))}

              {projects.length > 0 && (
                <div style={{ marginTop: groups.size > 0 ? 8 : 0 }}>
                  <div style={S.groupLabel}>🏗️ Construction Projects at this Property</div>
                  {projects.map(p => (
                    <a
                      key={p.opp_id}
                      href={`/field/project/${p.opp_id}`}
                      style={{ textDecoration: 'none' }}
                    >
                      <div style={{
                        background: '#fff', border: '1px solid #e2e6ed', borderRadius: 10,
                        padding: '12px 14px', marginBottom: 8,
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{p.name}</div>
                          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                            {p.start && p.end ? `${fmtDate(p.start)} → ${fmtDate(p.end)}` : p.start ? `Starts ${fmtDate(p.start)}` : 'Construction'}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, background: '#fef3c7', color: '#92400e', borderRadius: 20, padding: '2px 8px' }}>
                            {p.status}
                          </span>
                          <span style={{ color: '#9ca3af', fontSize: 16 }}>›</span>
                        </div>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* ── FIELD ADVISOR TAB ── */}
        {tab === 'advisor' && (
          <div>
            {/* Ask form */}
            <div style={S.section}>
              <div style={S.sectionTitle}>🤖 Ask the Field Advisor</div>
              <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
                Describe your question or site issue. Optionally attach a photo for visual advice.
              </p>

              <textarea
                value={question}
                onChange={e => setQuestion(e.target.value)}
                placeholder="e.g. Turf is yellowing in one section — what's causing it?"
                rows={4}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '10px 12px', border: '1.5px solid #d1d5db', borderRadius: 8,
                  fontSize: 14, color: '#1a1d23', background: '#fff',
                  fontFamily: 'inherit', resize: 'vertical', outline: 'none',
                }}
              />

              {/* Photo preview */}
              {photoPreview && (
                <div style={{ marginTop: 8, position: 'relative', display: 'inline-block' }}>
                  <img src={photoPreview} alt="Preview" style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 8, border: '1px solid #e2e6ed' }} />
                  <button
                    onClick={() => { setPendingPhoto(null); setPhotoPreview(null); }}
                    style={{ position: 'absolute', top: -6, right: -6, background: '#ef4444', color: '#fff', border: 'none', borderRadius: '50%', width: 20, height: 20, fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >×</button>
                </div>
              )}

              {/* Photo buttons */}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={() => cameraRef.current?.click()} style={S.photoBtn}>📷 Camera</button>
                <button onClick={() => galleryRef.current?.click()} style={S.photoBtn}>🖼 Gallery</button>
                <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => handlePhotoSelect(e.target.files)} />
                <input ref={galleryRef} type="file" accept="image/*,video/*" style={{ display: 'none' }} onChange={e => handlePhotoSelect(e.target.files)} />
              </div>

              <button
                onClick={askAdvisor}
                disabled={advisorLoading || !question.trim()}
                style={{
                  marginTop: 12, width: '100%', padding: '13px 0',
                  background: advisorLoading || !question.trim() ? '#e5e7eb' : '#0f4c75',
                  color: advisorLoading || !question.trim() ? '#9ca3af' : '#fff',
                  border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700,
                  cursor: advisorLoading || !question.trim() ? 'default' : 'pointer',
                  fontFamily: 'inherit', transition: 'background .2s',
                }}
              >
                {advisorLoading ? 'Consulting advisor…' : 'Ask Advisor →'}
              </button>
            </div>

            {/* Answer */}
            {answer && (
              <div style={{ ...S.section, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  🤖 Advisor Response
                </div>
                <div style={{ fontSize: 14, color: '#1e293b', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                  {answer}
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                  <button
                    onClick={saveAdvisorAnswer}
                    disabled={saveStatus !== 'idle'}
                    style={{
                      flex: 1, padding: '10px 0',
                      background: saveStatus === 'saved' ? '#16a34a' : saveStatus === 'saving' ? '#e5e7eb' : '#0f4c75',
                      color: saveStatus === 'saving' ? '#9ca3af' : '#fff',
                      border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700,
                      cursor: saveStatus === 'idle' ? 'pointer' : 'default', fontFamily: 'inherit',
                    }}
                  >
                    {saveStatus === 'saved' ? '✓ Saved' : saveStatus === 'saving' ? 'Saving…' : 'Save to Record'}
                  </button>
                  <button
                    onClick={() => { setAnswer(''); setQuestion(''); setPendingPhoto(null); setPhotoPreview(null); }}
                    style={{ flex: 1, padding: '10px 0', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {advisorError && (
              <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: '#dc2626', marginBottom: 12 }}>
                {advisorError}
              </div>
            )}

            {/* Saved Q&A log */}
            {advisorLog.length > 0 && (
              <div>
                <div style={S.groupLabel}>📁 Saved Questions</div>
                {advisorLog.map(entry => (
                  <div key={entry.id} style={{ ...S.section, marginBottom: 10 }}>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>
                      {fmtDateTime(entry.asked_at)}
                      {entry.has_photo ? ' · 📷 photo attached' : ''}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b', marginBottom: 6 }}>
                      Q: {entry.question}
                    </div>
                    <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap', background: '#f8fafc', borderRadius: 8, padding: '8px 10px' }}>
                      {entry.answer}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  phone:      { maxWidth: 430, margin: '0 auto', minHeight: '100vh', background: '#f4f6f9', display: 'flex', flexDirection: 'column', fontFamily: "'DM Sans',sans-serif" },
  header:     { color: '#fff', padding: '16px 20px 20px', flexShrink: 0 },
  headerTop:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  hsub:       { fontSize: 20, fontWeight: 700, marginTop: 8 },
  tabBar:     { display: 'flex', borderBottom: '1px solid #e2e6ed', background: '#fff', flexShrink: 0 },
  tabBtn:     { flex: 1, padding: '12px 4px', background: 'none', border: 'none', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', transition: 'color .15s' },
  content:    { flex: 1, padding: '14px 14px 32px', overflowY: 'auto' },
  section:    { background: '#fff', border: '1px solid #e2e6ed', borderRadius: 12, padding: 16, marginBottom: 12 },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '.05em', marginBottom: 10 },
  ticketCard: { background: '#fff', border: '1px solid #e2e6ed', borderRadius: 10, padding: 14, marginBottom: 8 },
  actCard:    { background: '#fff', border: '1px solid #e2e6ed', borderRadius: 10, padding: 14, marginBottom: 8 },
  groupLabel: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '.05em', marginBottom: 8 },
  empty:      { textAlign: 'center' as const, padding: '32px 20px', color: '#9ca3af', fontSize: 14 },
  photoBtn:   { flex: 1, padding: '10px 0', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};
