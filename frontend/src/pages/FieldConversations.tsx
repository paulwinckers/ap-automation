/**
 * FieldConversations.tsx — Shared crew conversation component.
 * Used in both FieldMaintenance (tab: Conversations) and FieldProject (tab: Conversations).
 *
 * Features:
 *  - Threaded conversations per property/project
 *  - Tags: Irrigation, Turf, Pest, Safety, Materials, Schedule, Quality, Other
 *  - Optional AI assist on any message
 *  - Resolved conversations collapsed by default
 *  - Crew name persisted to localStorage
 */

import { useEffect, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? '';

const TAGS = ['Irrigation', 'Turf', 'Pest', 'Safety', 'Materials', 'Schedule', 'Quality', 'Other'];

const TAG_COLORS: Record<string, { bg: string; text: string }> = {
  Irrigation: { bg: '#dbeafe', text: '#1d4ed8' },
  Turf:       { bg: '#dcfce7', text: '#15803d' },
  Pest:       { bg: '#fef9c3', text: '#854d0e' },
  Safety:     { bg: '#fee2e2', text: '#dc2626' },
  Materials:  { bg: '#f3e8ff', text: '#7e22ce' },
  Schedule:   { bg: '#ffedd5', text: '#c2410c' },
  Quality:    { bg: '#e0f2fe', text: '#0369a1' },
  Other:      { bg: '#f3f4f6', text: '#374151' },
};

interface Conversation {
  id:            number;
  opp_id:        number;
  context_type:  string;
  title:         string;
  tag:           string | null;
  status:        string;
  created_by:    string | null;
  message_count: number;
  last_message:  string | null;
  created_at:    string;
  resolved_at:   string | null;
}

interface Message {
  id:              number;
  conversation_id: number;
  role:            'crew' | 'ai';
  crew_name:       string | null;
  content:         string;
  has_photo:       number;
  photo_r2_key:    string | null;
  created_at:      string;
}

function fmtTime(dt: string) {
  if (!dt) return '';
  try {
    return new Date(dt + (dt.includes('T') ? '' : 'T00:00:00Z')).toLocaleString('en-CA', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return dt; }
}

function TagBadge({ tag }: { tag: string | null }) {
  if (!tag) return null;
  const c = TAG_COLORS[tag] || TAG_COLORS.Other;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: c.bg, color: c.text, flexShrink: 0 }}>
      {tag}
    </span>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  oppId:        number;
  contextType:  'maintenance' | 'construction';
  propertyName: string;
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function FieldConversations({ oppId, contextType, propertyName }: Props) {
  const [crewName, setCrewName] = useState<string>(() => localStorage.getItem('fieldCrewName') || '');
  const [view, setView]         = useState<'list' | 'new' | 'thread'>('list');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingList, setLoadingList]     = useState(true);
  const [showResolved, setShowResolved]   = useState(false);

  // New conversation form
  const [newTitle,   setNewTitle]   = useState('');
  const [newTag,     setNewTag]     = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [newPhoto,   setNewPhoto]   = useState<File | null>(null);
  const [newPreview, setNewPreview] = useState<string | null>(null);
  const [creating,   setCreating]   = useState(false);

  // Thread view
  const [activeConv,    setActiveConv]    = useState<Conversation | null>(null);
  const [messages,      setMessages]      = useState<Message[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [msgText,       setMsgText]       = useState('');
  const [msgPhoto,      setMsgPhoto]      = useState<File | null>(null);
  const [msgPreview,    setMsgPreview]    = useState<string | null>(null);
  const [sending,       setSending]       = useState(false);
  const [aiLoading,     setAiLoading]     = useState(false);
  const [resolving,     setResolving]     = useState(false);

  const cameraRef  = useRef<HTMLInputElement>(null);
  const msgCamRef  = useRef<HTMLInputElement>(null);
  const bottomRef  = useRef<HTMLDivElement>(null);

  // Load conversation list
  useEffect(() => {
    if (view === 'list') {
      setLoadingList(true);
      fetch(`${API}/field/conversations/${oppId}?context_type=${contextType}`)
        .then(r => r.json())
        .then(d => setConversations(d.conversations || []))
        .catch(() => {})
        .finally(() => setLoadingList(false));
    }
  }, [oppId, contextType, view]);

  // Scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function handleCrewNameChange(v: string) {
    setCrewName(v);
    localStorage.setItem('fieldCrewName', v);
  }

  function handleNewPhotoChange(file: File | null) {
    setNewPhoto(file);
    if (file) {
      const url = URL.createObjectURL(file);
      setNewPreview(url);
    } else {
      setNewPreview(null);
    }
  }

  function handleMsgPhotoChange(file: File | null) {
    setMsgPhoto(file);
    if (file) {
      const url = URL.createObjectURL(file);
      setMsgPreview(url);
    } else {
      setMsgPreview(null);
    }
  }

  async function openThread(conv: Conversation) {
    setActiveConv(conv);
    setView('thread');
    setLoadingThread(true);
    setMsgText('');
    setMsgPhoto(null);
    setMsgPreview(null);
    try {
      const r = await fetch(`${API}/field/conversations/${oppId}/${conv.id}`);
      const d = await r.json();
      setMessages(d.messages || []);
    } catch {}
    finally { setLoadingThread(false); }
  }

  async function createConversation(useAi: boolean) {
    if (!newTitle.trim() || !newMessage.trim()) return;
    setCreating(true);
    try {
      const form = new FormData();
      form.append('title', newTitle.trim());
      form.append('context_type', contextType);
      form.append('first_message', newMessage.trim());
      form.append('use_ai', useAi ? '1' : '0');
      if (newTag) form.append('tag', newTag);
      if (crewName.trim()) form.append('crew_name', crewName.trim());
      form.append('property_name', propertyName);
      if (newPhoto) form.append('photo', newPhoto);

      const res = await fetch(`${API}/field/conversations/${oppId}`, { method: 'POST', body: form });
      const d   = await res.json();
      if (!res.ok) throw new Error('Failed to create');

      // Open the new thread
      const newConv: Conversation = {
        id: d.conv_id, opp_id: oppId, context_type: contextType,
        title: newTitle.trim(), tag: newTag, status: 'open',
        created_by: crewName || null, message_count: useAi ? 2 : 1,
        last_message: newMessage.trim(), created_at: new Date().toISOString(),
        resolved_at: null,
      };
      setActiveConv(newConv);
      const msgs: Message[] = [{
        id: 0, conversation_id: d.conv_id, role: 'crew', crew_name: crewName || null,
        content: newMessage.trim(), has_photo: newPhoto ? 1 : 0, photo_r2_key: null,
        created_at: new Date().toISOString(),
      }];
      if (d.ai_response) {
        msgs.push({
          id: 1, conversation_id: d.conv_id, role: 'ai', crew_name: 'Field Advisor',
          content: d.ai_response, has_photo: 0, photo_r2_key: null,
          created_at: new Date().toISOString(),
        });
      }
      setMessages(msgs);
      setNewTitle(''); setNewTag(null); setNewMessage(''); handleNewPhotoChange(null);
      setView('thread');
    } catch (e) {
      alert('Could not create conversation. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  async function sendMessage(useAi: boolean) {
    if (!msgText.trim() || !activeConv) return;
    useAi ? setAiLoading(true) : setSending(true);
    try {
      const form = new FormData();
      form.append('content', msgText.trim());
      form.append('use_ai', useAi ? '1' : '0');
      if (crewName.trim()) form.append('crew_name', crewName.trim());
      if (msgPhoto) form.append('photo', msgPhoto);

      const res = await fetch(`${API}/field/conversations/${oppId}/${activeConv.id}/messages`, {
        method: 'POST', body: form,
      });
      const d = await res.json();
      if (!res.ok) throw new Error('Failed');

      const crewMsg: Message = {
        id: Date.now(), conversation_id: activeConv.id, role: 'crew',
        crew_name: crewName || null, content: msgText.trim(),
        has_photo: msgPhoto ? 1 : 0, photo_r2_key: null,
        created_at: new Date().toISOString(),
      };
      const newMsgs = [...messages, crewMsg];
      if (d.ai_response) {
        newMsgs.push({
          id: Date.now() + 1, conversation_id: activeConv.id, role: 'ai',
          crew_name: 'Field Advisor', content: d.ai_response,
          has_photo: 0, photo_r2_key: null, created_at: new Date().toISOString(),
        });
      }
      setMessages(newMsgs);
      setMsgText('');
      handleMsgPhotoChange(null);
    } catch {
      alert('Could not send message. Please try again.');
    } finally {
      setSending(false);
      setAiLoading(false);
    }
  }

  async function resolveConversation() {
    if (!activeConv) return;
    setResolving(true);
    try {
      await fetch(`${API}/field/conversations/${oppId}/${activeConv.id}/resolve`, { method: 'PATCH' });
      setActiveConv(prev => prev ? { ...prev, status: 'resolved' } : prev);
    } catch {} finally { setResolving(false); }
  }

  async function reopenConversation() {
    if (!activeConv) return;
    try {
      await fetch(`${API}/field/conversations/${oppId}/${activeConv.id}/reopen`, { method: 'PATCH' });
      setActiveConv(prev => prev ? { ...prev, status: 'open' } : prev);
    } catch {}
  }

  // ── Render: LIST ──────────────────────────────────────────────────────────
  if (view === 'list') {
    const open     = conversations.filter(c => c.status === 'open');
    const resolved = conversations.filter(c => c.status !== 'open');

    return (
      <div>
        {/* Crew name */}
        <div style={S.section}>
          <div style={S.label}>Your name</div>
          <input
            value={crewName}
            onChange={e => handleCrewNameChange(e.target.value)}
            placeholder="e.g. Mike S."
            style={S.input}
          />
        </div>

        {/* New conversation button */}
        <button onClick={() => setView('new')} style={S.newBtn}>
          + Start New Conversation
        </button>

        {loadingList && (
          <div style={{ textAlign: 'center', padding: '20px 0', color: '#6b7280', fontSize: 13 }}>
            Loading conversations…
          </div>
        )}

        {!loadingList && open.length === 0 && resolved.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px 16px', color: '#9ca3af' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>💬</div>
            <div style={{ fontWeight: 600, color: '#374151' }}>No conversations yet</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Start one to log an issue or ask a question.</div>
          </div>
        )}

        {open.map(c => <ConvCard key={c.id} conv={c} onClick={() => openThread(c)} />)}

        {resolved.length > 0 && (
          <>
            <button
              onClick={() => setShowResolved(v => !v)}
              style={{ width: '100%', padding: '10px 14px', background: '#fff', border: '1px solid #e2e6ed', borderRadius: 10, marginTop: 8, fontSize: 13, color: '#6b7280', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
            >
              {showResolved ? '▲ Hide' : '▼ Show'} resolved ({resolved.length})
            </button>
            {showResolved && resolved.map(c => <ConvCard key={c.id} conv={c} onClick={() => openThread(c)} />)}
          </>
        )}
      </div>
    );
  }

  // ── Render: NEW CONVERSATION ───────────────────────────────────────────────
  if (view === 'new') {
    return (
      <div>
        <button onClick={() => setView('list')} style={S.backBtn}>← Back</button>

        <div style={S.section}>
          <div style={S.sectionTitle}>💬 New Conversation</div>

          <div style={S.label}>Your name</div>
          <input
            value={crewName}
            onChange={e => handleCrewNameChange(e.target.value)}
            placeholder="e.g. Mike S."
            style={{ ...S.input, marginBottom: 12 }}
          />

          <div style={S.label}>Topic / title *</div>
          <input
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            placeholder="e.g. Turf yellowing south section"
            style={{ ...S.input, marginBottom: 12 }}
          />

          <div style={S.label}>Category (optional)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {TAGS.map(t => {
              const c = TAG_COLORS[t];
              const sel = newTag === t;
              return (
                <button
                  key={t}
                  onClick={() => setNewTag(sel ? null : t)}
                  style={{
                    padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                    border: sel ? `2px solid ${c.text}` : '1.5px solid #e2e6ed',
                    background: sel ? c.bg : '#fff', color: sel ? c.text : '#6b7280',
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >{t}</button>
              );
            })}
          </div>

          <div style={S.label}>First message *</div>
          <textarea
            value={newMessage}
            onChange={e => setNewMessage(e.target.value)}
            placeholder="Describe the issue or question…"
            rows={4}
            style={{ ...S.input, resize: 'vertical' }}
          />

          {/* Photo */}
          <input type="file" accept="image/*" capture="environment" ref={cameraRef}
            style={{ display: 'none' }}
            onChange={e => handleNewPhotoChange(e.target.files?.[0] || null)}
          />
          {newPreview && (
            <div style={{ marginTop: 8, position: 'relative', display: 'inline-block' }}>
              <img src={newPreview} alt="Preview" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid #e2e6ed' }} />
              <button onClick={() => handleNewPhotoChange(null)}
                style={{ position: 'absolute', top: -6, right: -6, background: '#ef4444', color: '#fff', border: 'none', borderRadius: '50%', width: 20, height: 20, fontSize: 11, cursor: 'pointer' }}>×</button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, marginBottom: 14 }}>
            <button onClick={() => cameraRef.current?.click()} style={S.photoBtn}>📷 Photo</button>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => createConversation(false)}
              disabled={creating || !newTitle.trim() || !newMessage.trim()}
              style={{ ...S.btn, flex: 1, background: '#0f4c75' }}
            >
              {creating ? 'Saving…' : 'Send'}
            </button>
            <button
              onClick={() => createConversation(true)}
              disabled={creating || !newTitle.trim() || !newMessage.trim()}
              style={{ ...S.btn, flex: 1.4, background: '#1d4ed8' }}
            >
              {creating ? 'Asking AI…' : '🤖 Send & Ask AI'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: THREAD ─────────────────────────────────────────────────────────
  const conv = activeConv!;
  const isResolved = conv.status === 'resolved';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Thread header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
        <button onClick={() => setView('list')} style={S.backBtn}>← Back</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>{conv.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <TagBadge tag={conv.tag} />
            {conv.created_by && <span style={{ fontSize: 11, color: '#9ca3af' }}>by {conv.created_by}</span>}
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
              background: isResolved ? '#f3f4f6' : '#dcfce7',
              color: isResolved ? '#6b7280' : '#15803d',
            }}>
              {isResolved ? 'Resolved' : 'Open'}
            </span>
          </div>
        </div>
        <button
          onClick={isResolved ? reopenConversation : resolveConversation}
          disabled={resolving}
          style={{
            flexShrink: 0, padding: '5px 11px', borderRadius: 8, fontSize: 11, fontWeight: 700,
            border: '1.5px solid', cursor: 'pointer', fontFamily: 'inherit',
            background: isResolved ? '#f0fdf4' : '#fff',
            borderColor: isResolved ? '#86efac' : '#e2e6ed',
            color: isResolved ? '#15803d' : '#6b7280',
          }}
        >
          {isResolved ? '↺ Reopen' : '✓ Resolve'}
        </button>
      </div>

      {/* Messages */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {loadingThread && (
          <div style={{ textAlign: 'center', padding: '20px 0', color: '#6b7280', fontSize: 13 }}>Loading thread…</div>
        )}
        {messages.map((msg, i) => {
          const isAi = msg.role === 'ai';
          return (
            <div key={msg.id || i} style={{ display: 'flex', flexDirection: 'column', alignItems: isAi ? 'flex-start' : 'flex-end' }}>
              <div style={{
                maxWidth: '88%',
                background: isAi ? '#eff6ff' : '#f0fdf4',
                border: `1px solid ${isAi ? '#bfdbfe' : '#bbf7d0'}`,
                borderRadius: isAi ? '4px 12px 12px 12px' : '12px 4px 12px 12px',
                padding: '10px 12px',
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: isAi ? '#1d4ed8' : '#15803d', marginBottom: 4 }}>
                  {isAi ? '🤖 Field Advisor' : (msg.crew_name || 'Crew')}
                </div>
                <div style={{ fontSize: 13, color: '#1e293b', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                  {msg.content}
                </div>
                {msg.has_photo ? <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>📷 photo attached</div> : null}
              </div>
              <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, paddingLeft: 4, paddingRight: 4 }}>
                {fmtTime(msg.created_at)}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      {!isResolved && (
        <div style={{ background: '#fff', border: '1px solid #e2e6ed', borderRadius: 12, padding: 12 }}>
          <textarea
            value={msgText}
            onChange={e => setMsgText(e.target.value)}
            placeholder="Add a message…"
            rows={3}
            style={{ ...S.input, marginBottom: 8, resize: 'none' }}
          />

          <input type="file" accept="image/*" capture="environment" ref={msgCamRef}
            style={{ display: 'none' }}
            onChange={e => handleMsgPhotoChange(e.target.files?.[0] || null)}
          />
          {msgPreview && (
            <div style={{ marginBottom: 8, position: 'relative', display: 'inline-block' }}>
              <img src={msgPreview} alt="Preview" style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 6, border: '1px solid #e2e6ed' }} />
              <button onClick={() => handleMsgPhotoChange(null)}
                style={{ position: 'absolute', top: -5, right: -5, background: '#ef4444', color: '#fff', border: 'none', borderRadius: '50%', width: 18, height: 18, fontSize: 10, cursor: 'pointer' }}>×</button>
            </div>
          )}

          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => msgCamRef.current?.click()} style={{ ...S.photoBtn, padding: '8px 10px' }}>📷</button>
            <button
              onClick={() => sendMessage(false)}
              disabled={sending || aiLoading || !msgText.trim()}
              style={{ ...S.btn, flex: 1, background: '#374151', fontSize: 12 }}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
            <button
              onClick={() => sendMessage(true)}
              disabled={sending || aiLoading || !msgText.trim()}
              style={{ ...S.btn, flex: 1.5, background: '#1d4ed8', fontSize: 12 }}
            >
              {aiLoading ? 'Asking AI…' : '🤖 Ask AI'}
            </button>
          </div>
        </div>
      )}

      {isResolved && (
        <div style={{ textAlign: 'center', fontSize: 12, color: '#9ca3af', padding: '12px 0' }}>
          This conversation is resolved. Tap "Reopen" to add more messages.
        </div>
      )}
    </div>
  );
}

// ── Conversation card ─────────────────────────────────────────────────────────
function ConvCard({ conv, onClick }: { conv: Conversation; onClick: () => void }) {
  const isResolved = conv.status !== 'open';
  return (
    <div onClick={onClick} style={{ ...S.card, cursor: 'pointer', opacity: isResolved ? 0.75 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>{conv.title}</div>
        </div>
        <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
          <TagBadge tag={conv.tag} />
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
            background: isResolved ? '#f3f4f6' : '#dcfce7',
            color: isResolved ? '#6b7280' : '#15803d',
          }}>
            {isResolved ? '✓ Done' : 'Open'}
          </span>
        </div>
      </div>
      {conv.last_message && (
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {conv.last_message}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#9ca3af' }}>
        {conv.created_by && <span>👤 {conv.created_by}</span>}
        <span>💬 {conv.message_count}</span>
        <span>{fmtTime(conv.created_at)}</span>
        <span style={{ marginLeft: 'auto', color: '#9ca3af' }}>›</span>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  section:     { background: '#fff', border: '1px solid #e2e6ed', borderRadius: 12, padding: 14, marginBottom: 10 },
  card:        { background: '#fff', border: '1px solid #e2e6ed', borderRadius: 12, padding: 14, marginBottom: 8 },
  sectionTitle:{ fontSize: 13, fontWeight: 700, color: '#1e293b', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '.05em' },
  label:       { fontSize: 11, fontWeight: 700, color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.05em' },
  input: {
    width: '100%', boxSizing: 'border-box' as const,
    padding: '9px 12px', border: '1.5px solid #d1d5db', borderRadius: 8,
    fontSize: 14, color: '#1a1d23', background: '#fff',
    fontFamily: 'inherit', outline: 'none',
  },
  btn: {
    padding: '10px 0', border: 'none', borderRadius: 8,
    color: '#fff', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
  },
  newBtn: {
    width: '100%', padding: '12px 16px', marginBottom: 12,
    background: '#0f4c75', color: '#fff', border: 'none', borderRadius: 10,
    fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
    textAlign: 'left' as const,
  },
  backBtn: {
    padding: '6px 12px', background: '#f3f4f6', border: '1px solid #e2e6ed',
    borderRadius: 8, fontSize: 12, color: '#374151', cursor: 'pointer',
    fontFamily: 'inherit', marginBottom: 12, flexShrink: 0,
  },
  photoBtn: {
    padding: '8px 14px', background: '#f3f4f6', border: '1px solid #e2e6ed',
    borderRadius: 8, fontSize: 12, color: '#374151', cursor: 'pointer', fontFamily: 'inherit',
  },
};
