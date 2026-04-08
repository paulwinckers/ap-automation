/**
 * FieldWorkTicket.tsx — Mobile work ticket completion for field crews.
 * Accessible at /field/work-ticket
 *
 * Flow:
 *   1. Today's routes shown as cards (Past / Today / Upcoming toggle)
 *      Tap a route → see its tickets
 *      Tap a ticket → select it
 *   2. Add photos & videos
 *   3. Add completion notes + your name (from Aspire employees)
 *   4. Review & submit
 *   5. Success
 */

import { useState, useRef, useEffect } from 'react';
import {
  getScheduledTickets,
  getAspireEmployees,
  completeWorkTicket,
  type ScheduledWorkTicket,
  type TicketRoute,
  type TicketRange,
  type AspireEmployee,
} from '../lib/api';

type Step = 1 | 2 | 3 | 4 | 5;

const MAX_FILES = 10;
const MAX_PX    = 1600;

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

function fmtDate(d: string | null) {
  if (!d) return '';
  return d.slice(0, 10);
}

function statusColor(s: string | null) {
  const l = (s || '').toLowerCase();
  if (l.includes('complete')) return '#059669';
  if (l.includes('progress') || l.includes('active')) return '#2563eb';
  if (l.includes('not started')) return '#6b7280';
  return '#d97706';
}

export default function FieldWorkTicket() {
  const [step, setStep]               = useState<Step>(1);

  // Route / ticket list
  const [range, setRange]             = useState<TicketRange>('today');
  const [routes, setRoutes]           = useState<TicketRoute[] | null>(null);
  const [loading, setLoading]         = useState(false);
  const [loadError, setLoadError]     = useState<string | null>(null);
  const [expandedRoute, setExpandedRoute] = useState<string | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<ScheduledWorkTicket | null>(null);

  // Employees (Aspire Contacts)
  const [employees, setEmployees]     = useState<AspireEmployee[]>([]);
  const [submitterName, setSubmitterName] = useState(() => localStorage.getItem('field_employee') || '');

  // Media
  const [photos, setPhotos]           = useState<File[]>([]);
  const [previews, setPreviews]       = useState<string[]>([]);

  // Notes
  const [comment, setComment]         = useState('');

  // Submission
  const [submitting, setSubmitting]   = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<{ ticket: string; files: number } | null>(null);

  const cameraRef  = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  // Load Aspire employees once
  useEffect(() => {
    getAspireEmployees().then(emps => { if (emps.length > 0) setEmployees(emps); }).catch(() => {});
  }, []);

  // Load routes when range changes
  useEffect(() => {
    setLoading(true); setLoadError(null); setRoutes(null); setExpandedRoute(null);
    getScheduledTickets(range)
      .then(res => {
        setRoutes(res.routes);
        // Auto-expand if only one route
        if (res.routes.length === 1) setExpandedRoute(res.routes[0].route_name);
      })
      .catch(e => setLoadError((e as Error).message))
      .finally(() => setLoading(false));
  }, [range]);

  // Media handlers
  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const remaining = MAX_FILES - photos.length;
    const toAdd = Array.from(files).slice(0, remaining);
    const processed = await Promise.all(
      toAdd.map(f => f.type.startsWith('video/') ? Promise.resolve(f) : compressImage(f))
    );
    const newPreviews = processed.map(f => f.type.startsWith('image/') ? URL.createObjectURL(f) : '');
    setPhotos(p => [...p, ...processed]);
    setPreviews(p => [...p, ...newPreviews]);
  };

  const removePhoto = (idx: number) => {
    if (previews[idx]) URL.revokeObjectURL(previews[idx]);
    setPhotos(p => p.filter((_, i) => i !== idx));
    setPreviews(p => p.filter((_, i) => i !== idx));
  };

  const selectTicket = (t: ScheduledWorkTicket) => {
    setSelectedTicket(t);
    previews.forEach(p => URL.revokeObjectURL(p));
    setPhotos([]); setPreviews([]);
    setStep(2);
  };

  // Submit
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
        files:  res.photos_uploaded,
      });
      setStep(5);
    } catch (e: unknown) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    previews.forEach(p => URL.revokeObjectURL(p));
    setStep(1); setSelectedTicket(null); setPhotos([]); setPreviews([]);
    setComment(''); setSubmitError(null); setSuccessInfo(null);
  };

  const back = () => setStep(s => (s - 1) as Step);

  const canContinue = () => {
    if (step === 2) return true;
    if (step === 3) return submitterName.trim().length > 0 && comment.trim().length >= 3;
    return true;
  };

  const stepLabels = ['Select ticket', 'Add media', 'Notes & name', 'Review'];

  return (
    <div style={S.phone}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerTop}>
          <img src="/darios-logo.png" alt="Dario's" style={{ height: 30, filter: 'brightness(0) invert(1)' }} />
          {step > 1 && selectedTicket && (
            <span style={S.chip}>{selectedTicket._RouteName || 'Route'}</span>
          )}
        </div>
        <div style={S.hsub}>Work Ticket Update</div>
      </div>

      {/* Progress */}
      {step < 5 && (
        <div style={S.progress}>
          <div style={S.psteps}>
            {[1,2,3,4].map(i => (
              <div key={i} style={{...S.pstep, background: step > i ? '#2563eb' : step === i ? 'rgba(37,99,235,.45)' : '#e2e6ed'}}/>
            ))}
          </div>
          <div style={S.plabel}>{stepLabels[step - 1]}</div>
        </div>
      )}

      <div style={S.content}>

        {/* ── Step 1: Routes & tickets ── */}
        {step === 1 && (
          <>
            {/* Range toggle */}
            <div style={S.rangeBar}>
              {(['past', 'today', 'upcoming'] as TicketRange[]).map(r => (
                <button key={r} style={{...S.rangeBtn, ...(range === r ? S.rangeBtnActive : {})}}
                  onClick={() => setRange(r)}>
                  {r === 'past' ? '← Past 2 wks' : r === 'today' ? 'Today' : 'Upcoming →'}
                </button>
              ))}
            </div>

            {loading && (
              <div style={{...S.card, color:'#6b7280', fontSize:13, textAlign:'center', padding:'24px 16px'}}>
                Loading routes...
              </div>
            )}

            {loadError && (
              <div style={{...S.card, color:'#dc2626', fontSize:13}}>
                Could not load tickets: {loadError}
              </div>
            )}

            {routes && routes.length === 0 && (
              <div style={{...S.card, color:'#6b7280', fontSize:14, textAlign:'center', padding:'24px 16px'}}>
                {range === 'today' ? 'No tickets scheduled for today.'
                  : range === 'past' ? 'No tickets in the last 2 weeks.'
                  : 'No upcoming tickets in the next 30 days.'}
              </div>
            )}

            {routes && routes.map(route => (
              <div key={route.route_name} style={S.routeCard}>
                {/* Route header — tap to expand */}
                <button
                  style={S.routeHeader}
                  onClick={() => setExpandedRoute(v => v === route.route_name ? null : route.route_name)}
                >
                  <div style={{display:'flex', alignItems:'center', gap:10}}>
                    <span style={{fontSize:18}}>🚛</span>
                    <div style={{textAlign:'left'}}>
                      <div style={{fontSize:15, fontWeight:700, color:'#1a1d23'}}>{route.route_name}</div>
                      <div style={{fontSize:12, color:'#6b7280', marginTop:1}}>
                        {route.ticket_count} ticket{route.ticket_count !== 1 ? 's' : ''}
                      </div>
                    </div>
                  </div>
                  <span style={{fontSize:18, color:'#6b7280', transform: expandedRoute === route.route_name ? 'rotate(90deg)' : 'none', transition:'transform .2s'}}>›</span>
                </button>

                {/* Tickets within this route */}
                {expandedRoute === route.route_name && (
                  <div style={{borderTop:'1px solid #e2e6ed', padding:'8px 0 4px'}}>
                    {route.tickets.map(t => (
                      <button
                        key={t.WorkTicketID}
                        style={{
                          ...S.ticketRow,
                          background: selectedTicket?.WorkTicketID === t.WorkTicketID ? '#eff6ff' : 'transparent',
                          borderLeft: selectedTicket?.WorkTicketID === t.WorkTicketID ? '3px solid #2563eb' : '3px solid transparent',
                        }}
                        onClick={() => selectTicket(t)}
                      >
                        <div style={{flex:1, textAlign:'left'}}>
                          <div style={{fontSize:13, fontWeight:600, color:'#1a1d23', marginBottom:2}}>
                            {t.WorkTicketTitle || `Ticket #${t.WorkTicketID}`}
                          </div>
                          <div style={{fontSize:11, color:'#6b7280'}}>
                            {t.OpportunityName || `Job #${t.OpportunityID}`}
                            {t.ScheduledDate ? ` · ${fmtDate(t.ScheduledDate)}` : ''}
                          </div>
                          {(t.PropertyAddress || t.PropertyName) && (
                            <div style={{fontSize:11, color:'#9ca3af', marginTop:1}}>
                              {t.PropertyAddress || t.PropertyName}
                            </div>
                          )}
                        </div>
                        <span style={{
                          fontSize:10, fontWeight:600, borderRadius:6, padding:'2px 8px',
                          background: statusColor(t.WorkTicketStatusName) + '18',
                          color: statusColor(t.WorkTicketStatusName), flexShrink:0, marginLeft:8,
                        }}>
                          {t.WorkTicketStatusName || '—'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </>
        )}

        {/* ── Step 2: Media ── */}
        {step === 2 && selectedTicket && (
          <>
            <div style={{...S.card, background:'#eff6ff', border:'1.5px solid #bfdbfe'}}>
              <div style={{fontSize:13, fontWeight:600, color:'#1d4ed8', marginBottom:2}}>
                {selectedTicket.WorkTicketTitle || `Ticket #${selectedTicket.WorkTicketID}`}
              </div>
              <div style={{fontSize:11, color:'#3b82f6'}}>
                {selectedTicket.OpportunityName}{selectedTicket.PropertyName ? ` · ${selectedTicket.PropertyName}` : ''}
              </div>
            </div>

            <div style={S.card}>
              <div style={S.ctitle}>Add photos & videos ({photos.length}/{MAX_FILES})</div>

              <input ref={cameraRef}  type="file" accept="image/*,video/*" capture="environment" multiple onChange={e => handleFiles(e.target.files)} style={{display:'none'}}/>
              <input ref={galleryRef} type="file" accept="image/*,video/*" multiple onChange={e => handleFiles(e.target.files)} style={{display:'none'}}/>

              {photos.length < MAX_FILES && (
                <div style={{display:'flex', gap:10, marginBottom:12}}>
                  <div style={{...S.uparea, flex:1}} onClick={() => cameraRef.current?.click()}>
                    <span style={{fontSize:30}}>📷</span>
                    <div style={S.uptitle}>Camera</div>
                    <div style={{fontSize:11, color:'#6b7280', marginTop:2}}>Photo or video</div>
                  </div>
                  <div style={{...S.uparea, flex:1}} onClick={() => galleryRef.current?.click()}>
                    <span style={{fontSize:30}}>🖼️</span>
                    <div style={S.uptitle}>Library</div>
                    <div style={{fontSize:11, color:'#6b7280', marginTop:2}}>Photo or video</div>
                  </div>
                </div>
              )}

              {photos.length > 0 && (
                <div style={S.photoGrid}>
                  {photos.map((f, i) => (
                    <div key={i} style={S.photoThumb}>
                      {f.type.startsWith('video/')
                        ? <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100%',gap:2}}>
                            <span style={{fontSize:28}}>🎥</span>
                            <div style={{fontSize:9,color:'#6b7280',textAlign:'center',padding:'0 4px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:'100%'}}>{f.name}</div>
                          </div>
                        : previews[i]
                          ? <img src={previews[i]} alt={f.name} style={S.thumbImg}/>
                          : <div style={{fontSize:24,textAlign:'center'}}>📄</div>
                      }
                      <button style={S.removeBtn} onClick={() => removePhoto(i)}>✕</button>
                    </div>
                  ))}
                </div>
              )}

              {photos.length === 0 && (
                <div style={S.tip}>Photos and short video clips welcome. Videos up to 200 MB.</div>
              )}
            </div>
          </>
        )}

        {/* ── Step 3: Notes & name ── */}
        {step === 3 && (
          <div style={S.card}>
            <div style={S.ctitle}>Update details</div>

            <div style={{marginBottom:16}}>
              <div style={S.flabel}>Your name</div>
              {submitterName ? (
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 0'}}>
                  <span style={{fontSize:15, fontWeight:600, color:'#1a1d23'}}>{submitterName}</span>
                  <button style={{fontSize:12,color:'#6b7280',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit'}}
                    onClick={() => { setSubmitterName(''); localStorage.removeItem('field_employee'); }}>
                    Not you?
                  </button>
                </div>
              ) : employees.length > 0 ? (
                <select style={S.sel} value={submitterName}
                  onChange={e => { setSubmitterName(e.target.value); if (e.target.value) localStorage.setItem('field_employee', e.target.value); }}>
                  <option value="">Select your name...</option>
                  {employees.map(e => <option key={e.ContactID} value={e.FullName}>{e.FullName}</option>)}
                </select>
              ) : (
                <input style={S.input} placeholder="Your name" value={submitterName}
                  onChange={e => setSubmitterName(e.target.value)} autoFocus/>
              )}
            </div>

            <div>
              <div style={S.flabel}>Notes</div>
              <textarea
                style={{...S.input, minHeight:110, resize:'vertical'}}
                placeholder="Describe what was completed, any issues, materials used, etc."
                value={comment}
                onChange={e => setComment(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* ── Step 4: Review ── */}
        {step === 4 && selectedTicket && (
          <div style={S.card}>
            <div style={S.ctitle}>Review before submitting</div>
            <RR label="Route"  value={selectedTicket._RouteName || '—'}/>
            <RR label="Ticket" value={selectedTicket.WorkTicketTitle || `#${selectedTicket.WorkTicketID}`}/>
            <RR label="Job"    value={selectedTicket.OpportunityName || `#${selectedTicket.OpportunityID}`}/>
            {selectedTicket.ScheduledDate && <RR label="Date" value={fmtDate(selectedTicket.ScheduledDate)}/>}
            <RR label="Media"  value={`${photos.length} file${photos.length !== 1 ? 's' : ''}`} color={photos.length > 0 ? '#059669' : '#6b7280'}/>
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

        {/* ── Step 5: Success ── */}
        {step === 5 && successInfo && (
          <div style={S.success}>
            <span style={{fontSize:64, display:'block', marginBottom:16}}>✅</span>
            <div style={S.stitle}>Ticket updated!</div>
            <div style={S.ssub}>
              <strong>{successInfo.ticket}</strong> has been updated
              {successInfo.files > 0 ? ` with ${successInfo.files} file${successInfo.files !== 1 ? 's' : ''} attached` : ''}.
            </div>
            <div style={{fontSize:12, color:'#6b7280', marginTop:8}}>
              Your notes and photos have been saved.
            </div>
          </div>
        )}

      </div>

      {/* Bottom bar */}
      <div style={S.bar}>
        {step === 5 ? (
          <button style={S.bsuccess} onClick={reset}>Update another ticket</button>
        ) : step === 1 ? null
        : step === 4 ? (
          <>
            <button style={{...S.bprimary, opacity: submitting ? .4 : 1}} disabled={submitting} onClick={handleSubmit}>
              {submitting ? 'Submitting...' : 'Submit update'}
            </button>
            <button style={S.bback} onClick={back}>← Back</button>
          </>
        ) : (
          <>
            <button style={{...S.bprimary, opacity: canContinue() ? 1 : .4}} disabled={!canContinue()}
              onClick={() => setStep(s => (s + 1) as Step)}>
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
  sel:{width:'100%',padding:12,border:'1.5px solid #e2e6ed',borderRadius:8,fontSize:14,color:'#1a1d23',background:'#fff',outline:'none',fontFamily:'inherit'},
  rangeBar:{display:'flex',gap:6,marginBottom:12},
  rangeBtn:{flex:1,padding:'10px 4px',borderRadius:10,fontSize:12,fontWeight:600,cursor:'pointer',border:'1.5px solid #e2e6ed',background:'#fff',color:'#6b7280',fontFamily:'inherit'},
  rangeBtnActive:{background:'#2563eb',color:'#fff',borderColor:'#2563eb'},
  routeCard:{background:'#fff',border:'1.5px solid #e2e6ed',borderRadius:12,marginBottom:10,overflow:'hidden'},
  routeHeader:{width:'100%',display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 16px',background:'transparent',border:'none',cursor:'pointer',fontFamily:'inherit'},
  ticketRow:{width:'100%',display:'flex',alignItems:'center',padding:'10px 16px',background:'transparent',border:'none',cursor:'pointer',fontFamily:'inherit',borderBottom:'1px solid #f1f5f9'},
  flabel:{fontSize:12,fontWeight:600,color:'#6b7280',marginBottom:6,textTransform:'uppercase',letterSpacing:'.04em'},
  input:{width:'100%',padding:'12px 14px',border:'1.5px solid #e2e6ed',borderRadius:8,fontSize:15,color:'#1a1d23',outline:'none',fontFamily:'inherit',background:'#fff',boxSizing:'border-box'},
  uparea:{border:'2px dashed #e2e6ed',borderRadius:10,padding:'20px 12px',textAlign:'center',cursor:'pointer',background:'#f4f6f9'},
  uptitle:{fontSize:13,fontWeight:600,color:'#1a1d23',marginTop:4},
  photoGrid:{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginTop:8},
  photoThumb:{position:'relative',borderRadius:8,overflow:'hidden',aspectRatio:'1',background:'#f4f6f9',display:'flex',alignItems:'center',justifyContent:'center'},
  thumbImg:{width:'100%',height:'100%',objectFit:'cover',display:'block'},
  removeBtn:{position:'absolute',top:4,right:4,width:22,height:22,borderRadius:11,background:'rgba(0,0,0,.55)',color:'#fff',border:'none',cursor:'pointer',fontSize:11,display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1},
  tip:{background:'#fffbeb',border:'1px solid #fde68a',borderRadius:10,padding:12,fontSize:12,color:'#92400e',lineHeight:1.6},
  success:{textAlign:'center',padding:'40px 20px'},
  stitle:{fontSize:22,fontWeight:600,marginBottom:8},
  ssub:{fontSize:14,color:'#6b7280',lineHeight:1.6,marginBottom:8},
  bar:{padding:'16px 20px',background:'#fff',borderTop:'1px solid #e2e6ed',flexShrink:0},
  bprimary:{width:'100%',padding:16,background:'#2563eb',color:'#fff',border:'none',borderRadius:10,fontSize:16,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'block'},
  bback:{width:'100%',padding:12,background:'none',border:'none',fontSize:14,color:'#6b7280',cursor:'pointer',marginTop:8,fontFamily:'inherit'},
  bsuccess:{width:'100%',padding:16,background:'#059669',color:'#fff',border:'none',borderRadius:10,fontSize:16,fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
};
