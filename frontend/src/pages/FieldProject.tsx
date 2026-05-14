/**
 * FieldProject — permanent, bookmarkable project page for construction leads.
 * Route: /field/project/:oppId  (public, no login required)
 *
 * Shows live work ticket hours from Aspire, AI coaching tip,
 * check-in history, and a form to submit an update at any time.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';


const API = import.meta.env.VITE_API_URL ?? '';

interface Ticket {
  WorkTicketID:         number;
  WorkTicketNumber:     string | number;
  ServiceName:          string;
  WorkTicketStatusName: string;
  ScheduledStartDate:   string;
  HoursEst:             number | null;
  HoursAct:             number | null;
  HoursScheduled:       number | null;
  HoursUnscheduled:     number | null;
  CrewLeaderName:       string | null;
  Revenue:              number | null;
  EarnedRevenue:        number | null;
}

interface HistoryPhoto {
  id:             number;
  file_name:      string;
  file_extension: string;
  file_size:      number | null;
  uploaded_at:    string;
  url:            string;
}

interface HistoryEntry {
  id:              number;
  lead_name:       string;
  sent_at:         string;
  month:           string;
  approach_notes:  string | null;
  remaining_hours: number | null;
  blockers:        string | null;
  submitted_at:    string | null;
  photos:          HistoryPhoto[];
}

interface AdvisorLogEntry {
  id:           number;
  question:     string;
  answer:       string;
  has_photo:    number;   // 1 = photo was attached
  photo_r2_key: string | null;
  asked_at:     string;
}

interface ActivityComment {
  Comment:           string;
  CreatedDate:       string;
  CreatedByUserName: string;
}

interface SmartPrompt {
  id:        string;
  type:      string;
  icon:      string;
  situation: string;
  question:  string;
  options:   string[];
  actHours?: number;  // for over_hours prompts — used to detect if hours changed
}

interface PromptMemory {
  answer:      string;
  answeredAt:  number;  // epoch ms
  actHours?:   number;  // snapshot of actHours when answered
}

interface Attachment {
  attachment_id:   number | null;
  file_name:       string;
  file_extension:  string;
  file_url:        string;
  aspire_url:      string;
  attachment_type: string;
  type_id:         number | null;
  expose_to_crew:  boolean;
  created_date:    string;
  note:            string;
}

interface JobAttachment {
  id:              number;
  opp_id:          number;
  work_ticket_id:  number | null;
  attachment_type: string;
  file_name:       string;
  file_extension:  string;
  file_size:       number | null;
  note:            string | null;
  uploaded_by:     string | null;
  uploaded_at:     string;
}

interface Activity {
  ActivityID:           number;
  Subject:              string;
  ActivityType:         string;
  ActivityCategoryName: string;
  Status:               string;
  Notes:                string;
  CreatedDate:          string;
  CompleteDate:         string;
  CreatedByUserName:    string;
  comments:             ActivityComment[];
  IsMileStone:          boolean;
}

interface MaterialItem {
  description: string;
  quantity:    number;
  unit_cost:   number;
  total:       number;
}

interface MaterialPO {
  receipt_id:     number;
  display_number: number | null;
  work_ticket_id: number | null;
  ticket_number:  string | number | null;
  service_name:   string;
  vendor_name:    string;
  received_date:  string;
  total:          number;
  status:         string;
  note:           string;
  items:          MaterialItem[];
  _item_keys?:    string[];  // debug: actual field names from Aspire
}

interface MaterialsData {
  pos:                MaterialPO[];
  tickets_without_po: { WorkTicketID: number; ServiceName: string; WorkTicketNumber: string | number }[];
}

interface ProjectData {
  opportunity_id:   number;
  opportunity_name: string;
  property_name:    string;
  opp_number:       string | number | null;
  status:           string | null;
  hrs_est:          number | null;
  hrs_act:          number | null;
  revenue_est:      number | null;
  revenue_act:      number | null;
  pct_complete:     number | null;
  month:            string;
  tickets:          Ticket[];
  ai_tip:           string | null;
  scope_summary:    string;
  attachments:      Attachment[];
  project_summary:  string;
  smart_prompts:    SmartPrompt[];
  history:          HistoryEntry[];
  advisor_log:      AdvisorLogEntry[];
  activities:       Activity[];
}

function fmtHrs(h: number | null | undefined): string {
  if (h == null) return '—';
  return parseFloat(h as any).toFixed(1);
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '—';
  return '$' + parseFloat(v as any).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  return s.slice(0, 10);
}

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7)  return `${days} days ago`;
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

function StatusBadge({ status }: { status: string }) {
  const s = (status || '').toLowerCase();
  let bg = '#fef3c7', fg = '#92400e';
  if (s.includes('complete'))  { bg = '#dcfce7'; fg = '#15803d'; }
  else if (s.includes('progress')) { bg = '#dbeafe'; fg = '#1d4ed8'; }
  else if (s.includes('cancel'))   { bg = '#fee2e2'; fg = '#dc2626'; }
  return (
    <span style={{
      background: bg, color: fg, padding: '2px 9px', borderRadius: 12,
      fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
    }}>{status || '—'}</span>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function stripHtml(s: string): string {
  try {
    const doc = new DOMParser().parseFromString(s, 'text/html');
    return (doc.body.textContent || '').replace(/\s{2,}/g, ' ').trim();
  } catch {
    return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

// Comment popup — same pattern as ActivitiesDashboard
function CommentsPopup({ comments }: { comments: ActivityComment[] }) {
  const [open, setOpen] = useState(false);
  if (!comments.length) return null;

  const latest  = comments[comments.length - 1];
  const preview = stripHtml(latest.Comment);
  const short   = preview.length > 80 ? preview.slice(0, 80) + '…' : preview;
  const hasMore = comments.length > 1 || preview.length > 80;

  return (
    <div style={{ marginTop: 8, position: 'relative' }}>
      {/* Clickable preview */}
      <div
        onClick={() => hasMore && setOpen(o => !o)}
        style={{
          background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6,
          padding: '7px 10px', cursor: hasMore ? 'pointer' : 'default',
        }}
      >
        <div style={{ fontSize: 10, color: '#92400e', fontWeight: 600, marginBottom: 3 }}>
          💬 {latest.CreatedByUserName}{latest.CreatedDate ? ` · ${latest.CreatedDate.slice(0, 10)}` : ''}
          {comments.length > 1 && (
            <span style={{ marginLeft: 6, background: '#fde68a', borderRadius: 8, padding: '1px 6px' }}>
              +{comments.length - 1} more
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>{short}</div>
      </div>

      {/* Full popup */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, padding: '22px 24px', maxWidth: 480, width: '100%', maxHeight: '70vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>Comment History ({comments.length})</span>
              <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#9ca3af' }}>✕</button>
            </div>
            {[...comments].reverse().map((c, i) => (
              <div key={i} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: i < comments.length - 1 ? '1px solid #f1f5f9' : 'none' }}>
                <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 4 }}>
                  {c.CreatedByUserName}{c.CreatedDate ? ` · ${c.CreatedDate.slice(0, 10)}` : ''}
                </div>
                <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  {stripHtml(c.Comment)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HoursBar({ est, act }: { est: number | null; act: number | null }) {
  const e = est ?? 0;
  const a = act ?? 0;
  const pct   = e > 0 ? Math.min((a / e) * 100, 100) : 0;
  const color = (e > 0 && a > e) ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#22c55e';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 6, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4 }} />
      </div>
      <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 32 }}>{pct.toFixed(0)}%</span>
    </div>
  );
}

/** Resize + compress an image file before sending to the backend.
 *  Keeps the longest edge ≤ maxPx and re-encodes as JPEG at the given quality.
 *  Handles HEIC/HEIF from iOS: the browser decodes the pixel data via Image,
 *  then Canvas re-encodes it as JPEG — so the output is always a valid JPEG. */
async function compressPhoto(file: File, maxPx = 1600, quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth  * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        blob => (blob ? resolve(blob) : reject(new Error('Canvas toBlob returned null'))),
        'image/jpeg',
        quality,
      );
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Image failed to load')); };
    img.src = objectUrl;
  });
}

export default function FieldProject() {
  const { oppId } = useParams<{ oppId: string }>();

  const [data,       setData]       = useState<ProjectData | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // File input refs (label+hidden-input unreliable on some mobile browsers)
  const photoInputRef        = useRef<HTMLInputElement>(null);
  const advisorPhotoInputRef = useRef<HTMLInputElement>(null);

  // Form
  const [approachNotes,  setApproachNotes]  = useState('');
  const [remainingHours, setRemainingHours] = useState('');
  const [blockers,       setBlockers]       = useState('');
  const [submitting,     setSubmitting]     = useState(false);
  const [submitMsg,      setSubmitMsg]      = useState('');
  const [photos,         setPhotos]         = useState<File[]>([]);
  const [previews,       setPreviews]       = useState<string[]>([]);

  // Build object-URL previews whenever photos list changes
  useEffect(() => {
    const urls = photos.map(f => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach(u => URL.revokeObjectURL(u));
  }, [photos]);
  // Smart prompt selections: promptId → selected option string
  const [promptSelections, setPromptSelections] = useState<Record<string, string>>({});
  // Per-prompt additional free-form notes
  const [promptNotes, setPromptNotes] = useState<Record<string, string>>({});

  // ── Prompt memory helpers (localStorage) ─────────────────────────────────
  const promptMemoryKey = (promptId: string) => `pm_${oppId}_${promptId}`;

  function getPromptMemory(promptId: string): PromptMemory | null {
    try {
      const raw = localStorage.getItem(promptMemoryKey(promptId));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function savePromptMemory(promptId: string, answer: string, actHours?: number) {
    try {
      const mem: PromptMemory = { answer, answeredAt: Date.now(), actHours };
      localStorage.setItem(promptMemoryKey(promptId), JSON.stringify(mem));
    } catch {}
  }

  function isPromptSuppressed(p: SmartPrompt): boolean {
    const mem = getPromptMemory(p.id);
    if (!mem || !mem.answer) return false;
    const ageMs = Date.now() - mem.answeredAt;
    if (p.type === 'over_hours') {
      // Re-show if hours increased by more than 1h since last answer
      const hoursIncrease = (p.actHours ?? 0) - (mem.actHours ?? 0);
      return hoursIncrease < 1;
    }
    // Materials / upcoming: suppress for 24h
    return ageMs < 24 * 60 * 60 * 1000;
  }

  // Tab: 'scope' | 'tickets' | 'update' | 'materials' | 'history'
  const [tab, setTab] = useState<'scope' | 'tickets' | 'update' | 'materials' | 'history'>('scope');

  // Field Advisor
  const [advisorQuestion,    setAdvisorQuestion]    = useState('');
  const [advisorPhoto,       setAdvisorPhoto]       = useState<File | null>(null);
  const [advisorPreview,     setAdvisorPreview]     = useState('');
  const [advisorAnswer,      setAdvisorAnswer]      = useState('');
  const [advisorLoading,     setAdvisorLoading]     = useState(false);
  const [advisorPhotoR2Key,  setAdvisorPhotoR2Key]  = useState<string | null>(null);
  const [advisorHasPhoto,    setAdvisorHasPhoto]    = useState(0);
  const [advisorSaved,       setAdvisorSaved]       = useState(false);
  const [advisorSaving,      setAdvisorSaving]      = useState(false);
  // Snapshot of the question at the time of the ask (for saving later)
  const advisorQuestionRef = useRef('');

  const askAdvisor = async () => {
    if (!advisorQuestion.trim() && !advisorPhoto) return;
    setAdvisorLoading(true);
    setAdvisorAnswer('');
    setAdvisorSaved(false);
    setAdvisorPhotoR2Key(null);
    advisorQuestionRef.current = advisorQuestion.trim() || 'What do you observe in this photo and what should I know?';
    try {
      const fd = new FormData();
      fd.append('question', advisorQuestionRef.current);
      if (advisorPhoto) {
        // Compress to max 1600px / JPEG 85% — keeps large phone photos well under
        // the 5 MB backend limit, and handles HEIC by re-encoding via Canvas.
        try {
          const compressed = await compressPhoto(advisorPhoto);
          fd.append('photo', compressed, 'photo.jpg');
        } catch {
          fd.append('photo', advisorPhoto); // fallback: send original
        }
      }
      const r = await fetch(`${API}/checkin/project/${oppId}/field-advisor`, { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as any).detail || 'AI request failed');
      setAdvisorAnswer((j as any).answer || '');
      setAdvisorPhotoR2Key((j as any).photo_r2_key ?? null);
      setAdvisorHasPhoto((j as any).has_photo ?? 0);
    } catch (e: any) {
      setAdvisorAnswer(`⚠️ ${e.message || 'Something went wrong'}`);
    } finally {
      setAdvisorLoading(false);
    }
  };

  const saveAdvisorToFile = async () => {
    setAdvisorSaving(true);
    try {
      const fd = new FormData();
      fd.append('question',     advisorQuestionRef.current);
      fd.append('answer',       advisorAnswer);
      fd.append('has_photo',    String(advisorHasPhoto));
      if (advisorPhotoR2Key) fd.append('photo_r2_key', advisorPhotoR2Key);
      const r = await fetch(`${API}/checkin/project/${oppId}/field-advisor/save`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error('Save failed');
      setAdvisorSaved(true);
    } catch {
      alert('Could not save — please try again');
    } finally {
      setAdvisorSaving(false);
    }
  };

  // Per-ticket remaining hours on the Update tab: WorkTicketID → hours string
  const [ticketHours, setTicketHours] = useState<Record<number, string>>({});

  // Materials tab — lazy-loaded on first open
  const [materialsData,    setMaterialsData]    = useState<MaterialsData | null>(null);
  const [materialsLoading, setMaterialsLoading] = useState(false);
  const [materialsError,   setMaterialsError]   = useState('');

  // ── Change Order modal ─────────────────────────────────────────────────────
  const [coOpen,        setCoOpen]        = useState(false);
  const [coName,        setCoName]        = useState('');
  const [coScope,       setCoScope]       = useState('');
  const [coAssignee,    setCoAssignee]    = useState('');
  const [coFiles,       setCoFiles]       = useState<FileList | null>(null);
  const [coSubmitting,  setCoSubmitting]  = useState(false);
  const [coMsg,         setCoMsg]         = useState('');
  const [employees,     setEmployees]     = useState<{ id: number; name: string; username: string }[]>([]);
  const [empLoading,    setEmpLoading]    = useState(false);

  const openCO = async () => {
    setCoOpen(true);
    setCoMsg('');
    if (employees.length === 0) {
      setEmpLoading(true);
      try {
        const r = await fetch(`${API}/checkin/project/${oppId}/employees`);
        const j = await r.json();
        setEmployees(j.employees || []);
      } catch { /* non-fatal */ }
      setEmpLoading(false);
    }
  };

  const submitCO = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!coName.trim() || !coScope.trim()) return;
    setCoSubmitting(true);
    setCoMsg('');
    try {
      const fd = new FormData();
      fd.append('submitter_name', coName.trim());
      fd.append('scope', coScope.trim());
      // coAssignee stores the ContactID — send it directly as assigned_to_id
      if (coAssignee) {
        fd.append('assigned_to_id', coAssignee);
      }
      if (coFiles) {
        Array.from(coFiles).forEach(f => fd.append('files', f));
      }
      const r = await fetch(`${API}/checkin/project/${oppId}/change-order`, {
        method: 'POST', body: fd,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || 'Submit failed');
      setCoMsg('✅ Change Order Request created in Aspire.');
      setCoScope(''); setCoAssignee(''); setCoFiles(null);
      setTimeout(() => { setCoOpen(false); setCoMsg(''); }, 2500);
    } catch (err: any) {
      setCoMsg(`❌ ${err.message || 'Something went wrong'}`);
    } finally {
      setCoSubmitting(false);
    }
  };

  // Job attachments (our own DB, not Aspire)
  const [jobAtts,        setJobAtts]        = useState<JobAttachment[]>([]);
  const [jobAttsLoading, setJobAttsLoading] = useState(false);
  const [showUpload,     setShowUpload]     = useState(false);
  const [uploadFile,     setUploadFile]     = useState<File | null>(null);
  const [uploadType,     setUploadType]     = useState('Design Plan');
  const [uploadNote,     setUploadNote]     = useState('');
  const [uploading,      setUploading]      = useState(false);
  const [uploadMsg,      setUploadMsg]      = useState('');

  const loadMaterials = async (force = false) => {
    if (!force && materialsData !== null) return; // already fetched
    setMaterialsLoading(true);
    setMaterialsError('');
    try {
      const r = await fetch(`${API}/checkin/project/${oppId}/materials`);
      if (!r.ok) throw new Error('Failed to load materials');
      setMaterialsData(await r.json());
    } catch (e: any) {
      setMaterialsError(e.message || 'Could not load materials');
    } finally {
      setMaterialsLoading(false);
    }
  };

  const ATT_TYPES = ['Design Plan', 'Site Plan', 'Property Info', 'Irrigation Map', 'Photo', 'Contract', 'Permit', 'Other'];
  const KEY_TYPES = new Set(['design plan', 'site plan', 'property info', 'irrigation map']);

  const loadJobAtts = async () => {
    if (!oppId) return;
    setJobAttsLoading(true);
    try {
      const r = await fetch(`${API}/checkin/project/${oppId}/job-attachments`);
      if (r.ok) setJobAtts(await r.json());
    } finally {
      setJobAttsLoading(false);
    }
  };

  const submitUpload = async () => {
    if (!uploadFile || !oppId) return;
    setUploading(true);
    setUploadMsg('');
    try {
      const fd = new FormData();
      fd.append('file', uploadFile);
      fd.append('attachment_type', uploadType);
      fd.append('note', uploadNote);
      const r = await fetch(`${API}/checkin/project/${oppId}/job-attachments`, { method: 'POST', body: fd });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as any).detail || 'Upload failed');
      }
      setUploadFile(null);
      setUploadNote('');
      setShowUpload(false);
      setUploadMsg('');
      await loadJobAtts();
    } catch (e: any) {
      setUploadMsg(e.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const deleteJobAtt = async (id: number) => {
    await fetch(`${API}/checkin/job-attachment/${id}`, { method: 'DELETE' });
    setJobAtts(prev => prev.filter(a => a.id !== id));
  };

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    setError('');
    try {
      const r = await fetch(`${API}/checkin/project/${oppId}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as any).detail || 'Project not found');
      }
      setData(await r.json());
    } catch (e: any) {
      setError(e.message || 'Failed to load project');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); loadJobAtts(); }, [oppId]);

  // Pre-populate prompt selections from localStorage once data arrives
  useEffect(() => {
    if (!data) return;
    const saved: Record<string, string> = {};
    for (const p of (data.smart_prompts || [])) {
      const mem = getPromptMemory(p.id);
      if (mem?.answer) saved[p.id] = mem.answer;
    }
    if (Object.keys(saved).length > 0) {
      setPromptSelections(prev => ({ ...saved, ...prev }));
    }
  }, [data?.smart_prompts?.length]);

  const handleSubmit = async (e: React.FormEvent, combinedNotes?: string, overrideRemainingHours?: string) => {
    e.preventDefault();
    const notes = combinedNotes ?? approachNotes.trim();
    if (!notes) return;
    setSubmitting(true);
    setSubmitMsg('');
    // Use the passed-in override (avoids stale React state when called from form submit)
    const effectiveRemainingHours = overrideRemainingHours ?? remainingHours;
    try {
      const fd = new FormData();
      fd.append('approach_notes', notes);
      if (effectiveRemainingHours) fd.append('remaining_hours', effectiveRemainingHours);
      if (blockers.trim()) fd.append('blockers', blockers.trim());
      photos.forEach(f => fd.append('photos', f));

      const r = await fetch(`${API}/checkin/project/${oppId}/respond`, {
        method: 'POST',
        body: fd,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as any).detail || 'Submit failed');
      }
      const j = await r.json().catch(() => ({}));
      const photosSaved = (j as any).photos_saved ?? 0;
      const photoMsg = photos.length > 0
        ? (photosSaved > 0 ? ` · ${photosSaved} photo${photosSaved > 1 ? 's' : ''} saved` : ' · ⚠️ photos failed to upload')
        : '';
      setSubmitMsg(`✅ Update sent to the team.${photoMsg}`);
      setApproachNotes(''); setRemainingHours(''); setBlockers(''); setPhotos([]);
      setTab('history');
      load(true);   // refresh history quietly
    } catch (err: any) {
      setSubmitMsg(`❌ ${err.message || 'Something went wrong'}`);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Loading / error ──────────────────────────────────────────────────────────

  if (loading) return (
    <div style={SHELL}>
      <div style={{ textAlign: 'center', padding: 60, color: '#64748b' }}>Loading project…</div>
    </div>
  );

  if (error) return (
    <div style={SHELL}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '40px 28px', textAlign: 'center', maxWidth: 440, margin: '0 auto' }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
        <div style={{ fontWeight: 700, fontSize: 18, color: '#0f172a', marginBottom: 8 }}>Project not found</div>
        <div style={{ color: '#64748b', fontSize: 14 }}>{error}</div>
      </div>
    </div>
  );

  if (!data) return null;

  const totalEst        = data.tickets.reduce((s, t) => s + (t.HoursEst ?? 0), 0);
  const totalAct        = data.tickets.reduce((s, t) => s + (t.HoursAct ?? 0), 0);
  const totalRemaining  = data.tickets.reduce((s, t) => s + Math.max(0, (t.HoursEst ?? 0) - (t.HoursAct ?? 0)), 0);
  const totalRevenue    = data.tickets.reduce((s, t) => s + (t.Revenue ?? 0), 0);
  const totalEarned     = data.tickets.reduce((s, t) => s + (t.EarnedRevenue ?? 0), 0);
  const overBudget      = totalAct > totalEst && totalEst > 0;
  const responded  = data.history.filter(h => h.submitted_at).length;

  return (
    <div style={SHELL}>
      <div style={CARD}>

        {/* Header */}
        <div style={HDR}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, marginBottom: 8 }}>
            <a href="/field/project" style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,0.15)', borderRadius: 20, padding: '5px 12px' }}>
              ← Home
            </a>
            <button
              onClick={openCO}
              style={{ color: '#fff', fontSize: 13, background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 20, padding: '5px 13px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}
            >
              ＋ Change Order
            </button>
          </div>
          <div style={HDR_LABEL}>Construction Project</div>
          <div style={HDR_TITLE}>{data.property_name || data.opportunity_name}</div>
          {data.property_name && (
            <div style={HDR_SUB}>{data.opportunity_name}</div>
          )}
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {data.status && (
              <span style={{ background: 'rgba(255,255,255,.15)', color: '#fff', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                {data.status}
              </span>
            )}
            {data.opp_number && (
              <span style={{ background: 'rgba(255,255,255,.10)', color: '#86efac', padding: '3px 10px', borderRadius: 20, fontSize: 11 }}>
                #{data.opp_number}
              </span>
            )}
          </div>
        </div>

        {/* Summary chips */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #f1f5f9' }}>
          {[
            { label: 'Est Hrs',   value: fmtHrs(totalEst) },
            { label: 'Act Hrs',   value: fmtHrs(totalAct), alert: overBudget },
            { label: 'Remaining', value: fmtHrs(totalRemaining), alert: overBudget },
            { label: 'Updates',   value: `${responded}` },
          ].map(({ label, value, alert }) => (
            <div key={label} style={{ flex: 1, padding: '12px 4px', textAlign: 'center', borderRight: '1px solid #f1f5f9' }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: alert ? '#ef4444' : '#0f172a' }}>{value}</div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #f1f5f9', overflowX: 'auto' }}>
          {([
            { key: 'scope',     label: '📐 Scope' },
            { key: 'tickets',   label: `📋 Tickets (${data.tickets.length})` },
            { key: 'update',    label: '✏️ Update' },
            { key: 'materials', label: '📦 Materials' },
            { key: 'history',   label: `📝 History (${(data.activities || []).filter(a => (a.ActivityType || '').toLowerCase() !== 'email').length + responded + (data.advisor_log || []).length})` },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => {
                setTab(key);
                if (key === 'materials') loadMaterials();
              }}
              style={{
                flex: '0 0 auto', padding: '12px 10px', border: 'none', background: 'none',
                fontWeight: tab === key ? 700 : 500,
                fontSize: 12,
                color: tab === key ? '#16a34a' : '#6b7280',
                borderBottom: tab === key ? '2px solid #16a34a' : '2px solid transparent',
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ padding: '20px 16px' }}>

          {/* ── Scope tab ────────────────────────────────────────────────── */}
          {tab === 'scope' && (
            <>
              {/* Scope summary */}
              {data.scope_summary ? (
                <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 10, padding: '14px 16px', marginBottom: 20 }}>
                  <div style={{ fontWeight: 700, fontSize: 11, color: '#0369a1', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Project Scope
                  </div>
                  <p style={{ margin: 0, fontSize: 13, color: '#0c4a6e', lineHeight: 1.7 }}>
                    {data.scope_summary}
                  </p>
                </div>
              ) : (
                <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '20px 0 8px', marginBottom: 12 }}>
                  No scope notes found in Aspire for this job
                </div>
              )}

              {/* Job Attachments — our own DB, fully downloadable */}
              {(() => {
                const attIcon = (t: string, ext: string) =>
                  t.includes('irrigation') ? '💧' : t.includes('site plan') ? '📍' :
                  t.includes('property') ? '🏡' : t.includes('design') || t.includes('plan') ? '🗺️' :
                  t.includes('photo') || ['jpg','jpeg','png','gif','webp','heic'].includes(ext) ? '📷' :
                  t.includes('contract') ? '📃' : t.includes('permit') ? '🏛️' :
                  ext === 'pdf' ? '📄' : ['doc','docx'].includes(ext) ? '📝' : '📎';

                const keyDocs = jobAtts.filter(a => KEY_TYPES.has((a.attachment_type || '').toLowerCase()));
                const others  = jobAtts.filter(a => !KEY_TYPES.has((a.attachment_type || '').toLowerCase()));

                const renderJobAtt = (att: JobAttachment, i: number, highlight = false) => {
                  const t   = (att.attachment_type || '').toLowerCase();
                  const ext = (att.file_extension || '').toLowerCase();
                  const viewUrl = `${API}/checkin/job-attachment/${att.id}/file`;
                  return (
                    <div key={att.id} style={{
                      padding: '10px 14px',
                      background: highlight ? '#f0f9ff' : i % 2 === 0 ? '#fff' : '#f9fafb',
                      borderTop: i > 0 ? '1px solid #f1f5f9' : undefined,
                      display: 'flex', alignItems: 'center', gap: 10,
                    }}>
                      <span style={{ fontSize: 20, flexShrink: 0 }}>{attIcon(t, ext)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {att.file_name}
                        </div>
                        <div style={{ fontSize: 11, color: highlight ? '#0369a1' : '#9ca3af' }}>
                          {att.attachment_type}
                          {att.file_extension ? ` · .${att.file_extension.toUpperCase()}` : ''}
                          {att.file_size ? ` · ${(att.file_size / 1024).toFixed(0)} KB` : ''}
                        </div>
                        {att.note && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{att.note}</div>}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <a href={viewUrl} target="_blank" rel="noopener noreferrer"
                          style={{ padding: '5px 11px', background: highlight ? '#0369a1' : '#1e3a5f', color: '#fff', borderRadius: 7, fontSize: 12, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                          View
                        </a>
                        <button onClick={() => { if (confirm('Delete this attachment?')) deleteJobAtt(att.id); }}
                          style={{ padding: '5px 8px', background: 'none', border: '1px solid #fca5a5', color: '#ef4444', borderRadius: 7, fontSize: 11, cursor: 'pointer' }}>
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                };

                return (
                  <>
                    {/* Header row */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <div style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Documents ({jobAtts.length})
                        {jobAttsLoading && <span style={{ marginLeft: 6, color: '#cbd5e1' }}>loading…</span>}
                      </div>
                      <button onClick={() => setShowUpload(v => !v)}
                        style={{ padding: '5px 12px', background: '#1e3a5f', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                        {showUpload ? '✕ Cancel' : '＋ Add'}
                      </button>
                    </div>

                    {/* Upload panel */}
                    {showUpload && (
                      <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10, color: '#111827' }}>Upload Document</div>
                        <div style={{ marginBottom: 10 }}>
                          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>Type</label>
                          <select value={uploadType} onChange={e => setUploadType(e.target.value)}
                            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}>
                            {ATT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </div>
                        <div style={{ marginBottom: 10 }}>
                          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>File</label>
                          <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.xls,.xlsx,.dwg"
                            onChange={e => setUploadFile(e.target.files?.[0] ?? null)}
                            style={{ width: '100%', fontSize: 13 }} />
                        </div>
                        <div style={{ marginBottom: 12 }}>
                          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>Note (optional)</label>
                          <input value={uploadNote} onChange={e => setUploadNote(e.target.value)}
                            placeholder="e.g. Rev 3, approved 2026-04-10"
                            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
                        </div>
                        {uploadMsg && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{uploadMsg}</div>}
                        <button onClick={submitUpload} disabled={!uploadFile || uploading}
                          style={{ width: '100%', padding: '10px', background: uploadFile && !uploading ? '#16a34a' : '#d1d5db', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: uploadFile && !uploading ? 'pointer' : 'not-allowed' }}>
                          {uploading ? 'Uploading…' : 'Upload'}
                        </button>
                      </div>
                    )}

                    {/* Key docs */}
                    {keyDocs.length > 0 && (
                      <>
                        <div style={{ fontWeight: 700, fontSize: 11, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                          📋 Key Documents ({keyDocs.length})
                        </div>
                        <div style={{ border: '1.5px solid #bae6fd', borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
                          {keyDocs.map((att, i) => renderJobAtt(att, i, true))}
                        </div>
                      </>
                    )}

                    {/* All other docs */}
                    {others.length > 0 && (
                      <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
                        {others.map((att, i) => renderJobAtt(att, i, false))}
                      </div>
                    )}

                    {jobAtts.length === 0 && !jobAttsLoading && (
                      <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '16px 0' }}>
                        No documents uploaded yet — tap <strong>＋ Add</strong> to upload
                      </div>
                    )}
                  </>
                );
              })()}
            </>
          )}

          {/* ── Tickets tab ──────────────────────────────────────────────── */}
          {tab === 'tickets' && (
            <>
              {/* Header row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Work Tickets ({data.tickets.length})
                </div>
                <button onClick={() => load(true)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 12 }}>
                  {refreshing ? '↻' : '↺ refresh'}
                </button>
              </div>

              {data.tickets.length === 0 ? (
                <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '24px 0' }}>
                  No work tickets found for this job
                </div>
              ) : (
                <>
                  {/* Totals row */}
                  <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 12px', marginBottom: 8, display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
                    {[
                      { label: 'Est Hrs',     value: `${fmtHrs(totalEst)}h` },
                      { label: 'Act Hrs',     value: `${fmtHrs(totalAct)}h`,        alert: overBudget },
                      { label: 'Remaining',   value: `${fmtHrs(totalRemaining)}h` },
                      { label: 'Earned Rev',  value: fmtMoney(totalEarned || null),  highlight: totalEarned > 0 },
                      { label: 'Revenue',     value: fmtMoney(totalRevenue || null) },
                    ].map(({ label, value, alert, highlight }) => (
                      <div key={label} style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: alert ? '#ef4444' : highlight ? '#15803d' : '#111827' }}>{value}</div>
                        <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 1 }}>{label}</div>
                      </div>
                    ))}
                  </div>

                  {/* Ticket rows */}
                  <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                    {data.tickets.map((t, i) => {
                      const est  = t.HoursEst ?? 0;
                      const act  = t.HoursAct ?? 0;
                      const rem  = Math.max(0, est - act);
                      const over = act > est && est > 0;
                      const label = t.ServiceName || `#${t.WorkTicketNumber}`;
                      return (
                        <div key={t.WorkTicketID} style={{
                          padding: '11px 14px',
                          background: i % 2 === 0 ? '#fff' : '#f9fafb',
                          borderTop: i > 0 ? '1px solid #f1f5f9' : undefined,
                        }}>
                          {/* Service name + status */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 1 }}>{label}</div>
                              <div style={{ fontSize: 11, color: '#9ca3af' }}>#{t.WorkTicketNumber} · {fmtDate(t.ScheduledStartDate)}</div>
                            </div>
                            <StatusBadge status={t.WorkTicketStatusName || '—'} />
                          </div>
                          {/* Hours grid: Est / Actual / Remaining / Earned / Revenue */}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4 }}>
                            {[
                              { label: 'Est',      value: `${fmtHrs(est)}h` },
                              { label: 'Actual',   value: `${fmtHrs(act)}h`,   alert: over },
                              { label: 'Rem',      value: over ? 'Over' : `${fmtHrs(rem)}h`, alert: over },
                              { label: 'Earned',   value: fmtMoney(t.EarnedRevenue), highlight: (t.EarnedRevenue ?? 0) > 0 },
                              { label: 'Revenue',  value: fmtMoney(t.Revenue) },
                            ].map(({ label, value, alert, highlight }) => (
                              <div key={label} style={{ background: '#f8fafc', borderRadius: 5, padding: '4px 4px', textAlign: 'center' }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: alert ? '#ef4444' : highlight ? '#15803d' : '#111827' }}>{value}</div>
                                <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 1 }}>{label}</div>
                              </div>
                            ))}
                          </div>
                          <div style={{ marginTop: 6 }}>
                            <HoursBar est={est} act={act} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

            </>
          )}

          {/* ── History tab ──────────────────────────────────────────────── */}
          {tab === 'history' && (
            <>
              {/* Aspire Activities — filter out Email notification logs, strip HTML from notes */}
              {(() => {
                const visibleActs = (data.activities || []).filter(
                  a => (a.ActivityType || '').toLowerCase() !== 'email'
                );
                return (
                  <>
                    <div style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                      Aspire Activities ({visibleActs.length})
                    </div>
                    {visibleActs.length === 0 ? (
                      <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '16px 0 24px' }}>
                        No activities logged in Aspire
                      </div>
                    ) : (
                      <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 24 }}>
                        {visibleActs.map((a, i) => {
                          const plainNotes = stripHtml(a.Notes || '');
                          return (
                            <div key={a.ActivityID} style={{
                              padding: '11px 14px',
                              background: i % 2 === 0 ? '#fff' : '#f9fafb',
                              borderTop: i > 0 ? '1px solid #f1f5f9' : undefined,
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 2 }}>
                                    {a.IsMileStone ? '🏁 ' : ''}{a.Subject || '(no subject)'}
                                  </div>
                                  <div style={{ fontSize: 11, color: '#9ca3af' }}>
                                    {[a.ActivityType, a.ActivityCategoryName].filter(Boolean).join(' · ')}
                                    {a.CreatedByUserName ? ` · ${a.CreatedByUserName}` : ''}
                                  </div>
                                </div>
                                <div style={{ flexShrink: 0, textAlign: 'right' }}>
                                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{a.CompleteDate || a.CreatedDate}</div>
                                  {a.Status && (
                                    <span style={{ fontSize: 10, fontWeight: 600, background: a.Status.toLowerCase().includes('complet') ? '#dcfce7' : '#fef3c7', color: a.Status.toLowerCase().includes('complet') ? '#15803d' : '#92400e', padding: '1px 6px', borderRadius: 8, marginTop: 3, display: 'inline-block' }}>
                                      {a.Status}
                                    </span>
                                  )}
                                </div>
                              </div>
                              {plainNotes && (
                                <div style={{ marginTop: 6, fontSize: 12, color: '#374151', lineHeight: 1.6, background: '#f8fafc', borderRadius: 6, padding: '6px 10px' }}>
                                  {plainNotes.length > 300 ? plainNotes.slice(0, 300) + '…' : plainNotes}
                                </div>
                              )}
                              <CommentsPopup comments={a.comments || []} />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                );
              })()}

              {/* Check-in History */}
              <div style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                Check-in History ({responded})
              </div>
              {data.history.length === 0 ? (
                <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '16px 0' }}>
                  No check-ins yet
                </div>
              ) : data.history.map((h) => (
                <div key={h.id} style={{ marginBottom: 12, border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 14px',
                    background: h.submitted_at ? '#f0fdf4' : '#fffbeb',
                    borderBottom: h.approach_notes ? '1px solid #e2e8f0' : undefined,
                  }}>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: 13, color: '#0f172a' }}>
                        {h.submitted_at ? '✅' : '⏳'} {h.submitted_at ? fmtRelative(h.submitted_at) : 'Awaiting'}
                      </span>
                      <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 8 }}>{fmtDate(h.sent_at)}</span>
                    </div>
                    {h.remaining_hours != null && (
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#15803d' }}>{h.remaining_hours}h rem</span>
                    )}
                  </div>
                  {h.approach_notes && (
                    <div style={{ padding: '10px 14px', fontSize: 13, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                      {h.approach_notes}
                    </div>
                  )}
                  {h.blockers && (
                    <div style={{ padding: '8px 14px', background: '#fff7ed', borderTop: '1px solid #fed7aa', fontSize: 12, color: '#c2410c' }}>
                      ⚠️ {h.blockers}
                    </div>
                  )}
                  {(h.photos || []).length > 0 && (
                    <div style={{ padding: '10px 14px', borderTop: '1px solid #f1f5f9', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {(h.photos || []).map(photo => {
                        const isVideo = ['mp4','mov','avi','webm'].includes((photo.file_extension || '').toLowerCase());
                        const src = `${API}${photo.url}`;
                        return isVideo ? (
                          <a key={photo.id} href={src} target="_blank" rel="noopener noreferrer"
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 72, height: 72, background: '#0f172a', borderRadius: 8, textDecoration: 'none', fontSize: 24 }}>
                            🎥
                          </a>
                        ) : (
                          <a key={photo.id} href={src} target="_blank" rel="noopener noreferrer">
                            <img src={src} alt={photo.file_name}
                              style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid #e2e8f0', display: 'block' }} />
                          </a>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}

              {/* Field Advisor Q&A Log */}
              {(data.advisor_log || []).length > 0 && (
                <>
                  <div style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10, marginTop: 24 }}>
                    🤖 Field Advisor Q&amp;A ({(data.advisor_log || []).length})
                  </div>
                  {(data.advisor_log || []).map((entry) => (
                    <div key={entry.id} style={{ marginBottom: 12, border: '1px solid #e9d5ff', borderRadius: 10, overflow: 'hidden' }}>
                      {/* Question */}
                      <div style={{ padding: '10px 14px', background: '#faf5ff', borderBottom: '1px solid #e9d5ff' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#6b21a8', flex: 1 }}>
                            {entry.has_photo ? '📷 ' : '❓ '}{entry.question}
                          </div>
                          <div style={{ fontSize: 11, color: '#a78bfa', flexShrink: 0 }}>
                            {fmtRelative(entry.asked_at)}
                          </div>
                        </div>
                      </div>
                      {/* Answer */}
                      <div style={{ padding: '10px 14px', fontSize: 13, color: '#374151', lineHeight: 1.65, whiteSpace: 'pre-wrap', background: '#fff' }}>
                        {entry.answer}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </>
          )}

          {/* ── Update tab ───────────────────────────────────────────────── */}
          {tab === 'update' && (
            <form onSubmit={e => {
              e.preventDefault();

              // Compute per-ticket hours summary
              const ACTIVE_S = new Set(['open', 'in progress', 'scheduled', 'in production', 'in queue']);
              const activeTickets = data.tickets.filter(t =>
                ACTIVE_S.has((t.WorkTicketStatusName || '').toLowerCase())
              );
              const filledHours = activeTickets
                .map(t => ({ t, h: parseFloat(ticketHours[t.WorkTicketID] || '') }))
                .filter(x => !isNaN(x.h) && x.h >= 0);
              const totalRemaining = filledHours.reduce((s, x) => s + x.h, 0);
              const hoursLine = filledHours.length > 0
                ? 'Hours remaining — ' + filledHours
                    .map(x => `${x.t.ServiceName || '#' + x.t.WorkTicketNumber}: ${x.h}h`)
                    .join(', ')
                : '';
              // Update the remainingHours state to be the total (for the API field)
              const totalRemStr = filledHours.length > 0 ? String(totalRemaining) : remainingHours;

              // Prepend prompt selections + any per-prompt notes to approach notes
              const answered = (data.smart_prompts || []).filter(p => promptSelections[p.id]);
              answered.forEach(p => savePromptMemory(p.id, promptSelections[p.id], p.actHours));
              const promptLines = answered.map(p => {
                const note = (promptNotes[p.id] || '').trim();
                return `${p.icon} ${p.situation}\n→ ${promptSelections[p.id]}${note ? `\n  Note: ${note}` : ''}`;
              });

              const parts = [
                hoursLine,
                ...promptLines,
                approachNotes.trim(),
              ].filter(Boolean);
              const combined = parts.join('\n\n');
              if (!combined.trim()) return;
              // Pass totalRemStr directly — don't rely on setState (async, stale read)
              if (filledHours.length > 0) setRemainingHours(totalRemStr);
              handleSubmit(e, combined, filledHours.length > 0 ? totalRemStr : undefined);
            }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a', marginBottom: 12 }}>
                Site Update
              </div>

              {/* ── Project Summary ── */}
              {data.project_summary && (
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '14px 16px', marginBottom: 18 }}>
                  <div style={{ fontWeight: 700, fontSize: 11, color: '#475569', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    🗂 Project Status
                  </div>
                  <p style={{ margin: 0, fontSize: 13, color: '#1e293b', lineHeight: 1.65 }}>
                    {data.project_summary}
                  </p>
                </div>
              )}

              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
                Answer the prompts below, then add any notes.
              </div>

              {/* ── Smart Prompts ── always visible; pre-populated from memory ── */}
              {(data.smart_prompts || []).map(p => {
                const selected  = promptSelections[p.id] || '';
                const hasAnswer = !!selected;
                const borderColor = p.type === 'over_hours' ? '#fca5a5' : p.type === 'upcoming' ? '#93c5fd' : '#d1d5db';
                const headerBg    = p.type === 'over_hours' ? '#fff1f2' : p.type === 'upcoming' ? '#eff6ff' : '#f9fafb';
                const labelColor  = p.type === 'over_hours' ? '#dc2626' : p.type === 'upcoming' ? '#1d4ed8' : '#374151';
                return (
                  <div key={p.id} style={{ marginBottom: 14, border: `1.5px solid ${borderColor}`, borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ padding: '10px 14px', background: headerBg }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: labelColor, marginBottom: 2 }}>
                        {hasAnswer ? '✓ ' : ''}{p.icon} {p.situation}
                      </div>
                      <div style={{ fontSize: 13, color: '#0f172a', fontWeight: 600 }}>{p.question}</div>
                    </div>
                    {/* Options — always clickable to change selection */}
                    <div style={{ padding: '8px 10px 6px', background: '#fff', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {p.options.map(opt => {
                        const isSelected = selected === opt;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => {
                              const newVal = isSelected ? '' : opt;
                              setPromptSelections(prev => ({ ...prev, [p.id]: newVal }));
                              if (newVal) savePromptMemory(p.id, newVal, p.actHours);
                            }}
                            style={{
                              padding: '6px 11px', borderRadius: 20,
                              border: isSelected ? '2px solid #16a34a' : '1.5px solid #d1d5db',
                              background: isSelected ? '#dcfce7' : '#fff',
                              color: isSelected ? '#15803d' : '#374151',
                              fontSize: 12, fontWeight: isSelected ? 700 : 400,
                              cursor: 'pointer', textAlign: 'left',
                            }}
                          >
                            {isSelected ? '✓ ' : ''}{opt}
                          </button>
                        );
                      })}
                    </div>
                    {/* Additional context note */}
                    <div style={{ padding: '0 10px 10px', background: '#fff' }}>
                      <textarea
                        placeholder="Add additional context (optional)…"
                        value={promptNotes[p.id] || ''}
                        onChange={e => setPromptNotes(prev => ({ ...prev, [p.id]: e.target.value }))}
                        rows={2}
                        style={{
                          width: '100%', boxSizing: 'border-box', fontSize: 12,
                          border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 8px',
                          resize: 'vertical', color: '#374151', fontFamily: 'inherit',
                          background: '#f9fafb',
                        }}
                      />
                    </div>
                  </div>
                );
              })}

              {/* ── Field Advisor ── */}
              <div style={{ marginBottom: 16, border: '1.5px solid #c7d2fe', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ background: '#eef2ff', padding: '10px 14px' }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: '#4338ca' }}>🤖 Field Advisor</div>
                  <div style={{ fontSize: 12, color: '#6366f1', marginTop: 2 }}>
                    Snap a photo of a site problem and describe it — get instant AI guidance
                  </div>
                </div>
                <div style={{ background: '#fff', padding: '12px 14px' }}>
                  {/* Photo picker */}
                  <button
                    type="button"
                    onClick={() => advisorPhotoInputRef.current?.click()}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', background: '#f5f3ff', border: '1.5px dashed #a5b4fc', borderRadius: 8, padding: '9px 12px', fontSize: 12, color: '#6366f1', marginBottom: 10, width: '100%', textAlign: 'left', fontFamily: 'inherit' }}
                  >
                    <span style={{ fontSize: 18 }}>📸</span>
                    <span>{advisorPhoto ? advisorPhoto.name : 'Attach site photo (optional)'}</span>
                  </button>
                  <input
                    ref={advisorPhotoInputRef}
                    type="file"
                    accept="image/*"
                    onChange={e => {
                      const f = e.target.files?.[0] ?? null;
                      if (advisorPreview) URL.revokeObjectURL(advisorPreview);
                      setAdvisorPhoto(f);
                      setAdvisorPreview(f ? URL.createObjectURL(f) : '');
                    }}
                    style={{ display: 'none' }}
                  />
                  {advisorPreview && (
                    <div style={{ marginBottom: 10, position: 'relative', display: 'inline-block' }}>
                      <img src={advisorPreview} alt="" style={{ width: 100, height: 100, objectFit: 'cover', borderRadius: 8, border: '2px solid #c7d2fe' }} />
                      <button type="button"
                        onClick={() => { URL.revokeObjectURL(advisorPreview); setAdvisorPhoto(null); setAdvisorPreview(''); }}
                        style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', background: '#ef4444', color: '#fff', border: 'none', fontSize: 12, cursor: 'pointer', padding: 0, lineHeight: '20px', textAlign: 'center' }}>×</button>
                    </div>
                  )}
                  {/* Question input */}
                  <textarea
                    placeholder="Describe the issue — e.g. 'slope eroding near retaining wall, what should we do?'"
                    value={advisorQuestion}
                    onChange={e => setAdvisorQuestion(e.target.value)}
                    rows={2}
                    style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit', marginBottom: 10, color: '#374151', background: '#f9fafb' }}
                  />
                  <button type="button" onClick={askAdvisor}
                    disabled={advisorLoading || (!advisorQuestion.trim() && !advisorPhoto)}
                    style={{ width: '100%', padding: '10px', background: (!advisorLoading && (advisorQuestion.trim() || advisorPhoto)) ? '#4f46e5' : '#94a3b8', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: advisorLoading || (!advisorQuestion.trim() && !advisorPhoto) ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
                    {advisorLoading ? '🤔 Thinking…' : '✨ Ask Field Advisor'}
                  </button>
                  {advisorAnswer && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 8, padding: '12px 14px', fontSize: 13, color: '#1e1b4b', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                        {advisorAnswer}
                      </div>
                      {/* Save prompt — only show when answer is a real response (not an error) */}
                      {!advisorAnswer.startsWith('⚠️') && (
                        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                          {advisorSaved ? (
                            <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>✓ Saved to project file</span>
                          ) : (
                            <>
                              <span style={{ fontSize: 12, color: '#6b7280' }}>Save to project file?</span>
                              <button
                                type="button"
                                onClick={saveAdvisorToFile}
                                disabled={advisorSaving}
                                style={{ padding: '4px 12px', fontSize: 12, fontWeight: 600, background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, cursor: advisorSaving ? 'wait' : 'pointer' }}
                              >
                                {advisorSaving ? 'Saving…' : '💾 Yes, save'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setAdvisorAnswer('')}
                                style={{ padding: '4px 10px', fontSize: 12, background: '#f3f4f6', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' }}
                              >
                                No thanks
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Per-ticket remaining hours — only scheduled/active tickets */}
              {(() => {
                const ACTIVE_S = new Set(['open', 'in progress', 'scheduled', 'in production', 'in queue']);
                const activeTickets = data.tickets.filter(t =>
                  ACTIVE_S.has((t.WorkTicketStatusName || '').toLowerCase())
                );
                if (activeTickets.length === 0) return null;
                return (
                  <div style={{ marginBottom: 16 }}>
                    <label style={LABEL}>Hours remaining per ticket</label>
                    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
                      {activeTickets.map((t, i) => {
                        const label = t.ServiceName || `#${t.WorkTicketNumber}`;
                        const est   = t.HoursEst ?? 0;
                        const act   = t.HoursAct ?? 0;
                        const rem   = Math.max(est - act, 0);
                        return (
                          <div key={t.WorkTicketID} style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '8px 12px',
                            background: i % 2 === 0 ? '#fff' : '#f9fafb',
                            borderTop: i > 0 ? '1px solid #f1f5f9' : undefined,
                          }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {label}
                              </div>
                              <div style={{ fontSize: 10, color: '#9ca3af' }}>
                                {act.toFixed(1)}h used of {est.toFixed(1)}h est · ~{rem.toFixed(1)}h rem
                              </div>
                            </div>
                            <input
                              type="number" min="0" step="0.5"
                              placeholder={rem.toFixed(1)}
                              value={ticketHours[t.WorkTicketID] ?? ''}
                              onChange={e => setTicketHours(prev => ({ ...prev, [t.WorkTicketID]: e.target.value }))}
                              style={{ ...INPUT, width: 72, marginBottom: 0, padding: '6px 8px', textAlign: 'right' }}
                            />
                            <span style={{ fontSize: 11, color: '#6b7280', flexShrink: 0 }}>h</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              <div style={{ marginBottom: 14 }}>
                <label style={LABEL}>
                  Additional notes <span style={{ color: '#6b7280', fontWeight: 400 }}>(optional if prompts answered)</span>
                </label>
                <textarea
                  rows={4}
                  placeholder="Any other details, plan for tomorrow, or context for the team…"
                  value={approachNotes}
                  onChange={e => setApproachNotes(e.target.value)}
                  style={{ ...INPUT, resize: 'vertical', minHeight: 90 }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={LABEL}>Blockers or issues (optional)</label>
                <textarea
                  rows={2}
                  placeholder="Anything slowing you down?"
                  value={blockers}
                  onChange={e => setBlockers(e.target.value)}
                  style={{ ...INPUT, resize: 'vertical' }}
                />
              </div>

              {/* Photo / video upload */}
              <div style={{ marginBottom: 22 }}>
                <label style={LABEL}>Photos / Videos (optional)</label>
                {previews.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                    {previews.map((src, i) => (
                      <div key={i} style={{ position: 'relative' }}>
                        {photos[i]?.type.startsWith('video/') ? (
                          <video src={src} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, background: '#000' }} muted />
                        ) : (
                          <img src={src} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8 }} />
                        )}
                        <button type="button" onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))}
                          style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', background: '#ef4444', color: '#fff', border: 'none', fontSize: 12, lineHeight: '20px', textAlign: 'center', cursor: 'pointer', padding: 0 }}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', background: '#f8fafc', border: '1.5px dashed #cbd5e1', borderRadius: 10, padding: '11px 14px', fontSize: 13, color: '#475569', width: '100%', textAlign: 'left', fontFamily: 'inherit' }}
                >
                  <span style={{ fontSize: 20 }}>📷</span>
                  <span>Take or choose photos/videos</span>
                </button>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  onChange={e => { setPhotos(prev => [...prev, ...Array.from(e.target.files ?? [])]); e.target.value = ''; }}
                  style={{ display: 'none' }}
                />
              </div>

              {submitMsg && (
                <div style={{
                  marginBottom: 14, padding: '10px 14px', borderRadius: 8,
                  background: submitMsg.startsWith('✅') ? '#f0fdf4' : '#fef2f2',
                  color: submitMsg.startsWith('✅') ? '#15803d' : '#dc2626',
                  fontSize: 14, fontWeight: 600,
                }}>
                  {submitMsg}
                </div>
              )}

              {(() => {
                const hasPrompts = (data.smart_prompts || []).some(p => promptSelections[p.id]);
                const canSubmit  = hasPrompts || approachNotes.trim();
                return (
                  <button
                    type="submit"
                    disabled={submitting || !canSubmit}
                    style={{
                      width: '100%', padding: '15px',
                      background: canSubmit ? '#16a34a' : '#94a3b8',
                      color: '#fff', border: 'none', borderRadius: 10,
                      fontWeight: 800, fontSize: 16,
                      cursor: canSubmit ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {submitting ? 'Sending…' : 'Send Update to Team →'}
                  </button>
                );
              })()}
            </form>
          )}

          {/* ── Materials tab ─────────────────────────────────────────── */}
          {tab === 'materials' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Purchase Orders / Materials
                </div>
                <button
                  onClick={() => loadMaterials(true)}
                  style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 12 }}
                >
                  {materialsLoading ? '↻' : '↺ refresh'}
                </button>
              </div>

              {materialsLoading && (
                <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '32px 0' }}>
                  Loading materials…
                </div>
              )}

              {materialsError && !materialsLoading && (
                <div style={{ textAlign: 'center', color: '#dc2626', fontSize: 13, padding: '24px 0' }}>
                  {materialsError}
                </div>
              )}

              {!materialsLoading && materialsData && (
                <>
                  {/* PO list */}
                  {materialsData.pos.length === 0 && materialsData.tickets_without_po.length === 0 && (
                    <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '24px 0' }}>
                      No purchase orders found for this job
                    </div>
                  )}

                  {materialsData.pos.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      {materialsData.pos.map((po) => (
                        <div key={po.receipt_id} style={{
                          border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 10,
                        }}>
                          {/* PO header */}
                          <div style={{
                            background: '#f8fafc', padding: '10px 14px',
                            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                          }}>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: 13, color: '#111827' }}>
                                PO #{po.display_number ?? po.receipt_id}
                              </div>
                              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                                {po.service_name && <span>{po.service_name} · </span>}
                                {po.vendor_name}
                                {po.received_date && <span> · {po.received_date}</span>}
                              </div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>
                                {po.total ? `$${Number(po.total).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                              </div>
                              {po.status && (
                                <span style={{
                                  fontSize: 10, fontWeight: 600, marginTop: 3, display: 'inline-block',
                                  padding: '1px 7px', borderRadius: 8,
                                  background: po.status.toLowerCase().includes('approved') ? '#dcfce7' : po.status.toLowerCase().includes('new') ? '#fef3c7' : '#f1f5f9',
                                  color: po.status.toLowerCase().includes('approved') ? '#15803d' : po.status.toLowerCase().includes('new') ? '#92400e' : '#475569',
                                }}>
                                  {po.status}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Note snippet */}
                          {po.note && (
                            <div style={{ padding: '6px 14px', fontSize: 11, color: '#6b7280', borderTop: '1px solid #f1f5f9', background: '#fff' }}>
                              {po.note}
                            </div>
                          )}


                          {/* Line items (if Aspire returns them) */}
                          {po.items.length > 0 && (
                            <div style={{ borderTop: '1px solid #f1f5f9' }}>
                              {/* Table header */}
                              <div style={{
                                display: 'grid', gridTemplateColumns: '1fr 56px 64px 64px',
                                padding: '5px 14px', background: '#f8fafc',
                                fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em',
                              }}>
                                <div>Item</div><div style={{ textAlign: 'right' }}>Qty</div>
                                <div style={{ textAlign: 'right' }}>Unit</div>
                                <div style={{ textAlign: 'right' }}>Total</div>
                              </div>
                              {po.items.map((item, idx) => (
                                <div key={idx} style={{
                                  display: 'grid', gridTemplateColumns: '1fr 56px 64px 64px',
                                  padding: '6px 14px',
                                  background: idx % 2 === 0 ? '#fff' : '#f9fafb',
                                  fontSize: 12, color: '#374151',
                                  borderTop: '1px solid #f1f5f9',
                                }}>
                                  <div style={{ paddingRight: 8 }}>{item.description}</div>
                                  <div style={{ textAlign: 'right', color: '#6b7280' }}>{item.quantity}</div>
                                  <div style={{ textAlign: 'right', color: '#6b7280' }}>
                                    {item.unit_cost ? `$${Number(item.unit_cost).toFixed(2)}` : '—'}
                                  </div>
                                  <div style={{ textAlign: 'right', fontWeight: 600 }}>
                                    {item.total ? `$${Number(item.total).toFixed(2)}` : '—'}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Tickets without any PO */}
                  {materialsData.tickets_without_po.length > 0 && (
                    <>
                      <div style={{ fontWeight: 700, fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                        Tickets Without PO
                      </div>
                      <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                        {materialsData.tickets_without_po.map((t, i) => (
                          <div key={t.WorkTicketID} style={{
                            padding: '11px 14px',
                            background: i % 2 === 0 ? '#fff' : '#f9fafb',
                            borderTop: i > 0 ? '1px solid #f1f5f9' : undefined,
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          }}>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
                                {t.ServiceName || `Ticket #${t.WorkTicketNumber}`}
                              </div>
                              <div style={{ fontSize: 11, color: '#9ca3af' }}>#{t.WorkTicketNumber}</div>
                            </div>
                            <a
                              href={`/field/purchase-order?oppId=${data.opportunity_id}&oppName=${encodeURIComponent(data.opportunity_name)}&propName=${encodeURIComponent(data.property_name || '')}&wtId=${t.WorkTicketID}&wtNum=${t.WorkTicketNumber}&svcName=${encodeURIComponent(t.ServiceName || '')}`}
                              style={{
                                padding: '7px 12px', background: '#16a34a', color: '#fff',
                                borderRadius: 8, fontSize: 12, fontWeight: 700,
                                textDecoration: 'none', whiteSpace: 'nowrap',
                              }}
                            >
                              ＋ Create PO
                            </a>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          )}

        </div>

        <div style={{ padding: '12px 16px', borderTop: '1px solid #f1f5f9', textAlign: 'center' }}>
          <span style={{ fontSize: 11, color: '#cbd5e1' }}>Darios Landscaping · Project Portal</span>
        </div>
      </div>

      {/* ── Change Order Modal ─────────────────────────────────────────────── */}
      {coOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: 480, maxHeight: '92vh', overflowY: 'auto', padding: '0 0 32px' }}>
            {/* Modal header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px 12px', borderBottom: '1px solid #f1f5f9', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a' }}>Change Order Request</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{data?.property_name || data?.opportunity_name}</div>
              </div>
              <button onClick={() => { setCoOpen(false); setCoMsg(''); }} style={{ background: 'none', border: 'none', fontSize: 22, color: '#9ca3af', cursor: 'pointer', lineHeight: 1, padding: 4 }}>×</button>
            </div>

            <form onSubmit={submitCO} style={{ padding: '16px 20px 0' }}>

              {/* Submitted by — employee dropdown */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 5 }}>Submitted By *</label>
                {empLoading ? (
                  <div style={{ fontSize: 13, color: '#9ca3af', padding: '8px 0' }}>Loading employees…</div>
                ) : (
                  <select
                    required
                    value={coName}
                    onChange={e => setCoName(e.target.value)}
                    style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #e2e6ed', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', color: coName ? '#1a1d23' : '#9ca3af', background: '#fff' }}
                  >
                    <option value="">— Select your name —</option>
                    {employees.map(emp => (
                      <option key={emp.id} value={emp.name}>{emp.name}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* Scope of work */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 5 }}>Scope of Change *</label>
                <textarea
                  required
                  placeholder="Describe the change order scope, reason, and any cost/time impact…"
                  value={coScope}
                  onChange={e => setCoScope(e.target.value)}
                  rows={5}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1.5px solid #e2e6ed', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', color: '#1a1d23', resize: 'vertical' }}
                />
              </div>

              {/* Assign to */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 5 }}>Assign To</label>
                {empLoading ? (
                  <div style={{ fontSize: 13, color: '#9ca3af', padding: '8px 0' }}>Loading employees…</div>
                ) : (
                  <select
                    value={coAssignee}
                    onChange={e => setCoAssignee(e.target.value)}
                    style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #e2e6ed', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', color: '#1a1d23', background: '#fff' }}
                  >
                    <option value="">— Unassigned —</option>
                    {employees.map(emp => (
                      <option key={emp.id} value={emp.id}>{emp.name}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* Photos / Videos */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 5 }}>Photos / Videos <span style={{ fontWeight: 400, color: '#9ca3af' }}>(optional, up to 10)</span></label>
                <input
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  onChange={e => setCoFiles(e.target.files)}
                  style={{ width: '100%', fontSize: 13, color: '#374151' }}
                />
                {coFiles && coFiles.length > 0 && (
                  <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
                    {Array.from(coFiles).map(f => f.name).join(', ')}
                  </div>
                )}
              </div>

              {/* Message */}
              {coMsg && (
                <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, background: coMsg.startsWith('✅') ? '#f0fdf4' : '#fef2f2', color: coMsg.startsWith('✅') ? '#15803d' : '#dc2626', fontSize: 13, fontWeight: 600 }}>
                  {coMsg}
                </div>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={coSubmitting || !coName.trim() || !coScope.trim()}
                style={{ width: '100%', padding: '13px', background: coSubmitting ? '#9ca3af' : '#1e3a2f', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: coSubmitting ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
              >
                {coSubmitting ? 'Submitting…' : 'Submit Change Order Request'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const SHELL: React.CSSProperties = {
  minHeight: '100vh',
  background: '#0f172a',
  padding: '16px 12px 48px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};

const CARD: React.CSSProperties = {
  maxWidth: 480,
  margin: '0 auto',
  background: '#fff',
  borderRadius: 16,
  overflow: 'hidden',
  boxShadow: '0 4px 24px rgba(0,0,0,.18)',
};

const HDR: React.CSSProperties = {
  background: '#14532d',
  padding: '22px 20px 18px',
};
const HDR_LABEL: React.CSSProperties = { color: '#86efac', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 };
const HDR_TITLE: React.CSSProperties = { color: '#fff', fontSize: 22, fontWeight: 800, lineHeight: 1.2 };
const HDR_SUB:   React.CSSProperties = { color: '#4ade80', fontSize: 13, marginTop: 4 };

const LABEL: React.CSSProperties = {
  display: 'block', fontWeight: 600, fontSize: 13, color: '#374151', marginBottom: 6,
};

const INPUT: React.CSSProperties = {
  width: '100%', padding: '11px 13px',
  border: '1.5px solid #e2e8f0', borderRadius: 10,
  fontSize: 15, color: '#0f172a', background: '#fff',
  boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit',
};
