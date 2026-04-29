/**
 * FieldDocuments — company policies & procedures for field crew.
 * Public, no login required. /field/documents
 */
import { useState, useEffect } from 'react';
import { listDocuments, getDocumentFileUrl, type CompanyDocument } from '../lib/api';

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

export default function FieldDocuments() {
  const [docs, setDocs] = useState<CompanyDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div style={wrap}>
      {/* Header */}
      <div style={{ background: '#1e293b', padding: '20px 20px 16px', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <a href="/" style={{ color: '#64748b', fontSize: 20, textDecoration: 'none' }}>←</a>
          <h1 style={{ margin: 0, color: '#fff', fontSize: 20, fontWeight: 800 }}>📋 Company Documents</h1>
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
