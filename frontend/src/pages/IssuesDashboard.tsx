/**
 * IssuesDashboard.tsx — Ops manager view of all crew conversations.
 * Route: /ops/issues
 *
 * Shows all field conversations (maintenance + construction) in one place.
 * Filter by status, type, and tag. Expand a card to view the thread and reply.
 */

import { useEffect, useState } from 'react';

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
  property_name: string | null;
  title:         string;
  tag:           string | null;
  status:        string;
  created_by:    string | null;
  crew_whatsapp: string | null;
  message_count: number;
  last_message:  string | null;
  created_at:    string;
  updated_at:    string | null;
  resolved_at:   string | null;
}

interface Watcher {
  id:         number;
  user_id:    number | null;
  name:       string;
  whatsapp:   string;
  added_at:   string;
}

interface Message {
  id:           number;
  role:         string;
  crew_name:    string | null;
  content:      string;
  has_photo:    number;
  photo_url:    string | null;
  created_at:   string;
}

function fmtTime(dt: string | null) {
  if (!dt) return '';
  try {
    const iso = dt.includes('T') ? dt : dt.replace(' ', 'T') + 'Z';
    return new Date(iso).toLocaleString('en-CA', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return dt; }
}

function TagBadge({ tag }: { tag: string | null }) {
  if (!tag) return null;
  const c = TAG_COLORS[tag] || TAG_COLORS.Other;
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: c.bg, color: c.text }}>
      {tag}
    </span>
  );
}

function ContextBadge({ type }: { type: string }) {
  const isCon = type === 'construction';
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
      background: isCon ? '#fef3c7' : '#d1fae5',
      color: isCon ? '#92400e' : '#065f46',
    }}>
      {isCon ? '🏗️ Construction' : '🌿 Maintenance'}
    </span>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const role = msg.role;
  const isManager = role === 'manager';
  const isAi      = role === 'ai';
  const isCrew    = role === 'crew';

  const bg     = isManager ? '#fef3c7' : isAi ? '#eff6ff' : '#f0fdf4';
  const border  = isManager ? '#fde68a' : isAi ? '#bfdbfe' : '#bbf7d0';
  const nameColor = isManager ? '#92400e' : isAi ? '#1d4ed8' : '#15803d';
  const label  = isManager ? `👔 ${msg.crew_name || 'Manager'}` : isAi ? '🤖 Field Advisor' : (msg.crew_name || 'Crew');
  const align  = isManager || isAi ? 'flex-start' : 'flex-end';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align, marginBottom: 8 }}>
      <div style={{ maxWidth: '80%', background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: '8px 12px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: nameColor, marginBottom: 3 }}>{label}</div>
        <div style={{ fontSize: 13, color: '#1e293b', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{msg.content}</div>
        {msg.photo_url ? (
          <a href={msg.photo_url} target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginTop: 8 }}>
            <img
              src={msg.photo_url}
              alt="Attached photo"
              style={{
                maxWidth: '100%', maxHeight: 300,
                borderRadius: 8, border: '1px solid rgba(0,0,0,0.1)',
                display: 'block', cursor: 'zoom-in',
              }}
            />
            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>📷 tap to open full size</div>
          </a>
        ) : msg.has_photo ? (
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>📷 photo</div>
        ) : null}
      </div>
      <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{fmtTime(msg.created_at)}</div>
    </div>
  );
}

// ── Conversation card with inline thread ──────────────────────────────────────
function ConversationCard({
  conv,
  managerName,
  availableUsers,
  onResolved,
}: {
  conv: Conversation;
  managerName: string;
  availableUsers: { id: number; name: string; phone: string | null }[];
  onResolved: (id: number) => void;
}) {
  const [expanded,     setExpanded]     = useState(false);
  const [messages,     setMessages]     = useState<Message[]>([]);
  const [watchers,     setWatchers]     = useState<Watcher[]>([]);
  const [loadingMsgs,  setLoadingMsgs]  = useState(false);
  const [replyText,    setReplyText]    = useState('');
  const [sending,      setSending]      = useState(false);
  const [resolving,    setResolving]    = useState(false);
  const [localStatus,  setLocalStatus]  = useState(conv.status);
  const [addingWatcher,setAddingWatcher]= useState(false);
  const [selectedUser, setSelectedUser] = useState('');

  const isOpen = localStatus === 'open';

  // Users with phones who aren't already watching
  const watchableUsers = availableUsers.filter(
    u => u.phone && !watchers.some(w => w.user_id === u.id)
  );

  async function loadThread() {
    if (messages.length > 0) { setExpanded(v => !v); return; }
    setExpanded(true);
    setLoadingMsgs(true);
    try {
      const r = await fetch(`${API}/field/conversations/${conv.opp_id}/${conv.id}`);
      const d = await r.json();
      setMessages(d.messages || []);
      setWatchers(d.watchers || []);
    } catch {}
    finally { setLoadingMsgs(false); }
  }

  async function addWatcher() {
    if (!selectedUser) return;
    const user = availableUsers.find(u => u.id === Number(selectedUser));
    if (!user || !user.phone) return;
    setAddingWatcher(true);
    try {
      const form = new FormData();
      form.append('user_id', String(user.id));
      form.append('name', user.name);
      form.append('whatsapp', user.phone);
      const r = await fetch(`${API}/field/conversations/${conv.opp_id}/${conv.id}/watchers`, { method: 'POST', body: form });
      const d = await r.json();
      setWatchers(prev => [...prev, d]);
      setSelectedUser('');
    } catch {}
    finally { setAddingWatcher(false); }
  }

  async function removeWatcher(watcherId: number) {
    await fetch(`${API}/field/conversations/${conv.opp_id}/${conv.id}/watchers/${watcherId}`, { method: 'DELETE' });
    setWatchers(prev => prev.filter(w => w.id !== watcherId));
  }

  async function sendReply() {
    if (!replyText.trim()) return;
    setSending(true);
    try {
      const form = new FormData();
      form.append('content', replyText.trim());
      form.append('sender_role', 'manager');
      form.append('manager_name', managerName || 'Manager');
      const res = await fetch(`${API}/field/conversations/${conv.opp_id}/${conv.id}/messages`, {
        method: 'POST', body: form,
      });
      if (!res.ok) throw new Error('Failed');
      setMessages(prev => [...prev, {
        id: Date.now(), role: 'manager',
        crew_name: managerName || 'Manager',
        content: replyText.trim(), has_photo: 0,
        photo_url: null,
        created_at: new Date().toISOString(),
      }]);
      setReplyText('');
    } catch {
      alert('Could not send reply. Try again.');
    } finally {
      setSending(false);
    }
  }

  async function toggleResolved() {
    setResolving(true);
    const endpoint = isOpen ? 'resolve' : 'reopen';
    try {
      await fetch(`${API}/field/conversations/${conv.opp_id}/${conv.id}/${endpoint}`, { method: 'PATCH' });
      const next = isOpen ? 'resolved' : 'open';
      setLocalStatus(next);
      if (next === 'resolved') onResolved(conv.id);
    } catch {}
    finally { setResolving(false); }
  }

  return (
    <div style={{
      background: '#fff', border: '1px solid #e2e6ed', borderRadius: 12,
      borderLeft: `4px solid ${isOpen ? '#16a34a' : '#d1d5db'}`,
      opacity: isOpen ? 1 : 0.8,
    }}>
      {/* Card header */}
      <div style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
              <ContextBadge type={conv.context_type} />
              <TagBadge tag={conv.tag} />
              {!isOpen && (
                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: '#f3f4f6', color: '#6b7280' }}>
                  ✓ Resolved
                </span>
              )}
            </div>
            {/* Property name + contract link */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
              <span style={{ fontWeight: 800, fontSize: 15, color: '#111827' }}>
                {conv.property_name || `Opp #${conv.opp_id}`}
              </span>
              <a
                href={`/field/${conv.context_type === 'construction' ? 'project' : 'maintenance'}/${conv.opp_id}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 11, fontWeight: 600, color: '#2563eb',
                  textDecoration: 'none', padding: '1px 7px',
                  border: '1px solid #bfdbfe', borderRadius: 6,
                  background: '#eff6ff', whiteSpace: 'nowrap',
                }}
              >
                View Contract ↗
              </a>
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{conv.title}</div>
            {conv.last_message && (
              <div style={{ fontSize: 13, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 500 }}>
                {conv.last_message}
              </div>
            )}
            <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 12, color: '#9ca3af', flexWrap: 'wrap' }}>
              {conv.created_by && <span>👤 {conv.created_by}</span>}
              {conv.crew_whatsapp && <span>📱 {conv.crew_whatsapp}</span>}
              <span>💬 {conv.message_count} message{conv.message_count !== 1 ? 's' : ''}</span>
              <span>🕐 {fmtTime(conv.updated_at || conv.created_at)}</span>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
            <button
              onClick={loadThread}
              style={{
                padding: '6px 14px', background: isOpen ? '#0f4c75' : '#f3f4f6',
                color: isOpen ? '#fff' : '#6b7280',
                border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700,
                cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
              }}
            >
              {expanded ? '▲ Hide thread' : '▼ View & Reply'}
            </button>
            <button
              onClick={toggleResolved}
              disabled={resolving}
              style={{
                padding: '5px 14px',
                background: isOpen ? '#f0fdf4' : '#fff',
                color: isOpen ? '#15803d' : '#6b7280',
                border: `1px solid ${isOpen ? '#86efac' : '#e2e6ed'}`,
                borderRadius: 8, fontSize: 11, fontWeight: 700,
                cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
              }}
            >
              {isOpen ? '✓ Resolve' : '↺ Reopen'}
            </button>
          </div>
        </div>
      </div>

      {/* Thread panel */}
      {expanded && (
        <div style={{ borderTop: '1px solid #e2e6ed', padding: '14px 16px', background: '#fafafa', borderRadius: '0 0 12px 12px' }}>
          {loadingMsgs && <div style={{ textAlign: 'center', padding: '12px 0', color: '#9ca3af', fontSize: 13 }}>Loading thread…</div>}

          {messages.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              {messages.map((m, i) => <MessageBubble key={m.id || i} msg={m} />)}
            </div>
          )}

          {/* Watchers section */}
          <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e6ed' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              👁️ Watching ({watchers.length})
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: watchableUsers.length > 0 ? 8 : 0 }}>
              {watchers.length === 0 && (
                <span style={{ fontSize: 12, color: '#9ca3af' }}>Nobody watching — add managers below</span>
              )}
              {watchers.map(w => (
                <span key={w.id} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: '#dbeafe', color: '#1d4ed8', fontSize: 12, fontWeight: 600,
                  padding: '3px 8px', borderRadius: 20,
                }}>
                  📱 {w.name}
                  <button
                    onClick={() => removeWatcher(w.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#93c5fd', fontSize: 13, lineHeight: 1, padding: 0 }}
                    title="Remove"
                  >×</button>
                </span>
              ))}
            </div>
            {watchableUsers.length > 0 && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select
                  value={selectedUser}
                  onChange={e => setSelectedUser(e.target.value)}
                  style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, color: '#374151', background: '#fff' }}
                >
                  <option value="">+ Add watcher…</option>
                  {watchableUsers.map(u => (
                    <option key={u.id} value={u.id}>{u.name} ({u.phone})</option>
                  ))}
                </select>
                <button
                  onClick={addWatcher}
                  disabled={!selectedUser || addingWatcher}
                  style={{
                    padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 700,
                    background: !selectedUser || addingWatcher ? '#e5e7eb' : '#2563eb',
                    color: !selectedUser || addingWatcher ? '#9ca3af' : '#fff',
                    cursor: !selectedUser || addingWatcher ? 'default' : 'pointer',
                  }}
                >
                  Add
                </button>
              </div>
            )}
          </div>

          {isOpen && (
            <div style={{ background: '#fff', border: '1px solid #e2e6ed', borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                Reply as {managerName || 'Manager'}
                {conv.crew_whatsapp && <span style={{ fontWeight: 400, textTransform: 'none', marginLeft: 6, color: '#9ca3af' }}>— crew will be notified by WhatsApp</span>}
              </div>
              <textarea
                value={replyText}
                onChange={e => setReplyText(e.target.value)}
                placeholder="Type your reply…"
                rows={3}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '9px 12px',
                  border: '1.5px solid #d1d5db', borderRadius: 8,
                  fontSize: 14, color: '#1a1d23', background: '#fff',
                  fontFamily: 'inherit', resize: 'vertical', outline: 'none', marginBottom: 8,
                }}
              />
              <button
                onClick={sendReply}
                disabled={sending || !replyText.trim()}
                style={{
                  padding: '9px 20px',
                  background: sending || !replyText.trim() ? '#e5e7eb' : '#0f4c75',
                  color: sending || !replyText.trim() ? '#9ca3af' : '#fff',
                  border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700,
                  cursor: sending || !replyText.trim() ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {sending ? 'Sending…' : 'Send Reply'}
              </button>
            </div>
          )}

          {!isOpen && (
            <div style={{ textAlign: 'center', fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>
              Conversation resolved — reopen to reply.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function IssuesDashboard() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading]             = useState(true);
  const [status,  setStatus]              = useState('open');
  const [ctxType, setCtxType]             = useState('all');
  const [tag,     setTag]                 = useState('all');
  const [search,  setSearch]              = useState('');
  const [availableUsers, setAvailableUsers] = useState<{ id: number; name: string; phone: string | null }[]>([]);

  // Use the logged-in user's name from ap_user JSON (set at login)
  const managerName = (() => {
    try { return JSON.parse(localStorage.getItem('ap_user') || '{}').name || localStorage.getItem('user_name') || 'Manager'; }
    catch { return localStorage.getItem('user_name') || 'Manager'; }
  })();

  // Load users with phones for the watcher add dropdown
  useEffect(() => {
    const token = localStorage.getItem('ap_token') || localStorage.getItem('auth_token');
    if (!token) return;
    fetch(`${API}/auth/users`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setAvailableUsers(
        (d.users || []).filter((u: { active: number | boolean; phone: string | null }) => u.active && u.phone)
      ))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ status, context_type: ctxType, tag });
    fetch(`${API}/field/conversations/all/dashboard?${params}`)
      .then(r => r.json())
      .then(d => setConversations(d.conversations || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [status, ctxType, tag]);

  // When a conversation is resolved via the card, hide it if we're in 'open' view
  function handleResolved(id: number) {
    if (status === 'open') {
      setConversations(prev => prev.filter(c => c.id !== id));
    }
  }

  const q = search.trim().toLowerCase();
  const filtered = q
    ? conversations.filter(c =>
        (c.property_name || '').toLowerCase().includes(q) ||
        (c.title || '').toLowerCase().includes(q) ||
        (c.created_by || '').toLowerCase().includes(q) ||
        (c.last_message || '').toLowerCase().includes(q)
      )
    : conversations;

  const open     = filtered.filter(c => c.status === 'open').length;
  const resolved = filtered.filter(c => c.status !== 'open').length;

  return (
    <div style={{ padding: '24px 24px 48px', maxWidth: 900, margin: '0 auto', fontFamily: "'DM Sans', sans-serif" }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <a href="/" style={{ color: '#6b7280', fontSize: 13, textDecoration: 'none' }}>← Home</a>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: '#111827' }}>💬 Field Issues</h1>
            <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>
              All crew conversations across maintenance and construction
            </p>
          </div>
          {/* Shows logged-in user name */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f3f4f6', borderRadius: 8, padding: '6px 12px' }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Replying as</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{managerName}</span>
            <a href="/users" style={{ fontSize: 11, color: '#9ca3af', textDecoration: 'none', marginLeft: 4 }}>✎</a>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Open',     value: open,            color: '#16a34a', bg: '#f0fdf4' },
          { label: 'Resolved', value: resolved,         color: '#6b7280', bg: '#f9fafb' },
          { label: 'Total',    value: filtered.length,  color: '#0369a1', bg: '#eff6ff' },
        ].map(s => (
          <div key={s.label} style={{ flex: 1, background: s.bg, borderRadius: 10, padding: '12px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: 8, padding: 3, gap: 2 }}>
          {['open', 'resolved', 'all'].map(s => (
            <button key={s} onClick={() => setStatus(s)} style={{
              padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600,
              background: status === s ? '#fff' : 'transparent',
              color: status === s ? '#111827' : '#6b7280',
              boxShadow: status === s ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize',
            }}>{s === 'all' ? 'All status' : s.charAt(0).toUpperCase() + s.slice(1)}</button>
          ))}
        </div>

        <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: 8, padding: 3, gap: 2 }}>
          {[['all', 'All types'], ['maintenance', '🌿 Maintenance'], ['construction', '🏗️ Construction']].map(([v, l]) => (
            <button key={v} onClick={() => setCtxType(v)} style={{
              padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600,
              background: ctxType === v ? '#fff' : 'transparent',
              color: ctxType === v ? '#111827' : '#6b7280',
              boxShadow: ctxType === v ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              cursor: 'pointer', fontFamily: 'inherit',
            }}>{l}</button>
          ))}
        </div>

        <select
          value={tag}
          onChange={e => setTag(e.target.value)}
          style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #e2e6ed', fontSize: 12, color: '#374151', background: '#fff', fontFamily: 'inherit', cursor: 'pointer' }}
        >
          <option value="all">All tags</option>
          {TAGS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 16 }}>
        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }}>🔍</span>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by property, title, crew name…"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '9px 12px 9px 36px',
            border: '1.5px solid #e2e6ed', borderRadius: 10, fontSize: 14,
            color: '#1a1d23', fontFamily: 'inherit', outline: 'none',
          }}
        />
      </div>

      {/* List */}
      {loading && <div style={{ textAlign: 'center', padding: '32px 0', color: '#6b7280' }}>Loading conversations…</div>}

      {!loading && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 0', color: '#9ca3af' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>💬</div>
          <div style={{ fontWeight: 600, color: '#374151' }}>No conversations found</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.map(c => (
          <ConversationCard
            key={c.id}
            conv={c}
            managerName={managerName}
            availableUsers={availableUsers}
            onResolved={handleResolved}
          />
        ))}
      </div>
    </div>
  );
}
