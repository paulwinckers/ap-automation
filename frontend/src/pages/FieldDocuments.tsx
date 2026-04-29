/**
 * FieldDocuments — company policies & procedures for field crew.
 * Public, no login required. /field/documents
 */
import { useState, useEffect } from 'react';
import { listDocuments, getDocumentFileUrl, getVapidPublicKey, savePushSubscription, type CompanyDocument } from '../lib/api';

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

/** Convert a base64url string to a Uint8Array (needed for applicationServerKey). */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { state: notifState, subscribe } = usePushSubscription();

  useEffect(() => {
    listDocuments()
      .then(setDocs)
      .catch(() => setError('Could not load documents. Please try again.'))
      .finally(() => setLoading(false));
  }, []);

  const wrap: React.CSSProperties = {
    minHeight: '100vh', background: BG,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    padding: '0 0 40px',
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

        {docs.map(doc => (
          <a
            key={doc.id}
            href={getDocumentFileUrl(doc.id)}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: 'none', display: 'block', marginBottom: 12 }}
          >
            <div style={{
              background: CARD, borderRadius: 12, padding: '14px 16px',
              display: 'flex', alignItems: 'center', gap: 14,
              border: '1px solid #334155',
            }}>
              <div style={{ fontSize: 32, flexShrink: 0 }}>{fileIcon(doc.filename)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 700, marginBottom: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {doc.title}
                </div>
                {doc.description && (
                  <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 3 }}>{doc.description}</div>
                )}
                <div style={{ color: '#475569', fontSize: 11 }}>
                  {formatDate(doc.created_at)}{doc.file_size ? ` · ${formatSize(doc.file_size)}` : ''}
                </div>
              </div>
              <div style={{ color: '#3b82f6', fontSize: 20, flexShrink: 0 }}>→</div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
