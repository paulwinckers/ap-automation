/**
 * FieldFeed — the crew's Feed. Route: /field/feed (public, no login, built for phones).
 * Every field chat with activity in the last two weeks, newest first, across all jobs.
 * Tapping one opens it on its job page. "New" is remembered on this phone (no login to tie it to).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listFieldFeed, type FieldFeedItem } from '../lib/api';

const SEEN_KEY = 'field_feed_seen';   // { [conversationId]: last_at when opened }
const FIRST_KEY = 'field_feed_first'; // when this phone first opened the Feed

function readSeen(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch { return {}; }
}
function firstSeen(): string {
  try {
    let f = localStorage.getItem(FIRST_KEY);
    if (!f) {
      // First visit: only the last two days count as new, not the whole fortnight.
      f = new Date(Date.now() - 2 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
      localStorage.setItem(FIRST_KEY, f);
    }
    return f;
  } catch { return ''; }
}
function isNew(c: FieldFeedItem, seen: Record<string, string>, first: string): boolean {
  const s = seen[String(c.id)];
  return s ? c.last_at > s : c.last_at > first;
}
/** How many chats have news since this phone last looked (used by the Main Menu tile). */
export function countNew(list: FieldFeedItem[]): number {
  const seen = readSeen(); const first = firstSeen();
  return list.filter(c => isNew(c, seen, first)).length;
}
function markSeen(ids: { id: number; last_at: string }[]) {
  try {
    const seen = readSeen();
    ids.forEach(c => { seen[String(c.id)] = c.last_at; });
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch { /* private mode — fine */ }
}
function ago(ts: string): string {
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return '';
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export default function FieldFeed() {
  const navigate = useNavigate();
  const [list, setList] = useState<FieldFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<'all' | 'open'>('open');
  const [seen, setSeen] = useState(readSeen());
  const first = useMemo(firstSeen, []);

  async function load() {
    setLoading(true); setErr('');
    try { setList((await listFieldFeed(14)).conversations || []); setSeen(readSeen()); }
    catch { setErr('Could not load the feed. Check your signal and try again.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const shown = list.filter(c => filter === 'all' || c.status !== 'resolved');
  const newCount = shown.filter(c => isNew(c, seen, first)).length;

  function open(c: FieldFeedItem) {
    markSeen([c]);
    navigate(c.url);
  }
  function markAll() {
    markSeen(list);
    setSeen(readSeen());
  }

  const chip = (on: boolean) => ({
    padding: '7px 14px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer',
    border: `1px solid ${on ? '#16a34a' : '#334155'}`, background: on ? '#14532d' : '#1e293b', color: on ? '#fff' : '#94a3b8',
  });

  return (
    <div style={{ minHeight: '100vh', background: '#0f172a', padding: '18px 14px 24px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ color: '#fff', fontSize: 22, fontWeight: 800 }}>💬 Feed</div>
          <button onClick={load} style={{ background: 'transparent', border: '1px solid #334155', color: '#cbd5e1',
            borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 600 }}>↻</button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}>
          <button style={chip(filter === 'open')} onClick={() => setFilter('open')}>Open</button>
          <button style={chip(filter === 'all')} onClick={() => setFilter('all')}>All</button>
          <div style={{ flex: 1 }} />
          {newCount > 0 && <button onClick={markAll} style={{ background: 'transparent', border: 'none', color: '#7dd3fc',
            fontSize: 13, fontWeight: 600 }}>Mark all seen</button>}
        </div>

        {err && <div style={{ background: '#450a0a', color: '#fecaca', padding: 12, borderRadius: 10, fontSize: 14, marginBottom: 12 }}>{err}</div>}

        {loading ? (
          <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>Loading…</div>
        ) : shown.length === 0 ? (
          <div style={{ color: '#64748b', textAlign: 'center', padding: 40, fontSize: 15 }}>No chats in the last two weeks.</div>
        ) : shown.map(c => {
          const fresh = isNew(c, seen, first);
          return (
            <button key={c.id} onClick={() => open(c)} style={{
              display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, padding: '12px 14px', borderRadius: 12,
              background: fresh ? '#0c4a6e' : '#1e293b', border: `1px solid ${fresh ? '#0284c7' : '#334155'}`, cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {fresh && <span style={{ width: 9, height: 9, borderRadius: 999, background: '#38bdf8', flexShrink: 0 }} />}
                <span style={{ color: '#fff', fontWeight: fresh ? 800 : 600, fontSize: 15, flex: 1, minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                <span style={{ color: '#64748b', fontSize: 12 }}>{ago(c.last_at)}</span>
              </div>
              <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 3 }}>
                {c.context_type === 'construction' ? '🏗️ ' : '🌿 '}
                {[c.property_name || `Job #${c.opp_id}`, c.tag, c.status === 'resolved' ? '✓ resolved' : ''].filter(Boolean).join(' · ')}
              </div>
              {c.last_message && (
                <div style={{ color: '#cbd5e1', fontSize: 13, marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis',
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }}>
                  {c.last_author ? <b style={{ color: '#e2e8f0' }}>{c.last_author}: </b> : null}{c.last_message}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
