/**
 * FieldDocuments — company policies & procedures for field crew.
 * Public, no login required. /field/documents
 */
import { useState, useEffect } from 'react';
import { listDocuments, listFolders, getDocumentFileUrl, getVapidPublicKey, savePushSubscription, type CompanyDocument, type DocumentFolder } from '../lib/api';

const BG   = '#0f172a';
const CARD = '#1e293b';

function fileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return '📄';
  if (['doc', 'docx'].includes(ext || '')) return '📝';
  if (['xls', 'xlsx'].includes(ext || '')) return '📊';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext || '')) return '🖼️';
  return '📎';
}

function formatSize(bytes?: number | null) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(dt: string) {
  return new Date(dt).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Convert a base64url string to a Uint8Array backed by a plain ArrayBuffer. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  const bytes   = [...raw].map(c => c.charCodeAt(0));
  const buf     = new ArrayBuffer(bytes.length);
  const view    = new Uint8Array(buf);
  bytes.forEach((b, i) => { view[i] = b; });
  return view;
}

// ── Push subscription hook ─────────────────────────────────────────────────────

type NotifState = 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed' | 'subscribing';

function usePushSubscription() {
  const [state, setState] = useState<NotifState>('unsubscribed');

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setState('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setState('denied');
      return;
    }
    // Check if already subscribed
    navigator.serviceWorker.ready.then(reg => {
      reg.pushManager.getSubscription().then(sub => {
        if (sub) setState('subscribed');
      });
    });
  }, []);

  async function subscribe() {
    setState('subscribing');
    try {
      // Register service worker if not yet registered
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      // Get VAPID public key
      const publicKey = await getVapidPublicKey();

      // Request permission
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState('denied');
        return;
      }

      // Subscribe
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const json   = sub.toJSON();
      const keys   = json.keys ?? {};
      await savePushSubscription({
        endpoint: sub.endpoint,
        p256dh:   keys.p256dh   ?? '',
        auth:     keys.auth     ?? '',
      });

      setState('subscribed');
    } catch (err) {
      console.error('Push subscribe failed:', err);
      setState('unsubscribed');
    }
  }

  return { state, subscribe };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function FieldDocuments() {
  const [docs, setDocs] = useState<CompanyDocument[]>([]);
  const [folders, setFolders] = useState<DocumentFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const { state: notifState, subscribe } = usePushSubscription();

  useEffect(() => {
    Promise.all([listDocuments(), listFolders()])
      .then(([d, f]) => { setDocs(d); setFolders(f); })
      .catch(() => setError('Could not load documents. Please try again.'))
      .finally(() => setLoading(false));
  }, []);

  const wrap: React.CSSProperties = {
    minHeight: '100vh', background: BG,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding: '0 0 40px',
  };

  // Folder tree helpers
  const childrenOf = (pid: number | null) => folders.filter(f => f.parent_id === pid).sort((a, b) => a.name.localeCompare(b.name));
  const docsIn = (fid: number | null) => docs.filter(d => (d.folder_id ?? null) === fid);
  const toggle = (id: number) => setCollapsed(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const DocCard = ({ doc }: { doc: CompanyDocument }) => (
    <a key={doc.id} href={getDocumentFileUrl(doc.id)} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', display: 'block', marginBottom: 10 }}>
      <div style={{ background: CARD, borderRadius: 12, padding: '13px 15px', display: 'flex', alignItems: 'center', gap: 13, border: '1px solid #334155' }}>
        <div style={{ fontSize: 30, flexShrink: 0 }}>{fileIcon(doc.filename)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 700, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</div>
          {doc.description && <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 3 }}>{doc.description}</div>}
          <div style={{ color: '#475569', fontSize: 11 }}>{formatDate(doc.created_at)}{doc.file_size ? ` · ${formatSize(doc.file_size)}` : ''}</div>
        </div>
        <div style={{ color: '#3b82f6', fontSize: 20, flexShrink: 0 }}>→</div>
      </div>
    </a>
  );

  const renderFolder = (f: DocumentFolder, depth: number): React.ReactNode => {
    const kids = childrenOf(f.id);
    const inner = docsIn(f.id);
    const isCollapsed = collapsed.has(f.id);
    const count = inner.length + kids.reduce((s, k) => s + docsIn(k.id).length, 0);
    return (
      <div key={f.id} style={{ marginLeft: depth * 12, marginBottom: 6 }}>
        <div onClick={() => toggle(f.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#cbd5e1', fontWeight: 800, fontSize: 14, padding: '8px 2px' }}>
          <span style={{ color: '#64748b', width: 12 }}>{isCollapsed ? '▸' : '▾'}</span>
          📁 {f.name} <span style={{ color: '#64748b', fontWeight: 500, fontSize: 12 }}>· {count}</span>
        </div>
        {!isCollapsed && (
          <div style={{ marginLeft: 8 }}>
            {inner.map(doc => <DocCard key={doc.id} doc={doc} />)}
            {kids.map(k => renderFolder(k, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const notifButton = () => {
    if (notifState === 'unsupported' || notifState === 'denied') return null;
    if (notifState === 'subscribed') {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6,
          color: '#22c55e', fontSize: 12, fontWeight: 600 }}>
          🔔 Notifications on
        </div>
      );
    }
    return (
      <button
        onClick={subscribe}
        disabled={notifState === 'subscribing'}
        style={{
          background: 'none', border: '1px solid #334155',
          color: '#94a3b8', fontSize: 12, borderRadius: 20,
          padding: '4px 12px', cursor: 'pointer', display: 'flex',
          alignItems: 'center', gap: 5,
        }}
      >
        🔔 {notifState === 'subscribing' ? 'Enabling…' : 'Get notified'}
      </button>
    );
  };

  return (
    <div style={wrap}>
      {/* Header */}
      <div style={{ background: '#1e293b', padding: '20px 20px 16px', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <a href="/" style={{ color: '#64748b', fontSize: 20, textDecoration: 'none' }}>←</a>
          <h1 style={{ margin: 0, color: '#fff', fontSize: 20, fontWeight: 800, flex: 1 }}>
            📋 Company Documents
          </h1>
          {notifButton()}
        </div>
        <p style={{ margin: 0, color: '#64748b', fontSize: 13 }}>Policies, procedures & resources</p>
      </div>

      <div style={{ padding: '0 16px' }}>
        {loading && (
          <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>Loading documents…</div>
        )}

        {error && (
          <div style={{ color: '#ef4444', textAlign: 'center', padding: 40 }}>{error}</div>
        )}

        {!loading && !error && docs.length === 0 && (
          <div style={{ color: '#64748b', textAlign: 'center', padding: 60 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
            <div>No documents uploaded yet.</div>
          </div>
        )}

        {!loading && !error && (
          <>
            {childrenOf(null).map(f => renderFolder(f, 0))}
            {docsIn(null).length > 0 && (
              <div style={{ marginTop: folders.length ? 14 : 0 }}>
                {folders.length > 0 && (
                  <div style={{ color: '#64748b', fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '4px 2px 10px' }}>General</div>
                )}
                {docsIn(null).map(doc => <DocCard key={doc.id} doc={doc} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
