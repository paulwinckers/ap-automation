/**
 * IssuesDashboard.tsx — Ops manager view of all crew conversations.
 * Route: /ops/issues
 *
 * Shows all field conversations (maintenance + construction) in one place.
 * Filter by status, type, and tag. Tap to open in the field portal.
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
  message_count: number;
  last_message:  string | null;
  created_at:    string;
  updated_at:    string | null;
  resolved_at:   string | null;
}

function fmtTime(dt: string | null) {
  if (!dt) return '';
  try {
    return new Date(dt.includes('T') ? dt : dt + 'Z').toLocaleString('en-CA', {
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

export default function IssuesDashboard() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading]             = useState(true);
  const [status,  setStatus]              = useState('open');
  const [ctxType, setCtxType]             = useState('all');
  const [tag,     setTag]                 = useState('all');
  const [search,  setSearch]              = useState('');

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ status, context_type: ctxType, tag });
    fetch(`${API}/field/conversations/all/dashboard?${params}`)
      .then(r => r.json())
      .then(d => setConversations(d.conversations || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [status, ctxType, tag]);

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

  function deepLink(c: Conversation) {
    if (c.context_type === 'construction') {
      return `https://darios-ap.pages.dev/field/project/${c.opp_id}`;
    }
    return `https://darios-ap.pages.dev/field/maintenance/${c.opp_id}`;
  }

  return (
    <div style={{ padding: '24px 24px 48px', maxWidth: 900, margin: '0 auto', fontFamily: "'DM Sans', sans-serif" }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <a href="/" style={{ color: '#6b7280', fontSize: 13, textDecoration: 'none' }}>← Home</a>
        </div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: '#111827' }}>💬 Field Issues</h1>
        <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>
          All crew conversations across maintenance and construction
        </p>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Open', value: open, color: '#16a34a', bg: '#f0fdf4' },
          { label: 'Resolved', value: resolved, color: '#6b7280', bg: '#f9fafb' },
          { label: 'Total', value: filtered.length, color: '#0369a1', bg: '#eff6ff' },
        ].map(s => (
          <div key={s.label} style={{ flex: 1, background: s.bg, borderRadius: 10, padding: '12px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {/* Status */}
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

        {/* Context type */}
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

        {/* Tag */}
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
        {filtered.map(c => {
          const isOpen = c.status === 'open';
          const ts = c.updated_at || c.created_at;
          return (
            <div key={c.id} style={{
              background: '#fff', border: '1px solid #e2e6ed', borderRadius: 12,
              padding: '14px 16px', opacity: isOpen ? 1 : 0.8,
              borderLeft: `4px solid ${isOpen ? '#16a34a' : '#d1d5db'}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Property + type */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>
                      {c.property_name || `Opp #${c.opp_id}`}
                    </span>
                    <ContextBadge type={c.context_type} />
                    <TagBadge tag={c.tag} />
                    {!isOpen && (
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: '#f3f4f6', color: '#6b7280' }}>
                        ✓ Resolved
                      </span>
                    )}
                  </div>

                  {/* Title */}
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{c.title}</div>

                  {/* Last message preview */}
                  {c.last_message && (
                    <div style={{ fontSize: 13, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 500 }}>
                      {c.last_message}
                    </div>
                  )}

                  {/* Meta */}
                  <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 12, color: '#9ca3af', flexWrap: 'wrap' }}>
                    {c.created_by && <span>👤 {c.created_by}</span>}
                    <span>💬 {c.message_count} message{c.message_count !== 1 ? 's' : ''}</span>
                    <span>🕐 {fmtTime(ts)}</span>
                  </div>
                </div>

                {/* Open link */}
                <a
                  href={deepLink(c)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    flexShrink: 0, padding: '7px 14px',
                    background: isOpen ? '#0f4c75' : '#f3f4f6',
                    color: isOpen ? '#fff' : '#6b7280',
                    borderRadius: 8, fontSize: 12, fontWeight: 700,
                    textDecoration: 'none', whiteSpace: 'nowrap',
                  }}
                >
                  Open →
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
