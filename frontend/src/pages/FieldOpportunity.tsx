/**
 * FieldOpportunity.tsx — Mobile new opportunity creation for field crews.
 * Accessible at /field/opportunity
 *
 * Flow:
 *   1. Search for property/client by name
 *   2. Select from results (or enter manually)
 *   3. Fill in opportunity details (name, division, estimated value)
 *   4. Add up to 10 photos (compressed)
 *   5. Add notes + your name
 *   6. Review & submit
 *   7. Success
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  searchFieldProperties,
  createFieldOpportunity,
  getLeadSources,
  getSalesTypes,
  listEmployees,
  type FieldPropertyResult,
  type AspirePicklistItem,
} from '../lib/api';

const FALLBACK_EMPLOYEES = ['Marcus Torres','Jake Willms','Devon Hicks','Priya Sandhu','Cole Beaumont'];

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const MAX_PHOTOS = 10;
const MAX_PX     = 1600;

const DIVISIONS: { id: number; name: string; icon: string }[] = [
  { id: 8, name: 'Construction',             icon: '🏗️' },
  { id: 2, name: 'Residential Maintenance',  icon: '🏡' },
  { id: 9, name: 'Commercial Maintenance',   icon: '🏢' },
  { id: 6, name: 'Snow',                     icon: '❄️' },
  { id: 7, name: 'Irrigation / Lighting',    icon: '💧' },
];

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

export default function FieldOpportunity() {
  const [step, setStep]             = useState<Step>(1);

  // Step 1 — property search
  const [propQuery, setPropQuery]   = useState('');
  const [searching, setSearching]   = useState(false);
  const [propResults, setPropResults] = useState<FieldPropertyResult[] | null>(null);
  const [selectedProp, setSelectedProp] = useState<FieldPropertyResult | null>(null);
  const [manualPropName, setManualPropName] = useState('');
  const [useManual, setUseManual]   = useState(false);

  // Step 2 — opportunity details
  const [oppName, setOppName]           = useState('');
  const [divisionId, setDivisionId]     = useState<number | null>(null);
  const [estimatedValue, setEstimatedValue] = useState('');
  const [dueDate, setDueDate]           = useState('');
  const [startDate, setStartDate]       = useState('');
  const [endDate, setEndDate]           = useState('');
  const [leadSources, setLeadSources]   = useState<AspirePicklistItem[]>([]);
  const [salesTypes, setSalesTypes]     = useState<AspirePicklistItem[]>([]);
  const [leadSourceId, setLeadSourceId] = useState<number | null>(null);
  const [salesTypeId, setSalesTypeId]   = useState<number | null>(null);

  // Step 3 — photos
  const [photos, setPhotos]         = useState<File[]>([]);
  const [previews, setPreviews]     = useState<string[]>([]);

  // Step 4 — notes + name
  const [submitterName, setSubmitterName] = useState(
    () => localStorage.getItem('field_employee') || ''
  );
  const [employees, setEmployees] = useState<string[]>(FALLBACK_EMPLOYEES);

  useEffect(() => {
    listEmployees().then(names => { if (names.length > 0) setEmployees(names); }).catch(() => {});
    getLeadSources().then(items => { if (items.length > 0) setLeadSources(items); }).catch(() => {});
    getSalesTypes().then(items  => { if (items.length > 0) setSalesTypes(items);  }).catch(() => {});
  }, []);
  const [notes, setNotes]           = useState('');

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<{ name: string; id: string | number; number: number | null; photos: number } | null>(null);

  const cameraRef  = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Property search ────────────────────────────────────────────────────────
  const handlePropQuery = (val: string) => {
    setPropQuery(val);
    setPropResults(null);
    setSelectedProp(null);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (val.trim().length < 2) return;
    searchTimeout.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchFieldProperties(val.trim());
        setPropResults(res.properties);
      } catch {
        setPropResults([]);
      } finally {
        setSearching(false);
      }
    }, 500);
  };

  const selectProp = useCallback((p: FieldPropertyResult) => {
    setSelectedProp(p);
    setUseManual(false);
    setManualPropName('');
  }, []);

  // ── Photos ─────────────────────────────────────────────────────────────────
  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const remaining = MAX_PHOTOS - photos.length;
    const toAdd = Array.from(files).slice(0, remaining);
    const processed = await Promise.all(
      toAdd.map(f => f.type.startsWith('video/') ? Promise.resolve(f) : compressImage(f))
    );
    const newPreviews = processed.map(f =>
      f.type.startsWith('image/') ? URL.createObjectURL(f) : ''
    );
    setPhotos(p => [...p, ...processed]);
    setPreviews(p => [...p, ...newPreviews]);
  };

  const removePhoto = (idx: number) => {
    if (previews[idx]) URL.revokeObjectURL(previews[idx]);
    setPhotos(p => p.filter((_, i) => i !== idx));
    setPreviews(p => p.filter((_, i) => i !== idx));
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!oppName.trim() || !divisionId || !submitterName.trim()) return;
    setSubmitting(true); setSubmitError(null);

    const propertyId  = selectedProp?.PropertyID ?? undefined;
    const propertyFyi = selectedProp?.PropertyName ?? (useManual ? manualPropName : undefined);

    const selectedLeadSource = leadSources.find(l => l.id === leadSourceId);
    const selectedSalesType  = salesTypes.find(s => s.id === salesTypeId);

    try {
      const res = await createFieldOpportunity({
        submitterName:  submitterName.trim(),
        opportunityName: oppName.trim(),
        divisionId,
        estimatedValue: parseFloat(estimatedValue) || 0,
        notes:          notes.trim(),
        photos,
        propertyId,
        propertyNameFyi: propertyFyi,
        dueDate:        dueDate   || undefined,
        startDate:      startDate || undefined,
        endDate:        endDate   || undefined,
        leadSourceId:   leadSourceId   ?? undefined,
        leadSourceName: selectedLeadSource?.name,
        salesTypeId:    salesTypeId    ?? undefined,
        salesTypeName:  selectedSalesType?.name,
      });
      localStorage.setItem('field_employee', submitterName.trim());
      setSuccessInfo({ name: res.opportunity_name, id: res.opportunity_id, number: res.opportunity_number ?? null, photos: res.photos_uploaded });
      setStep(7);
    } catch (e: unknown) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    previews.forEach(p => URL.revokeObjectURL(p));
    setStep(1); setPropQuery(''); setPropResults(null); setSelectedProp(null);
    setManualPropName(''); setUseManual(false);
    setOppName(''); setDivisionId(null); setEstimatedValue('');
    setDueDate(''); setStartDate(''); setEndDate('');
    setLeadSourceId(null); setSalesTypeId(null);
    setPhotos([]); setPreviews([]);
    setNotes(''); setSubmitError(null); setSuccessInfo(null);
  };

  const stepLabels = ['Find property', 'Job details', 'Add photos', 'Notes & name', 'Review'];
  const showProgress = step < 7;

  const canContinue = () => {
    if (step === 1) return !!(selectedProp || (useManual && manualPropName.trim().length > 1));
    if (step === 2) return !!(oppName.trim() && divisionId);
    if (step === 3) return true; // photos optional
    if (step === 4) return !!(submitterName.trim());
    if (step === 5) return true;
    return false;
  };

  const next = () => {
    if (step === 6) { handleSubmit(); return; }
    setStep(s => (s + 1) as Step);
  };
  const back = () => setStep(s => (s - 1) as Step);

  const selectedDivision = DIVISIONS.find(d => d.id === divisionId);

  return (
    <div style={S.phone}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerTop}>
          <img src="/darios-logo.png" alt="Dario's" style={{ height: 30, filter: 'brightness(0) invert(1)' }} />
          <span style={S.chip}>{submitterName || 'Field crew'}</span>
        </div>
        <div style={S.hsub}>New Opportunity</div>
      </div>

      {/* Progress */}
      {showProgress && (
        <div style={S.progress}>
          <div style={S.psteps}>
            {[1,2,3,4,5].map((i) => (
              <div key={i} style={{...S.pstep, background: step > i ? '#2563eb' : step === i ? 'rgba(37,99,235,.45)' : '#e2e6ed'}}/>
            ))}
          </div>
          <div style={S.plabel}>{stepLabels[Math.min(step, 6) - 1]}</div>
        </div>
      )}

      <div style={S.content}>

        {/* Step 1 — Find property */}
        {step === 1 && (
          <>
            <div style={S.card}>
              <div style={S.ctitle}>Search for property / client</div>
              <input
                style={S.search}
                placeholder="Type property or client name"
                value={propQuery}
                onChange={e => handlePropQuery(e.target.value)}
                autoFocus
              />
              {searching && <div style={S.hint}>Searching...</div>}
            </div>

            {propResults && propResults.length === 0 && !useManual && (
              <div style={S.card}>
                <div style={{fontSize:13, color:'#6b7280', marginBottom:10}}>
                  No existing properties found for "{propQuery}".
                </div>
                <button style={S.secondaryBtn} onClick={() => setUseManual(true)}>
                  Enter property name manually
                </button>
              </div>
            )}

            {propResults && propResults.map(p => (
              <div
                key={p.PropertyID || p.OpportunityID}
                style={{
                  ...S.card, cursor:'pointer',
                  border: selectedProp?.PropertyID === p.PropertyID
                    ? '2px solid #2563eb' : '1.5px solid #e2e6ed',
                  background: selectedProp?.PropertyID === p.PropertyID ? '#eff6ff' : '#fff',
                }}
                onClick={() => selectProp(p)}
              >
                <div style={{fontWeight:600, fontSize:15, color:'#1a1d23', marginBottom:2}}>
                  {p.PropertyName || 'Unknown property'}
                </div>
                <div style={{fontSize:12, color:'#6b7280'}}>
                  {p.DivisionName || '—'} · From: {p.OpportunityName || '—'}
                </div>
              </div>
            ))}

            {(useManual || (propResults && propResults.length > 0 && !selectedProp)) && (
              <div style={S.card}>
                {propResults && propResults.length > 0 && (
                  <div style={{fontSize:12, color:'#6b7280', marginBottom:8}}>
                    Don't see it? Enter property name manually:
                  </div>
                )}
                {useManual && (
                  <input
                    style={S.search}
                    placeholder="Property / client name"
                    value={manualPropName}
                    onChange={e => setManualPropName(e.target.value)}
                    autoFocus={useManual}
                  />
                )}
                {!useManual && (
                  <button style={S.secondaryBtn} onClick={() => setUseManual(true)}>
                    Enter manually
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {/* Step 2 — Opportunity details */}
        {step === 2 && (
          <div style={S.card}>
            <div style={S.ctitle}>Opportunity details</div>

            <div style={{marginBottom:16}}>
              <div style={S.flabel}>Opportunity name</div>
              <input
                style={S.input}
                placeholder="e.g. Smith Residence — Patio & Fire Pit"
                value={oppName}
                onChange={e => setOppName(e.target.value)}
                autoFocus
              />
            </div>

            <div style={{marginBottom:16}}>
              <div style={S.flabel}>Division</div>
              <div style={S.divGrid}>
                {DIVISIONS.map(d => (
                  <button
                    key={d.id}
                    style={{
                      ...S.divBtn,
                      border: divisionId === d.id ? '2px solid #2563eb' : '1.5px solid #e2e6ed',
                      background: divisionId === d.id ? '#eff6ff' : '#f9fafb',
                      color: divisionId === d.id ? '#1d4ed8' : '#374151',
                    }}
                    onClick={() => setDivisionId(d.id)}
                  >
                    <span style={{fontSize:20, display:'block', marginBottom:2}}>{d.icon}</span>
                    <div style={{fontSize:11, fontWeight:600, lineHeight:1.3}}>{d.name}</div>
                  </button>
                ))}
              </div>
            </div>

            <div style={{marginBottom:16}}>
              <div style={S.flabel}>Estimated value ($)</div>
              <input
                style={S.input}
                type="number"
                min="0"
                step="100"
                placeholder="0"
                value={estimatedValue}
                onChange={e => setEstimatedValue(e.target.value)}
              />
              <div style={{fontSize:11, color:'#9ca3af', marginTop:4}}>Optional — best estimate is fine</div>
            </div>

            {/* Dates */}
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:16}}>
              <div>
                <div style={S.flabel}>Start date</div>
                <input style={S.input} type="date" value={startDate} onChange={e => setStartDate(e.target.value)}/>
              </div>
              <div>
                <div style={S.flabel}>End date</div>
                <input style={S.input} type="date" value={endDate} onChange={e => setEndDate(e.target.value)}/>
              </div>
            </div>

            <div style={{marginBottom:16}}>
              <div style={S.flabel}>Due date</div>
              <input style={S.input} type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}/>
              <div style={{fontSize:11, color:'#9ca3af', marginTop:4}}>Client's requested completion date</div>
            </div>

            {leadSources.length > 0 && (
              <div style={{marginBottom:16}}>
                <div style={S.flabel}>Lead source</div>
                <select
                  style={S.sel}
                  value={leadSourceId ?? ''}
                  onChange={e => setLeadSourceId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Select lead source...</option>
                  {leadSources.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            )}

            {salesTypes.length > 0 && (
              <div>
                <div style={S.flabel}>Sales type</div>
                <select
                  style={S.sel}
                  value={salesTypeId ?? ''}
                  onChange={e => setSalesTypeId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Select sales type...</option>
                  {salesTypes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}
          </div>
        )}

        {/* Step 3 — Photos */}
        {step === 3 && (
          <div style={S.card}>
            <div style={S.ctitle}>Add photos & videos ({photos.length}/{MAX_PHOTOS})</div>

            <input ref={cameraRef}  type="file" accept="image/*,video/*" capture="environment" multiple onChange={e => handleFiles(e.target.files)} style={{display:'none'}}/>
            <input ref={galleryRef} type="file" accept="image/*,video/*" multiple onChange={e => handleFiles(e.target.files)} style={{display:'none'}}/>

            {photos.length < MAX_PHOTOS && (
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
                        : <div style={{fontSize:24, textAlign:'center'}}>📄</div>
                    }
                    <button style={S.removeBtn} onClick={() => removePhoto(i)}>✕</button>
                  </div>
                ))}
              </div>
            )}

            {photos.length === 0 && (
              <div style={S.tip}>Photos and short video clips welcome. Videos up to 200 MB — keep clips under 30 seconds for faster uploads.</div>
            )}
          </div>
        )}

        {/* Step 4 — Notes & name */}
        {step === 4 && (
          <div style={S.card}>
            <div style={S.ctitle}>Notes & your name</div>

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
                <select
                  style={S.sel}
                  value={submitterName}
                  onChange={e => {
                    setSubmitterName(e.target.value);
                    if (e.target.value) localStorage.setItem('field_employee', e.target.value);
                  }}
                >
                  <option value="">Select your name...</option>
                  {employees.map(emp => <option key={emp}>{emp}</option>)}
                </select>
              )}
            </div>

            <div>
              <div style={S.flabel}>Additional notes (optional)</div>
              <textarea
                style={{...S.input, minHeight:90, resize:'vertical'}}
                placeholder="Scope of work, client requests, access notes, etc."
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* Step 5 — Review */}
        {step === 5 && (
          <div style={S.card}>
            <div style={S.ctitle}>Review before submitting</div>
            <RR label="Property"  value={selectedProp?.PropertyName || manualPropName || '—'}/>
            <RR label="Job name"  value={oppName}/>
            <RR label="Division"  value={selectedDivision ? `${selectedDivision.icon} ${selectedDivision.name}` : '—'}/>
            {estimatedValue && <RR label="Estimate" value={`$${parseFloat(estimatedValue).toLocaleString()}`}/>}
            {startDate && <RR label="Start date" value={startDate}/>}
            {endDate   && <RR label="End date"   value={endDate}/>}
            {dueDate   && <RR label="Due date"   value={dueDate}/>}
            {leadSourceId  && <RR label="Lead source" value={leadSources.find(l => l.id === leadSourceId)?.name ?? ''}/>}
            {salesTypeId   && <RR label="Sales type"  value={salesTypes.find(s => s.id === salesTypeId)?.name  ?? ''}/>}
            <RR label="Photos"    value={`${photos.length} photo${photos.length !== 1 ? 's' : ''}`} color={photos.length > 0 ? '#059669' : '#6b7280'}/>
            <RR label="Created by" value={submitterName}/>
            {notes && (
              <div style={{paddingTop:10, fontSize:13, color:'#1a1d23', lineHeight:1.6, whiteSpace:'pre-wrap'}}>
                <span style={{fontSize:12, color:'#6b7280', fontWeight:500, display:'block', marginBottom:4, textTransform:'uppercase', letterSpacing:'.04em'}}>Notes</span>
                {notes}
              </div>
            )}
            {submitError && (
              <div style={{...S.tip, background:'#fef2f2', borderColor:'#fca5a5', color:'#dc2626', marginTop:12}}>
                {submitError}
              </div>
            )}
          </div>
        )}

        {/* Step 7 — Success */}
        {step === 7 && successInfo && (
          <div style={S.success}>
            <span style={{fontSize:64, display:'block', marginBottom:16}}>✅</span>
            <div style={S.stitle}>Opportunity created!</div>
            {successInfo.number && (
              <div style={{background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:10, padding:'10px 16px', marginBottom:14, fontSize:18, fontWeight:700, color:'#1d4ed8', letterSpacing:'.02em'}}>
                Opp #{successInfo.number}
              </div>
            )}
            <div style={S.ssub}>
              <strong>{successInfo.name}</strong> has been added to Aspire.
              {successInfo.photos > 0 ? ` ${successInfo.photos} photo${successInfo.photos !== 1 ? 's' : ''} attached.` : ''}
            </div>
            <div style={{fontSize:12, color:'#6b7280', marginTop:8}}>
              The office will follow up to assign an estimator and create a quote.
            </div>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div style={S.bar}>
        {step === 7 ? (
          <button style={S.bsuccess} onClick={reset}>Create another opportunity</button>
        ) : step === 6 ? (
          <>
            <button
              style={{...S.bprimary, opacity: submitting ? .4 : 1}}
              disabled={submitting}
              onClick={handleSubmit}
            >
              {submitting ? 'Creating...' : 'Create opportunity'}
            </button>
            <button style={S.bback} onClick={back}>← Back</button>
          </>
        ) : step === 1 ? (
          <button
            style={{...S.bprimary, opacity: canContinue() ? 1 : .4}}
            disabled={!canContinue()}
            onClick={next}
          >
            Continue
          </button>
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
  flabel:{fontSize:12,fontWeight:600,color:'#6b7280',marginBottom:6,textTransform:'uppercase',letterSpacing:'.04em'},
  input:{width:'100%',padding:'12px 14px',border:'1.5px solid #e2e6ed',borderRadius:8,fontSize:15,color:'#1a1d23',outline:'none',fontFamily:'inherit',background:'#fff',boxSizing:'border-box'},
  divGrid:{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8},
  divBtn:{padding:'12px 6px',textAlign:'center',borderRadius:10,cursor:'pointer',fontFamily:'inherit',transition:'all .15s'},
  uparea:{border:'2px dashed #e2e6ed',borderRadius:10,padding:'20px 12px',textAlign:'center',cursor:'pointer',background:'#f4f6f9'},
  uptitle:{fontSize:13,fontWeight:600,color:'#1a1d23',marginTop:4},
  photoGrid:{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginTop:8},
  photoThumb:{position:'relative',borderRadius:8,overflow:'hidden',aspectRatio:'1',background:'#f4f6f9',display:'flex',alignItems:'center',justifyContent:'center'},
  thumbImg:{width:'100%',height:'100%',objectFit:'cover',display:'block'},
  removeBtn:{position:'absolute',top:4,right:4,width:22,height:22,borderRadius:11,background:'rgba(0,0,0,.55)',color:'#fff',border:'none',cursor:'pointer',fontSize:11,display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1},
  tip:{background:'#fffbeb',border:'1px solid #fde68a',borderRadius:10,padding:12,fontSize:12,color:'#92400e',lineHeight:1.6},
  sel:{width:'100%',padding:12,border:'1.5px solid #e2e6ed',borderRadius:8,fontSize:14,color:'#1a1d23',background:'#fff',outline:'none',fontFamily:'inherit'},
  secondaryBtn:{width:'100%',padding:12,background:'#f4f6f9',border:'1.5px solid #e2e6ed',borderRadius:8,fontSize:14,color:'#374151',fontWeight:500,cursor:'pointer',fontFamily:'inherit'},
  success:{textAlign:'center',padding:'40px 20px'},
  stitle:{fontSize:22,fontWeight:600,marginBottom:8},
  ssub:{fontSize:14,color:'#6b7280',lineHeight:1.6,marginBottom:8},
  bar:{padding:'16px 20px',background:'#fff',borderTop:'1px solid #e2e6ed',flexShrink:0},
  bprimary:{width:'100%',padding:16,background:'#2563eb',color:'#fff',border:'none',borderRadius:10,fontSize:16,fontWeight:600,cursor:'pointer',fontFamily:'inherit',display:'block'},
  bback:{width:'100%',padding:12,background:'none',border:'none',fontSize:14,color:'#6b7280',cursor:'pointer',marginTop:8,fontFamily:'inherit'},
  bsuccess:{width:'100%',padding:16,background:'#059669',color:'#fff',border:'none',borderRadius:10,fontSize:16,fontWeight:600,cursor:'pointer',fontFamily:'inherit'},
};
