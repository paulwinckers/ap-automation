/**
 * FieldWorkTicket.tsx — Mobile work ticket completion for field crews.
 * Accessible at /field/work-ticket
 *
 * Flow:
 *   1. Search for a job by name
 *   2. Select the job → see its work tickets → pick one
 *   3. Add up to 10 photos (compressed)
 *   4. Add completion comment + your name
 *   5. Review & submit
 *   6. Success
 */

import { useState, useRef, useCallback } from 'react';
import {
  searchFieldOpportunities,
  getOpportunityWorkTickets,
  completeWorkTicket,
  type FieldOpportunity,
  type FieldWorkTicket,
} from '../lib/api';

type Step = 1 | 2 | 3 | 4 | 5 | 6;

const MAX_PHOTOS = 10;
const MAX_PX     = 1600;

// ── Image compression (same as FieldSubmit) ───────────────────────────────────
function compressImage(f: File): Promise<File> {
  return new Promise(resolve => {
    if (f.type === 'application/pdf' || f.size < 1.5 * 1024 * 1024) { resolve(f); return; }
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let { width, height } = img;
      if (width > MAX_PX || height > MAX_PX) {
        if (width > height) { height = Math.round(height * MAX_PX / width); width = MAX_PX; }
        else { width = Math.round(width * MAX_PX / height); height = MAX_PX; }
      }
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => {
        if (blob) resolve(new File([blob], f.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
        else resolve(f);
      }, 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(f); };
    img.src = url;
  });
}

export default function FieldWorkTicket() {
  const [step, setStep]               = useState<Step>(1);
  const [query, setQuery]             = useState('');
  const [searching, setSearching]     = useState(false);
  const [searchResults, setSearchResults] = useState<FieldOpportunity[] | null>(null);
  const [selectedJob, setSelectedJob] = useState<FieldOpportunity | null>(null);
  const [tickets, setTickets]         = useState<FieldWorkTicket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<FieldWorkTicket | null>(null);
  const [photos, setPhotos]           = useState<File[]>([]);
  const [previews, setPreviews]       = useState<string[]>([]);
  const [submitterName, setSubmitterName] = useState(
    () => localStorage.getItem('field_employee') || ''
  );
  const [comment, setComment]         = useState('');
  const [submitting, setSubmitting]   = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<{ ticket: string; photos: number } | null>(null);

  const cameraRef  = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Search ─────────────────────────────────────────────────────────────────
  const handleQueryChange = (val: string) => {
    setQuery(val);
    setSearchResults(null);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (val.trim().length < 2) return;
    searchTimeout.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchFieldOpportunities(val.trim());
        setSearchResults(res.opportunities);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 500);
  };

  const selectJob = useCallback(async (job: FieldOpportunity) => {
    setSelectedJob(job);
    setSelectedTicket(null);
    setLoadingTickets(true);
    try {
      const res = await getOpportunityWorkTickets(job.OpportunityID);
      setTickets(res.tickets);
    } catch {
      setTickets([]);
    } finally {
      setLoadingTickets(false);
    }
  }, []);

  const selectTicket = (t: FieldWorkTicket) => {
    setSelectedTicket(t);
    setStep(2); // move to photos
    // clear any prior photos
    previews.forEach(p => URL.revokeObjectURL(p));
    setPhotos([]); setPreviews([]);
  };

  // ── Photos ─────────────────────────────────────────────────────────────────
  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const remaining = MAX_PHOTOS - photos.length;
    const toAdd = Array.from(files).slice(0, remaining);
    const compressed = await Promise.all(toAdd.map(compressImage));
    const newPreviews = compressed.map(f => f.type.startsWith('image/') ? URL.createObjectURL(f) : '');
    setPhotos(p => [...p, ...compressed]);
    setPreviews(p => [...p, ...newPreviews]);
  };

  const removePhoto = (idx: number) => {
    if (previews[idx]) URL.revokeObjectURL(previews[idx]);
    setPhotos(p => p.filter((_, i) => i !== idx));
    setPreviews(p => p.filter((_, i) => i !== idx));
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!selectedTicket || !submitterName.trim() || !comment.trim()) return;
    setSubmitting(true); setSubmitError(null);
    try {
      const res = await completeWorkTicket(
        selectedTicket.WorkTicketID,
        submitterName.trim(),
        comment.trim(),
        photos,
      );
      localStorage.setItem('field_employee', submitterName.trim());
      setSuccessInfo({
        ticket: selectedTicket.WorkTicketTitle || `Ticket #${selectedTicket.WorkTicketID}`,
        photos: res.photos_uploaded,
      });
      setStep(6);
    } catch (e: unknown) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    previews.forEach(p => URL.revokeObjectURL(p));
    setStep(1); setQuery(''); setSearchResults(null); setSelectedJob(null);
    setTickets([]); setSelectedTicket(null); setPhotos([]); setPreviews([]);
    setComment(''); setSubmitError(null); setSuccessInfo(null);
  };

  const stepLabels = ['Find job', 'Add photos', 'Add comment', 'Review'];
  const showProgress = step < 6;

  const canContinue = () => {
    if (step === 1) return !!selectedTicket;
    if (step === 2) return true; // photos optional but encouraged
    if (step === 3) return submitterName.trim().length > 0 && comment.trim().length >= 3;
    if (step === 4) return !submitting;
    return false;
  };

  const next = () => {
    if (step === 5) { handleSubmit(); return; }
    setStep(s => (s + 1) as Step);
  };
  const back = () => setStep(s => (s - 1) as Step);

  return (
    <div style={S.phone}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerTop}>
          <img src="/darios-logo.png" alt="Dario's" style={{ height: 30, filter: 'brightness(0) invert(1)' }} />
          <span style={S.chip}>{submitterName || 'Field crew'}</span>
        </div>
        <div style={S.hsub}>Complete Work Ticket</div>
      </div>

      {/* Progress */}
      {showProgress && (
        <div style={S.progress}>
          <div style={S.psteps}>
            {[1,2,3,4].map((i) => (
              <div key={i} style={{...S.pstep, background: step > i ? '#2563eb' : step === i ? 'rgba(37,99,235,.45)' : '#e2e6ed'}}/>
            ))}
          </div>
          <div style={S.plabel}>{stepLabels[Math.min(step, 4) - 1]}</div>
        </div>
      )}

      <div style={S.content}>

        {/* Step 1 — Find job & ticket */}
        {step === 1 && (
          <>
            <div style={S.card}>
              <div style={S.ctitle}>Search for your job</div>
              <input
                style={S.search}
                placeholder="Type job name (e.g. Smith Residence)"
                value={query}
                onChange={e => handleQueryChange(e.target.value)}
                autoFocus
              />
              {searching && <div style={S.hint}>Searching...</div>}
            </div>

            {searchResults && searchResults.length === 0 && (
              <div style={{...S.card, color:'#6b7280', fontSize:14}}>
                No active jobs found for "{query}". Try a different name.
              </div>
            )}

            {searchResults && searchResults.map(job => (
              <div
                key={job.OpportunityID}
                style={{
                  ...S.card, cursor:'pointer',
                  border: selectedJob?.OpportunityID === job.OpportunityID
                    ? '2px solid #2563eb' : '1.5px solid #e2e6ed',
                  background: selectedJob?.OpportunityID === job.OpportunityID ? '#eff6ff' : '#fff',
                }}
                onClick={() => selectJob(job)}
              >
                <div style={{fontWeight:600, fontSize:15, color:'#1a1d23', marginBottom:4}}>
                  {job.OpportunityName}
                </div>
                <div style={{fontSize:12, color:'#6b7280'}}>
                  {job.PropertyName || 'No property'} · {job.DivisionName || ''}
                </div>
              </div>
            ))}

            {selectedJob && (
              <div style={S.card}>
                <div style={S.ctitle}>Select work ticket</div>
                {loadingTickets && <div style={S.hint}>Loading tickets...</div>}
                {!loadingTickets && tickets.length === 0 && (
                  <div style={{fontSize:13, color:'#6b7280'}}>No work tickets found for this job.</div>
                )}
                {tickets.map(t => (
                  <button
                    key={t.WorkTicketID}
                    style={{
                      width:'100%', textAlign:'left', padding:'12px 14px',
                      marginBottom:8, borderRadius:10, cursor:'pointer', fontFamily:'inherit',
                      border: selectedTicket?.WorkTicketID === t.WorkTicketID
                        ? '2px solid #2563eb' : '1.5px solid #e2e6ed',
                      background: selectedTicket?.WorkTicketID === t.WorkTicketID ? '#eff6ff' : '#f9fafb',
                    }}
                    onClick={() => selectTicket(t)}
                  >
                    <div style={{fontWeight:600, fontSize:14, color:'#1a1d23', marginBottom:2}}>
                      {t.WorkTicketTitle || `Ticket #${t.WorkTicketID}`}
                    </div>
                    <div style={{fontSize:11, color:'#6b7280'}}>
                      Status: {t.WorkTicketStatusName || '—'}
                      {t.ScheduledDate ? ` · Scheduled: ${t.ScheduledDate.slice(0,10)}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Step 2 — Photos */}
        {step === 2 && (
          <div style={S.card}>
            <div style={S.ctitle}>Add completion photos ({photos.length}/{MAX_PHOTOS})</div>

            {/* Camera / gallery buttons */}
            <input ref={cameraRef}  type="file" accept="image/*" capture="environment" multiple onChange={e => handleFiles(e.target.files)} style={{display:'none'}}/>
            <input ref={galleryRef} type="file" accept="image/*" multiple onChange={e => handleFiles(e.target.files)} style={{display:'none'}}/>

            {photos.length < MAX_PHOTOS && (
              <div style={{display:'flex', gap:10, marginBottom:12}}>
                <div style={{...S.uparea, flex:1}} onClick={() => cameraRef.current?.click()}>
                  <span style={{fontSize:30}}>📷</span>
                  <div style={S.uptitle}>Camera</div>
                </div>
                <div style={{...S.uparea, flex:1}} onClick={() => galleryRef.current?.click()}>
                  <span style={{fontSize:30}}>🖼️</span>
                  <div style={S.uptitle}>Gallery</div>
                </div>
              </div>
            )}

            {/* Photo grid */}
            {photos.length > 0 && (
              <div style={S.photoGrid}>
                {photos.map((f, i) => (
                  <div key={i} style={S.photoThumb}>
                    {previews[i]
                      ? <img src={previews[i]} alt={f.name} style={S.thumbImg}/>
                      : <div style={{fontSize:24, textAlign:'center'}}>📄</div>
                    }
                    <button style={S.removeBtn} onClick={() => removePhoto(i)}>✕</button>
                  </div>
                ))}
              </div>
            )}

            {photos.length === 0 && (
              <div style={S.tip}>Photos are optional but help document the completed work.</div>
            )}
          </div>
        )}

        {/* Step 3 — Comment & name */}
        {step === 3 && (
          <div style={S.card}>
            <div style={S.ctitle}>Completion details</div>

            <div style={{marginBottom:16}}>
              <div style={S.flabel}>Your name</div>
              {submitterName ? (
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 0'}}>
                  <span style={{fontSize:15, fontWeight:600, color:'#1a1d23'}}>{submitterName}</span>
                  <button style={{fontSize:12, color:'#6b7280', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit'}}
                    onClick={() => { setSubmitterName(''); localStorage.removeItem('field_employee'); }}>
                    Not you?
                  </button>
                </div>
              ) : (
                <input
                  style={S.input}
                  placeholder="First and last name"
                  value={submitterName}
                  onChange={e => setSubmitterName(e.target.value)}
                  autoFocus
                />
              )}
            </div>

            <div>
              <div style={S.flabel}>Completion notes</div>
              <textarea
                style={{...S.input, minHeight:100, resize:'vertical'}}
                placeholder="Describe what was completed, any issues, materials used, etc."
                value={comment}
                onChange={e => setComment(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* Step 4 — Review */}
        {step === 4 && selectedTicket && (
          <div style={S.card}>
            <div style={S.ctitle}>Review before submitting</div>
            <RR label="Job"    value={selectedJob?.OpportunityName || '—'}/>
            <RR label="Ticket" value={selectedTicket.WorkTicketTitle || `#${selectedTicket.WorkTicketID}`}/>
            <RR label="Photos" value={`${photos.length} photo${photos.length !== 1 ? 's' : ''}`} color={photos.length > 0 ? '#059669' : '#6b7280'}/>
            <RR label="Crew"   value={submitterName}/>
            <div style={{paddingTop:10, fontSize:13, color:'#1a1d23', lineHeight:1.6, whiteSpace:'pre-wrap'}}>
              <span style={{fontSize:12, color:'#6b7280', fontWeight:500, display:'block', marginBottom:4, textTransform:'uppercase', letterSpacing:'.04em'}}>Notes</span>
              {comment}
            </div>
            {submitError && (
              <div style={{...S.tip, background:'#fef2f2', borderColor:'#fca5a5', color:'#dc2626', marginTop:12}}>
                {submitError}
              </div>
            )}
          </div>
        )}

        {/* Step 6 — Success */}
        {step === 6 && successInfo && (
          <div style={S.success}>
            <span style={{fontSize:64, display:'block', marginBottom:16}}>✅</span>
            <div style={S.stitle}>Work ticket updated!</div>
            <div style={S.ssub}>
              <strong>{successInfo.ticket}</strong> has been logged as complete
              {successInfo.photos > 0 ? ` with ${successInfo.photos} photo${successInfo.photos !== 1 ? 's' : ''}` : ''}.
            </div>
            <div style={{fontSize:12, color:'#6b7280', marginTop:8}}>
              Photos and your notes are now visible in Aspire on the work ticket.
            </div>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div style={S.bar}>
        {step === 6 ? (
          <button style={S.bsuccess} onClick={reset}>Complete another ticket</button>
        ) : step === 1 ? (
          <button
            style={{...S.bprimary, opacity: canContinue() ? 1 : .4}}
            disabled={!canContinue()}
            onClick={() => selectedTicket && setStep(2)}
          >
            Continue
          </button>
        ) : step === 4 ? (
          <>
            <button
              style={{...S.bprimary, opacity: submitting ? .4 : 1}}
              disabled={submitting}
              onClick={handleSubmit}
            >
              {submitting ? 'Submitting...' : 'Submit completion'}
            </button>
            <button style={S.bback} onClick={back}>← Back</button>
          </>
        ) : (
          <>
            <button
              style={{...S.bprimary, opacity: canContinue() ? 1 : .4}}
              disabled={!canContinue()}
              onClick={next}
            >
              Continue
            </button>
            <button style={S.bback} onClick={back}>← Back</button>
          </>
        )}
      </div>
    </div>
  );
}

function RR({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', padding:'10px 0', borderBottom:'1px solid #e2e6ed'}}>
      <span style={{fontSize:12, color:'#6b7280', fontWeight:500, flexShrink:0}}>{label}</span>
      <span style={{fontSize:13, fontWeight:500, textAlign:'right', maxWidth:220, color: color || '#1a1d23'}}>{value}</span>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  phone:{maxWidth:430,margin:'0 auto',minHeight:'100vh',background:'#f4f6f9',display:'flex',flexDirection:'column',fontFamily:"'DM Sans',sans-serif"},
  header:{background:'#1e3a2f',color:'#fff',padding:'16px 20px 20px',flexShrink:0},
  headerTop:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4},
  hsub:{fontSize:13,opacity:.8},
  chip:{background:'rgba(255,255,255,.2)',borderRadius:20,padding:'4px 12px',fontSize:12,fontWeight:500},
  progress:{padding:'16px 20px 0',flexShrink:0},
  psteps:{display:'flex',gap:6,marginBottom:6},
  pstep:{flex:1,height:4,borderRadius:2,transition:'background .3s'},
  plabel:{fontSize:12,color:'#6b7280',fontWeight:500},
  content:{flex:1,padding:'16px 20px',overflowY:'auto'},
  card:{background:'#fff',border:'1.5px solid #e2e6ed',borderRadius:12,padding:16,marginBottom:12},
  ctitle:{fontSize:13,fontWeight:600,color:'#6b7280',textTransform:'uppercase',letterSpacing:'.04em',marginBottom:12},
  search:{width:'100%',padding:'12px 14px',border:'1.5px solid #e2e6ed',borderRadius:8,fontSize:16,color:'#1a1d23',outline:'none',fontFamily:'inherit',background:'#fff',boxSizing:'border-box'},
  hint:{fontSize:12,color:'#6b7280',padding:'6px 0'},
  uparea:{border:'2px dashed #e2e6ed',borderRadius:10,padding:'20px 12px',textAlign:'center',cursor:'pointer',background:'#f4f6f9'},
  uptitle:{fontSize:13,fontWeight:600,color:'#1a1d23',marginTop:4},
  photoGrid:{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginTop:8},
  photoThumb:{position:'relative',borderRadius:8,overflow:'hidden',aspectRatio:'1',background:'#f4f6f9',display:'flex',alignItems:'center',justifyContent:'center'},
  thumbImg:{width:'100%',height:'100%',objectFit:'cover',display:'block'},
  removeBtn:{position:'absolute',top:4,right:4,width:22,height:22,borderRadius:11,background:'rgba(0,0,0,.55)',color:'#fff',border:'none',cursor:'pointer',fontSize:11,display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1},
  tip:{background:'#fffbeb',border:'1px solid #fde68a',borderRadius:10,padding:12,fontSize:12,color:'#92400e',lineHeight:1.6},
  flabel:{fontSize:12,fontWeight:600,color:'#6b7280',marginBottom:6,textTransform:'uppercase',letterSpacing:'.04em'},
  input:{width:'100%',padding:'12px 14px',border:'1.5px solid #e2e6ed',borderRadius:8,fontSize:15,color:'#1a1d23',outline:'none',fontFamily:'inherit',background:'#fff',boxSizing:'border-box'},
  success:{textAlign:'center',padding:'40px 20px'},
  stitle:{fontSize:22,fontWeight:600,marginBottom:8},
  ssub:{fontSize:14,color:'#6b7280',lineHeight:1.6,marginBottom:8},
  bar:{padding:'16px 20px',background:'#fff',borderTop:'1px solid #e2e6ed',flexShrink:0},
  bprimary:{width:'100%',padding:16,background:'#2563eb',color:'#fff',border:'none',borderRadius:10,fontSize:16,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'block'},
  bback:{width:'100%',padding:12,background:'none',border:'none',fontSize:14,color:'#6b7280',cursor:'pointer',marginTop:8,fontFamily:'inherit'},
  bsuccess:{width:'100%',padding:16,background:'#059669',color:'#fff',border:'none',borderRadius:10,fontSize:16,fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
};
