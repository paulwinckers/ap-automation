/**
 * FieldAdvisor.tsx — the "Ask AI" assistant (photo + question → AI guidance).
 * Extracted from FieldProject so it can live inside the Chat & AI tab.
 *
 * Backend: POST /checkin/project/{oppId}/field-advisor  (ask)
 *          POST /checkin/project/{oppId}/field-advisor/save  (save to project file / advisor log)
 *
 * Props:
 *  - oppId    : opportunity id for project context
 *  - onShare  : optional — when provided, a "Share to chat" button appears that hands the
 *               Q&A back to the parent (FieldConversations) to start a new conversation.
 */

import { useRef, useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? '';

/** Compress to max 1600px / JPEG — keeps large phone photos under the backend limit. */
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

interface ShformPayload {
  question:    string;
  answer:      string;
  photoR2Key:  string | null;
  hasPhoto:    number;
}

interface Props {
  oppId:    number;
  onShare?: (p: ShformPayload) => Promise<void> | void;
}

export default function FieldAdvisor({ oppId, onShare }: Props) {
  const [question,     setQuestion]     = useState('');
  const [photo,        setPhoto]        = useState<File | null>(null);
  const [preview,      setPreview]      = useState('');
  const [answer,       setAnswer]       = useState('');
  const [loading,      setLoading]      = useState(false);
  const [photoR2Key,   setPhotoR2Key]   = useState<string | null>(null);
  const [hasPhoto,     setHasPhoto]     = useState(0);
  const [saved,        setSaved]        = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [photoDropped, setPhotoDropped] = useState(false);
  const [sharing,      setSharing]      = useState(false);
  const [shared,       setShared]       = useState(false);

  const photoInputRef = useRef<HTMLInputElement>(null);
  const questionRef   = useRef('');

  const askAdvisor = async () => {
    if (!question.trim() && !photo) return;
    setLoading(true);
    setAnswer('');
    setSaved(false);
    setShared(false);
    setPhotoDropped(false);
    setPhotoR2Key(null);
    questionRef.current = question.trim() || 'What do you observe in this photo and what should I know?';
    try {
      const fd = new FormData();
      fd.append('question', questionRef.current);
      if (photo) {
        try {
          const compressed = await compressPhoto(photo);
          fd.append('photo', compressed, 'photo.jpg');
        } catch {
          fd.append('photo', photo); // fallback: send original
        }
      }
      const r = await fetch(`${API}/checkin/project/${oppId}/field-advisor`, { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as any).detail || 'AI request failed');
      setAnswer((j as any).answer || '');
      setPhotoR2Key((j as any).photo_r2_key ?? null);
      setHasPhoto((j as any).has_photo ?? 0);
      if (photo && (j as any).photo_received === false) setPhotoDropped(true);
    } catch (e: any) {
      setAnswer(`⚠️ ${e.message || 'Something went wrong'}`);
    } finally {
      setLoading(false);
    }
  };

  const saveToFile = async () => {
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('question',  questionRef.current);
      fd.append('answer',    answer);
      fd.append('has_photo', String(hasPhoto));
      if (photoR2Key) fd.append('photo_r2_key', photoR2Key);
      const r = await fetch(`${API}/checkin/project/${oppId}/field-advisor/save`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error('Save failed');
      setSaved(true);
    } catch {
      alert('Could not save — please try again');
    } finally {
      setSaving(false);
    }
  };

  const shareToChat = async () => {
    if (!onShare) return;
    setSharing(true);
    try {
      await onShare({ question: questionRef.current, answer, photoR2Key, hasPhoto });
      setShared(true);
    } catch {
      alert('Could not share — please try again');
    } finally {
      setSharing(false);
    }
  };

  return (
    <div style={{ border: '1.5px solid #c7d2fe', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ background: '#eef2ff', padding: '10px 14px' }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: '#4338ca' }}>🤖 Ask AI — Field Advisor</div>
        <div style={{ fontSize: 12, color: '#6366f1', marginTop: 2 }}>
          Snap a photo of a site problem and describe it — get instant AI guidance, then share it to the team.
        </div>
      </div>
      <div style={{ background: '#fff', padding: '12px 14px' }}>
        {/* Photo picker */}
        <button
          type="button"
          onClick={() => photoInputRef.current?.click()}
          style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', background: '#f5f3ff', border: '1.5px dashed #a5b4fc', borderRadius: 8, padding: '9px 12px', fontSize: 12, color: '#6366f1', marginBottom: 10, width: '100%', textAlign: 'left', fontFamily: 'inherit' }}
        >
          <span style={{ fontSize: 18 }}>📸</span>
          <span>{photo ? photo.name : 'Attach site photo (optional)'}</span>
        </button>
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          onChange={e => {
            const f = e.target.files?.[0] ?? null;
            if (preview) URL.revokeObjectURL(preview);
            setPhoto(f);
            setPreview(f ? URL.createObjectURL(f) : '');
          }}
          style={{ display: 'none' }}
        />
        {preview && (
          <div style={{ marginBottom: 10, position: 'relative', display: 'inline-block' }}>
            <img src={preview} alt="" style={{ width: 100, height: 100, objectFit: 'cover', borderRadius: 8, border: '2px solid #c7d2fe' }} />
            <button type="button"
              onClick={() => { URL.revokeObjectURL(preview); setPhoto(null); setPreview(''); }}
              style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', background: '#ef4444', color: '#fff', border: 'none', fontSize: 12, cursor: 'pointer', padding: 0, lineHeight: '20px', textAlign: 'center' }}>×</button>
          </div>
        )}
        {/* Question input */}
        <textarea
          placeholder="Describe the issue — e.g. 'slope eroding near retaining wall, what should we do?'"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          rows={2}
          style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit', marginBottom: 10, color: '#374151', background: '#f9fafb' }}
        />
        <button type="button" onClick={askAdvisor}
          disabled={loading || (!question.trim() && !photo)}
          style={{ width: '100%', padding: '10px', background: (!loading && (question.trim() || photo)) ? '#4f46e5' : '#94a3b8', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: loading || (!question.trim() && !photo) ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
          {loading ? '🤔 Thinking…' : '✨ Ask Field Advisor'}
        </button>
        {photoDropped && (
          <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
            ⚠️ The photo was attached but the server didn't receive it — the answer below is text-only. Try again or use a smaller image.
          </div>
        )}
        {answer && (
          <div style={{ marginTop: 12 }}>
            <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 8, padding: '12px 14px', fontSize: 13, color: '#1e1b4b', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
              {answer}
            </div>
            {/* Actions — only for a real answer (not an error) */}
            {!answer.startsWith('⚠️') && (
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                {/* Save to project file */}
                {saved ? (
                  <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>✓ Saved to project file</span>
                ) : (
                  <button
                    type="button"
                    onClick={saveToFile}
                    disabled={saving}
                    style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, cursor: saving ? 'wait' : 'pointer' }}
                  >
                    {saving ? 'Saving…' : '💾 Save to project file'}
                  </button>
                )}
                {/* Share to chat */}
                {onShare && (shared ? (
                  <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>✓ Shared to chat</span>
                ) : (
                  <button
                    type="button"
                    onClick={shareToChat}
                    disabled={sharing}
                    style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, background: '#0f4c75', color: '#fff', border: 'none', borderRadius: 6, cursor: sharing ? 'wait' : 'pointer' }}
                  >
                    {sharing ? 'Sharing…' : '💬 Share to chat'}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setAnswer('')}
                  style={{ padding: '5px 10px', fontSize: 12, background: '#f3f4f6', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' }}
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
